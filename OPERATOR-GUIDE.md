# EtsyOps 后端操作人手册（Windows）

> 你是「团队操作人」。这份文档只给你看——照着做，就能让团队在 Cloudflare 上的工作台**真实发布文章到微信公众号**。
> 你只需要一台 **Windows 电脑保持开机 + 联网**。前端（网页）团队其他人任意设备都能开，不需要他们装任何东西。
>
> 前置条件（向工作台 owner 索取）：
> - 微信公众号的 **AppID** 和 **AppSecret**（在 mp.weixin.qq.com → 设置与开发 → 基本配置 拿）
> - 一个 **Cloudflare 账号**（owner 已有，Tunnel 在 owner 的 Cloudflare 里建，你只跑客户端）

---

## 第 1 步：安装 Node.js
1. 打开 https://nodejs.org ，下载 **LTS** 版（左边那个大按钮），双击安装，一路下一步。
2. 安装完，按 `Win + R` → 输入 `powershell` → 回车，执行：
   ```powershell
   node -v
   ```
   能看到 `v18.x` 或更高的版本号就 OK。看不到就重启一下电脑再试。

## 第 2 步：安装 cloudflared（Cloudflare 隧道客户端）
在刚才的 PowerShell（**用管理员身份打开**：开始菜单搜 PowerShell → 右键 → 以管理员身份运行）执行：
```powershell
winget install Cloudflare.cloudflared
```
装完验证：
```powershell
cloudflared --version
```
能看到版本号即可。（若 `winget` 不可用，去 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载 Windows 版手动安装。）

## 第 3 步：拿到代码
- 有 Git：在你想放的目录执行 `git clone git@github.com:1031582293-design/etsyops-workbench.git`
- 没 Git：去 https://github.com/1031582293-design/etsyops-workbench 点绿色 **Code → Download ZIP**，解压。

进入目录后会看到 `server.js`、`start-backend.bat`、`.env.example` 等文件。

## 第 4 步：填写凭证（.env）
1. 把 `.env.example` **复制一份**，改名为 `.env`（就在同一目录）。
2. 用记事本打开 `.env`，改成：
   ```env
   WECHAT_APPID=你的AppID
   WECHAT_APPSECRET=你的AppSecret
   API_KEY=一串你自己编的随机字符串（如 X7kP9qW2mT4nR8v）
   ```
   - 前两行向 owner 要（微信公众号后台拿）。
   - `API_KEY` 你自己随便编一长串，**记下来**——稍后要发给 owner 配到 Cloudflare。

## 第 5 步：建 Cloudflare Tunnel（拿稳定地址）
1. 打开 https://one.dash.cloudflare.com → 左侧 **Zero Trust**（免费注册一次）→ **Networks → Tunnels → Create a tunnel**。
2. 选 **Cloudflared** → 给隧道起名 `etsyops-backend` → 下一步。
3. 页面会显示一段安装命令，形如：
   ```
   cloudflared tunnel run --token eyJhIjoi...一长串...
   ```
   把里面 `--token` 后面**那整串**（从 `eyJ` 开始到结尾）复制出来。
4. 回到代码目录，新建一个文件 `tunnel-token.txt`，**只**把刚才那串 token 粘进去保存（不要换行、不要多余字符）。
   > ⚠️ 这个文件含隧道凭据，已被 .gitignore 忽略，不会进仓库，放心。

## 第 6 步：一键启动后端
**双击**目录里的 `start-backend.bat`。
- 会弹出两个最小化窗口：`EtsyOps-Backend`（Node 服务）和 `Cloudflare-Tunnel`（隧道）。
- 启动后回到 Cloudflare → Zero Trust → Tunnels → `etsyops-backend`，状态变 **Healthy**，并给出一个稳定地址，类似：
  ```
  https://xxxx-xxxx.cfargotunnel.com
  ```
  **把这个地址记下来，发给 owner**（他要在 Cloudflare Pages 里填）。

## 第 7 步：微信 IP 白名单（必做，否则发布报 40164）
1. 在你这台电脑的浏览器打开：
   ```
   https://<你的隧道地址>/api/wechat/ip
   ```
   页面会返回一段文字，里面有 `"ip":"1.2.3.4"` —— 记下这个 IP。
2. 去 mp.weixin.qq.com → 设置与开发 → 基本配置 → **IP 白名单** → 把上面那个 IP 加进去保存。
   - 如果提示格式，就填纯 IP（如 `1.2.3.4`），不要带端口。
   - **换网络 / 宽带重拨导致 IP 变了**时，重复这步（建议把家里、办公室等常用网络的 IP 都提前加进去，白名单最多 100 个）。

## 第 8 步：交给 owner 的两样东西
把下面两样发给工作台 owner，由他在 Cloudflare 控制台完成最后对接：
1. **隧道地址**：`https://xxxx-xxxx.cfargotunnel.com`
2. **API_KEY**：你在第 4 步编的那串

owner 会在 Cloudflare Pages 项目 `etsyops-workbench` 的 **Settings → Build & deployments → 环境变量** 里加：
- `WECHAT_API_BASE = <隧道地址>`
- `WECHAT_API_KEY = <API_KEY>`
然后重新部署。这一步你不用管。

---

## ✅ 验证（owner 或你都能测）
团队打开 `https://etsyops-workbench.pages.dev/wechat-publisher.html`：
- 顶部「绑定状态」显示 `✅ 已绑定真实公众号 xxxx****xxxx`
- 上传封面图 + 文稿 → 选模板排版 → 填作者/摘要 → 「发布到草稿箱」
- 去微信公众号后台 → 草稿箱，能看到刚发布的真实文章 ✅

## ⚠️ 日常维护
- **这台电脑不能关机、不能退出那两个窗口**，否则团队无法真实发布（网页仍能看，其他模块照用）。
- 发布突然报 `40164` → 第 7 步的出口 IP 变了，重加白名单即可。
- 想彻底不依赖某台电脑：让 owner 改用自有 VPS（见主文档 9.1-①）。

出问题把报错截图发给 owner 即可。
