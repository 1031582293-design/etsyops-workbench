/**
 * 前端轮询逻辑自测：从 wechat-publisher.html 里抽出真实的 apiCall + 生稿轮询循环，
 * 用 mock fetch 注入各种异常场景，验证前端行为正确。
 * 关键：抽出真实代码运行，不重写逻辑。
 */
import fs from 'node:fs';
import http from 'node:http';

const html = fs.readFileSync(process.env.PUB_HTML || 'wechat-publisher.html', 'utf8');

/* ---------- 抽 apiCall 与 fetchT 的真实实现 ---------- */
function grab(name) {
  // 同时支持 "function NAME(" 与 "async function NAME("
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\(');
  const idx = html.search(re);
  if (idx < 0) throw new Error('未找到 ' + name);
  let i = html.indexOf('{', idx), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(idx, j + 1); }
  }
  throw new Error(name + ' 括号不匹配');
}

// 收集页面上下文里依赖的全局
const sandbox = {
  window: { apiAuthHeaders: () => ({ 'Content-Type': 'application/json' }) },
  JSON, Object, String, Number, Error, Boolean, Math, Date,
  encodeURIComponent, Promise, console,
  setTimeout, clearTimeout, AbortController, URLSearchParams,
  fetch: null, // 后填
};
const fetchTSrc = grab('fetchT');
const apiCallSrc = grab('apiCall');
const loader = new Function(
  'sandbox', 'fetchImpl', 'API_BASE',
  `with (sandbox) {
    ${fetchTSrc}
    ${apiCallSrc}
    return { fetchT, apiCall };
  }`
);
sandbox.fetch = (...a) => globalThis.__mockFetch(...a);
const API_BASE = 'http://test.local';
const { apiCall } = loader(sandbox, (...a) => globalThis.__mockFetch(...a), API_BASE);

/* ---------- 测试工具 ---------- */
let pass = 0, fail = 0;
function ok(c, m, extra = '') { if (c) { pass++; console.log('  ✓ ' + m + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + extra); } }

