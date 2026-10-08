# 电商运营工作台 · 搭建总结

> **本文按日期追加章节**（第一章是 10-02，最新进展见第十章 2026-10-07）。
> 每章记录该阶段**已完成的搭建步骤**，未完成的留作「下一步待办」。
> 配套文档：`OPERATOR-GUIDE.md`（操作人 Windows 傻瓜指引）、`MAC-QUICKSTART.md`（Mac 傻瓜指引）、`DEPLOY.md`（总部署文档）、`PITFALLS.md`（坑与避坑清单）。

## 章节索引

| 章 | 日期 | 内容 |
|---|---|---|
| 零~七 | 10-02 | 整体架构、前端上线、Gitee 镜像、隧道准备、账号账本 |
| 八 | 10-05 | 工作台四步流、AI 生稿、稳定地址打通 |
| 九 | 10-06 | 稳定性改造、AI 生稿根因修复、部署通道厘清 |
| **十** | **10-07** | **★ Etsy Open API v3 全链路打通 + 工作流重排为七步** |

---

## 零、整体架构与数据流（一图看懂）

本项目分"前端"和"后端"两部分，中间用**免费隧道**打通。谁和谁说话，看这张图：

```
团队浏览器
   │ 打开 https://etsyops-workbench.pages.dev （静态前端，Cloudflare 免费托管，推代码自动更新）
   ▼
[ 前端 html / js ]  ←── 代码来自 GitHub，推一次自动更新
   │  要发稿 / 拉数据 / 拉飞书文稿 时，调用 API_BASE
   ▼  经 Cloudflare Tunnel（公网稳定地址 https://api.你的域名）
[ 操作人 Windows 电脑 ]
   │  server.js（零依赖 Node 后端）+ cloudflared 隧道，长期开机运行
   ├──► 微信公众平台 API   发草稿箱 / 拉公众号数据   （需 AppID+AppSecret + IP 白名单）
   └──► 飞书开放平台 API   拉取飞书文档正文          （需飞书自建应用凭证）
```

一句话：**前端在云上（免费、自动更新），后端在同事电脑上（免费、需长期开机），用隧道连起来；微信/飞书才是真正的业务数据来源。**

### 角色分工（谁做什么）

| 角色 | 机器 | 负责的事 | 不负责的事 |
|---|---|---|---|
| **你（老板）** | Mac | 写/推前端代码到 GitHub；Cloudflare 前端部署与配环境变量；申请微信/飞书账号与凭证；买域名并绑 Cloudflare；最终验收 | 不在 Mac 跑后端（装不上 cloudflared + 网络受限） |
| **操作人** | Windows | 装 Node + cloudflared；填 `.env`（微信+飞书凭证）；双击 `start-backend.bat` 起后端+隧道；把"稳定地址 + API_KEY"发你 | 不改前端、不碰 Cloudflare 部署 |

> 关键认知：**Cloudflare Pages 只能放静态网页，跑不了 Node 后端**。所以"调微信接口、存 AppSecret、给前端发真实数据"必须在一台真在运行的电脑上（操作人 Windows）。又因为微信要求调用方是固定公网 IP 且加白名单，这台电脑得长期开机——免费 Tunnel 正好解决"暴露公网"这环。

### 为什么不走"WorkBuddy 自带沙箱发布"，而选了托管方式？

WorkBuddy 自带"沙箱发布"能力（如 CloudStudio 等，把静态站一键发到云端沙箱、给一个分享链接）。本项目**没有用沙箱**，而是选了"Cloudflare Pages 前端 + 操作人 Windows 后端 + 隧道"的托管方式。两种方案对比：

| 维度 | 方案 A：WorkBuddy 自带沙箱发布 | 方案 B：托管方式（本项目选用） |
|---|---|---|
| **怎么用** | 在对话里一键把前端发到云端沙箱，立刻得分享链接 | 前端丢 GitHub→Cloudflare Pages 自动部署；后端在操作人 Windows 跑 `server.js`+隧道 |
| **门槛** | 极低：不用买域名、不用装 cloudflared、不用一台常开电脑 | 较高：要买域名(¥9/年)、装 cloudflared、配 Zero Trust、操作人电脑长期开机 |
| **能跑后端吗** | 否：通常只托管静态前端(HTML/JS)，跑不了常驻的 Node 后端 `server.js` | 是：后端在操作人电脑常驻，能真实调微信/飞书接口 |
| **地址稳不稳** | 注意：分享链接可能随部署/过期变化，不适合团队长期记一个地址 | 是：配自有域名后是 `https://api.你的域名`，长期不变 |
| **微信 IP 白名单** | 否：沙箱出口 IP 不固定，微信白名单加不上 | 是：隧道出口 IP 固定，可加微信白名单 |
| **凭证/密钥存放** | 否：没有常驻服务端，AppSecret 无处落地运行 | 是：凭证放操作人电脑 `.env`，后端运行时读取 |
| **成本** | 免费（沙箱资源有限） | 免费（仅域名 ¥9/年 + 微信认证 ¥300/年） |
| **依赖** | 依赖平台沙箱在线 | 依赖操作人电脑长期开机 |

**为什么本项目选 B（托管方式）**：本工作台的核心价值是"真实业务联动"——一键把飞书文稿发成微信草稿、从微信拉真实粉丝/阅读数据。这要求一个**常驻运行、地址稳定、出口 IP 固定**的后端来跑 `server.js`、存 AppSecret、过微信白名单。沙箱只托管静态页面，给不了常驻后端，因此满足不了核心需求。换句话说：**沙箱能让你"看到界面"，托管方式能让你"真把活干成"**。

**什么情况该用沙箱（方案 A）**：门槛低、不用自己的机器和域名，适合——
- 快速预览 UI 效果、给客户/同事演示页面长什么样；
- 内部临时评审、单人短期试用；
- 还不需要真实后端 / 真实数据，只想看前端交互的阶段。

**什么情况该用托管方式（方案 B）**：需要"真干活"且想零服务器费，适合——
- 要真实后端接口联动（发草稿到微信、拉飞书文稿、取真实数据）；
- 团队长期使用，需要稳定不变的地址；
- 想免 VPS 服务器费，接受"操作人电脑常开"这个代价。

