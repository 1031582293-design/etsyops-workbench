# 部署 · 协作 · 真实绑定公众号 指南

EtsyOps 工作台 = 前端看板 + 一个**零依赖 Node 后端**（`server.js`）。
后端承担：① 静态托管前端；② 公众号真实 API 的**安全代理**（AppSecret 只在服务端，前端只调同源 `/api/wechat/*`）。

> ⚠️ **CloudStudio 实测结论（最重要）**：CloudStudio 部署**只要目录里有 `package.json` 就走 `npm install` + `npm start`**，
> 而云端沙箱**连不上 npm registry**，`install` 卡满 30s → 端口 3000 起不来 → `504`。
> 这与是否零依赖**无关**（已实测：去掉 vite、server.js 零依赖仍 504）。
> 因此：**CloudStudio 只能托管纯静态目录（无 package.json 的 `dist/`）**，无法运行 Node 后端、`/api/wechat/*` 在云端不可用。
> 想让"公众号真实发布"在线上跑，后端必须放在**本地 Mac** 或**真正能跑 Node 的 PaaS（CloudBase / Railway 等）**。

---

## 1. 本地预览（含真实后端）
```bash
cd etsyops
npm start                 # 零依赖，默认 http://localhost:3000（含 /api/wechat/*）
# 仅看静态页也可： python3 -m http.server 3000
```
本地真实发布：先 `export WECHAT_APPID=xxx WECHAT_APPSECRET=yyy` 再 `npm start`，
开 http://localhost:3000/wechat-publisher.html 即真实写入你公众号草稿箱。

---

## 2. 代码仓库（代码源真相 / Source of Truth）
代码放在 Gitee：`git@gitee.com:fu-po-fa-cai/etsyops-workbench.git`（main 分支，已推送）。
本地认证用专用 SSH 密钥 `~/.ssh/etsyops_ed25519`（公钥已加进 Gitee）。

日常提交：
```bash
git add -A && git commit -m "说明" && git push
```

> CODING（dev.tencent.com / coding.net）正在下线（2028-09-30 全停），别新建 CODING 仓库。

---

## 3. 🚀 Gitee → CloudStudio 自动部署（静态站）
自动部署 = CloudStudio 在控制台**关联 Gitee 仓库**并监听 push。部署目录必须指向 `dist/`（纯静态、无 package.json）。

### 你在 CloudStudio 控制台操作（我这边无对应工具，需你点几下）
1. 打开 CloudStudio（WorkBuddy/腾讯云账号下）→ 新建应用 / 导入代码仓库；
2. 授权并选择 Gitee 仓库 **`fu-po-fa-cai/etsyops-workbench`**；
3. **部署目录 / 服务目录设为 `dist/`**（关键！选根目录会 504）；端口填 `3000`；
4. 开启 **「推送到 main 自动重新部署」**（即 Gitee WebHook）；
5. 保存并部署 → 生成新的公网链接。
> 之后 `git push origin main` 即可**自动更新线上**（无需再找我手动部署）。

### 前提（仓库侧我已备好）
- `dist/` 已提交进 Gitee（见 `.gitignore` 注释），云端直接读取静态文件；
- ⚠️ 每次 push 前务必先 `npm run build:static` 重建 dist，否则线上是旧构建；
- 若 CloudStudio 不允许选子目录 `dist/`、只能部署根目录 → 自动部署会 504，此时退回「手动部署」（见第 4 节）。

---

## 4. 手动部署（兜底 / 当前线上链接来源）
当目录无 `package.json` 时，我可用部署工具直接推 `dist/`：
```bash
npm run build:static
# 然后用部署工具发布 dist/ 目录（端口 3000），返回 verified:true 即成功
```
当前线上链接（手动部署的纯静态版，演示/模拟发布）：
https://54cfb13a51384e53bbb43ca2508bd43a.app.workbuddy.host
「设置 - 数据管理 - 我发布的应用」可管理。

---

## 5. 🎯 真实绑定公众号（让"发布草稿箱"真正写入你的号）
工具页 `wechat-publisher.html` 自动检测后端是否配置凭证：已配→真实、未配→模拟。
**但 CloudStudio 静态部署没有后端，所以云端链接只能是模拟**；真实发布需本地或 PaaS 跑 `server.js`。

### 4 步接通（一次性，本地/PaaS 环境）
1. **公众号**：[mp.weixin.qq.com](https://mp.weixin.qq.com)，需**已认证公众号**（个人/企业认证均可建草稿；
   正式群发需认证服务号）。未认证报 `48001`。
2. **取凭证**：`设置与开发 → 基本配置` 记 **AppID**；重置得 **AppSecret**（只显示一次）。
3. **注入环境变量**（⚠️ 不入库、不聊天传）：`WECHAT_APPID` / `WECHAT_APPSECRET`，重启生效。
4. **IP 白名单**：`基本配置 → IP白名单` 加后端出口 IP（工具页第③步或 `GET /api/wechat/ip` 查询）。漏了报 `40164`。

### 用起来
上传文稿（md/txt/html/docx）或填飞书链接 → 选模板排版 → 上传封面图 + 作者/摘要 →「发布到草稿箱」。
后端：上传封面为永久素材 → `draft/add` → 返回真实 `media_id`，去公众号后台草稿箱可见。

### 接口与报错
- token：`GET cgi-bin/token`（2h，后端缓存）；封面：`POST cgi-bin/material/add_material?type=image`；草稿：`POST cgi-bin/draft/add`
- 报错：`40164` IP 未白名单｜`48001` 未认证｜`40007` 封面 media_id 无效｜`45009` 当日限额

---

## 6. 安全须知
- AppSecret 只在服务端；CloudStudio 环境变量或本地 export 注入，不入库。
- 飞书文档真实拉取需接「飞书」连接器授权（当前为模拟拉取）。
- 正文外链图片需先上传为微信素材（本期未自动处理，已知限制）。

## 7. 分支策略（团队协作）
- `main`：受保护，接生产（CloudStudio 部署源 = `dist/`）。
- 日常 `feature/*` 开发，PR 评审合并 → 自动重新部署。
