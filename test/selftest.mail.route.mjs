/**
 * 邮件接口的路由级自测（无端口）
 *
 * 沙盒会拦截所有本地监听端口，所以这里不用 listen，而是：
 *   1) 复制一份 server.js，把 listen 那行关掉，并导出 handleApi；
 *   2) 用 mock 的 req/res 直接调用真实的 handleApi。
 * 验证的是「路由有没有挂上、白名单对不对、验签拦不拦得住」。
 *
 * 用法：node test/selftest.mail.route.mjs
 */
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SECRET = 'route-test-secret';
const API_KEY = 'test-api-key-123';

// ---- mock req / res ----
function mkReq(method, url, headers = {}, bodyStr = null) {
  const req = new http.IncomingMessage();
  req.method = method;
  req.url = url;
  req.headers = { origin: 'http://127.0.0.1', ...headers };
  if (bodyStr != null) {
    req.__body = Buffer.from(bodyStr, 'utf8');
    req.headers['content-length'] = String(req.__body.length);
    req[Symbol.asyncIterator] = async function* () { yield req.__body; };
  }
  return req;
}
function mkRes() {
  const r = { _code: 0, _headers: null, _body: null };
  r.writeHead = (code, h) => { r._code = code; r._headers = h; return r; };
  r.setHeader = (k, v) => { r._headers = r._headers || {}; r._headers[k] = v; };
  r.end = (b) => { r._body = b ? Buffer.from(b) : Buffer.alloc(0); return r; };
  return r;
}

let pass = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '→', e.message); }
}

const dataDir = await mkdtemp(join(tmpdir(), 'etsyops-mailroute-'));
const tmpServer = join(ROOT, '.selftest-server.mjs');

// 先写环境变量（server.js 的 loadDotEnv 只在变量不存在时才覆盖）
process.env.MAIL_INGEST_SECRET = SECRET;
process.env.MAIL_DATA_DIR = dataDir;
process.env.API_KEY = API_KEY;

const src = await readFile(join(ROOT, 'server.js'), 'utf8');
const patched = src
  .replace('server.listen(PORT, HOST, () => {', 'if (false) server.listen(PORT, HOST, () => {')
  + '\nexport { handleApi };\n';
await writeFile(tmpServer, patched);
const mod = await import(tmpServer + '?t=' + Date.now());

const { signPayload } = await import('../mail-ingest.js');

function eml(subject) {
  return ['From: Etsy <transaction@etsy.com>', 'To: etsy@mail.mailili-agency.com',
    `Subject: ${subject}`, 'Message-ID: <r1@mail.etsy.com>', '',
    'You sold an item.'].join('\r\n');
}

async function call(method, url, { headers = {}, body = null } = {}) {
  const req = mkReq(method, url, headers, body);
  const res = mkRes();
  await mod.handleApi(req, res);
  const text = res._body ? res._body.toString('utf8') : '';
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { code: res._code, text, json };
}

console.log('\n[1] 验签拦截');
await ok('不带签名 → 401', async () => {
  const r = await call('POST', '/api/mail/ingest', { body: JSON.stringify({ rawB64: 'eA==' }) });
  assert.equal(r.code, 401);
  assert.equal(r.json.error, 'missing_signature');
});
await ok('签名错误 → 401', async () => {
  const ts = String(Date.now());
  const r = await call('POST', '/api/mail/ingest', {
    headers: { 'x-mail-timestamp': ts, 'x-mail-signature': 'deadbeef' },
    body: JSON.stringify({ rawB64: 'eA==' }),
  });
  assert.equal(r.code, 401);
  assert.equal(r.json.error, 'bad_signature');
});

console.log('\n[2] 正常投递');
const rawB64 = Buffer.from(eml('=?UTF-8?B?' + Buffer.from('新订单').toString('base64') + '?='), 'utf8').toString('base64');
await ok('正确签名 → 200 并落盘', async () => {
  const ts = String(Date.now());
  const r = await call('POST', '/api/mail/ingest', {
    headers: { 'x-mail-timestamp': ts, 'x-mail-signature': signPayload(SECRET, ts, rawB64) },
    body: JSON.stringify({ rawB64, to: 'etsy@mail.mailili-agency.com' }),
  });
  assert.equal(r.code, 200, r.text.slice(0, 200));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.subject, '新订单');
  const days = await readdir(join(dataDir, 'inbox'));
  assert.equal(days.length, 1);
});
await ok('重复投递 → duplicate', async () => {
  const ts = String(Date.now());
  const r = await call('POST', '/api/mail/ingest', {
    headers: { 'x-mail-timestamp': ts, 'x-mail-signature': signPayload(SECRET, ts, rawB64) },
    body: JSON.stringify({ rawB64 }),
  });
  assert.equal(r.code, 200);
  assert.equal(r.json.duplicate, true);
});

console.log('\n[3] 白名单与保护');
await ok('status 免 API_KEY 可读（排障用）', async () => {
  const r = await call('GET', '/api/mail/status');
  assert.equal(r.code, 200, r.text.slice(0, 200));
  assert.equal(r.json.configured, true);
  assert.ok(r.json.count >= 1);
});
await ok('recent 不带 key → 401（邮件内容不裸奔）', async () => {
  const r = await call('GET', '/api/mail/recent');
  assert.equal(r.code, 401);
});
await ok('recent 带 key → 200 且能查到', async () => {
  const r = await call('GET', '/api/mail/recent?limit=5', { headers: { 'x-api-key': API_KEY } });
  assert.equal(r.code, 200, r.text.slice(0, 200));
  assert.ok(r.json.items.length >= 1);
});

await rm(dataDir, { recursive: true, force: true });
await rm(tmpServer, { force: true });

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