> 一句话总结：**看界面用沙箱，干真活用托管**。本项目因为要做微信/飞书真实联动，所以走托管；若你只想先给老板看个页面雏形，完全可以先沙箱发一版，不耽误事。

---

## 一、今天已经搭好的（已完成步骤）

### 1. 前端站点已上线
- 代码主库放在 **GitHub**（`1031582293-design/etsyops-workbench`，main 分支）。
- **Cloudflare Pages** 连了 GitHub，推代码就**自动部署**，线上地址：`https://etsyops-workbench.pages.dev`（已验证可访问）。
- 含义：以后你改前端（html/界面/数据展示），推 GitHub 即自动更新，**不用碰操作人电脑**。

### 2. 代码自动镜像到 Gitee（国内可下载）
- 恢复了 **GitHub → Gitee 自动同步**：你从 Mac/沙箱推 GitHub，会经 **GitHub Actions**（用仓库密钥 `GITEE_TOKEN`）自动镜像到 Gitee（`fu-po-fa-cai/etsyops-workbench`）。
- 操作人从 Gitee 下代码，拿到的就是最新版（不用连 GitHub）。
- 提交记录：`2ac0978` → `6889159b` → `fa1e5b3` → `9453f32` → `8b9794a`，每一步都验证 Gitee 已同步。

### 3. 飞书文稿真实拉取（当前未启用——代码已移除，留作未来参考）
- 后端 `server.js` 原 `/api/feishu/fetch`（真实调飞书接口取文档正文，支持 docx / wiki / 旧版 doc）与前端"拉取"按钮，已在本次调整中**暂时移除**。
- 当前「文稿收集」仅支持本地文件（md / txt / html / docx）上传。
- 若后续整个工作台用飞书较多，再按 `OPERATOR-GUIDE.md` 第 11 步重新接入（原提交 `fa1e5b3` 保留历史实现）。

### 4. 操作人指引补齐 + 后端一键更新
- `OPERATOR-GUIDE.md` 新增：第 11 步「飞书自建应用怎么申请」、第 12 步「后端代码怎么更新」。
- `start-backend.bat` 改成**启动即自动 `git pull`**——操作人开机双击一次就自动拿最新代码。
- 提交：`9453f32`。

### 5. 隧道工具准备（操作人侧，已装好并跑通连接）
- 修正了文档里两处错误（`cloudflared` 下载文件名漏 `.tgz`、隧道"稳定地址"写法错误）。
- 操作人 Windows 电脑已装 `cloudflared`，在 Cloudflare Zero Trust 建了命名隧道 `etsyops-backend`，状态 **Healthy**（连上了）。
- **待完成**：给隧道配一个"公共主机名"（需要你买一个自有域名绑到 Cloudflare），才能拿到团队长期用的稳定地址。详见 `PITFALLS.md` 第 7 条。

---

## 二、搭建的前置条件 / 需要取得的凭证

| 需要什么 | 用途 | 怎么取得 | 状态 |
|---|---|---|---|
| **微信认证服务号 AppID + AppSecret** | 真实发布草稿、拉取公众号数据 | mp.weixin.qq.com → 设置与开发 → 基本配置 | 需你提供（核心） |
| **微信 IP 白名单配置权** | 后端出口 IP 要加白，否则调接口报 40164 | 同上页面 → IP 白名单 | 待隧道起来后配 |
| **飞书企业自建应用 AppID + AppSecret** | 真实拉取飞书文稿 | open.feishu.cn → 开发者后台建应用（需建在**文稿所在飞书企业**内） | 推荐老板/文档所有者建（同企业+有开发者权限即可）；操作者仅填凭证 |
| **飞书应用"文档读取"权限 + 发布版本** | 否则拉不到文档 | 应用内"权限管理"勾 doc/drive/wiki 只读 + "版本管理"发布 | 同上 |
| **Cloudflare 账号** | 托管前端(Pages) + 隧道(Zero Trust)，均免费 | 注册即用 | ✅ 已有 |
| **一个自有域名（.top/.xyz，约 ¥9/年）** | 给隧道配公共主机名，拿到稳定地址 | 任意域名注册商（腾讯云/阿里云等）购买 | ⚠️ 待买（卡点） |
| **GitHub 账号** | 代码主库 + 自动部署触发 | 已有 | ✅ |
| **Gitee 账号** | 国内代码镜像，操作人下载用 | 已有 | ✅ |
| **API_KEY（自己编的一串）** | 防护公开隧道被滥用 | 随便编，如 `X7kP9qW2mT4nR8vZ3bC5` | 操作人编 |
| **操作人 Windows 电脑（长期开机）** | 跑后端 `server.js` + 隧道 | 已有 | ✅ 在准备 |
| **Node.js（操作人电脑装）** | 跑后端 | nodejs.org 或国内镜像 | 操作人装 |
| **cloudflared（操作人电脑装）** | 隧道工具 | 已修正下载方式 | ✅ 已装 |

> 一句话：真正"要你去拿"的，主要是**微信认证服务号凭证**和**一个便宜域名**；飞书凭证让操作人按第 11 步申请即可。

---

## 三、涉及的平台 / App / 网站 及各自作用

| 平台 / 工具 | 在本项目里做什么 | 是否必需 |
|---|---|---|
| **GitHub** | 代码主仓库；推代码触发 Cloudflare 自动部署 | 必需（前端部署核心） |
| **Gitee** | GitHub 的国内镜像；操作人电脑下载代码用（直连 GitHub 不通） | 必需（国内下载通道） |
| **Cloudflare Pages** | 托管前端静态站（pages.dev），自动部署 | 必需 |
| **Cloudflare Zero Trust / Tunnel** | 把操作人电脑的后端免费暴露到公网（稳定地址靠它+域名） | 必需（免费后端入口） |
| **Cloudflare DNS / 域名** | 把你买的域名接进 Cloudflare，给隧道配公共主机名 | 必需（拿稳定地址） |
| **微信公众平台** (mp.weixin.qq.com) | 真实发布草稿、拉取公众号数据；需 AppID/Secret | 必需（业务核心） |
| **飞书开放平台** (open.feishu.cn) | 建企业应用，给"文稿收集"真实拉取飞书文档的能力 | 必需（工作流第①步） |
| **WorkBuddy 飞书连接器** | 已授权，提供取飞书文档的底层能力 | 已接 |
| **操作人 Windows 电脑** | 后端 `server.js` + 隧道的长期运行宿主 | 必需（IP 稳定可白名单） |
| **Node.js** | 运行后端 `server.js`（零依赖，不用 npm install） | 必需 |
| **cloudflared** | 隧道客户端 | 必需 |
| **域名注册商**（腾讯云/阿里云等） | 买 .top/.xyz 域名（¥9/年） | 必需（拿稳定地址） |
| **GitHub Actions** | 推 GitHub 后自动镜像到 Gitee（用 `GITEE_TOKEN` 密钥） | 已配 |

