/**
 * 类目批量 + AI 重试 + AI 日志，无网络自测。
 *
 * 覆盖本次新增的三块：
 *   1. POST /api/etsy/category/batch —— AI 给 3 个候选类目关键词 → 逐个搜 taxonomy
 *      选叶子 → 标最推荐（第一个 is_leaf=true；没有叶子退第一个并警告）。
 *   2. withAiRetry —— 429 过载自动重试，重试成功仍出结果；重试过程写进 aiLog。
 *   3. GET /api/etsy/ai/logs —— 后端真实 AI 日志可增量拉取（前端「日志与事实不符」的修复）。
 *
 * 与其它 selftest 同一套思路：不监听端口，直接 import 真实 server.js 的 handleApi，
 * 用 mock fetch 拦下所有网络。Etsy token 用「未来才过期的 access token」伪造，
 * 避免触发 refresh token 网络调用。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ---------- 伪造 Etsy 授权（数据文件，避免 refresh token 网络调用） ----------
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'etsy-accounts.json'), JSON.stringify({
  version: 1,
  activeUserId: 'testuser',
  accounts: {
    testuser: {
      userId: 'testuser', label: '',
      accessToken: 'test-access-token', refreshToken: 'test-refresh',
      accessTokenExpiresAt: Date.now() + 3600 * 1000,
      refreshTokenExpiresAt: Date.now() + 90 * 24 * 3600 * 1000,
      shops: [], activeShopId: '', addedAt: Date.now() - 1000,
    },
  },
}, null, 2));

// ---------- 环境变量（必须在 import server 前设好） ----------
process.env.ETSY_AI_API_KEY = 'sk-test';
process.env.ETSY_AI_BASE_URL = 'https://mock.local/v1';
process.env.ETSY_AI_MODEL = 'mock-model';
process.env.ETSY_KEYSTRING = 'test-keystring';
process.env.ETSY_SHARED_SECRET = 'test-secret';
process.env.ETSY_REDIRECT_URI = 'http://127.0.0.1:3000/api/etsy/callback';
delete process.env.ETSY_AI_PROXY;
delete process.env.ETSY_PROXY;

// ---------- mock fetch ----------
let chatCalls = 0;
let failFirstChat429 = false;   // 为「重试」场景：第一次 chat 返回 429
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('/chat/completions')) {
    chatCalls++;
    if (failFirstChat429 && chatCalls === 1) {
      return jsonRes({ error: { message: 'The model is overloaded' } }, 429);
    }
    // AI 返回 3 个候选类目关键词
    return jsonRes({ choices: [{ message: { content: '["ceramic horse figurine","horse figurine","pottery figurine"]' } }] });
  }
  if (u.includes('/seller-taxonomy/nodes')) {
    // URLSearchParams 把空格编码成 +，decodeURIComponent 不把 + 还原成空格，这里手动还原
    const kw = decodeURIComponent(u.replace(/\+/g, ' ')).toLowerCase();
    if (kw.includes('ceramic horse figurine')) {
      // 第 1 个关键词：只有非叶子（测「没有叶子退第一个并警告」）
      return jsonRes({ results: [{
        taxonomy_id: 100, name: 'Ceramic Horse',
        ancestors: [{ name: 'Home & Living' }], is_leaf: false, is_taxonomy_root: false,
      }] });
    }
    if (kw.includes('horse figurine')) {
      // 第 2 个关键词：命中叶子（测「推荐第一个 is_leaf=true」）
      return jsonRes({ results: [{
        taxonomy_id: 200, name: 'Horse Figurines',
        ancestors: [{ name: 'Home & Living' }, { name: 'Figurines' }], is_leaf: true, is_taxonomy_root: false,
      }] });
    }
    // 第 3 个关键词：没搜到
    return jsonRes({ results: [] });
  }
  return jsonRes({});
}
globalThis.fetch = mockFetch;

// ---------- 断言 ----------
let pass = 0, fail = 0;
function ok(cond, msg, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + msg + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + msg + '  ' + extra); }
}

// ---------- mock req/res + 调用 ----------
function mkReq(method, url, bodyObj = null) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const req = new http.IncomingMessage();
  req.method = method;
  req.url = url;
  req.headers = { origin: 'http://127.0.0.1', 'user-agent': 'category-selftest' };
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
let MOD = null;
async function callApi(method, url, bodyObj) {
  const req = mkReq(method, url, bodyObj);
  const res = mkRes();
  if (req.__body) req[Symbol.asyncIterator] = async function* () { yield req.__body; };
  if (!MOD) MOD = await import(path.resolve(ROOT, 'server.test.js'));
  await MOD.__test_handleApi(req, res);
  const txt = res._body ? res._body.toString('utf8') : '';
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { code: res._code, text: txt, json };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('='.repeat(76));
console.log('类目批量 + AI 重试 + AI 日志 无网络自测');
console.log('='.repeat(76));

// ========== 1. 类目批量：3 关键词 → 叶子选择 → 推荐 ==========
console.log('\n【1】AI 批量定类目（真实 handleApi + mock fetch）');
{
  const r = await callApi('POST', '/api/etsy/category/batch', {
    items: [{ index: 0, sku: 'HORSE-001', materials: ['ceramic'], item_weight: 500 }],
  });
  ok(r.code === 202, '受理返回 202', 'code=' + r.code);
  ok(r.json && r.json.jobId, '返回 jobId', r.json && r.json.jobId);

  // 轮询到 done（后台串行跑，mock 即时返回，很快）
  let poll = null;
  for (let i = 0; i < 100; i++) {
    await sleep(20);
    poll = await callApi('GET', '/api/etsy/category/batch?jobId=' + r.json.jobId);
    if (poll.json && (poll.json.status === 'done' || poll.json.status === 'stopped')) break;
  }
  ok(poll && poll.json && poll.json.status === 'done', '批次跑完', poll && poll.json && poll.json.status);
  const res = poll && poll.json && poll.json.results && poll.json.results[0];
  ok(res && Array.isArray(res.candidates) && res.candidates.length === 3,
    'AI 给了 3 个候选关键词', res && res.candidates && String(res.candidates.length));
  if (res && res.candidates) {
    ok(res.candidates[0].found === true && res.candidates[0].isLeaf === false,
      '第 1 关键词命中但非叶子（取第一个 + 标记）',
      res.candidates[0].leaf && res.candidates[0].leaf.full_path);
    ok(res.candidates[1].found === true && res.candidates[1].isLeaf === true,
      '第 2 关键词命中叶子', res.candidates[1].leaf && res.candidates[1].leaf.full_path);
    ok(res.candidates[2].found === false, '第 3 关键词没搜到');
    ok(res.recommended === 1, '★ 推荐 = 第一个 is_leaf=true 的候选', 'recommended=' + res.recommended);
    ok(res.candidates[1].leaf && res.candidates[1].leaf.taxonomy_id === 200,
      '叶子 taxonomy_id 正确', String(res.candidates[1].leaf && res.candidates[1].leaf.taxonomy_id));
    ok(res.candidates[1].leaf && /Horse Figurines/.test(res.candidates[1].leaf.full_path),
      'full_path 带祖先路径', res.candidates[1].leaf.full_path);
  }
}

// ========== 2. AI 日志端点 ==========
console.log('\n【2】GET /api/etsy/ai/logs（后端真实日志可增量拉取）');
{
  const r = await callApi('GET', '/api/etsy/ai/logs');
  ok(r.code === 200 && r.json && r.json.ok, '返回 200');
  ok(Array.isArray(r.json && r.json.logs) && r.json.logs.length > 0,
    '有日志条目', r.json && r.json.logs && String(r.json.logs.length));
  const all = (r.json && r.json.logs || []).map(x => x.msg).join('\n');
  ok(/类目批次/.test(all), '日志里含类目批次受理/完成');
  ok(/搜/.test(all), '日志里含逐个关键词搜索记录');
  const seq = r.json && r.json.seq;
  const r2 = await callApi('GET', '/api/etsy/ai/logs?since=' + seq);
  ok(r2.json && Array.isArray(r2.json.logs) && r2.json.logs.length === 0,
    'since=最新 seq → 无新条目（增量语义正确）', r2.json && r2.json.logs && String(r2.json.logs.length));
}

// ========== 3. 429 自动重试 ==========
console.log('\n【3】429 过载 → 自动重试后成功');
{
  chatCalls = 0;
  failFirstChat429 = true;
  const r = await callApi('POST', '/api/etsy/category/batch', {
    items: [{ index: 0, sku: 'RETRY-001', materials: ['ceramic'] }],
  });
  ok(r.code === 202, '受理返回 202', 'code=' + r.code);
  let poll = null;
  for (let i = 0; i < 100; i++) {
    await sleep(20);
    poll = await callApi('GET', '/api/etsy/category/batch?jobId=' + r.json.jobId);
    if (poll.json && (poll.json.status === 'done' || poll.json.status === 'stopped')) break;
  }
  const res = poll && poll.json && poll.json.results && poll.json.results[0];
  ok(res && !res.error && Array.isArray(res.candidates) && res.candidates.length === 3,
    '★ 429 重试后仍成功出 3 个候选', res && res.error ? res.error : (res && res.candidates && String(res.candidates.length)));
  ok(chatCalls >= 2, '确实发生了重试（chat 被调 ≥2 次）', 'chatCalls=' + chatCalls);
  const logs = await callApi('GET', '/api/etsy/ai/logs');
  const all = (logs.json && logs.json.logs || []).map(x => x.msg).join('\n');
  ok(/重试/.test(all), '重试过程写进了 aiLog（前端可见）');
  failFirstChat429 = false;
}

console.log('\n' + '='.repeat(76));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(76));
process.exit(fail ? 1 : 0);
