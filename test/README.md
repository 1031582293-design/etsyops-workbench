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

**Etsy selftest.etsy.mjs（117 项）**
按「最容易造成真实损失」排序，重点覆盖：
- **金额 subunit**：$29.99→2999、$0.29→29、负数与非数字被拒
- **标题/标签规则**：140 字符边界、`% : & +` 各限一次、标签 20 字符边界、
  **14 个标签自动截到 13**（超了会被 Etsy 整单拒绝）
- **库存整表合并**：只改一行时其余行/sku/offering_id 全部保留、
  不存在的变体拒绝提交（防误删在售商品）
- **写操作安全开关**：`ETSY_ALLOW_WRITE` 关闭时**根本不发请求**
- **token生命周期**：到期自动刷新、**refresh token 轮换后覆盖落盘**、
  并发只刷一次、401 强制刷新重试
- **429 退避**：按 `retry-after` 退避、持续 429 最终抛错并带剩余配额
- **报错可读**：错误里带 Etsy 原文；非 JSON 响应（Cloudflare 502 HTML）也不崩
- **授权 URL**：S256 + state 齐全，且不泄漏 verifier
- **路由降级**：未配置凭证时各接口返回 400 并点名缺哪个变量；
  `validate` 永远可用（不依赖凭证）

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

## 注意

`server.test.js` 是生成物，**不要提交**（已在 `.gitignore` 中）。