---

## 四、下一步待办（今天没做完的，搭好再补文档）

1. 买一个自有域名 → 加到 Cloudflare → 隧道配"公共主机名" `api.你的域名` → 拿到稳定地址。
2. 操作人 `.env` 填好微信 + 飞书凭证，双击 `start-backend.bat` 启动。
3. 你把稳定地址 + API_KEY 填进 Cloudflare Pages 的环境变量（`WECHAT_API_BASE` / `WECHAT_API_KEY`），重部署。
4. 微信后台把隧道出口 IP 加进白名单（否则报 40164）。
5. 在 pages.dev 验证：状态显示"飞书已授权 / 微信已授权"，媒体矩阵出真实数据、飞书能真实拉稿。

---

## 五、进度看板（各组件现在的状态）

| 组件 | 状态 | 说明 |
|---|---|---|
| 前端 (pages.dev) | ✅ 已上线 | 静态站可访问，推 GitHub 自动更新 |
| 代码同步 (GitHub→Gitee) | ✅ 已通 | Actions 自动镜像，约 10–30s |
| 飞书拉取（代码层） | ✅ 已接 | 待操作人填飞书凭证即生效 |
| 操作人指引 | ✅ 已齐 | 含飞书申请 + 后端更新步骤 |
| cloudflared 安装 | ✅ 操作人已装 | 隧道状态 Healthy |
| 隧道稳定地址 | ⚠️ 待买域名 | 唯一卡点：需自有域名配公共主机名 |
| 微信真实发布/数据 | ⛔ 未跑通 | 等后端连上 + 填凭证 + 配 Cloudflare 变量 + 白名单 |
| 飞书真实拉取 | ⛔ 未跑通 | 等飞书凭证填入 |

> 一句话：基础设施（前端/同步/文档/隧道工具）都好了，**最后差"买域名拿稳定地址 + 填凭证跑后端"这两步**就全通。

---

## 六、账号账本（你注册了哪些、花没花钱、还要不要）

> 针对你"注册了一堆账号、有的用不上"的痛点，这里一次列清。

### 已注册且本项目要用（保留）
| 账号/平台 | 费用 | 谁管 | 用途 | 备注 |
|---|---|---|---|---|
| GitHub | 免费 | 你 | 代码主库 + 自动部署 | 必需 |
| Gitee | 免费 | 你 | 国内代码镜像（操作人下载） | 必需 |
| Cloudflare | 免费 | 你 | Pages 前端 + Zero Trust 隧道 | 必需 |
| 微信公众平台（认证服务号） | 认证费 ¥300/年 | 你 | 真实发稿 + 拉数据 | 业务核心；个人订阅号不行 |
| 飞书开放平台 | 免费（自建应用） | 操作人 | 文稿真实拉取 | 需建应用 + 开权限 |
| 域名注册商（买 .top/.xyz） | ¥9/年 | 你 | 给隧道配公共主机名拿稳定地址 | 待买（唯一卡点） |

### 曾考虑 / 误以为要，但其实不用（别再注册或别花钱）
| 平台 | 为什么不用 | 出处 |
|---|---|---|
| Cloudflare Workers | 不能当后端（跑不了 server.js、IP 浮动白名单加不上） | 避坑第 1 条 |
| 付费 VPS / CloudBase / 腾讯云开发 | 能当后端但收费，本场景有免费替代（操作人电脑 + Tunnel） | 避坑第 2、9 条 |
| GitHub 代理站 (ghproxy 等) | 不可靠，仅临时绕过 | 避坑第 4 条 |
| npmmirror | 没镜像 cloudflared 这类二进制 | 避坑第 5 条 |
| Homebrew 官方脚本 | 国内连不上，换 Gitee 镜像 | 坑第 9 条 |
| 微信个人订阅号 | 拉不到真实运营数据（48001） | 坑第 10 条 |

> 结论：真正要**长期保留并花钱**的只有 **微信认证服务号（¥300/年）+ 一个域名（¥9/年）**，其余全免费。之前"注册一堆用不上"主要是把 Workers / VPS / 订阅号等误当解法，现已澄清。

---

## 七、关键文件与当前部署状态

- **线上前端**：`https://etsyops-workbench.pages.dev`（HTTP 200，标题"EtsyOps · 智能电商运营工作台"）
- **代码主库**：`https://github.com/1031582293-design/etsyops-workbench`（main 分支）
- **国内镜像**：`https://gitee.com/fu-po-fa-cai/etsyops-workbench`
- **最新提交**：`8b9794a`（隧道地址文档修正）
- **工程目录**：`etsyops/`（含 `server.js` / `wechat-publisher.html` / `wechat-dashboard.html` / `config.js` / 各部署文档）

### 后端相关文件（操作人电脑上）
| 文件 | 作用 | 是否在 git |
|---|---|---|
| `server.js` | 零依赖 Node 后端（微信+飞书代理） | ✅ 入库 |
| `start-backend.bat` | 一键起后端+隧道（启动即 git pull） | ✅ 入库 |
| `start-mac.sh` | Mac 版启动脚本 | ✅ 入库 |
| `.env` | 微信+飞书凭证 + API_KEY | ❌ 不入库（已 gitignore，**必须本地备份**） |
| `tunnel-token.txt` | 隧道令牌 | ❌ 不入库（已 gitignore，**必须本地备份**） |

---

