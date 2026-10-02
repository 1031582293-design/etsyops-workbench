# Mac 傻瓜式操作手册：把 etsyops-workbench.pages.dev 变成真实工作台

> 目标：让你 Mac 跑起后端 + 一条免费隧道，使线上 `https://etsyops-workbench.pages.dev` 能**真实发布公众号草稿箱 + 拉真实数据**。  
> 适合：完全不懂命令的人，照着复制粘贴即可。每一步都写明了"复制什么 / 粘贴到哪 / 你会看到什么"。  
> 预计耗时：第一次约 15–20 分钟（装工具较慢），之后每次开机只需 1 条命令。

---

## 0. 先准备两样"原料"（只有你有）

- **A. 微信 AppID 和 AppSecret**：登录 <https://mp.weixin.qq.com> → 左侧「设置与开发」→「基本配置」→ 开发者ID(AppID) 直接能看到；开发者密码(AppSecret) 点「重置」后**只显示一次**，马上抄下来。
- **B. 一个 Cloudflare 账号**：你已有（etsyops-workbench 就部署在那）。隧道功能在 **Zero Trust**（免费）里。

---

## 1. 打开"终端"（你输入命令的窗口）

- 同时按 `Command(⌘) + 空格`，输入 `终端`（或 `Terminal`），回车。
- 出来一个白底/黑底窗口，光标在闪，就是它。**后面所有"复制粘贴"都粘到这里，然后按回车**。

---

## 2. 装 Node.js（后端运行环境）

1. 浏览器开 <https://nodejs.org> （中文界面）→ 点绿色 **LTS 长期支持版** 下载（.pkg 文件）。
2. 双击下载的文件 → 一路「继续 / 同意 / 安装」→ 输 Mac 开机密码 → 完成。
3. 回到终端，粘贴下面这行，回车：
   ```bash
   node -v
   ```
   ✅ 看到类似 `v22.12.0` 的版本号 = 装好了。❌ 报错 `command not found` = 重装一遍。

---

## 3. 装 cloudflared（免费隧道工具）

1. 先确认有没有 Homebrew（Mac 的软件管理器）。终端粘贴：
   ```bash
   brew --version
   ```
   - 若显示版本号 → 跳到第 3 步。
   - 若报错 → 先装 Homebrew：终端粘贴下面整段，回车，等几分钟（可能要输密码）：
     ```bash
     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
     ```
     > 🇨🇳 **国内网络坑**：若报错 `curl: (35) Recv failure: Connection reset by peer` 或一直卡住，说明 `raw.githubusercontent.com` 连不上。改用 **Gitee 镜像安装脚本**（国内可达，且会自动配好清华/中科大镜像，之后 `brew install` 也快）：
     > ```bash
     > /bin/bash -c "$(curl -fsSL https://gitee.com/ineo6/homebrew-install/raw/master/install.sh)"
     > ```
     > 装完若提示粘贴两行 `eval "$(...)"` 配置命令，**照提示复制贴进终端回车**（只此一次，让终端认识 `brew`）。
2. 装 cloudflared（**不要**用 `brew install`，它要从 github.com 拉，国内会超时）：
   ```bash
   cd /tmp
   ARCH=$(uname -m); BIN=cloudflared-darwin-amd64; [ "$ARCH" = "arm64" ] && BIN=cloudflared-darwin-arm64
   curl -L -o cloudflared "https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN"
   chmod +x cloudflared
   sudo mv cloudflared /usr/local/bin/
   cloudflared --version
   ```
   > 走的是 **ghproxy 国内镜像**（代理 GitHub 下载），不直连 github.com。若 `ghproxy.net` 抽风，把上面链接里的 `https://ghproxy.net/` 换成 `https://ghproxy.com/` 或 `https://mirror.ghproxy.com/` 再试。
   > ⚠️ 若报 `SSL certificate problem: self signed certificate`，二选一：① 把链接开头的 `https://` 改成 `http://`（即 `http://ghproxy.net/https://...`）；② 或给 curl 加 `-k`：`curl -kL -o cloudflared "https://ghproxy.net/https://github.com/.../$BIN"`（跳过证书校验，仅本地下载用）。
   > 看到版本号（如 `cloudflared version 2024.x.x`）即成功 ✅。
3. 验证：
   ```bash
   cloudflared --version
   ```
   ✅ 显示版本号 = 好了。

---

## 4. 把项目弄到 Mac 上

> 🇨🇳 **国内网络坑**：你 Mac 直连 `github.com` 不通（clone / raw 都会超时）。项目代码改用 **Gitee 镜像仓库**下载（代码同步到 90e0b27，功能完整；仅少一次文档微调，不影响运行）。代码主库仍是 GitHub，等网络通畅再切回。

1. 选一个放代码的地方，比如"下载"文件夹。终端粘贴：
   ```bash
   cd ~/Downloads
   ```
2. 用 Gitee 下载项目（公开仓库，不用账号密码）：
   ```bash
   git clone https://gitee.com/fu-po-fa-cai/etsyops-workbench.git
   ```
3. 进目录：
   ```bash
   cd etsyops-workbench
   ```
   ✅ 之后所有命令都在 `etsyops-workbench` 这个文件夹里跑。

---

## 5. 填微信凭证（.env 文件）

1. 先复制一个模板：
   ```bash
   cp .env.example .env
   ```
2. 用记事本打开它（会弹出"文本编辑"程序）：
   ```bash
   open -e .env
   ```
3. 你会看到几行，把对应的值改成你自己的（**等号后面别留空格**）：
   ```
   WECHAT_APPID=wx1234567890abcdef
   WECHAT_APPSECRET=你的AppSecret抄在这里
   API_KEY=随便打一串字母数字例如 abcd1234efgh5678
   ```
   - 第 1–2 行填第 0 步拿到的微信凭证；
   - 第 3 行 `API_KEY` 你自己编任意一串（防陌生人乱发草稿，建议填）。
