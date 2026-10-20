# 邮件接入：Cloudflare Email Worker

把店主转发来的 Etsy 通知邮件推进工作台的后端接口 `/api/mail/ingest`，再由后端推一条飞书卡片。

**为什么不直接登录邮箱**：Etsy 账户只能绑一个邮箱地址（官方明说），没有"加第二个通知邮箱"；
直接读店主邮箱需要 OAuth 授权 + 令牌落盘 + 代理常开，泄露上限是「全部邮件」。
转发只泄露 Etsy 通知本身，边界是物理的。

**为什么转发不会被 Etsy 的 `p=reject` 挡**（实测 2026-10-20）：
店主用 Outlook 的「转发」时，邮件被重新打包成一封新邮件，`From` 变成店主自己，
`DKIM d=outlook.com` 且与 From 对齐 → DMARC 检查的对象不再是 etsy.com。
⚠️ 所以规则必须用 **转发（Forward）**，不能用 **重定向 / 原样转发（Redirect / Resend）**——
后者会保留 `From: etsy.com`，那才会撞上 `p=reject` 被拒。

---

## 一、接管根域收信

**没有"子域"这个入口**：Cloudflare 新版 UI 里 Email Routing 是空状态时只有一个
`Onboard Domain` 按钮，`Settings → Subdomains` 要等 apex onboard 之后才出现。
（官方文档写的 "Select the apex domain → Settings → Subdomains" 隐含了这个前提。）

前提：根域原来的 MX（本机是 Zoho）**确认没有在用**。

1. Cloudflare → 选中 `mailili-agency.com` → **DNS → Records**
2. 删掉三条：`MX mx.zoho.com.cn`、`MX mx2.zoho.com.cn`、`TXT v=spf1 include:zohomail.com.cn ~all`
   —— **旧 SPF 必须一起删**，否则 Cloudflare 会再加一条，两条 SPF 并存 = permerror 直接失效
3. **Compute → Email Service → Email Routing → Onboard Domain** → 选域名 → Done
4. 等它自动加上：3 条 MX → `*.mx.cloudflare.net`、SPF → `include:_spf.mx.cloudflare.net`、DKIM `cf2024-1`

回退（要恢复 Zoho 时）：MX 加回 10 / 20 两条，SPF 改回 `v=spf1 include:zohomail.com.cn ~all`。

## 二、建 Worker

1. **Compute → Workers & Pages → Create application → Start with Hello World!**
   （不要选 GitHub / 模板——Cloudflare 没有"Email Worker"模板，靠代码里的 `email()` 方法区分）
2. 名字填 `etsy-mail-ingest` → Deploy
3. **Edit code → `Cmd+A` 全选删除 → 粘贴 `cloudflare/mail-worker.js` 全文 → Deploy**
   ⚠️ 必须在**清空后**粘贴。直接追加会出现两个 `export default`，
   报 `Identifier 'default' has already been declared`。
4. **Settings → Variables and Secrets**：

| 名称 | 类型 | 值 |
|---|---|---|
| `MAIL_INGEST_SECRET` | **Secret（勾上）** | 与后端 `.env` 里那串完全一致 |
| `FALLBACK_TO` | Text（可选） | 推送失败时转投的备用邮箱 |

`Protect with Cloudflare Access` 保持**关闭**——我们不用 HTTP 访问它，开了只会让排查时看到登录框。

后端 `.env` 写同一串密钥，然后**重启后端**（`./start-mac.sh` 或 `start-backend.bat`）。

## 三、把地址挂到 Worker 上

**Email Routing → Routing rules** → 建一条：

| 字段 | 值 |
|---|---|
| 地址 | `etsy@mailili-agency.com` ← **根域，没有 `mail.`** |
| 动作 | **Send to a Worker** |
| Worker | `etsy-mail-ingest` |

> ⚠️ 写成 `etsy@mail.mailili-agency.com` 会静默失败：子域没有自己的 MX，
> 邮件 fallback 到根域 MX 后被 Cloudflare 收到，但匹配不到任何规则 → 丢弃，
> 后端日志里连一行记录都没有。

## 四、验证

```bash
curl https://api.mailili-agency.com/api/mail/status      # 期望 configured: true
curl -X POST https://api.mailili-agency.com/api/notify/test   # 群里有卡片 = 飞书通
```

然后让店主转一封**历史 Etsy 邮件**（不用等新订单）到上面的地址，再查：

```bash
curl -H "x-api-key: <API_KEY>" "https://api.mailili-agency.com/api/mail/recent?limit=5"
```

原始邮件落在 `data/mail/inbox/YYYY-MM-DD/<哈希>.eml`。

## 排障对照

| 现象 | 原因 |
|---|---|
| `count` 一直是 0，日志无 `[mail]` | 地址写错（多了 `mail.`），或规则没生效 |
| 日志 `验签失败: bad_signature` | 两边密钥不一致。用 `pbcopy` 从 `.env` 复制再粘进 Worker，别手抄 |
| 日志 `验签失败: stale_timestamp` | 本机时间误差超过 5 分钟 |
| 公网看到 `error code: 502` | 源站返回了 5xx，Cloudflare 替换成自己的错误页。**接口失败一律用 4xx**，否则真实原因会被吞 |
| 飞书返回 `404 page not found` | webhook 地址错。最常见是**被粘贴了两遍**（token 位置开头是 `https:`、长度 81 而非 36） |
| 飞书返回 `19021 sign match fail` | 地址对了，但 `FEISHU_SECRET` 不对或没传签名 |
| 店主收到退信 | 用了"重定向"而不是"转发"，撞上 `p=reject` |