## 八、2026-10-05 进展补充（工作台四步流 + AI 生稿 + 稳定地址已打通）

> 本次轮次完成：① 稳定公网地址 `api.mailili-agency.com` 正式生效、后端真绑定公众号；② 工作台升级为四步工作流并新增 AI 生稿；③ 一连串稳定性/兼容性修复。**改动全部在 `etsyops` 仓库，推 GitHub 即 Pages 自动部署 + 操作人 `start-robust.bat` 自动 git pull。**

### 1. 稳定地址已就绪 + 后端真绑定公众号（此前卡点已解除）
- 域名 `mailili-agency.com` 已绑 Cloudflare，隧道配公共主机名 `api.mailili-agency.com`，实测 `/api/wechat/status` 返回：
  ```json
  {"configured":true,"appid":"wxea****c150","note":"已检测到公众号凭证，发布将写入真实草稿箱。"}
  ```
  → 此前「隧道稳定地址」卡点（10-02 文档第四步待办）**已解除**。
- 微信 IP 白名单入口已**迁移到微信开发者平台**（`developers.weixin.qq.com` → 我的业务 → 公众号 → 基础信息 → 开发密钥与 API IP 白名单）。MP 后台「基本配置」只剩迁移通知。**加白名单时只动「API IP 白名单」，AppSecret 旁是「重置」按钮、千万别点**（点了旧 Secret 全部失效）。
- 出口 IP 探测 `/api/wechat/ip` 已做**多镜像兜底**（ipify 国内常不可达 → 依次试 ip.sb / ifconfig.me / ipip.net），操作者后端重开即生效。

### 2. 工作台升级为「四步工作流」（提交 `d0e4e6f`）
- 原「文稿收集 → 排版 → 发布（3 步）」改为：
  1. **文稿收集**：上传支持 `md / txt / html / docx / pdf`，可**一次多选**（多文件自动合并、带文件名分隔），也可直接粘贴。
  2. **AI 生稿（可选）**：内置完整生稿要求为默认 Prompt（角色/内容处理/结构/风格 + 硬性规则：引流《Etsy 0-1运营笔记》付费课程、规避与课程内容重复、减少 AI 腔、风险/侵权自查、输出分区）。Prompt **默认折叠可编辑**；「存为风格」保存风格1/风格2…（存浏览器 localStorage）可切换/删除。生稿结果拆分：主标题填标题、正文填编辑区、备选标题/风险审核/配图建议/转发文案单独展示（后两者不进发布正文）。后端未配 AI 时优雅降级可跳过。
  3. **公众号排版**：沿用原模板/主题色/实时预览。
  4. **发布草稿箱**：沿用原真实发布链路。

### 3. 后端新增 AI 生稿接口（提交 `d0e4e6f`）
- 新增 `GET /api/ai/status`（返回 `{available, model}`）与 `POST /api/ai/generate`（OpenAI 兼容 chat/completions，300s 长超时）。
- 凭证留在操作人 `.env`，**不暴露到前端**（符合「密钥不下前端」原则）；受可选 `API_KEY` 防护（status 接口豁免）。
- `.env` 新增三行（不配则第 2 步不可用，其余功能不受影响）：
  ```ini
  AI_API_KEY=sk-xxxx
  AI_BASE_URL=https://api.deepseek.com      # 或硅基流动 https://api.siliconflow.cn/v1
  AI_MODEL=deepseek-v4-flash                 # 见下方坑：deepseek-chat 已停用
  ```

### 4. AI 默认模型紧急修正（提交 `2f0261e`）
- **`deepseek-chat` 已于 2026-07-24 永久停用**，原默认值会直接报错。已改为 `deepseek-v4-flash`（更贵更强可选 `deepseek-v4-pro`）。`.env` 务必用新名，别照老教程写 `deepseek-chat`。

### 5. 稳定性 / 兼容性改造（提交 `5a35f5f` / `4dd09a3` / `8488fa8`）
- 修复工作台「检测绑定状态」**永久卡死**（TDZ：守卫代码在 `$` 定义前访问导致脚本中断）→ 改用 `getElementById` + 加超时（详见 PITFALLS 新增坑）。
- 超时写法兼容旧 Safari（`AbortSignal.timeout` 需 16.4+，改为 `AbortController`+`setTimeout`），并加 10s 兜底强提示。
- **前端自愈**：工作台 + 数据看板后端状态检测加**自动重连（3 次，间隔 1.5s）+ 手动「↻ 重试连接」按钮**；隧道闪断瞬间自愈，不再钉死「不可达」。
- 两页加**可见版本号**（`build v20261005d`），一眼判断是否部署到最新、是否还在跑旧缓存。
- 新增 **`start-robust.bat`**（替换 `start-backend.bat`）：git pull + cloudflared 独立窗口崩溃 3s 重连 + server.js 崩溃 3s 重启循环 + 接电源禁睡眠。**任一阵列崩溃自动拉起，不用人点。**

