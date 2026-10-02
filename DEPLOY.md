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
本地真实发布（最短路径）：
```bash
cd etsyops
cp .env.example .env          # 仅首次；在 .env 填入 WECHAT_APPID / WECHAT_APPSECRET
npm start                     # 零依赖，http://localhost:3000（自动读取 .env）
# 或等价地： export WECHAT_APPID=xxx WECHAT_APPSECRET=yyy && npm start
```
开 http://localhost:3000/wechat-publisher.html → 后端检测到凭证即真实写入你公众号草稿箱。
（也可用系统环境变量注入，server.js 优先用已存在的环境变量，.env 仅作本地便捷填充。）

---

## 2. 代码仓库（代码源真相 / Source of Truth）
代码主库 = **GitHub**：`git@github.com:1031582293-design/etsyops-workbench.git`（main 分支，已推送）。
本地认证用专用 SSH 密钥 `~/.ssh/etsyops_ed25519`，`~/.ssh/config` 已配 `Host github.com` 指向该密钥（公钥已加进 GitHub）。
Gitee `git@gitee.com:fu-po-fa-cai/etsyops-workbench.git` 保留为只读镜像/备份。

日常提交（github 是 Cloudflare 自动部署源）：
```bash
git push github main     # 推 GitHub → Cloudflare 自动构建部署
git push origin main     # 同步到 Gitee 备份（可选）
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

---

## 8. 🚀 Cloudflare Pages 自动部署（推荐 · 当前落地路径 A）
代码主库迁 GitHub 后，Cloudflare Pages 直连 GitHub，**push 即自动构建部署**，库与应用永远同步。

### 8.1 一次性前提
1. GitHub 新建**空**仓库 `etsyops-workbench`（Public 即可；demo 代码，Gitee 也已公开）。**不要**勾选 README / .gitignore / License，保持空。
2. 把本机公钥加进 GitHub：`Settings → SSH and GPG keys → New SSH key`，粘贴
   `~/.ssh/etsyops_ed25519.pub` 的内容（与 Gitee 同一把密钥可复用，个人 demo 可接受）。
3. 之后由 agent 推送：
   ```bash
   git remote add github git@github.com:1031582293-design/etsyops-workbench.git
   git push github main
   ```
   > 若不想给 agent 授权，也可自己在 Mac 终端跑上面两条（需你本机已登录 GitHub）。

### 8.2 Cloudflare 控制台（你点几下）
1. Cloudflare 控制台 → **Workers & Pages → Create → Pages → 连接 GitHub**；
2. 选 `etsyops-workbench` 仓库并授权；
3. 构建设置：
   - **Build command**：`npm run build:static`
   - **Build output directory**：`dist`
   （Cloudflare 会先 `npm install`——本仓库无依赖秒过——再执行 build:static 产出 dist 并发布）
4. 保存并部署 → 得到 `https://etsyops-workbench.pages.dev`（可绑自定义域）。
5. 此后 `git push github main` 自动重新部署。

### 8.3 访问管控（Cloudflare Access，免费 ≤50 人真鉴权）
线上谁都能看有风险 → 用 Access 加登录层：
1. Cloudflare → 左侧 **Zero Trust**（免费注册）→ **Access → Applications → Add application → Self-hosted**；
2. Application host 填 Pages 域名（如 `etsyops-workbench.pages.dev`）；
3. Policy：Action = **Allow**，加 `Email` 规则限定你能登录的邮箱（可多个）；
4. 保存。此后打开站点需先 Cloudflare 登录，未授权 403。

### 8.4 公众号真实发布
Cloudflare Pages 是纯静态，**云端仍无 Node 后端**，线上 wechat-publisher.html 仍是模拟发布。
真实发布同第 5 节：在本地 Mac 或 PaaS（Railway / CloudBase）跑 `server.js` 注入 `WECHAT_APPID/WECHAT_APPSECRET`。
