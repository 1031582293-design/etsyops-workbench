# Windows 傻瓜式操作手册：让团队工作台能真实发布公众号

> 你是「团队操作人」。这份文档**只给你看**——照着复制粘贴，就能让团队在 Cloudflare 上的
> `https://etsyops-workbench.pages.dev` **真实发布文章到微信公众号 + 看到真实数据**。
> 你只需要一台 **Windows 电脑保持开机 + 联网**。团队其他人用网页就行，不用装任何东西。
>
> 预计耗时：第一次约 15–25 分钟（装工具慢），之后每次开机只要双击一个文件、等 10 秒。
> 适合完全不懂命令的人，每一步都写了"复制什么 / 粘贴到哪 / 你会看到什么 / 错了怎么办"。

---

## 0. 先准备几样"原料"（向老板要，或自己有）
- **A. 微信 AppID 和 AppSecret**：老板给，或你自己去 https://mp.weixin.qq.com → 左侧「设置与开发」→「基本配置」拿。
- **B. 一个 Cloudflare 账号**：建隧道用。如果你**没有** Cloudflare 权限，跳过第 6 步，让老板把"隧道 token"发你（见第 6 步说明）。
- **C. API_KEY（你自己编）**：随便想一长串字母数字，例如 `X7kP9qW2mT4nR8vZ3bC5`，**记下来**——第 8 步要发给老板。

---

## 1. 打开"PowerShell"（你输入命令的窗口）
- 按 `Win + R` 键 → 输入 `powershell` → 回车。
- 出来一个蓝底窗口，光标在闪，这就是它。**所有"复制粘贴"都粘到这里，然后按回车**。
- 有些安装步骤需要管理员权限：开始菜单搜 `PowerShell` → 右键 → **以管理员身份运行**。
  （普通窗口也能开，只是装软件时若报"拒绝访问"就用管理员窗口重来。）

---

## 2. 装 Node.js（后端运行环境）
1. 浏览器开 https://nodejs.org → 点 **LTS 长期支持版** 那个大绿色按钮下载（得到 `.msi` 文件）。
2. 双击下载的文件 → 一路「Next / 同意 / Install」→ 完成。
3. 回到刚才的 PowerShell，粘贴这行，回车：
   ```powershell
   node -v
   ```
   ✅ 看到类似 `v18.19.0` 或更高的版本号 = 装好了。
   ❌ 报错 `node : 无法识别` = 重装一遍，或重启电脑再试。

---

## 3. 装 cloudflared（免费隧道工具）
1. 在 **管理员身份** 的 PowerShell 里粘贴：
   ```powershell
   winget install Cloudflare.cloudflared
   ```
   等它跑完（可能要几分钟，最后出现"已成功安装"）。
2. 验证：
   ```powershell
   cloudflared --version
   ```
   ✅ 显示版本号 = 好了。
   ❌ 若 `winget` 不可用（老系统），去 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载 Windows 版（`.msi`），双击安装。

---

## 4. 把项目弄到这台电脑上
> 项目在 GitHub 公开仓库，直接下载即可（不用账号）。
- **有 Git**（可选）：在你放代码的目录（比如桌面）右键"在终端中打开"，执行：
  ```powershell
  git clone https://github.com/1031582293-design/etsyops-workbench.git
  ```
  然后 `cd etsyops-workbench` 进目录。
- **没 Git（更简单）**：浏览器开 https://github.com/1031582293-design/etsyops-workbench → 点绿色 **Code** → **Download ZIP** → 解压到桌面。
  打开解压后的文件夹，会看到 `server.js`、`start-backend.bat`、`.env.example` 等文件。

> 💡 下面第 5–9 步，假设你就在 `etsyops-workbench` 这个文件夹里操作（资源管理器打开它即可）。

---

## 5. 填微信凭证（.env 文件）
1. 在文件夹里，找到 `.env.example` → **右键复制 → 粘贴**，把副本改名为 `.env`
   （改不了名就：`右键 → 打开方式 → 记事本`，另存为 `.env`）。
2. 用**记事本**打开 `.env`，内容改成下面这样（**等号后面别留空格**）：
   ```env
   WECHAT_APPID=老板给的AppID
   WECHAT_APPSECRET=老板给的AppSecret
   API_KEY=X7kP9qW2mT4nR8vZ3bC5
   ```
   - 第 1–2 行填第 0 步拿到的微信凭证；
   - 第 3 行 `API_KEY` 填你自己编的那串（第 0 步 C），**记下来**。
3. `Ctrl+S` 保存，关掉记事本。

---

## 6. 准备 Cloudflare Tunnel（拿一个稳定公网地址）

### 情形一：你**有** Cloudflare 账号权限（自己建）
1. 浏览器开 https://one.dash.cloudflare.com → 左侧 **Zero Trust**（免费注册一次）→ **Networks → Tunnels → Create a tunnel**。
2. 选 **Cloudflared** → 隧道名填 `etsyops-backend` → 下一步。
3. 页面会显示一段命令，形如：
   ```
   cloudflared tunnel run --token eyJhIjoi...一长串...
   ```
   把 `--token` **后面那整串**（从 `eyJ` 开始到结尾）全选复制。
