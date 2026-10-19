# 邮件接入：Cloudflare Email Worker

把店主转发来的 Etsy 通知邮件推进工作台的后端接口 `/api/mail/ingest`。

**为什么不直接登录邮箱**：Etsy 账户只能绑一个邮箱地址（官方明说），没有"加第二个通知邮箱"；
而直接读店主邮箱需要 OAuth 授权 + 令牌落盘 + 代理常开，泄露上限是「全部邮件」。
转发只泄露 Etsy 通知本身，边界是物理的。

**一个已知风险**：`_dmarc.etsy.com` 是 `p=reject`，转发若破坏了 DKIM 签名，接收方会**直接拒收**（不进垃圾箱）。
所以第一封信必须实测：到了就走这条路，没到就改走 Graph 直读。

---

## 一、开子域收信（不碰现有邮箱）

1. Cloudflare 面板 → 选中 `mailili-agency.com`
2. **Compute → Email Service → Email Routing** → 进入 Email Routing
3. 选 apex 域名 → **Settings** → 找到 **Subdomains** → 输入 `mail` → 提交
4. 等 DNS 记录生效（通常几十秒）

> ⚠️ **不要**在根域上点启用 Email Routing。根域的 MX 现在指向 Zoho（`mx.zoho.com.cn`），
> 一改就收不到信了。子域是独立的一套 MX，互不影响。
>
> 子域启用后，**catch-all 规则不可用**（那是 apex 专属），但这里只需要一个具体地址，够用。

## 二、建 Worker

1. **Compute → Workers & Pages → Create → Worker**，名字随意，例如 `etsy-mail-ingest`
2. 编辑代码，把 `cloudflare/mail-worker.js` 全文粘进去 → **Deploy**
3. 进这个 Worker → **Settings → Variables and Secrets**，加两条：

| 名称 | 类型 | 值 |
|---|---|---|
| `MAIL_INGEST_SECRET` | **Secret（加密）** | 与后端 `.env` 里那串完全一致 |
| `FALLBACK_TO` | Text（可选） | 推送失败时转投的备用邮箱，防 Tunnel 抖动丢信 |

> 密钥生成：`openssl rand -hex 32`。后端 `.env` 写 `MAIL_INGEST_SECRET=<同一串>`，然后**重启后端**。

## 三、把地址挂到 Worker 上

1. 回到 **Email Routing → Routing rules**
2. 建一条规则：目标地址 `etsy@mail.mailili-agency.com`
3. 动作选 **Send to a Worker** → 选中 `etsy-mail-ingest` → 保存

## 四、验证（30 秒）

后端跑起来后，先看它认不认这把钥匙：

```bash
curl https://api.mailili-agency.com/api/mail/status
```

期望看到 `"configured": true`。如果是 `false`，说明 `.env` 没写 `MAIL_INGEST_SECRET`，或者改了没重启。

然后让店主发一封测试信，再查：

```bash
curl -H "x-api-key: <你的 API_KEY>" "https://api.mailili-agency.com/api/mail/recent?limit=5"
```

出现 `items` 数组就通了。原始邮件落在 `data/mail/inbox/YYYY-MM-DD/<哈希>.eml`。

## 排障对照

| 现象 | 看哪里 |
|---|---|
| `configured: false` | 后端 `.env` 缺 `MAIL_INGEST_SECRET`，或改完没重启 |
| Worker 日志 `后端拒收 401` | 两边的密钥不一致（复制时带了空格/换行） |
| Worker 日志 `投递异常` | Tunnel 没通，或 `api.mailili-agency.com` 暂时 502 |
| 店主那边收到退信 | DMARC 拒收（`p=reject`），转发这条路走不通 → 改走 Graph 直读 |
| 后端日志 `验签失败: stale_timestamp` | 本机时间不准，误差超过 5 分钟 |
