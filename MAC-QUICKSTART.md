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
     >
     > ```bash
     > /bin/bash -c "$(curl -fsSL https://gitee.com/ineo6/homebrew-install/raw/master/install.sh)"
     > ```
     >
     > 装完若提示粘贴两行 `eval "$(...)"` 配置命令，**照提示复制贴进终端回车**（只此一次，让终端认识 `brew`）。
2. 装 cloudflared（**不要**用 `brew install`，它要从 github.com 拉，国内会超时）。下面这段**一次性整段复制粘贴**到终端回车即可——它会自动选架构、固定版本、依次试多个国内镜像，并且**先校验下到的是真二进制（gzip、>1MB）才安装**，避免再把坏文件装进系统：
   ```bash
   cd /tmp
   # 先清掉之前可能装错的"假 cloudflared"(它其实是网页, 不是程序)
   sudo rm -f /usr/local/bin/cloudflared
   rm -f /tmp/cloudflared /tmp/cf.tgz
   # 自动选架构 + 固定版本 2026.9.3 + 多镜像依次尝试
   ARCH=$(uname -m)
   BIN=cloudflared-darwin-amd64.tgz
   [ "$ARCH" = "arm64" ] && BIN=cloudflared-darwin-arm64.tgz
   VER=2026.9.3
   OK=""
   for M in \
     "https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/download/$VER/$BIN" \
     "https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/download/$VER/$BIN" \
     "https://ghproxy.com/https://github.com/cloudflare/cloudflared/releases/download/$VER/$BIN" \
     "https://gh.api.99988866.xyz/https://github.com/cloudflare/cloudflared/releases/download/$VER/$BIN" ; do
     echo ">> 尝试镜像: $M"
     curl -kL --max-time 60 -o /tmp/cf.tgz "$M" 2>/dev/null
     SZ=$(stat -f%z /tmp/cf.tgz 2>/dev/null || echo 0)
     if [ "$SZ" -gt 1000000 ] && file /tmp/cf.tgz | grep -q gzip; then
       echo ">> 成功, 文件大小: $SZ 字节"; OK=1; break
     else
       echo ">> 不是真二进制(大小 $SZ), 换下一个"; rm -f /tmp/cf.tgz
     fi
   done
   [ -z "$OK" ] && echo "!! 所有镜像都失败, 见下方『兜底方案』" && exit 1
   # 解压并安装
   tar -xzf /tmp/cf.tgz -C /tmp
   sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
   sudo chmod +x /usr/local/bin/cloudflared
   cloudflared --version
   ```
   > 说明：GitHub 上真实的文件名是带 **`.tgz`** 后缀的（之前漏写后缀才会下到一坨 HTML 错误页）。命令里已写对，且 `-kL` 跳过证书校验、自动跟重定向。看到版本号（如 `cloudflared version 2026.9.3`）即成功 ✅。  
   > **兜底方案（上面 4 个镜像全失败时才用）**：① 改用 `.pkg` 安装包——浏览器开 `https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-arm64.pkg`（Intel 芯片把 `arm64` 换成 `amd64`），若打不开就给它套个网页代理再下，下完双击安装即可；② 或把"隧道"改到 **Windows 操作人那台机器**做（网络通常更好），照 `OPERATOR-GUIDE.md` / DEPLOY.md 第 9.6 节来，本机就不用装 cloudflared。
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
   FEISHU_APP_ID=飞书自建应用AppID
   FEISHU_APP_SECRET=飞书自建应用AppSecret
   ```
   - 第 1–2 行填第 0 步拿到的微信凭证；
   - 第 3 行 `API_KEY` 你自己编任意一串（防陌生人乱发草稿，建议填）；
   - 第 4–5 行填**飞书企业自建应用**的凭证（用于「文稿收集」真实拉取飞书文档）。不填则飞书拉取不可用，但微信发布不受影响。飞书应用需开通「文档」读取权限并发布版本。
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

### 方案 B：稳定地址（团队长期使用，地址不变）✅ 推荐

> 这条用「Cloudflare Zero Trust 后台令牌」方式——**不用你自己的域名、不用 `cloudflared login`**，一条命令就拿固定地址。Windows 操作人也是同一套（见 OPERATOR-GUIDE.md 第 6 步）。

1. 浏览器开 <https://one.dash.cloudflare.com> → 左侧 **Zero Trust**（免费，首次会让你注册一次）→ **Networks → Tunnels → Create a tunnel**。
2. 选 **Cloudflared** → 隧道名填 `etsyops-backend` → 点下一步。
3. 页面会显示一段命令，形如：
   ```
   cloudflared tunnel run --token eyJhIjoi...一长串...
   ```
   把 `--token` **后面那整串**（从 `eyJ` 开头到结尾）全选复制下来。
4. 回到终端（在 `etsyops-workbench` 目录），把令牌存进文件，避免每次手敲：
   ```bash
   echo 'eyJ...把你复制的那整串粘这里...' > tunnel-token.txt
   ```
   > 这文件只存令牌、已被忽略不会进仓库，安全。
5. 起隧道（把本地 3000 暴露成公网地址）：
   ```bash
   cloudflared tunnel run --no-autupdate --token "$(cat tunnel-token.txt)" --url http://localhost:3000
   ```
   - 或图省事直接贴令牌：`cloudflared tunnel run --no-autoupdate --token eyJ...你的令牌... --url http://localhost:3000`