4. 回到 `etsyops-workbench` 文件夹，新建一个文件叫 `tunnel-token.txt`，
   **只**把那串 token 粘进去 → 保存（不要换行、不要多余空格）。

### 情形二：你**没有** Cloudflare 权限（老板发你）
- 老板会把一段 `eyJ...` 开头的 token 发给你 → 在 `etsyops-workbench` 文件夹新建 `tunnel-token.txt`，
  把那段粘进去保存即可。这一步你不用登录 Cloudflare。

> ⚠️ `tunnel-token.txt` 含隧道凭据，已被忽略、不会进仓库，安全。

---

## 7. 一键启动后端（双击即可）
1. 在 `etsyops-workbench` 文件夹里，**双击 `start-backend.bat`**。
2. 会弹出两个小窗口：
   - `EtsyOps-Backend`（Node 后端服务）
   - `Cloudflare-Tunnel`（隧道）
   让它们**最小化但别关**。
3. 等约 10 秒，回到 Cloudflare → Zero Trust → Tunnels → `etsyops-backend`，
   状态变成 **Healthy**，并给出一个稳定地址，类似：
   ```
   https://xxxx-xxxx.cfargotunnel.com
   ```
   **把这个地址复制下来**（下面第 8 步要发给老板）。

> 如果双击没反应：在文件夹空白处 `Shift+右键 → 在此处打开 PowerShell`，
> 执行 `.\start-backend.bat` 看报错。常见是 Node 没装好（重做第 2 步）。

---

## 8. 把两样东西发给老板
打开微信/聊天，把下面两样发给工作台老板（他来接 Cloudflare）：
1. **隧道地址**：`https://xxxx-xxxx.cfargotunnel.com`（第 7 步拿的）
2. **API_KEY**：你第 5 步编的那串（如 `X7kP9qW2mT4nR8vZ3bC5`）

老板会在 Cloudflare Pages 项目 `etsyops-workbench` 的
**Settings → Build & deployments → 环境变量** 里加：
- `WECHAT_API_BASE = <隧道地址>`
- `WECHAT_API_KEY = <API_KEY>`
然后重新部署。这一步**你不用管**，等老板说"好了"即可。

---

## 9. 微信 IP 白名单（必做，否则发布报 40164）
1. 在这台电脑的浏览器，打开（把地址换成你第 7 步的）：
   ```
   https://xxxx-xxxx.cfargotunnel.com/api/wechat/ip
   ```
   页面返回一段文字，里面有 `"ip":"1.2.3.4"` —— 抄下这个 IP。
2. 去 https://mp.weixin.qq.com → 设置与开发 → 基本配置 → **IP 白名单** → 添加 `1.2.3.4` → 保存。
   - 只填纯 IP，不带端口。
   - ⚠️ **这台电脑换网络 / 宽带重拨**后 IP 会变 → 重新做这步（建议把家里、办公室等常用 IP 都提前加进去，白名单最多 100 个）。

---

## 10. 日常开关机
- **开机想让团队能真实发布**：双击 `start-backend.bat`，两个窗口开着即可（约 10 秒变 Healthy）。
- **关机 / 退出那两个窗口**：团队暂时不能"真实发布"（前端照常能看、其他模块照用）。
- 长期更稳可选：让老板改用自有 VPS（付费，IP 固定，详见主文档 9.1）。

---

## ✅ 验证（老板或你都能测）
团队打开 `https://etsyops-workbench.pages.dev/wechat-publisher.html`：
- 顶部「绑定状态」显示 `✅ 已绑定真实公众号 xxxx****xxxx`
- 上传封面图 + 文稿 → 选模板排版 → 填作者/摘要 → 「发布到草稿箱」
- 去微信公众号后台 → 草稿箱，能看到刚发布的真实文章 ✅

---

## 排错速查
| 现象 | 原因 | 处理 |
|---|---|---|
| `node : 无法识别` | Node 没装好 | 重做第 2 步，或重启电脑 |
| `cloudflared : 无法识别` | cloudflared 没装好 | 重做第 3 步（用管理员 PowerShell） |
| 双击 bat 没反应 | Node 不在 PATH | 重做第 2 步；或 Shift+右键在此处打开 PowerShell 跑 `.\start-backend.bat` 看报错 |
| Tunnel 状态一直不是 Healthy | token 错了 / 网络不通 | 重做第 6 步，确认 `tunnel-token.txt` 内容完整无换行 |
| 发布报 `40164` | 微信白名单 IP 不对 | 重做第 9 步，换网络后重加 |
| 发布报 `401` | API_KEY 不符 | 确认你 `.env` 里的 key 和发给老板的一致 |
| 前端打不开后端 | 两个窗口关了 / 电脑睡了 | 重开第 7 步 |

出问题把报错截图发给老板即可。