### 6. 免费 AI key（2026-10-05 核实，已修正此前过时信息）
> ⚠️ 此前写的"硅基流动送 2000~3000 万 Tokens 永久"已过时（2026 年中已缩水）。以下为 2026-10 实测政策。**两家免费额度/免费模型都需先「实名认证」，且百炼需「开通服务」，否则看不到额度——这是"好像没有"的最常见原因。**
- **硅基流动 SiliconFlow** `https://cloud.siliconflow.cn`：新用户一次性赠送 **¥16（国内站）/ $1（全球站）** 试用额度（非永久大额）；**实名认证后**可用一批「永久免费模型」（如 `Qwen/Qwen3-8B-Instruct`、`THUDM/GLM-Z1-9B` 等），但有固定限速（DeepSeek-R1/V3 限 30 次/小时，未实名仅 100 次/天）。填 `AI_BASE_URL=https://api.siliconflow.cn/v1`、`AI_MODEL=Qwen/Qwen3-8B-Instruct`（免费档）或花 ¥16 试 `deepseek-ai/DeepSeek-V3`。
- **阿里云百炼** `https://bailian.aliyun.com`：注册 → **开通服务（同意协议）+ 实名** → 系统自动发放**每模型 100 万 Tokens（90 天）**，累计超 7000 万，限「中国内地/华北2北京」地域模型；`qwen-plus` 在免费之列。填 `AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`AI_MODEL=qwen-plus`。
- **火山引擎（豆包）** `https://console.volcengine.com/ark`：⚠️ 免费额度已缩水。现在**每开通一款模型仅赠 50 万 Tokens（一次性）**；所谓「每日 200 万」是**协作奖励计划**，需进方舟控制台 → 开通管理 → 右侧活动里**主动加入**才生效（注册不会自动给）。完整路径：注册 → 实名 → 在「模型管理」开通具体模型（如 `Doubao-Seed-2.1-turbo`）→ 加入协作奖励计划。「看不到额度」多半卡在最后两步。填 `AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`、`AI_MODEL=doubao-seed-2.1-turbo`。
- **智谱 BigModel（最稳的真免费档，强烈推荐）** `https://open.bigmodel.cn`：注册即送 **2000 万 Tokens**（1 年有效）；`GLM-4-Flash`、`GLM-4.6-Flash` 等 **永久免费不限量**（OpenAI 兼容，中文质量在免费档里最好）。填 `AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`、`AI_MODEL=glm-4-flash`。
- **百度千帆** `https://qianfan.baidu.com`：每模型 100 万 Tokens（3 个月）；ERNIE-Speed/Lite 永久免费。
- 备选（免信用卡、需境外网络）：Groq、OpenRouter（模型名加 `:free`）。**OpenAI 官方已无免费 key，Gemini 不兼容 OpenAI 格式，先别碰。**

### 7. 约定固化（写进 `~/.workbuddy/MEMORY.md`）
- **「改工作台」一律指公网版**（Pages 前端 + 操作人后端），不再动沙盒里发布的应用。
- 用户用 **Safari**：硬刷新是 `Cmd+Option+R`（不是 `Cmd+Shift+R`，那是阅读模式）；隔离缓存用私人窗口 `Cmd+Shift+N`。

### 8. 当前进度看板（更新 10-02 版）
| 组件 | 状态 | 说明 |
|---|---|---|
| 前端 (pages.dev) | ✅ 已上线 | 四步流 + AI 生稿 + 重试自愈，推 GitHub 自动更新 |
| 稳定地址 (api.mailili-agency.com) | ✅ 已通 | 隧道公共主机名已配，域名已绑 Cloudflare |
| 后端真绑定公众号 | ✅ configured:true | appid wxea****c150，草稿/数据可真实拉取 |
| AI 生稿 | ⚠️ 代码就绪 | 待操作人 `.env` 填 AI_API_KEY（硅基流动/百炼免费 key）后亮「✅ 已就绪」 |
| 微信 IP 白名单 | ⚠️ 待加 | 出口 IP 已可探测，加白后真实发布不再 40164 |
| 数据看板 | ✅ 可用 | 真实粉丝/草稿/已发布（图文分析需认证服务号+数据权限） |
| 稳定性 | ✅ 强化 | 前端自动重试 + start-robust.bat 崩溃自拉 |

### 9. 下一步待办（明天校验用）
1. 操作人 `.env` 填 `AI_API_KEY` 等三行（硅基流动/百炼免费 key），重开 `start-robust.bat`，确认日志 `ai: <model>`。
2. 微信开发者平台把出口 IP 加进「API IP 白名单」，保存（管理员扫码）。
3. 浏览器用 `?api=https://api.mailili-agency.com` 打开工作台，确认顶部 `✅ 已绑定真实公众号` + 版本号 `v20261005d`。
4. 试跑四步流：上传素材 → AI 生稿 → 排版 → 发布草稿箱，核对微信后台草稿箱出现该图文。
5. （可选）后端服务化：`cloudflared service install` + nssm 把 server.js 做成 Windows 服务，连注销/重启都自动恢复。

### 10. 关键文件变更（相对 10-02 版）
| 文件 | 变化 |
|---|---|
| `wechat-publisher.html` | 3 步→4 步；加多格式/多选上传、AI 生稿面板、自动重连/重试、版本号 |
| `wechat-dashboard.html` | 加自动重连/重试按钮、版本号 |
| `server.js` | 新增 `/api/ai/status`、`/api/ai/generate`、`/api/wechat/ip` 多镜像兜底；启动日志带 `ai:` |
| `start-robust.bat` | **新增**：崩溃自动重启的常驻启动器 |
| `.env.example` | 新增 `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` 段与注释 |
| 最新提交 | `d0e4e6f`（四步流）→ `2f0261e`（模型修正）→ `5a35f5f`/`4dd09a3`（卡死修复/兼容）→ `8488fa8`（重试自愈 + start-robust.bat + v20261005d） |

---

## 九、2026-10-06 进展补充（工作台稳定性 + AI 生稿根因修复 + 部署通道厘清）

> 本次轮次完成：① 厘清后端代码更新通道（操作者机器 github 直连 `git pull` 实测成功，gitee 镜像降级为纯兜底）；② 一连串真 bug 根因修复（docx 字数误报、页面默认示例文案、AI 生稿 `Invalid string length` 崩溃）；③ 后端版本号可见，不再靠口说"更新了没有"；④ 编码常识沉淀进资料库术语词典。**改动全部在 `etsyops` 仓库，推 GitHub 即 Pages 自动部署 + 操作人 `git pull` 更新后端。**

### 1. 后端代码更新通道厘清（推翻此前"github 被墙"判断）
- **操作者机器实测**：在正确目录 `D:\etsyops-workbench-main\etsyops-workbench-main` 跑 `git remote -v` → origin = `github.com:1031582293-design/etsyops-workbench.git`；`git pull` 从 github 直连**成功**（`4099be9..3137b5a` 快进），更新了 3 个文件。→ **github 直连拉取通畅，此前"被墙"判断作废**。
- **结论**：gitee 镜像（`fu-po-fa-cai/etsyops-workbench`）仅作兜底/备用，**日常更新走 github 即可**（bat 里那条 gitee 兜底现在永远用不上，可忽略）。update-backend 命令保持 `git pull` 即可。
- 同步修正了过时备忘：操作者 git **已安装**、目录**已是 git 仓库**（非此前记的"没装 git / ZIP 解压副本"）。

