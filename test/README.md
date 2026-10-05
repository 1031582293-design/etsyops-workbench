# 自测脚本

改动 `server.js` 或 `wechat-publisher.html` 后，**先跑这两个脚本再推**。

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
# 后端 23 项：真 handleApi + 真 parseAiOutput，mock fetch 模拟 AI 返回
AI_API_KEY=sk-test AI_BASE_URL=http://127.0.0.1:1/v1 AI_MODEL=mock \
  node test/selftest.server.mjs

# 前端 22 项：从 HTML 抽取真实 apiCall/fetchT，mock fetch 注入各类异常
node test/selftest.frontend.mjs
```

## 覆盖内容

**后端（23 项）**
- AI 状态探测；响应必带 `Content-Length` 与 `no-transform`
- 参数校验（缺素材 / 缺 prompt → 400，不 500）
- 异步任务提交**毫秒级**返回 `jobId`
- 轮询直到 `done`
- **重复查询同一任务仍返回 done**（验证是 `takenAt` 延迟清理，而非立即 delete）
- 不存在的任务 → 404 且带可读 `note`
- 用页面真实 `parseAiOutput` 解析产出（标题/正文/风险/附加各段正确切分）
- 同步模式仍可用（旧前端兼容）
- **等 35 秒验证清理定时器不报 ReferenceError**（捕获作用域错误这类只在运行期暴露的 bug）

**前端（22 项）**
- `apiCall` 强制带 `Accept-Encoding: identity`、正确拼 URL、带 `AbortSignal`
- 收到 HTML（地址打到 Pages）→ 报「不是 JSON」并带 content-type 与内容开头
- JSON 被截断 → 报字节数与 content-encoding
- 正文读取中断 → 明确指出是否 `br` 压缩
- HTTP 错误 → 直接抛后端 `note`
- **超时确实会抛而不是永久挂起**
- 轮询容忍单次失败（连丢 5 次才终止）；任务不存在时给出可读原因
- **全页所有 `setInterval` 回调均不含 fetch**（防抢并发连接导致事件循环阻塞）

## 注意

`server.test.js` 是生成物，**不要提交**（已在 `.gitignore` 中）。