4. 按 `Command+S` 保存，关掉窗口。

---

## 6. 起隧道，拿到一个公网地址（二选一）

### 方案 A：最快测试（1 条命令，地址每次重启会变）

终端粘贴（确保你还在 `etsyops-workbench` 目录）：

```bash
cloudflared tunnel --url http://localhost:3000
```

- 它会滚几行字，最后出现一行类似：
  ```
  INF + https://xxxx.trycloudflare.com  <- 你的隧道地址
  ```
- **复制这个 `https://xxxx.trycloudflare.com`**（下面要用）。这是你 Mac 后端的公网入口。
- ⚠️ 这个窗口**不要关**。关了隧道就断。

### 方案 B：稳定地址（团队长期使用，地址不变）

1. 登录 Cloudflare（浏览器）：
   ```bash
   cloudflared tunnel login
   ```
   自动开网页 → 选你的账号 → 授权。
2. 建一个命名隧道：
   ```bash
   cloudflared tunnel create etsyops-backend
   ```
   屏幕会显示一个 **隧道 ID**（一长串字母数字），抄下来。
3. 起隧道（把 `隧道ID` 换成上一步那串）：
   ```bash
   cloudflared tunnel run --url http://localhost:3000 隧道ID
   ```
4. 你的稳定地址是：`https://隧道ID.cfargotunnel.com`（把 `隧道ID` 换成你的）。
   - ⚠️ 这个窗口**不要关**。

> 建议：先走方案 A 验证能跑通，再换方案 B 给团队用。

---

## 7. 启动后端（另开一个终端窗口）

> 第 6 步的终端在跑隧道，**别动它**。点终端顶部「壳」→「新建窗口」（或 `Command+N`）开第二个终端。

1. 进目录：
   ```bash
   cd ~/Downloads/etsyops-workbench
   ```
2. 启动后端：
   ```bash
   npm start
   ```
   - ✅ 看到 `wechat proxy: ON` = 凭证读到了，后端已连微信。
   - ❌ 看到 `wechat proxy: OFF` = 第 5 步 `.env` 没填对，回去检查。
3. 这个窗口也**不要关**。

现在你的 Mac 上：一个窗口跑隧道、一个窗口跑后端，后端已经通过隧道暴露到公网了。

---

## 8. 让线上站点指向你的后端

### 立刻测试（不动 Cloudflare 设置）

浏览器开（把地址换成你第 6 步拿到的）：

```
https://etsyops-workbench.pages.dev/wechat-publisher.html?api=https://xxxx.trycloudflare.com
```

（方案 B 就把 `xxxx.trycloudflare.com` 换成 `隧道ID.cfargotunnel.com`）

- 顶部「绑定状态」显示 `✅ 已绑定真实公众号` → 上传封面+文稿 → 发布到草稿箱 → 去公众号后台草稿箱能看到真实文章 = 成功！

### 正式给全团队用（设一次，地址稳定后）

1. 浏览器开 Cloudflare → **Workers & Pages** → `etsyops-workbench` → **Settings → Build & deployments → 环境变量(Environment variables)**。
2. 点 **Add variable**（生产环境 Production）：
   - 变量名 `WECHAT_API_BASE`，值 = 你的隧道地址（如 `https://隧道ID.cfargotunnel.com`）
   - 再添加一个 `WECHAT_API_KEY`，值 = 第 5 步你编的那串
3. 保存 → 回到项目页点 **Deployments → 最新一次 → Retry deployment**（或随便 push 一次 GitHub 触发重建）。
4. 部署完，团队直接开 `https://etsyops-workbench.pages.dev` 就是真实工作台了（不再需要 `?api=`）。

---

## 9. 微信 IP 白名单（不做会报 40164 发不出去）

1. 浏览器开（地址换成你的）：
   ```
   https://xxxx.trycloudflare.com/api/wechat/ip
   ```
   屏幕返回一段文字，里面有 `"ip":"1.2.3.4"` → 抄下这个 IP。
2. 去 mp.weixin.qq.com → 设置与开发 → 基本配置 → **IP 白名单** → 添加 → 粘贴 `1.2.3.4` → 保存。
3. ⚠️ 你的 Mac **换网络 / 宽带重新拨号**后这个 IP 会变 → 重新做第 9 步（可提前把常用几个网络 IP 都加进去，微信白名单最多 100 个）。

---

## 10. 日常开关机

- **开机想让团队能真实发布**：重复第 6 步（隧道）+ 第 7 步（后端），两个窗口都开着即可。
- **关机 / 合盖 / 关那两个窗口**：团队暂时不能"真实发布"（前端照常能看、其他模块照用）。
- 长期更稳可选：自有 VPS（付费，IP 固定，详见 DEPLOY.md 9.1）。

---

## 排错速查

| 现象                               | 原因              | 处理                               |
| -------------------------------- | --------------- | -------------------------------- |
| `node: command not found`        | Node 没装好        | 重做第 2 步                          |
| `cloudflared: command not found` | cloudflared 没装好 | 重做第 3 步                          |
| `wechat proxy: OFF`              | .env 没填对        | 重做第 5 步，确认保存                     |
| 发布报 `40164`                      | 微信白名单 IP 不对     | 重做第 9 步                          |
| 发布报 `401`                        | API_KEY 不符      | 确认 .env 与 Cloudflare 变量里的 key 一致 |
| 前端打不开后端                          | 隧道窗口关了 / Mac 睡了 | 重开第 6、7 步                        |