### 2. docx 上传「5 万字超限」误报根因修复（提交 `60696c8`）
- **根因**：上传 `.docx` 后，mammoth 把 Word 解析成 HTML（含图片转 base64 `<img src="data:...">`），旧逻辑直接把整段 HTML 当正文填入素材框；字数校验用 `textarea.value.length`，HTML 标签 + 图片 base64 让 3000 字正文涨到几万 → 误报超 5 万。
- **修复**：新增 `htmlToText()` 抽纯文本（去标签/去 base64 图片/解 HTML 实体）后再填框；字数校验基于纯文本。模拟验证：含图片 base64 的 2.2 万字符 HTML → 压回 2240 字。
- ⚠️ 上传请用 **`.docx`**（老 `.doc` 格式 mammoth 不支持，需另存为 `.docx`）。

### 3. 页面初始化示例文案移除 + 版本号注入修正（提交 `e135e7c`）
- **根因**：`wechat-publisher.html` 初始化代码自动填「手作蜡烛」示例文案到素材框/标题（开发者演示逻辑），导致"模拟数据还在"。
- **修复**：初始化改为默认空白，预览区显示空态提示；同时修正版本号注入（`BUILD_VERSION` 占位 → 自动注入 git 提交号，`null` 异常值过滤，消除"build nullc069a8"双前缀）。

### 4. AI 生稿 `Invalid string length` 根因修复——不再报错、始终出稿（提交 `7bb3fb4`）
- **根因（读代码实测确认）**：`aiGenerate` 请求体**未设 `max_tokens`**，模型输出长度无上限；免费档模型遇较长素材偶尔失控输出约 **512MB** 内容 → 后端 `json()` 序列化时崩成 `Invalid string length`。Node 触发该错的阈值约 512MB（`0x1fffffe8` 字符），远非素材本身能触发。
- **前期弯路（已废弃）**：曾在 `content > 100000` 字时 `throw` 拦下报错（正是"报错不出来稿"的元凶），并反复改报错提示词——**用户明确要求"不要一遍遍改提示词，要从根上让生稿走通"**。
- **最终修复（根因级）**：
  1. 请求体加 **`max_tokens: 4000` 硬上限**，从协议层锁死输出长度，模型绝不可能再返回几百 MB；
  2. **删掉"超长抛错拦截"，改成"超长截断兜底"**（>8000 字截断返回），保证始终出稿、不再报错；
  3. 输入侧 `manuscript` 截断 **15000 字**双保险。
- 配套（提交 `a477c1a` / `1955953`）：后端 `catch` 真正 `console.error` 打印真实错误；前端删掉"掩盖真实错误"的猜测分支，直接展示后端原始报错；前端生稿 `catch` 加"诚实诊断"——探测 `/api/ai/status` 区分"隧道真断"与"生稿接口崩了"。

### 5. 后端版本号可见（提交 `acab1bc`）
- 后端启动读 git 提交号得 `SERVER_VERSION`，`/api/wechat/status` 返回 `serverVersion`；前端状态区新增「后端 xxxx」显示。
- 用途：用户/操作者**硬刷新后肉眼确认正在跑的是哪份代码**，不再靠"我更新了"口说。

### 6. 编码常识沉淀进资料库术语词典（持续更新）
- 已建《EtsyOps 工作台 · 编码常识与术语词典（持续更新）》到资料库个人空间：https://www.workbuddy.cn/space/d/3u93crFpwktQpdMguW145y
- 含：部署架构常识、技术名词词典（JSON/Git Bash/mammoth/.js/curl/server.js/Cloudflared/dist/API/base64/.env 等）、命令与脚本阅读常识（CMD vs PowerShell、横杠/大小写约定、怎么读代码）。
- 约定：以后新术语/新踩坑补进这份文档，不入 git 仓总结文档。（删除"踩坑根因速查"章节、新增"命令与脚本阅读常识"章节均走资料库审阅卡，需用户「接受」才落正文。）

### 7. 当前进度看板（更新 10-05 版）
| 组件 | 状态 | 说明 |
|---|---|---|
| 前端 (pages.dev) | ✅ 已上线 | 默认空白素材框、版本号自动注入、后端版本显示 |
| 后端代码更新通道 | ✅ github 直连通 | `git pull` 实测成功；gitee 仅兜底 |
| AI 生稿 | ✅ 根因已修 | `max_tokens` 硬上限 + 截断兜底，长素材也能出稿不报错 |
| docx 上传字数校验 | ✅ 已修 | 抽纯文本后再算字数，不再被 base64 图片撑爆 |
| 后端版本可见 | ✅ 已加 | 状态区显示「后端 <commit>」 |
| 隧道稳定性 | ✅ 已稳 | 单实例（bat 不再双拉隧道），cloudflared 服务 Running |

### 8. 下一步待办
1. 操作者 `git pull` + 双击 `start-backend.bat`（自动杀旧窗口、用新代码起）拿到 `7bb3fb4` 后端；用户硬刷新后右上角应显示「后端 7bb3fb4」。
2. 上传真实 docx 跑完整四步流，核对微信后台草稿箱出现该图文。
3. （可选）若还想更快，把内置生稿提示词默认「800~1800 字」调短，或 `.env` 换更快付费模型。

### 9. 关键文件变更（相对 10-05 版）
| 文件 | 变化 |
|---|---|
| `wechat-publisher.html` | 初始化空白；`htmlToText` 抽纯文本；版本号注入修正；生稿诚实诊断 + 显示「后端版本」 |
| `server.js` | `max_tokens:4000` 硬上限；超长截断兜底；`manuscript` 截断 15000；`serverVersion` 暴露；`catch` 打日志 |
| `start-backend.bat` | 修正误导性 echo（去掉凭空假设的 `(github)`）；保留 gitee 兜底 + 启动杀旧窗口 |
| 最新提交 | `60696c8`（docx 纯文本）→ `e135e7c`（示例文案移除+版本号）→ `4099be9`/`1955953`（诚实诊断）→ `3137b5a`（去误导 echo）→ `acab1bc`（后端版本可见）→ `a477c1a`（日志/不掩盖）→ `7bb3fb4`（AI 生稿根因修复） |

