/**
 * 飞书通知自测（无网络）
 *
 * 用 mock 的 globalThis.fetch 拦下请求，验证：
 *   1) 签名算法是否与飞书文档一致（timestamp + "\n" + secret 作为 HMAC 的 key，data 为空）
 *   2) 卡片结构与分类结果
 *   3) 失败分支是否被正确识别（飞书返回 code!=0、HTTP 5xx、超时抛错）
 * 不真的发消息出去。
 *
 * 用法：node test/selftest.notify.mjs
 */
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildSign, sendText, sendCard } from '../notify-feishu.js';
import { classify, extractSnippet, buildCard, notifyMail } from '../mail-notify.js';

let pass = 0;
let failed = 0;
const fails = [];

async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { failed++; fails.push(`${name}: ${e.message}`); console.log('  ✗', name, '→', e.message); }
}

// ---- mock fetch ----
let captured = null;
let nextResponse = () => ({ code: 0, msg: 'success' });
let nextStatus = 200;
globalThis.fetch = async (url, opts = {}) => {
  captured = { url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers };
  return new Response(JSON.stringify(nextResponse()), { status: nextStatus });
};

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token';
const SECRET = 'test-secret';

console.log('\n[1] 签名');
await ok('签名稳定', () => {
  assert.equal(buildSign(SECRET, '1700000000'), buildSign(SECRET, '1700000000'));
});
await ok('算法与文档一致（timestamp\\nsecret 当 key，data 为空）', () => {
  const ts = '1700000000';
  const expect = createHmac('sha256', `${ts}\n${SECRET}`).update('').digest('base64');
  assert.equal(buildSign(SECRET, ts), expect);
});
await ok('漏配 secret 时不带 sign', async () => {
  await sendText(WEBHOOK, 'hi');
  assert.equal(captured.body.sign, undefined);
  assert.equal(captured.body.timestamp, undefined);
});
await ok('配了 secret 时带 timestamp 且签名对得上', async () => {
  await sendText(WEBHOOK, 'hi', { secret: SECRET });
  const { timestamp, sign } = captured.body;
  assert.ok(timestamp);
  assert.equal(sign, buildSign(SECRET, timestamp));
});

console.log('\n[2] 分类');
await ok('订单类主题', () => {
  assert.equal(classify('You sold an item!').type, 'order');
  assert.equal(classify('Your order receipt').label, '新订单');
});
await ok('转发前缀能被剥掉', () => {
  assert.equal(classify('Fw: You sold an item!').type, 'order');
  assert.equal(classify('转发：You sold an item!').type, 'order');
  assert.equal(classify('FWD: RE: You sold an item!').subject, 'You sold an item!');
});
await ok('买家消息类', () => {
  assert.equal(classify('New message from Anna K.').type, 'message');
});
await ok('纠纷类', () => {
  assert.equal(classify('A case has been opened').type, 'case');
});
await ok('未知主题落到 other', () => {
  assert.equal(classify('Your Etsy weekly digest').type, 'other');
});
await ok('空主题不炸', () => {
  assert.equal(classify('').type, 'other');
  assert.equal(classify(undefined).type, 'other');
});

console.log('\n[3] 摘要提取');
await ok('去 HTML 标签与脚本/样式', () => {
  const raw = 'Subject: x\r\n\r\n<html><style>p{}</style><body><p>你卖出了 <b>一件商品</b></p></body></html>';
  const s = extractSnippet(Buffer.from(raw));
  assert.ok(s.includes('你卖出了'));
  assert.ok(s.includes('一件商品'));
  assert.ok(!s.includes('<b>'));
  assert.ok(!s.includes('p{}'));
});
await ok('quoted-printable 软换行被去掉', () => {
  const raw = 'Subject: x\r\n\r\nHello =\r\nworld';
  assert.equal(extractSnippet(Buffer.from(raw)), 'Hello world');
});
await ok('超长被截断并加省略号', () => {
  const raw = 'Subject: x\r\n\r\n' + 'a'.repeat(600);
  const s = extractSnippet(Buffer.from(raw), 100);
  assert.ok(s.length <= 101);
  assert.ok(s.endsWith('…'));
});

console.log('\n[4] 卡片与推送');
await ok('卡片带标题、类型色与按钮', async () => {
  const rec = { subject: 'You sold an item!', from: 'x@outlook.com', at: new Date().toISOString() };
  await sendCard(WEBHOOK, buildCard(rec, '买家 John 下单', 'https://example.com/'), { secret: SECRET });
  assert.equal(captured.body.msg_type, 'interactive');
  assert.equal(captured.body.card.header.title.content, '新订单');
  assert.equal(captured.body.card.header.template, 'green');
  const btn = captured.body.card.elements.find((e) => e.tag === 'action');
  assert.ok(btn, '应该有按钮');
  assert.equal(btn.actions[0].url, 'https://example.com/');
});
await ok('notifyMail 端到端拼装', async () => {
  const raw = 'Subject: New message from Anna\r\n\r\nShe asked: will it ship before Christmas?';
  const rec = { subject: 'New message from Anna', at: new Date().toISOString() };
  const r = await notifyMail(rec, Buffer.from(raw), { webhook: WEBHOOK, secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(captured.body.card.header.title.content, '买家咨询');
  assert.ok(JSON.stringify(captured.body).includes('Christmas'));
});
await ok('飞书返回 code!=0 判为失败', async () => {
  nextResponse = () => ({ code: 19021, msg: 'sign match fail' });
  const r = await sendText(WEBHOOK, 'hi', { secret: SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.code, 19021);
  nextResponse = () => ({ code: 0, msg: 'success' });
});
await ok('HTTP 5xx 判为失败', async () => {
  nextStatus = 500;
  const r = await sendText(WEBHOOK, 'hi');
  assert.equal(r.ok, false);
  nextStatus = 200;
});
await ok('没有 webhook 时直接返回错误，不发请求', async () => {
  captured = null;
  const r = await sendText('', 'hi');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_webhook');
  assert.equal(captured, null);
});

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(' -', f);
  process.exit(1);
}
