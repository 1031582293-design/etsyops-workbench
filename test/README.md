# 自测脚本

改动 `server.js`、`etsy-api.js` 或前端 HTML 后，**先跑这些脚本再推**。

## 为什么不用真实 HTTP

沙盒环境会拦截所有本地端口（任意端口的 `127.0.0.1` 请求都返回 502），
所以不能起服务再用 curl 打。改为**直接 import 模块并 mock `req`/`res`/`fetch`**，
跑的是真实的 `handleApi` 与真实的 `apiCall`，不重写任何业务逻辑。

## 一次性准备

生成一份不监听端口、且导出 `handleApi` 的 `server.test.js`：

```bash
node -e '
const fs=require("fs");
const lines=fs.readFileSync("server.js","utf8").split("\n");
const i=lines.findIndex(l=>l.startsWith("async function handleApi"));
lines.splice(i,0,
  "export async function __test_handleApi(req,res){return handleApi(req,res);}");
// 把 server.listen(...) 整块（到行首的 });）注释掉，避免占用端口
const s=lines.findIndex(l=>l.startsWith("server.listen(PORT, HOST"));
let e=s; while(!/^\}\);/.test(lines[e])) e++;
for(let k=s;k<=e;k++) lines[k]="// [selftest] "+lines[k];
fs.writeFileSync("server.test.js", lines.join("\n"));
'
node --check server.test.js && echo "生成成功"
```

## 运行

```bash
# 一键跑全套（332 项）
node -e '
const fs=require("fs");
const lines=fs.readFileSync("server.js","utf8").split("\n");
const i=lines.findIndex(l=>l.startsWith("async function handleApi"));
lines.splice(i,0,"export async function __test_handleApi(req,res){return handleApi(req,res);}");
const s=lines.findIndex(l=>l.startsWith("server.listen(PORT, HOST"));
let e=s; while(!/^\}\);/.test(lines[e])) e++;
for(let k=s;k<=e;k++) lines[k]="// [selftest] "+lines[k];
fs.writeFileSync("server.test.js", lines.join("\n"));
'
node --check server.test.js
AI_API_KEY=sk-test AI_BASE_URL=http://127.0.0.1:1/v1 AI_MODEL=mock node test/selftest.server.mjs
node test/selftest.etsy.mjs
for f in frontend preview canvas cover filestyle runs; do node test/selftest.$f.mjs; done
```

> `selftest.etsy.mjs` 必须在 `server.test.js` 生成之后跑（它会测真实 handleApi 的路由）。

## 覆盖内容

**后端selftest.server.mjs（24 项）**
- AI 状态探测；响应必带 `Content-Length` 与 `no-transform`
- 参数校验（缺素材 / 缺 prompt → 400，不 500）
- 异步任务提交**毫秒级**返回 `jobId`
- 轮询直到 `done`
- **重复查询同一任务仍返回 done**（验证是 `takenAt` 延迟清理，而非立即 delete）
- 不存在的任务 → 404 且带可读 `note`
- 用页面真实 `parseAiOutput` 解析产出（标题/正文/风险/附加各段正确切分）
- 同步模式仍可用（旧前端兼容）
- **等 35 秒验证清理定时器不报 ReferenceError**（捕获作用域错误这类只在运行期暴露的 bug）

**Etsy selftest.etsy.mjs（197 项）**
按「最容易造成真实损失」排序，重点覆盖：
- **金额 subunit**：$29.99→2999、$0.29→29、负数与非数字被拒
- **★ inventory 价格格式不对称**：读回是 Money 对象 `{amount, divisor}`，
  写入要**浮点**（官方原文 "assign a float equal to amount divided by divisor" /
  "set your price as a float value"）。整表 PUT 前必须把**所有行**（含未修改的）
  归一化成浮点，否则对象格式被原样写回
- **标题/标签规则**：140 字符边界、`% : & +` 各限一次、标签 20 字符边界、
  **14 个标签自动截到 13**（超了会被 Etsy 整单拒绝）
- **库存整表合并**：只改一行时其余行/sku/offering_id 全部保留、
  不存在的变体拒绝提交（防误删在售商品）
- **变体链路**：组合数是乘法累乘（初始值必须为 1，用 0 会恒等于 0）、
  笛卡尔积展开、scale_id 按维度带对、**缺 value_id / property_id 一律拒绝**
  （这是「不许猜 ID」的强制点）、逐格校验且报错指名是哪个组合
- **写操作安全开关**：`ETSY_ALLOW_WRITE` 关闭时**根本不发请求**
- **token生命周期**：到期自动刷新、**refresh token 轮换后覆盖落盘**、
  并发只刷一次、401 强制刷新重试
- **429 退避**：按 `retry-after` 退避、持续 429 最终抛错并带剩余配额
- **报错可读**：错误里带 Etsy 原文；非 JSON 响应（Cloudflare 502 HTML）也不崩
- **授权 URL**：S256 + state 齐全，且不泄漏 verifier
- **shop_id 自动发现**：从 access token 前缀取 user_id → 查`/users/{user_id}/shops`
  反查 shop_id；**多店铺时拒绝自动挑选**（可能把商品写进错误的店），单店铺自动采用；
  客户端的 shopId 必须**动态取**（授权前为空、发现后立刻可用）