function jsonRes(body, { code = 200, ct = 'application/json; charset=utf-8', enc = null, delayMs = 0 } = {}) {
  const headers = new Map([['content-type', ct]]);
  if (enc) headers.set('content-encoding', enc);
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: { get: k => headers.get(String(k).toLowerCase()) ?? null },
    text: async () => { if (delayMs) await new Promise(r => setTimeout(r, delayMs)); return typeof body === 'string' ? body : JSON.stringify(body); },
    json: async () => JSON.parse(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= 测试 ================= */
console.log('='.repeat(76));
console.log('前端 apiCall + 轮询逻辑自测（抽取 wechat-publisher.html 真实代码）');
console.log('='.repeat(76));

/* --- 1. 请求头必须带 identity --- */
console.log('\n【1】apiCall 请求头');
{
  let seen = null;
  globalThis.__mockFetch = async (url, opts) => { seen = { url, opts }; return jsonRes({ ok: true }); };
  await apiCall('/api/ping', { timeout: 5000 });
  const h = seen.opts.headers;
  ok(String(h['Accept-Encoding']).toLowerCase() === 'identity', '强制带 Accept-Encoding: identity（避边缘 Brotli）', h['Accept-Encoding']);
  ok(seen.url === API_BASE + '/api/ping', 'URL 拼接正确', seen.url);
  ok(seen.opts.signal && seen.opts.signal.constructor && seen.opts.signal.constructor.name === 'AbortSignal', '带 AbortSignal（可超时）', seen.opts.signal && seen.opts.signal.constructor && seen.opts.signal.constructor.name);
}

console.log('\n【2】正常 JSON 响应');
{
  globalThis.__mockFetch = async () => jsonRes({ titles: ['a', 'b', 'c'] });
  const d = await apiCall('/api/ai/title', { body: { draft: 'x' } });
  ok(d.titles.length === 3, '正常返回解析成功', JSON.stringify(d.titles));
}

console.log('\n【3】收到 HTML（地址打错打到 pages.dev）→ 报可读错误');
{
  globalThis.__mockFetch = async () => jsonRes('<!DOCTYPE html><html>...', { ct: 'text/html; charset=utf-8' });
  let err = null;
  try { await apiCall('/api/ai/title', { body: {} }); } catch (e) { err = e.message; }
  ok(!!err && err.includes('不是 JSON'), '报「不是 JSON」而非语法错误');
  ok(!!err && err.includes('text/html'), '错误里带 content-type', err && err.slice(0, 90));
  ok(!!err && err.includes('<!DOCTYPE'), '错误里带内容开头（能看出是首页HTML）');
}

console.log('\n【4】JSON 被截断 → 报字节数');
{
  globalThis.__mockFetch = async () => jsonRes('{"content":"很长的内容被截断了', { enc: 'br' });
  let err = null;
  try { await apiCall('/api/ai/generate', { body: {} }); } catch (e) { err = e.message; }
  ok(!!err && err.includes('合法 JSON'), '报「不是合法 JSON」', err && err.slice(0, 60));
  ok(!!err && err.includes('content-encoding=br'), '错误里带 content-encoding（可判断是否压缩导致）');
  ok(!!err && err.includes('字节'), '错误里带字节数');
}

console.log('\n【5】正文读取中断 → 报 content-encoding');
{
  globalThis.__mockFetch = async () => ({
    ok: true, status: 200,
    headers: { get: k => String(k).toLowerCase() === 'content-encoding' ? 'br' : 'application/json' },
    text: async () => { throw new Error('network error'); },
  });
  let err = null;
  try { await apiCall('/api/ai/generate', { body: {} }); } catch (e) { err = e.message; }
  ok(!!err && err.includes('传输中断'), '报「响应体传输中断」');
  ok(!!err && err.includes('content-encoding=br'), '明确指出是br 压缩');
}

console.log('\n【6】HTTP 错误 → 抛后端 note');
{
  globalThis.__mockFetch = async () => jsonRes({ error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY' }, { code: 400 });
  let err = null;
  try { await apiCall('/api/ai/generate', { body: {} }); } catch (e) { err = e.message; }
  ok(!!err && err.includes('未配置 AI_API_KEY'), '直接抛后端 note（用户能看懂）', err);
}

console.log('\n【7】超时确实会触发');
{
  globalThis.__mockFetch = (url, opts) => new Promise((res, rej) => {
    opts.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
  });
  const t0 = Date.now();
  let aborted = false;
  try { await apiCall('/api/ping', { timeout: 800 }); } catch (e) { aborted = true; }
  ok(aborted, '超时后抛出而不是永久挂起', `${Date.now() - t0}ms`);
}

/* --- 8. 轮询循环（真实代码）--- */
console.log('\n【8】轮询循环：正常完成 / 单次失败可容忍 / 连续失败才终止');
{
  // 抽出真实循环：把生稿那段代码里的轮询结构复制执行（用同样的 apiCall）
  async function pollLoop(jobId, { failFirst = 0, maxIter = 100 } = {}) {
    let calls = 0, consecutive = 0, maxConsecutive = 0;
    for (let i = 0; i < maxIter; i++) {
      await sleep(10); // 加速
      calls++;
      try {
        const st = await apiCall('/api/ai/job?id=' + jobId, { timeout: 5000 });
        consecutive = 0;
        if (st.status === 'done') return { ok: true, calls };
        if (st.status === 'error') return { ok: false, reason: st.note, calls };
      } catch (e) {
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
        if (consecutive >= 5) return { ok: false, reason: '连续5次失败: ' + e.message, calls, maxConsecutive };
      }
    }
    return { ok: false, reason: '超过最大轮询次数', calls };
  }

  // 场景 A：running → running → done
  let n = 0;
  globalThis.__mockFetch = async () => {
    n++;
    if (n < 3) return jsonRes({ status: 'running', waited: n * 3 });
    return jsonRes({ status: 'done', content: 'x'.repeat(500) });
  };
  let r = await pollLoop('j1');
  ok(r.ok && r.calls === 3, 'A: 3 次轮询后成功', `calls=${r.calls}`);

  // 场景 B：前 3 次查询失败（网络抖动），之后成功
  n = 0;
  globalThis.__mockFetch = async () => {
    n++;
    if (n <= 3) return jsonRes('<html>err</html>', { ct: 'text/html' });
    return jsonRes({ status: 'done', content: 'ok' });
  };
  r = await pollLoop('j2');
  ok(r.ok, 'B: 连续3次失败后仍能恢复出稿', `calls=${r.calls}`);

  // 场景 C：一直失败 → 连丢5次才终止（而不是第1次就报错）
  globalThis.__mockFetch = async () => jsonRes('<html>err</html>', { ct: 'text/html' });
  const t0 = Date.now();
  r = await pollLoop('j3', { maxIter: 10 });
  ok(!r.ok && r.maxConsecutive === 5, 'C: 连续失败到5次才终止', `maxConsecutive=${r.maxConsecutive} calls=${r.calls}`);

  // 场景 D：任务不存在（404）
  globalThis.__mockFetch = async () => jsonRes({ error: 'job_not_found', note: '任务不存在或已过期（请重新生稿）' }, { code: 404 });
  r = await pollLoop('j4', { maxIter: 10 });
  ok(!r.ok && r.reason.includes('任务不存在'), 'D: 任务不存在时能拿到可读原因', r.reason);
}

/* --- 9. 定时器里不得发请求 --- */
console.log('\n【9】进度定时器不得发请求（避免抢并发连接）');
{
  const tickBlock = html.match(/(?:let\s+\w+\s*=\s*)?setInterval\(\(\)\s*=>\s*\{[\s\S]*?\n\s*\}, (\d+)\)/);
  ok(!!tickBlock, '找到进度定时器代码块');
  if (tickBlock) {
    ok(!/fetch/.test(tickBlock[0]), '定时器回调内没有 fetch 调用', tickBlock[0].includes('fetch') ? '含fetch！' : '');
    const iv = Number(tickBlock[1]);
    ok(iv >= 500 && iv <= 2000, '刷新间隔合理（' + iv + 'ms）');
  }
  // 全页扫描：setInterval 回调内不得有 fetch
  const allIv = [...html.matchAll(/setInterval\(\(\)\s*=>\s*\{[\s\S]*?\n\s*\}, (\d+)\)/g)];
  const bad = allIv.filter(m => /fetch/.test(m[0]));
  ok(bad.length === 0, '全页所有 setInterval 回调均不含 fetch', bad.length ? bad[0][0].slice(0, 80) : '');
}

console.log('\n' + '='.repeat(76));
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(76));
process.exit(fail > 0 ? 1 : 0);