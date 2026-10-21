/**
 * 邮件接入自测（无网络、无端口）
 *
 * 只测 mail-ingest.js 这个模块本身：验签、落盘、去重、主题解码、索引查询。
 * 用临时目录，跑完删掉，不碰 data/ 里真实数据。
 * 用法：node test/selftest.mail.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mail from '../mail-ingest.js';

let pass = 0;
let failed = 0;
const fails = [];

async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    fails.push(`${name}: ${e.message}`);
    console.log('  ✗', name, '→', e.message);
  }
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function mkEml({ subject, from = 'Etsy <transaction@etsy.com>', body = 'You sold an item.' }) {
  return [
    `From: ${from}`,
    'To: etsy@mail.mailili-agency.com',
    `Subject: ${subject}`,
    'Message-ID: <test-abc@mail.etsy.com>',
    'Date: Mon, 20 Oct 2026 01:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

const dir = await mkdtemp(join(tmpdir(), 'etsyops-mail-'));
const SECRET = 'test-secret-0123456789';

console.log('\n[1] 签名与验签');
await ok('同一输入签名稳定', () => {
  const ts = String(Date.now());
  assert.equal(mail.signPayload(SECRET, ts, 'abc'), mail.signPayload(SECRET, ts, 'abc'));
});
await ok('正确签名通过', () => {
  const ts = String(Date.now());
  const sig = mail.signPayload(SECRET, ts, 'abc');
  assert.equal(mail.verifySignature(SECRET, ts, 'abc', sig).ok, true);
});
await ok('错误密钥被拒', () => {
  const ts = String(Date.now());
  const sig = mail.signPayload(SECRET, ts, 'abc');
  const r = mail.verifySignature('another-secret', ts, 'abc', sig);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});
await ok('过期时间戳被拒（防重放）', () => {
  const ts = String(Date.now() - 10 * 60 * 1000);
  const sig = mail.signPayload(SECRET, ts, 'abc');
  const r = mail.verifySignature(SECRET, ts, 'abc', sig);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale_timestamp');
});
await ok('未配置密钥时明确报错', () => {
  const r = mail.verifySignature('', String(Date.now()), 'abc', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_secret_configured');
});
await ok('缺签名被拒', () => {
  const r = mail.verifySignature(SECRET, String(Date.now()), 'abc', '');
  assert.equal(r.reason, 'missing_signature');
});

console.log('\n[2] 收信与落盘');
await ok('主题里的 RFC2047 中文能解码', () => {
  const h = mail.parseHeaders(Buffer.from(mkEml({ subject: `=?UTF-8?B?${b64('你卖出了一件商品')}?=` })));
  assert.equal(h.subject, '你卖出了一件商品');
});
await ok('Q 编码也能解码', () => {
  const h = mail.parseHeaders(Buffer.from(mkEml({ subject: '=?UTF-8?Q?You_sold_an_item?=' })));
  assert.equal(h.subject, 'You sold an item');
});
await ok('收信成功并写入 .eml', async () => {
  const eml = mkEml({ subject: `=?UTF-8?B?${b64('新订单')}?=` });
  const r = await mail.ingest({ rawB64: b64(eml), to: 'etsy@mail.mailili-agency.com' }, { secret: SECRET, dataDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.subject, '新订单');
  const back = await readFile(join(dir, r.file), 'utf8');
  assert.ok(back.includes('You sold an item.'));
});
await ok('同一封重复投递判为 duplicate，不重复入库', async () => {
  const eml = mkEml({ subject: 'dup-test' });
  const a = await mail.ingest({ rawB64: b64(eml) }, { secret: SECRET, dataDir: dir });
  const b = await mail.ingest({ rawB64: b64(eml) }, { secret: SECRET, dataDir: dir });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.id, b.id);
});
await ok('没配密钥时拒收，不写盘', async () => {
  const r = await mail.ingest({ rawB64: b64(mkEml({ subject: 'x' })) }, { secret: '', dataDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});
await ok('空内容被拒', async () => {
  const r = await mail.ingest({ rawB64: '' }, { secret: SECRET, dataDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

console.log('\n[3] 查询');
await ok('recent 返回最近的在前', async () => {
  const r = await mail.recent(dir, 10);
  assert.equal(r.ok, true);
  assert.ok(r.items.length >= 2);
  const times = r.items.map((x) => x.at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], '应按时间倒序');
});
await ok('status 计数与最后时间', async () => {
  const s = await mail.status(dir);
  assert.equal(s.ok, true);
  assert.ok(s.count >= 2);
  assert.ok(s.lastAt);
});

console.log('\n[4] 处理状态（人工标记）');
await ok('标记已处理后能读回来', async () => {
  const r = await mail.markState(dir, 'abc123', 'done');
  assert.equal(r.ok, true);
  const st = await mail.readState(dir);
  assert.equal(st.abc123.status, 'done');
  assert.ok(st.abc123.at);
});
await ok('不认识的 id 默认没有状态（前端按 pending 处理）', async () => {
  const st = await mail.readState(dir);
  assert.equal(st.never_seen, undefined);
});
await ok('非法状态被拒', async () => {
  const r = await mail.markState(dir, 'abc123', 'whatever');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_status');
});
await ok('缺 id 被拒', async () => {
  const r = await mail.markState(dir, '', 'done');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_id');
});

await rm(dir, { recursive: true, force: true });

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(' -', f);
  process.exit(1);
}