- **★ 回调路径兼容**：`/api/etsy/callback` 与 `/api/etsy/oauth/callback` **两个路径
  都必须进回调逻辑**（曾因指引里写了后者、代码只注册前者，导致点「同意」后拿到
  404 not_found、授权 100% 失败）；state校验（CSRF 防护）仍生效；
  另有一条对照组断言确保无关路径不会被误当成回调
- **路由降级**：未配置凭证时各接口返回 400 并点名缺哪个变量；报错**不再要求填
  ETSY_SHOP_ID**（已自动发现）；`validate` 永远可用；带变体时返回组合行给前端渲染

**前端 selftest.frontend.mjs（22 项）**
- `apiCall` 强制带 `Accept-Encoding: identity`、正确拼 URL、带 `AbortSignal`
- 收到 HTML（地址打到 Pages）→ 报「不是 JSON」并带 content-type 与内容开头
- JSON 被截断 → 报字节数与 content-encoding
- 正文读取中断 → 明确指出是否 `br` 压缩
- HTTP 错误 → 直接抛后端 `note`
- **超时确实会抛而不是永久挂起**
- 轮询容忍单次失败（连丢 5 次才终止）；任务不存在时给出可读原因
- **全页所有 `setInterval` 回调均不含 fetch**（防抢并发连接导致事件循环阻塞）

其余：`selftest.preview.mjs`（28）、`selftest.canvas.mjs`（74）、
`selftest.cover.mjs`（22）、`selftest.filestyle.mjs`（22）、`selftest.runs.mjs`（23）。

## 历史：自测抓出过的真实缺陷（别再犯）

| 缺陷 | 后果 | 现在的防护 |
|---|---|---|
| `refreshAccessToken` 用全局 `fetch` 而非注入的 `fetchImpl` | 自测直接打到生产 `api.etsy.com` | token 端点强制显式传 fetchImpl，注释里写明原因 |
| 标签超过 13 个不截断 | Etsy 整单拒绝，那张草稿白建 | `validateTags` 里截断到 13 并记为错误 |
| `expires_in \|\| 3600` | `expires_in=0` 被误判成还有 1 小时有效，白发一次 401 | 改用 `??`，并测 0/ 30 / 缺失 三种情况 |
| Etsy 路由写在「公众号未配置」闸门之后 | 只配 Etsy 不配公众号时 Etsy 整体不可用 | 路由已移到闸门前，注释标注原因 |
| `tags`/`materials` 以数组进 URLSearchParams | 依赖隐式 toString，后续改动易踩坑 | 显式 `join(',')`，并断言类型为 string |
| **inventory 的 price 用了 subunit** | 与 createDraftListing 规则相反，$29.99 会变成 $29 —— **100 倍价格事故** | 改为浮点；新增 `toFloatPrice()` 统一读写不对称；专门测「读是对象、写是浮点」 |
| **整表 PUT 时只归一化了被修改行的价格** | 未命中的行会带着 Money 对象格式写回 Etsy，写入格式错误 | 归一化提到 patch 循环**之前**，对所有行执行 |
| **组合数用 `reduce(..., 0)`** | 乘法累乘初始值 0 → 任何数乘 0 都等于 0，组合数恒为 0（页面据此显示的行数全错） | 初始值改1，并测 1/2/3 维度共 10 项断言 |

## shop_id 为什么不用手工填

Etsy 的**任何界面都不显示数字 shop_id**（Shop Manager、店铺网址、开发者后台都没有），
让操作者手工找是不现实的；而所有写操作（建草稿 / 改库存 / 填物流单号）的 URL 里都必须带它。

所以设计成自动发现：

```
授权成功 → access_token 形如 {user_id}.{token}
         → 取点号前那段得到 user_id
         → GET /users/{user_id}/shops
         → 得到 shop_id，存进 data/etsy-shop.json
```

**多店铺时程序不自动挑**——把商品写进错误的店铺是要收拾的烂摊子，会在状态里返回
`needShopChoice` 并提示在 `.env` 里用 `ETSY_SHOP_ID` 指定。

⚠️ 客户端的 `shopId` 必须是 `shopIdProvider()` 动态取，不能把 `config.shopId` 烤死进闭包——
否则授权前它是空的，授权后即使发现了也拿不到。测试里有专门的断言守着这一条。

## 关于 inventory 价格格式（最容易改错的一处）

Etsy 有**两套相反的价格规则**，同一份代码里并存：

| 接口 | price格式 | 例子 |
|---|---|---|
| `POST /listings`（建草稿表单） | **subunit 整数** | $29.99 → `2999` |
| `PUT /inventory`（变体价格） | **浮点** | $29.99 → `29.99` |

而 `GET /inventory` **读回来**的 price 又是 `Money` 对象 `{amount: 2999, divisor: 100}`。

官方依据（用官方 MCP 的 `get_endpoint` / `get_guide` 直接查证）：
- `updateListingInventory` 描述：*"assign a float equal to amount divided by divisor"*
- Listings 教程 `uploadListingInventory` 示例：*"set your price as a float value"*

所以整表覆盖时的正确顺序是：`GET` → **所有行** price 从 Money 对象归一化成浮点 → 改目标行 → `PUT`。两处不要互相照抄。

## 注意

`server.test.js` 是生成物，**不要提交**（已在 `.gitignore` 中）。