---

# 追加到 SETUP-SUMMARY.md 末尾（第十章）
## 十、2026-10-07 进展补充（Etsy Open API v3 全链路打通 + 工作流重排）

> 本章记录 Etsy 上架链路从0到 1 的全过程。这是项目里**第一个真实对接第三方平台 API** 的功能，
> 与公众号链路最大的差别是：**Etsy 的写操作会真实改变线上店铺状态且产生费用**。

### 1. Etsy API 接入的完整链路（已全部打通）

| 环节 | 状态 | 说明 |
|---|---|---|
| Seller App | ✅ | 店主已建，拿到 keystring + shared secret |
| OAuth 授权 | ✅ | PKCE 流程，店铺 `Aurenmorph`（shop_id 67875620，**自动识别**） |
| 授权回调 | ✅ | 两个路径都支持（见踩坑 26） |
| 网络出口（代理） | ✅ | `ETSY_PROXY=http://127.0.0.1:10080` |
| 店铺预置数据读取 | ✅ | 分区 4 个 / 配送模板 4 个 / 处理档案 3 个 |
| 批量表格导入 | ✅ | 粘贴或 CSV，16 列自动映射 |
| AI 文案生成 | ✅ | 队列串行 + 断点续跑 + 单条重生成 |
| 变体写入 | ✅ | 笛卡尔积展开，最多 3 个维度 |
| 发布（state=active） | ⏸ **故意不做** | 见下方「设计上的取舍」 |

**核心接口清单**（`etsy-api.js`，零依赖实现）：
```
POST   /api/etsy/auth                      跳 Etsy 授权页（生成 PKCE + state）
GET    /api/etsy/callback                  换 token + 自动发现 shop_id
GET    /api/etsy/status                    授权状态自检
GET    /api/etsy/whoami                    实例身份（hostname/pid/commit）
GET    /api/etsy/connectivity              连通性自检（不需要凭证）
POST   /api/etsy/preflight                 拉分区/配送/处理档案
POST   /api/etsy/taxonomy / properties     搜类目 / 查该类目属性
POST   /api/etsy/validate                  本地校验（不花额度）
POST   /api/etsy/draft                     建草稿（+传图+属性+库存）
POST   /api/etsy/publish                   发布（人工点，产生 $0.20）
POST   /api/etsy/deactivate                下架（止损）
POST   /api/etsy/ai/copy                   单条 AI 文案
POST   /api/etsy/ai/batch                  批量 AI 队列（GET 查进度 / stop 中断）
GET    /api/diag/logs?file=backend|tunnel  远程读日志（排障用，免key）
```

### 2. ★ Etsy 的两套相反价格规则（最容易改错的一处）

| 接口 | price 格式 | $29.99 应传 |
|---|---|---|
| `POST /listings`（建草稿表单） | **subunit 整数** | `2999` |
| `PUT /listings/{id}/inventory`（变体价格） | **浮点** | `29.99` |

官方依据：`updateListingInventory` 描述写 *"assign a float equal to amount divided by divisor"*；
Listings 教程示例写 *"set your price as a float value"*。

**更坑的是读回来又是第三种格式**：`GET /inventory` 返回 `price: {amount, divisor}` 对象。
所以整表覆盖时**必须先把所有行归一化成浮点**，未修改的行也要做——
否则那些行会带着对象格式写回 Etsy（写入格式错误）。

新增 `toFloatPrice()` 统一这个不对称，`test/README.md` 有专节说明。

### 3. ★ Etsy 的必填要求：API 层与界面层不一致

这是店主经验与我查证结果冲突的地方，**以实测为准**：

| 字段 | API 规范 | Shop Manager 界面 |
|---|---|---|
| `quantity` / `title` / `description` / `price` / `who_made` / `when_made` / `taxonomy_id` | **必填** | 必填 |
| `shipping_profile_id` / `readiness_state_id` | 实物必填 | 必填 |
| `image_ids` | 上架时必填（草稿不用） | 必填 |
| **`production_partner_ids`** | `optional` | **拦住** |
| **物理属性**（重量/尺寸/体积） | `optional` | **拦住** |
| 类目属性（风格/物种等） | 可空 | 可空 |

官方教程原文：`must include at a minimum` / `required for physical listings`。

**实际影响**：走 API 建的草稿能成功，但**在 Shop Manager 里打开时会被界面拦住**，
无法编辑或上架。所以页面把这两项处理成「强烈建议」——黄字提示但不硬拦。

### 4. 设计上的三个刻意取舍

**① 建草稿与发布拆成两步，发布按钮只由人工点**
Etsy 上架费 $0.20 只在 `state=active` 时收，草稿不收。所以程序建完草稿就停，
`publish` 是独立接口。弹窗二次确认 + 常驻「下架」按钮（发现错价时先下架再改）。

**② 写操作有独立总开关 `ETSY_ALLOW_WRITE=1`（默认关）**
Etsy **没有沙箱环境**，测试就是真写店铺。关闭时**请求根本发不出去**（不是拦截），
所以调试期可以随便点页面。判定用严格 `=== '1'`：`ETSY_ALLOW_WRITE=true` / `yes` / `0`
**都不算开**。理由是这一个字符就是「误改真实店铺」和「安全」的分界线——
若写成 `if (env.ETSY_ALLOW_WRITE)`，`.env` 里误写任何非空值都会开。

**③ AI 只喂「已填的事实」，素材缺失时拒绝生成**
只根据材质、尺寸、适合人群、净重生成文案，**这三项一项都没填时直接报错**。
凭空生成会写出产品上不存在的规格（比如写了 "squeaky" 但产品没响笛），那是 Etsy 合规风险。

### 5. ★ 批量导入：这类代码最危险的失败模式是「静默丢值」

列名没匹配上时**不报错、只是那一列全空**，用户以为导入成功了，
结果建出一堆缺字段的草稿（每个草稿上架费 $0.20）。

自测抓到 3 处：
| 缺陷 | 后果 |
|---|---|
| `get('weight')` 用了表头写法而非字段名 |重量、尺寸、适合人群三列**全部静默变空** |
| 别名表只有「长/宽/高」，缺「长度/宽度/高度」 | 真实表格用后者 → 三维尺寸整列读不到 |
| 缺带空格的「包装尺寸 长×宽×高(cm)」 | 真实飞书表头正是这一写法 |

