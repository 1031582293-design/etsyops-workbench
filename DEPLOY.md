# 部署 · 协作 · 真实绑定公众号 指南

EtsyOps 工作台 = 前端看板 + 一个**零依赖 Node 后端**（`server.js`）。
后端同时承担两件事：① 静态托管前端页面；② 公众号真实 API 的**安全代理**（把 AppSecret 留在服务端，
前端只调同源 `/api/wechat/*`，绝不直接暴露密钥）。

> ⚠️ **历史坑（已解决）**：CloudStudio 部署只要目录里有 `package.json` 就会走 `npm install` + `npm start`。
> 早期我们挂了 `vite` 依赖，云端装不上 → 端口 3000 起不来 → `504`。
> 现在 `package.json` **零依赖**，`server.js` 只用 Node 内置模块，`npm install` 秒过、`npm start` 立刻监听 3000，
> **因此直接部署根目录即可**（无需再用纯静态 dist/ 规避）。

---

## 1. 本地预览
```bash
cd etsyops
npm start                 # 零依赖，默认 http://localhost:3000（含 /api/wechat/*）
# 仅想看静态页也可：
python3 -m http.server 3000
```
本地调试公众号接口：先 `export WECHAT_APPID=xxx WECHAT_APPSECRET=yyy` 再 `npm start`，
打开 http://localhost:3000/wechat-publisher.html 即可真实写入你公众号草稿箱。

---

## 2. 代码仓库（代码源真相 / Source of Truth）
**不要**把 CloudStudio 当唯一代码库（它是运行环境，沙箱可被回收、无 Git 版本/协作）。
代码必须放在真正的 Git 仓库。

> 📌 CODING（`dev.tencent.com` / `coding.net`）正在下线：标准版 2025-09 停服、2028-09-30 全停，官方建议迁移到 **CNB（cnb.cool，云原生构建）**。
> 所以**别新建 CODING 仓库了**。可选：
> - **CNB（cnb.cool）**：腾讯生态新一代代码托管，免费，与 CloudStudio 同账号体系，迁移首选；
> - **GitHub**：全球标准，跨平台协作；
> - **Gitee**：国内访问快。
>
> CloudStudio 工作台内的代码也会保留，但仅作运行副本，不作为版本库。

关联远程并推送：
```bash
git remote add origin <仓库地址>     # 例如 https://cnb.cool/<你>/etsyops-workbench.git
git branch -M main
git push -u origin main
```

---

## 3. 部署到 CloudStudio（根目录，含后端）
直接部署 `etsyops/` 根目录（含 `package.json` + `server.js`），端口 `3000`。
由于零依赖，`npm install` 不会卡住，部署稳定。
- 部署完成后在「设置 - 数据管理 - 我发布的应用」可管理；
- 首次访问稍等几秒预热。

> 若你只想托管纯前端（不要公众号真实接口），也可部署 `dist/`（见 `npm run build:static`），但那种模式发布只能是模拟。

---

## 4. 🎯 真实绑定公众号（让"发布草稿箱"真正写入你的号）
工具页 `wechat-publisher.html` 会自动检测后端是否配置凭证：
- 已配置 → 「真实模式」，发布真实写入你公众号草稿箱；
- 未配置 → 「模拟模式」，仅演示流程。

### 4 步接通（一次性）
1. **准备公众号**：登录 [mp.weixin.qq.com](https://mp.weixin.qq.com)，需要**已认证公众号**（个人/企业认证均可创建草稿；
   正式群发 `freepublish` 需认证服务号）。未认证会报 `48001`。
2. **取凭证**：`设置与开发 → 基本配置` → 记下 **AppID**；点击「开发者密码(AppSecret)」启用/重置，得到 **AppSecret**（只显示一次，务必保存）。
3. **注入 CloudStudio 环境变量**（⚠️ 千万别写进代码或发到聊天里）：
   在 CloudStudio 该应用的环境变量里加：
   ```
   WECHAT_APPID=wx你的AppID
   WECHAT_APPSECRET=你的AppSecret
   ```
   改完**重启应用**使环境变量生效。工具页右上角会从「⚠ 未绑定·模拟」变成「✅ 已绑定真实公众号」。
4. **加 IP 白名单**（最常见失败原因）：
   在 `基本配置 → IP白名单` 加入**云端服务器出口 IP**。该 IP 工具页第③步会自动显示
   （打开工具页 → 发布草稿箱 → 文案里那串 `code` 就是），或调 `GET /api/wechat/ip` 查询。
   没加白名单会报 `40164 invalid ip`。云环境 IP 可能变动，报错时按提示补加即可。

### 然后正常用
打开工具页 → ① 上传文稿（md/txt/html/docx）或填飞书链接 → ② 选模板排版 →
③ **上传封面图**（真实发布必填，微信要求 `thumb_media_id`）+ 填作者/摘要 →「发布到草稿箱」。
后端会：上传封面为永久素材 → `draft/add` 写入草稿 → 返回真实 `media_id`。
去公众号后台「草稿箱」即可看到，确认后群发。

### 官方接口与报错对照
- 获取 token：`GET cgi-bin/token`（2h 有效，后端已缓存）
- 封面素材：`POST cgi-bin/material/add_material?type=image`（永久素材，返回 `media_id`）
- 草稿：`POST cgi-bin/draft/add`（返回 `media_id`）
- 正文图片也必须是 `mmbiz.qpic.cn` 域名（需先上传素材），外链图在微信内不显示。
- 报错：`40164` IP 未白名单｜`48001` 账号未认证/无权限｜`40007` 封面 media_id 无效｜`45009` 当日限额

---

## 5. 安全须知
- **AppSecret 只在服务端**，前端永远看不到；CloudStudio 环境变量方式注入，不入库、不聊天传输。
- 飞书文档真实拉取需接入「飞书」连接器并授权（当前工具页为演示拉取）。
- 正文含外链图片时，发布前请先上传为微信素材（本期未自动处理，属已知限制）。

---

## 6. 分支策略（团队协作）
- `main`：受保护，接生产（CloudStudio 部署源）。
- 日常 `feature/*` 开发，PR 评审合并 → CloudStudio 自动重新部署。

## 7. 当前已落地资源
- CloudStudio 线上链接（含后端，真实公众号可接通）：见最新部署返回的地址
- 资料库（SOP / 素材 / 交付归档）：https://www.workbuddy.cn/space/d/nKNS2kaUYoovmCnlil8Yc1
- 本地仓库：`etsyops/`（main 分支，已提交，待推远端 Git）