6. 约 10 秒后，回 Zero Trust → **Tunnels → etsyops-backend**，状态变 **Healthy**。
   > ⚠️ **注意：Healthy ≠ 有公网地址**。它只代表「你的电脑 ↔ Cloudflare」这条隧道通了。  
   > **要拿到稳定公网地址，还必须给隧道配一个「公共主机名」，而这需要你自己的域名**（操作见下）。
7. **配公共主机名（拿稳定地址的关键一步）**：
   - 前提：你有一个**已添加到 Cloudflare** 的域名（没有就花约 ¥9 买个 `.top`/`.xyz` 首年域名，任意注册商都行，然后 Cloudflare 控制台 →「添加站点」按提示把 DNS 托管过来，免费套餐即可）。
   - 回到隧道详情页 → 标签 **「Published application routes」（或 Public Hostname / 公共主机名）** → 点 **Add a published application route（添加）**：
     - **Subdomain（子域）**：`api`
     - **Domain（域）**：选你的域名
     - **Path**：留空
     - **Service Type（类型）**：`HTTP`
     - **URL**：`localhost:3000`
   - 保存后，你的**稳定公网地址**就是：
     ```
     https://api.你的域名
     ```
     **重启、换网络都不变**，这就是要填进 Cloudflare 环境变量 `WECHAT_API_BASE` 的地址。
   - ❌ 没有"添加公共主机名"这个入口/选项 → 说明你账号里没有域名，先完成上面的"前提"。

> 建议：先走方案 A 验证能跑通，再换方案 B 给团队用。  
> 💡 不想买域名？那就只能用方案 A 的临时地址（每次重启都变，团队没法长期用）。**「稳定地址」绕不开一个自己的域名**——这是 Cloudflare 的机制，不是操作问题。

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

（方案 B 就把地址换成第 6 步配好的 `https://api.你的域名`）

- 顶部「绑定状态」显示 `✅ 已绑定真实公众号` → 上传封面+文稿 → 发布到草稿箱 → 去公众号后台草稿箱能看到真实文章 = 成功！

### 正式给全团队用（设一次，地址稳定后）

1. 浏览器开 Cloudflare → **Workers & Pages** → `etsyops-workbench` → **Settings → Build & deployments → 环境变量(Environment variables)**。
2. 点 **Add variable**（生产环境 Production）：
   - 变量名 `WECHAT_API_BASE`，值 = 你的隧道地址（方案 B 如 `https://api.你的域名`；方案 A 则每次重启都要改）
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