**已加回归守卫断言**：源码里不允许再出现 `get('weight')` 这类调用。

图片方案用**文件夹 + 文件名匹配**：表格写 `6-狼头套-1.jpg`，与已选文件对上号，
**保留表格里的顺序**（第一张是主图）。

### 6. ★ 工作流重排为七步（原来是五步）

原设计是**单条上架的思维**（先填表→ 再传图 → 点一次 AI）。批量场景应该是：

```
① 给料（表格 + 图片文件夹）
② AI 文案（队列生成 / 逐条改 / 单条换一版 / 提示词编辑器）
③ 店铺设置  ④ 类目与属性  ⑤ 商品资料  ⑥ 库存与变体  ⑦ 写入与发布
```

第 ① 步是**给料**而非填表——先给料、自动填、AI 生成、人工逐条核对。
第 ⑥ 步的图片区已移除（① 步选完），只留库存与变体。

**提示词编辑器**（第 ② 步，默认收起）：优先级 页面输入 > `data/etsy-prompt.txt` > 内置。
每次生成时读盘，**改完立即生效不用重启**。

**AI 队列在后端跑**：30 个商品串行要 10~30 分钟，浏览器刷新就白跑。
关掉页面继续跑，有进度条、可中断、单次失败跳过并记录原因（不中断整批）。

### 7. AI 配置拆成两套（互不影响）

| | 公众号（原有，一行未改） | Etsy（新增） |
|---|---|---|
| Key | `AI_API_KEY` | `ETSY_AI_API_KEY` |
| 地址 | `AI_BASE_URL` | `ETSY_AI_BASE_URL` |
| 模型 | `AI_MODEL` | `ETSY_AI_MODEL` |
| 代理 | `AI_PROXY` | `ETSY_AI_PROXY` |

Etsy 那套**留空时自动回落**到公众号那套（向后兼容）。
拆分的理由：公众号用国内服务直连最快，Etsy Listing 要英文 SEO 质量可能想换 OpenAI（需走代理），
合成一套会导致「换 GPT 时把公众号一起换掉」且两边互相拖累出口。

### 8. 当前进度看板（更新 10-07 下午版）

| 组件 | 状态 |
|---|---|
| Etsy API 授权 | ✅ 已授权（店铺 Aurenmorph） |
| 批量导入 | ✅ 已完成（含图片文件名匹配） |
| AI 文案（智谱） | ✅ 可用（公众号同套） |
| AI 文案（OpenAI） | ⏸ key 已拿到，**等店主充值**（"You have no credits remaining"） |
| 变体写入 | ✅ 后端链路完整可用 |
| 物理属性 + 生产伙伴 | ✅ 已接入页面 |
| 工作流七步重排 | ✅ 已完成 |
| **建第一个草稿** | ⏳ **未做** —— 这是下一步 |
| 发布到 active | ⏸ 故意不做（要人工确认） |

### 9. 下一步待办

1. **用智谱跑通第一个草稿**（`.env` 注释掉 `ETSY_AI_*` 三行 → 自动回落到智谱）
2. 店主发邮件 `developer@etsy.com` **退出误开的Developer Mode**（当前商品在搜索里搜不到）
3. 确认店铺注册主体与收钱账户（合规基础，见PITFALLS 第 31 条）
4. 前端 UI 的变体选择器仍待做（后端链路已通，属性表形状要等真实数据确认）

### 10. 关键文件变更（相对 10-06 版）

| 文件 | 变化 |
|---|---|
| `etsy-api.js` | **新建**（1149 行）Etsy 客户端零依赖实现：PKCE / token 自动刷新与轮换 / 429 退避 / 变体笛卡尔积 / 代理转发 / 网络错误诊断 |
| `etsy-import.js` | **新建**（315 行）批量表格解析器：表头别名映射、数值容错、AI 返回解析（与后端同源） |
| `etsy-publisher.html` | **新建**（1614 行）上架页，已重排为七步 |
| `server.js` | +11 个 `/api/etsy/*` 路由 + `whoami` / `connectivity` / `diag/logs` 三个诊断接口 + AI 配置拆分 + `AI_PROXY` |
| `test/selftest.etsy.mjs` | **新建**（274 项） |
| `test/selftest.import.mjs` | **新建**（69 项） |
| `test/selftest.aiparse.mjs` | **新建**（61 项）前后端解析器一致性 |
| `test/selftest.aiproxy.mjs` | **新建**（7 项） |
| `test/selftest.batcfg.sh` | **新建**（20 项）bat 配置预检逻辑 |
| 最新提交 | `3a800c8`（工作流重排七步） |

### 11. 自测规模（截至 10-07）

全套 **636 项全绿**，19 个脚本 / 3211 行：

```
aiparse 61 / etsy 274 / import 69 / preview 45 / canvas 74 / parse 36 /
cover3 31 / server 24 / cover 22 / frontend 22 / filestyle 22 / runs 23 /
aiproxy 7 / batcfg 20
```

**沙盒不能起服务测HTTP**（所有本地端口返回 502），所以自测一律用
「import 模块 + mock req/res/fetch」的方式，跑的是**真实业务函数**。

### 12. 项目投入统计（口径说明）

以**工作区目录创建时间**（2026-10-01 17:20，即首次对话）为起点，
到 10-07 17:30 为终点：

| 口径 | 时长 | 说明 |
|---|---|---|
| 日历跨度 | **144 h = 6.0 天** | 对外说项目周期用这个 |
| 其中无提交空档 | 91.7 h = 3.8 天 | 夜间与休息 |
| **实际投入（估）** | **约 64 h ≈ 2.7 天** | 按 commit 密度 + `backend.log` 重启次数 + 文件 mtime 三类痕迹倒推 |
| 功能开发（不含排障） | 约 46 h ≈ 2 天 | |

**排障占比约 28%**，四个主要坑：CloudStudio 504、Cloudflare 边缘截断、
多后端抢域名、Node 忽略系统代理。详见 PITFALLS 第 26~30 条。

---