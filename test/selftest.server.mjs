/**
 * 无网络自测：直接 mock req/res 对象调用 server.js 的真实 handleApi，
 * 不监听端口（沙盒会拦所有本地端口）。覆盖完整「提交任务 → 轮询 → 重复查询」流程。
 *
 * 关键：用真·server.js 代码、真·parseAiOutput（从 HTML 抽出来），不做任何逻辑重写。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---- 1. 造 mock 的 req/res ----
function mkReq(method, url, headers = {}, bodyObj = null) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const req = new http.IncomingMessage();
  req.method = method;
  req.url = url;
  req.headers = { origin: 'http://127.0.0.1', 'user-agent': 'e2e-selftest', ...headers };
  if (bodyStr) {
    req.__body = Buffer.from(bodyStr);
    req.headers['content-length'] = String(req.__body.length);
  }
  return req;
}
function mkRes() {
  const r = { _code: 0, _headers: null, _body: null, ended: false };
  r.writeHead = (code, hdrs) => { r._code = code; r._headers = hdrs; return r; };
  r.setHeader = (k, v) => { r._headers = r._headers || {}; r._headers[k] = v; };
  r.end = (b) => { r._body = b ? Buffer.from(b) : Buffer.alloc(0); r.ended = true; return r; };
  return r;
}
async function callApi(method, url, bodyObj) {
  const req = mkReq(method, url, {}, bodyObj);
  const res = mkRes();
  if (req.__body) {
    // 让 for await (chunk of req) 能读到
    req[Symbol.asyncIterator] = async function* () { yield req.__body; };
  }
  const mod = await import(path.resolve(process.env.SELFTEST_SERVER || 'server.test.js'));
  await mod.__test_handleApi(req, res);
  const txt = res._body ? res._body.toString('utf8') : '';
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { code: res._code, headers: res._headers, text: txt, json };
}

// ---- 2. 把真实的 aiGenerate 替换成「延迟 2 秒返回固定文章」 ----
// server.js 通过全局变量拿配置，我们不改源码，改为用环境变量 + mock fetch。
const fakeArticle = `====TITLE_MAIN====
自测标题：杭州Etsy实操营学员反馈课程实用
====BODY====
<h1>开篇</h1><p>正文第一段。</p>
<h2>一、选品</h2><p>选品要综合需求、竞争、利润。</p>
<p>正文末段。</p>
====RISK====
1. 无版权风险。
====EXTRA====
附加说明。`;

let aiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/chat/completions')) {
    aiCalls++;
    await new Promise(r => setTimeout(r, 2000));
    return new Response(JSON.stringify({
      choices: [{ message: { content: fakeArticle } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

// ---- 3. 断言工具 ----
let pass = 0, fail = 0;
function ok(cond, msg, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + msg + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + msg + '  ' + extra); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 4. 跑测试 ----
console.log('='.repeat(76));
console.log('server.js 无网络自测（真实 handleApi + 真实 parseAiOutput）');
console.log('='.repeat(76));

console.log('\n【1】AI 状态探测');
{
  const r = await callApi('GET', '/api/ai/status');
  ok(r.code === 200, 'GET /api/ai/status→ 200', `code=${r.code}`);
  ok(r.headers && r.headers['Content-Length'] !== undefined, '响应带 Content-Length', `cl=${r.headers && r.headers['Content-Length']}`);
  ok(r.headers && /no-transform/.test(r.headers['Cache-Control'] || ''), '响应带 no-transform（避边缘压缩）', r.headers && r.headers['Cache-Control']);
  // 回归防护：Connection: close 会让浏览器每次新建连接，经隧道要~11 秒，
  // 而连接复用只要 ~0.4 秒 → 轮询追不上，页面像卡死。禁止再出现该头。
  const connHdr = (r.headers && (r.headers['Connection'] || '')).toLowerCase();
  ok(!connHdr.includes('close'), '响应未设 Connection: close（保证连接可复用）', 'Connection=' + (connHdr || '无'));
  ok(r.json && r.json.configured === true, 'configured=true（AI 已配置）');
}

console.log('\n【2】参数校验（不该 500）');
{
  const r1 = await callApi('POST', '/api/ai/generate', { prompt: '写800字' });
  ok(r1.code === 400, '缺素材 → 400', `code=${r1.code} note=${r1.json && r1.json.note}`);
  const r2 = await callApi('POST', '/api/ai/generate', { manuscript: '素材' });
  ok(r2.code === 400, '缺 prompt → 400', `code=${r2.code}`);
}

console.log('\n【3】提交异步任务（async:true）应毫秒级返回 jobId');
let jobId = '';
{
  const t0 = Date.now();
  const r = await callApi('POST', '/api/ai/generate', { manuscript: '杭州Etsy实操营学员反馈课程实用。', prompt: '写800字', async: true });
  const ms = Date.now() - t0;
  jobId = r.json && r.json.jobId;
  ok(r.code === 200, 'POST async → 200', `code=${r.code}`);
  ok(!!jobId, '拿到 jobId', jobId);
  ok(ms < 1500, '提交是毫秒级返回（没等AI 完成）', `${ms}ms`);
  ok(r.json && !!r.json.poll, '返回 poll 路径', r.json && r.json.poll);
}

console.log('\n【4】轮询直到done');
let result = null;
{
  let polls = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    polls++;
    const r = await callApi('GET', '/api/ai/job?id=' + jobId);
    if (r.code !== 200) { ok(false, '轮询返回非 200（前端会报"任务不存在"）', `code=${r.code} body=${r.text.slice(0,80)}`); break; }
    if (r.json.status === 'done') { result = r.json; ok(true, `第 ${polls} 次轮询拿到结果`, `content=${r.json.content.length}字`); break; }
    if (r.json.status === 'error') { ok(false, '任务失败', r.json.note); break; }
  }
  ok(!!result, '轮询成功完成');
}

console.log('\n【5】重复查询同一任务（takenAt 而非立即 delete）');
{
  const r = await callApi('GET', '/api/ai/job?id=' + jobId);
  ok(r.code === 200 && r.json && r.json.status === 'done',
     '重复查询仍返回 done（不会报"任务不存在"）', `code=${r.code} status=${r.json && r.json.status}`);
}

console.log('\n【6】查询不存在的任务 → 404 且有可读note');
{
  const r = await callApi('GET', '/api/ai/job?id=nosuchjob');
  ok(r.code === 404, '不存在的任务 → 404', `code=${r.code}`);
  ok(r.json && typeof r.json.note === 'string' && r.json.note.length > 0, '404 带可读说明', r.json && r.json.note);
}

console.log('\n【7】用页面真实 parseAiOutput 解析产出');
{
  const html = fs.readFileSync('wechat-publisher.html', 'utf8');
  const m = html.match(/function parseAiOutput\(text\)\{[\s\S]*?\n\}/);
  ok(!!m, '从 HTML 中抽出 parseAiOutput');
  if (m) {
    const fn = eval('(' + m[0] + ')');
    const out = fn(result.content);
    ok(out.title.includes('自测标题'), '标题解析正确', JSON.stringify(out.title));
    ok(out.body.includes('选品') && !out.body.includes('===='), '正文正确切分且不含标记');
    ok(!!out.risk, '风险段解析正确', JSON.stringify(out.risk.slice(0, 20)));
    ok(!!out.extra, '附加段解析正确');
    ok(out.body.length < result.content.length, '正文比原文短（已剥离各段）', `${out.body.length} < ${result.content.length}`);
  }
}

console.log('\n【8】同步模式仍可用（旧前端兼容）');
{
  const r = await callApi('POST', '/api/ai/generate', { manuscript: '素材', prompt: '写500字' });
  ok(r.code === 200, '同步请求 → 200', `code=${r.code}`);
  ok(r.json && typeof r.json.content === 'string' && r.json.content.length > 0, '直接返回 content');
}

console.log('\n【9】清理定时器 35 秒内不报错');
{
  await sleep(35000);
  console.log('  （等待 35 秒，定时器应已触发 1~2 次）');
}

console.log('\n' + '='.repeat(76));
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(76));
process.exit(fail > 0 ? 1 : 0);