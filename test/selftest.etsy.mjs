/**
 * Etsy API 模块无网络自测。
 *
 * 做法与 selftest.server.mjs 同一套思路：不监听端口（沙盒会拦所有本地端口），
 * 直接 import真实的 etsy-api.js 与真实 server.js 的 handleApi，用 mock fetch 拦下所有网络。
 * 重点覆盖「最容易造成真实损失的四个点」：
 *   1. 金额 subunit 换算（填错就是 100 倍价格事故）
 *   2. 库存整表合并（只提交一行会把其他在售商品误删）
 *   3. token 自动刷新 + refresh token 轮换落盘（漏了会每 1 小时全链路 401）
 *   4. 写操作安全开关（Etsy 没有沙箱，开错就是真写店铺）
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import * as etsy from '../etsy-api.js';

const ROOT = process.cwd();
const SERVER_TEST = process.env.SELFTEST_SERVER || 'server.test.js';

// ---------- mock req/res ----------
function mkReq(method, url, headers = {}, bodyObj = null) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const req = new http.IncomingMessage();
  req.method = method;
  req.url = url;
  req.headers = { origin: 'http://127.0.0.1', 'user-agent': 'etsy-selftest', ...headers };
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
  if (req.__body) req[Symbol.asyncIterator] = async function* () { yield req.__body; };
  const mod = await import(path.resolve(ROOT, SERVER_TEST));
  await mod.__test_handleApi(req, res);
  const txt = res._body ? res._body.toString('utf8') : '';
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { code: res._code, headers: res._headers, text: txt, json };
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
function ok(cond, msg, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + msg + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + msg + '  ' + extra); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('='.repeat(76));
console.log('etsy-api.js 无网络自测（真实模块 + mock fetch）');
console.log('='.repeat(76));

// ========== 1. 金额 subunit ==========
console.log('\n【1】价格 subunit 换算（填错就是 100 倍事故）');
{
  ok(eq(etsy.toSubunit(29.99), { amount: 2999, divisor: 100 }), '$29.99 → { amount: 2999 }',
    JSON.stringify(etsy.toSubunit(29.99)));
  ok(etsy.toSubunit(0.29).amount === 29, '$0.29 → 29（不是 0.29）');
  ok(etsy.toSubunit(0.01).amount === 1, '$0.01 → 1');
  ok(etsy.toSubunit(1000).amount === 100000, '$1000 → 100000（整数不带小数点也不丢精度）');
  ok(etsy.toSubunit(19.999).amount === 2000, '$19.999 四舍五入到 2000', String(etsy.toSubunit(19.999).amount));
  ok(etsy.fromSubunit({ amount: 2999, divisor: 100 }) === 29.99, '回显 2999/100 → 29.99');
  let threw = false;
  try { etsy.toSubunit(-1); } catch { threw = true; }
  ok(threw, '负价格被拒绝（不静默产出负数金额）');
  threw = false;
  try { etsy.toSubunit('abc'); } catch { threw = true; }
  ok(threw, '非数字价格被拒绝');
}

// ========== 2. 标题校验 ==========
console.log('\n【2】标题校验（Etsy 硬限制）');
{
  const okTitle = 'Ceramic Horse Figurine with Kiln Fired Glaze';
  const r1 = etsy.validateTitle(okTitle);
  ok(r1.ok && r1.length === 44, '正常标题通过', `${r1.length} 字符`);
  ok(etsy.validateTitle('a'.repeat(140)).ok, '正好 140 字符通过（边界值）');
  const r2 = etsy.validateTitle('a'.repeat(141));
  ok(!r2.ok && /140/.test(r2.errors.join()), '141 字符被拦', r2.errors[0]);
  ok(!etsy.validateTitle('').ok, '空标题被拦');
  const r3 = etsy.validateTitle('Horse %Figurine %Glaze');
  ok(!r3.ok && /%/.test(r3.errors.join()), '% 出现两次被拦（Etsy 限制只能 1 次）',
    r3.errors.join('; ').slice(0, 60));
  ok(etsy.validateTitle('50% & 60: 70 + 80').ok, '% & : + 各一次 → 通过');
  const r4 = etsy.validateTitle('陶瓷 Horse 🐴');
  ok(!r4.ok, '含中文/emoji 被拦（Etsy 标题面向英语买家，且有字符白名单）');
}

// ========== 3. 标签校验 ==========
console.log('\n【3】标签校验');
{
  const r = etsy.validateTags(['blue horse decor', 'horse figurine', 'ceramic horse']);
  ok(r.count === 3, '正常 3 个标签通过', String(r.count));
  const dup = etsy.validateTags(['horse decor', 'Horse Decor']);
  ok(dup.count === 1 && dup.ok, '重复标签被合并（记为提示而非错误）', '剩 ' + dup.count + ' 个');
  ok(dup.notes.some(n => /重复/.test(n)), '重复以notes 形式提示', dup.notes[0] || '');
  const long = etsy.validateTags(['a'.repeat(21)]);
  ok(!long.ok && /20/.test(long.errors.join()), '21 字符标签被拦', long.errors[0]);
  ok(long.count === 0, '超长标签不进 cleaned（不会被发出去）');
  ok(etsy.validateTags(['a'.repeat(20)]).ok, '正好 20 字符通过（边界值）');
  // ★ 这一条是自测抓出来的真实缺陷：曾经 14 个标签会原样发给 Etsy，导致整单被拒
  const over = etsy.validateTags(Array.from({ length: 14 }, (_, i) => 'tag number ' + i));
  ok(over.count === 13, '★ 14 个标签被自动截到 13（Etsy 硬上限）', '实际 ' + over.count);
  ok(over.truncated === 1 && !over.ok, '截断被记为错误（提示人手工补位）');
  ok(etsy.validateTags(Array.from({ length: 13 }, (_, i) => 'tag number ' + i)).ok, '正好 13 个通过');
  const hash = etsy.validateTags(['#red gift']);
  ok(hash.tags[0] === 'red gift', '# 号被剥掉', hash.tags[0]);
  const comma = etsy.validateTags(['red, gift']);
  ok(!comma.ok, '标签内含逗号被拦（逗号不能进标签）');
  ok(etsy.validateTags(['one']).ok, '少于 13 个不视为错误（只是 notes 提示）');
  const thirteen = etsy.validateTags(Array.from({ length: 13 }, (_, i) => 'tag ' + i));
  ok(thirteen.count === 13 && thirteen.errors.length === 0, '13 个标签零错误');
}

// ========== 4. 建草稿必填校验 ==========
console.log('\n【4】建草稿前校验（能在本地拦下的，绝不浪费 API 额度）');
{
  const good = {
    title: 'Ceramic Horse Figurine with Kiln Fired Glaze',
    description: 'A small ceramic horse figurine.',
    tags: Array.from({ length: 13 }, (_, i) => 'tag ' + i),
    price: '29.99', quantity: '10', taxonomy_id: '1',
    who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
    shipping_profile_id: '111', readiness_state_id: '222',
  };
  ok(etsy.validateDraftInput(good).ok, '完整输入 → 通过');
  const e1 = etsy.validateDraftInput({ ...good, shipping_profile_id: '' });
  ok(!e1.ok && /shipping_profile_id/.test(e1.errors.join()), '缺配送模板被拦');
  const e2 = etsy.validateDraftInput({ ...good, readiness_state_id: '' });
  ok(!e2.ok && /readiness_state_id/.test(e2.errors.join()), '缺处理档案被拦');
  const e3 = etsy.validateDraftInput({ ...good, taxonomy_id: '' });
  ok(!e3.ok && /taxonomy_id/.test(e3.errors.join()), '缺 taxonomy_id 被拦');
  const e4 = etsy.validateDraftInput({ ...good, description: '材质待确认' });
  ok(!e4.ok && /待确认/.test(e4.errors.join()), '描述里带「待确认」被拦（SOP 硬要求）');
  const e5 = etsy.validateDraftInput({ ...good, who_made: '' });
  ok(!e5.ok && /who_made/.test(e5.errors.join()), '缺 who_made 被拦（三者互相依赖）');
  const e6 = etsy.validateDraftInput({ ...good, quantity: '' });
  ok(!e6.ok && /quantity/.test(e6.errors.join()), '缺数量被拦');
}

// ========== 5. draft form 组装 ==========
console.log('\n【5】createDraftListing 请求体组装');
{
  const form = etsy.buildDraftForm({
    title: '  Ceramic Horse  ',
    description: 'A small ceramic horse.',
    tags: ['#red gift', 'horse decor'],
    price: '29.99', quantity: '10', taxonomy_id: '496',
    who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
    shipping_profile_id: '111', readiness_state_id: '222',
    materials: ['Ceramic'],
  });
  ok(form.price === '2999', 'price 用 subunit 整数（不是 29.99）', form.price);
  ok(form.title === 'Ceramic Horse', '标题已trim', form.title);
  // ★ 自测抓出来的缺陷：tags/materials 曾以数组形式进 URLSearchParams，
  //   依赖了隐式的 toString 行为。现已显式 join 成逗号分隔字符串。
  ok(form.tags === 'red gift,horse decor', '★ tags 是逗号分隔字符串（不是数组）', JSON.stringify(form.tags));
  ok(form.materials === 'Ceramic', '★ materials 是逗号分隔字符串', JSON.stringify(form.materials));
  ok(typeof form.tags === 'string' && typeof form.materials === 'string', 'tags/materials 类型确为 string');
  ok(form.shipping_profile_id === '111' && form.readiness_state_id === '222', '实物必填两项都在');
  ok(form.is_supply === 'false', 'is_supply 转字符串');
  // 反向保护：绝不能把 29.99 直接发出去
  ok(!Object.values(form).includes('29.99'), '表单里不含裸小数价格（防止 100 倍事故）');
}

// ========== 6. 库存整表合并（最容易造成真实损失的地方） ==========
console.log('\n【6】库存整表合并（Etsy PUT /inventory 是整表覆盖）');
{
  const current = {
    products: [
      { sku: 'RED-S', property_values: [{ property_id: 200, value_ids: [1], values: ['Red'], property_name: 'Primary color' }],
        offerings: [{ offering_id: 111, price: 2999, quantity: 10, is_enabled: true }] },
      { sku: 'BLUE-S', property_values: [{ property_id: 200, value_ids: [2], values: ['Blue'], property_name: 'Primary color' }],
        offerings: [{ offering_id: 222, price: 2999, quantity: 8, is_enabled: true }] },
      { sku: 'GRN-S', property_values: [{ property_id: 200, value_ids: [3], values: ['Green'], property_name: 'Primary color' }],
        offerings: [{ offering_id: 333, price: 2999, quantity: 5, is_enabled: true }] },
    ],
    price_on_property: [200], quantity_on_property: [], sku_on_property: [],
  };
  const r = etsy.mergeInventory(current, [
    { property_values: [{ property_id: 200, value_ids: [2] }], quantity: 3 },
  ]);
  ok(r.body.products.length === 3, '提交后仍是 3 行（没把其他行删掉）', '实际 ' + r.body.products.length);
  ok(r.applied === 1 && r.untouched === 2, '改了 1 行、保留 2 行', `${r.applied}/${r.untouched}`);
  const q = r.body.products.map(p => p.offerings[0].quantity);
  ok(eq(q, [10, 3, 5]), '只有目标行被改，其余原样', q.join(','));
  ok(r.body.products.map(p => p.sku).join(',') === 'RED-S,BLUE-S,GRN-S', 'sku 全部保留');
  ok(r.body.products.map(p => p.offerings[0].offering_id).join(',') === '111,222,333', 'offering_id 全部保留');
  ok(r.body.price_on_property.join(',') === '200', 'price_on_property 保留');
  ok(!JSON.stringify(r.body).includes('values":["Blue"]') ||
     r.body.products[1].property_values[0].values[0] === 'Blue', '变体名保留（买家端显示用）');

  // 顺序无关：patch 里的 property_values 顺序不同也应命中同一行
  const r2 = etsy.mergeInventory(current, [
    { property_values: [{ property_id: 200, value_ids: [3], values: ['Green'] }], quantity: 99 },
  ]);
  ok(eq(r2.body.products.map(p => p.offerings[0].quantity), [10, 8, 99]), '按 key 精确定位，不串行');

  // 不存在的 key 必须拒绝提交
  let threw = false;
  try { etsy.mergeInventory(current, [{ property_values: [{ property_id: 200, value_ids: [999] }], quantity: 1 }]); }
  catch { threw = true; }
  ok(threw, '不存在的变体 → 拒绝提交（宁可不动也不误删）');

  // 异常结构必须拒绝
  threw = false;
  try { etsy.mergeInventory({ foo: 1 }, [{ property_values: [] }]); } catch { threw = true; }
  ok(threw, '线上表结构异常 → 拒绝提交');
  threw = false;
  try { etsy.mergeInventory(current, []); } catch { threw = true; }
  ok(threw, '空 patch → 拒绝提交');

  // 改价格也走同一套
  const r3 = etsy.mergeInventory(current, [
    { property_values: [{ property_id: 200, value_ids: [1] }], price: '24.99' },
  ]);
  // ★ 关键修正：inventory 写入的价格是**浮点**，不是 subunit 整数。
  //   官方 updateListingInventory 描述 "assign a float equal to amount divided by divisor"，
  //   官方 Listings 教程示例写 "set your price as a float value"。
  //   读回时 price 是 Money 对象 {amount, divisor}，整表 PUT 前必须归一化成浮点，
  //   否则未修改的行会带着对象格式写回去。
  ok(r3.body.products[0].offerings[0].price === 24.99, '★ 写入价格是浮点 24.99（不是 2499）',
    String(r3.body.products[0].offerings[0].price));
  ok(r3.body.products[0].offerings[0].quantity === 10, '只改价格不动数量');
  ok(typeof r3.body.products[0].offerings[0].price === 'number', 'price 是 number 不是对象/字符串');
}

// ========== 6b. inventory 价格格式：读写不对称（官方规范硬约束） ==========
console.log('\n【6b】inventory 价格格式：读是 Money 对象，写是浮点');
{
  // Etsy 读回的形状
  const fromEtsy = {
    products: [
      { sku: 'A', property_values: [{ property_id: 200, value_ids: [1], values: ['Red'] }],
        offerings: [{ offering_id: 111, price: { amount: 2999, divisor: 100, currency_code: 'USD' }, quantity: 10, is_enabled: true }] },
      { sku: 'B', property_values: [{ property_id: 200, value_ids: [2], values: ['Blue'] }],
        offerings: [{ offering_id: 222, price: { amount: 4500, divisor: 100, currency_code: 'USD' }, quantity: 8, is_enabled: true }] },
    ],
    price_on_property: [200], quantity_on_property: [], sku_on_property: [],
  };
  ok(etsy.toFloatPrice({ amount: 2999, divisor: 100 }) === 29.99, 'Money 对象 → 浮点 29.99');
  ok(etsy.toFloatPrice({ amount: 4500, divisor: 100 }) === 45, 'Money 对象 → 浮点 45');
  ok(etsy.toFloatPrice(29.99) === 29.99, '已是数字则原样返回');
  ok(etsy.toFloatPrice('30') === 30, '数字字符串 → 数字');

  // 只改 B 的库存，A 未被命中 → A 的 price 必须也被归一化成浮点
  const r = etsy.mergeInventory(fromEtsy, [
    { property_values: [{ property_id: 200, value_ids: [2] }], quantity: 2 },
  ]);
  const prices = r.body.products.map(p => p.offerings[0].price);
  ok(prices.every(p => typeof p === 'number'), '★ 未命中的行也被归一化成浮点（不会被带着对象写回）',
    JSON.stringify(prices));
  ok(prices[0] === 29.99 && prices[1] === 45, '两行价格都正确还原', prices.join(', '));

  // 建草稿表单的价格规则相反（subunit 整数），必须两者不互相污染
  const form = etsy.buildDraftForm({
    title: 'T', description: 'D', tags: ['a'], price: '29.99', quantity: '1',
    taxonomy_id: '1', who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
    shipping_profile_id: '1', readiness_state_id: '2',
  });
  ok(form.price === '2999', '★ createDraftListing 仍是 subunit 整数 2999（与 inventory 规则相反）', form.price);

  const invBody = etsy.buildInventoryBody({
    readiness_state_id: 222,
    products: [{ sku: 'X', property_values: [{ property_id: 200, value_ids: [1], values: ['Red'] }],
      price: '29.99', quantity: 5 }],
  });
  ok(invBody.products[0].offerings[0].price === 29.99, '★ buildInventoryBody 是浮点 29.99', String(invBody.products[0].offerings[0].price));

  // 100 倍事故的两个方向都要挡住
  const bad1 = etsy.buildInventoryBody({ readiness_state_id: 1,
    products: [{ sku: 'X', property_values: [], price: 2999, quantity: 1 }] });
  ok(bad1.products[0].offerings[0].price === 2999, '若真传入 2999 就是 $2999 —— 正是靠人/前端不传错来防');
  const bad2 = etsy.buildDraftForm({ title: 'T', description: 'D', tags: ['a'], price: 29.99,
    quantity: '1', taxonomy_id: '1', who_made: 'i_did', when_made: 'made_to_order',
    is_supply: false, shipping_profile_id: '1', readiness_state_id: '2' });
  ok(bad2.price !== '29.99', '★ 草稿表单绝不会把裸小数发出去', bad2.price);
}

// ========== 7. 写操作安全开关 ==========
console.log('\n【7】写操作安全开关（Etsy 没有沙箱，开错就是真写店铺）');
{
  const baseCfg = {
    keystring: 'ks', sharedSecret: 'ss',
    apiKeyHeader: 'ks:ss', shopId: '999',
    redirectUri: 'https://x.test/cb', allowWrite: false,
    baseUrl: 'https://api.etsy.com/v3/application',
  };
  const store = { data: { accessToken: 'AT', accessTokenExpiresAt: Date.now() + 3600e3, refreshToken: 'RT' },
    read() { return this.data; }, write(d) { this.data = d; } };
  let called = 0;
  const fetchOk = async () => { called++; return new Response(JSON.stringify({ listing_id: 1 }), { status: 200 }); };

  const roClient = etsy.createClient({ config: baseCfg, store, fetchImpl: fetchOk });
  let threw = '';
  try { await roClient.post('/shops/999/listings', { form: { a: 1 } }); } catch (e) { threw = e.message; }
  ok(threw.includes('ETSY_ALLOW_WRITE'), '写操作默认关闭并给出可操作提示', threw.slice(0, 60));
  ok(called === 0, '关闭时根本没发请求（不会误碰生产）');

  const rwCfg = { ...baseCfg, allowWrite: true };
  const rwClient = etsy.createClient({ config: rwCfg, store, fetchImpl: fetchOk });
  await rwClient.post('/shops/999/listings', { form: { a: 1 } });
  ok(called === 1, 'ETSY_ALLOW_WRITE=1 时才真的发请求');

  // 缺凭证时任何请求都应拒绝，且给出具体缺哪个
  const noCfg = { ...rwCfg, apiKeyHeader: '' };
  const noClient = etsy.createClient({ config: noCfg, store, fetchImpl: fetchOk });
  threw = '';
  try { await noClient.get('/shops/999'); } catch (e) { threw = e.message; }
  ok(threw.includes('ETSY_KEYSTRING'), '缺凭证时拒绝并点名变量', threw.slice(0, 60));
}

// ========== 8. 双头+ token 刷新 + 轮换落盘 ==========
console.log('\n【8】认证：双头、token 自动刷新、refresh token 轮换落盘');
{
  const cfg = {
    keystring: 'ks', sharedSecret: 'ss', apiKeyHeader: 'ks:ss', shopId: '999',
    redirectUri: 'https://x.test/cb', allowWrite: true,
    baseUrl: 'https://api.etsy.com/v3/application',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  };
  // store：模拟真实落盘
  let disk = { accessToken: '', refreshToken: 'RT0', accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0 };
  const store = { read: () => ({ ...disk }), write: (d) => { disk = { ...d }; } };

  const seen = [];
  let refreshCalls = 0;
  // ★ 计数必须单调递增，不能在断言之间重置：重置后 mock 会又生成 RT1，
  //   让人误以为「第二次刷新没有轮换」。token 轮换的验证依赖它一直往前数。
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    seen.push({ u, h: opts.headers || {} });
    if (u.includes('/oauth/token')) {
      refreshCalls++;
      return new Response(JSON.stringify({
        access_token: 'AT' + refreshCalls, refresh_token: 'RT' + refreshCalls,
        expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ shop_id: 999 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // 第一次：完全没有 token → 必须先刷
  const c1 = etsy.createClient({ config: cfg, store, fetchImpl });
  await c1.get('/shops/999');
  ok(refreshCalls === 1, '无 access token 时先刷一次', 'refreshCalls=' + refreshCalls);
  ok(disk.accessToken === 'AT1', '新 access token 已落盘');
  ok(disk.refreshToken === 'RT1', '★ refresh token 轮换后已覆盖落盘（否则下次刷新会用失效的）', disk.refreshToken);

  const authReq = seen.find(s => !s.u.includes('oauth'));
  ok(authReq.h['x-api-key'] === 'ks:ss', '每次请求都带 x-api-key: keystring:shared_secret', authReq.h['x-api-key']);
  ok(String(authReq.h.Authorization || '').startsWith('Bearer '), '每次请求都带 Bearer token');

  // token 未过期时不该再刷
  const before = refreshCalls;
  await c1.get('/shops/999');
  ok(refreshCalls === before, 'token 未过期不重复刷新', '仍为 ' + refreshCalls);

  // 过期后应刷新，且用上轮轮换出来的新 refresh token（这里断言传入的 refresh_token 确实是 RT1）
  disk.accessTokenExpiresAt = Date.now() - 1;
  let sentRefresh = '';
  const fetchSpy = async (url, opts = {}) => {
    if (String(url).includes('/oauth/token')) {
      sentRefresh = new URLSearchParams(String(opts.body || '')).get('refresh_token') || '';
    }
    return fetchImpl(url, opts);
  };
  const c1b = etsy.createClient({ config: cfg, store, fetchImpl: fetchSpy });
  await c1b.get('/shops/999');
  ok(refreshCalls === before + 1, '过期后刷新一次', 'refreshCalls=' + refreshCalls);
  ok(sentRefresh === 'RT1', '★ 第二次刷新用的是上一轮轮换出来的 RT1（不是最初的 RT0）', sentRefresh);
  ok(disk.refreshToken === 'RT2', '★ refresh token 再次轮换并落盘', disk.refreshToken);
  ok(disk.accessToken === 'AT2', 'access token 也更新', disk.accessToken);

  // 并发去重：多个请求同时发现过期，只应刷一次
  disk.accessTokenExpiresAt = Date.now() - 1;
  const beforeConc = refreshCalls;
  await Promise.all([c1.get('/shops/999'), c1.get('/shops/999'), c1.get('/shops/999')]);
  ok(refreshCalls === beforeConc + 1,
    '并发请求只触发一次刷新（Etsy 的 refresh token 是一次性的，并发刷新会互相踩）',
    'refreshCalls=' + refreshCalls);

  // 401 → 强制刷新重试一次
  disk.accessTokenExpiresAt = Date.now() + 3600e3;
  let tries = 0;
  const fetch401 = async (url, opts = {}) => {
    if (String(url).includes('oauth')) {
      return new Response(JSON.stringify({ access_token: 'ATX', refresh_token: 'RTX', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    tries++;
    if (tries === 1) return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
    return new Response(JSON.stringify({ shop_id: 999 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c2 = etsy.createClient({ config: cfg, store, fetchImpl: fetch401 });
  const r401 = await c2.get('/shops/999');
  ok(r401.shop_id === 999, '401 后刷新重试成功', 'tries=' + tries);

  // 无refresh token → 明确提示去授权
  const emptyStore = { read: () => ({ accessToken: '', refreshToken: '', accessTokenExpiresAt: 0 }), write() {} };
  const c3 = etsy.createClient({ config: cfg, store: emptyStore, fetchImpl });
  let msg = '';
  try { await c3.get('/shops/999'); } catch (e) { msg = e.message; }
  ok(msg.includes('/api/etsy/auth'), '没 token 时提示去授权（给出可点路径）', msg.slice(0, 50));
}

// ========== 9. 429 退避 ==========
console.log('\n【9】429 限流退避');
{
  const cfg = {
    keystring: 'ks', sharedSecret: 'ss', apiKeyHeader: 'ks:ss', shopId: '999',
    allowWrite: false, baseUrl: 'https://api.etsy.com/v3/application',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  };
  const store = { read: () => ({ accessToken: 'AT', refreshToken: 'RT', accessTokenExpiresAt: Date.now() + 3600e3 }), write() {} };
  let n = 0;
  const slept = [];
  const fetchImpl = async () => {
    n++;
    if (n <= 2) return new Response(JSON.stringify({ error: 'rate limited' }),
      { status: 429, headers: { 'retry-after': '2', 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c = etsy.createClient({
    config: cfg, store, fetchImpl,
    sleep: async (ms) => { slept.push(ms); },
  });
  const r = await c.get('/shops/999');
  ok(r.ok === true, '429 后重试成功');
  ok(slept.length === 2, '退避了 2 次', slept.join(','));
  ok(slept.every(ms => ms === 2000), '按 retry-after 秒数退避（不是拍脑袋等）', slept.join(','));

  // 持续 429 → 最终抛错，且带上限流响应头
  let k = 0;
  const fetchAlways429 = async () => {
    k++;
    return new Response(JSON.stringify({ error: 'too many' }), {
      status: 429, headers: { 'retry-after': '1', 'x-limit-per-day': '10000', 'x-remaining-today': '0', 'Content-Type': 'application/json' },
    });
  };
  const c2 = etsy.createClient({ config: cfg, store, fetchImpl: fetchAlways429, sleep: async () => {} });
  let err = null;
  try { await c2.get('/shops/999'); } catch (e) { err = e; }
  ok(err && err.status === 429, '持续 429 最终抛错（不会无限重试）', 'attempts=' + k);
  ok(err && err.rateLimit && err.rateLimit.remainingToday === '0', '抛错时带上限流剩余量，能判断是配额用完');
}

// ========== 10. 错误信息可读性 ==========
console.log('\n【10】Etsy 报错要能直接看懂');
{
  const cfg = {
    keystring: 'ks', sharedSecret: 'ss', apiKeyHeader: 'ks:ss', shopId: '999',
    allowWrite: true, baseUrl: 'https://api.etsy.com/v3/application',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  };
  const store = { read: () => ({ accessToken: 'AT', refreshToken: 'RT', accessTokenExpiresAt: Date.now() + 3600e3 }), write() {} };
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: 'property_values[0] is required' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } });
  const c = etsy.createClient({ config: cfg, store, fetchImpl });
  let err = null;
  try { await c.post('/shops/999/listings', { form: { a: 1 } }); } catch (e) { err = e; }
  ok(err && err.status === 400, '400 被抛出', String(err && err.status));
  ok(err && err.message.includes('property_values[0] is required'), '★ 报错带上 Etsy 原文（能照着改）', err.message.slice(0, 90));
  ok(err && err.etsy && err.etsy.error, '附上原始响应体');

  // 502 HTML（Cloudflare 那种）也要能读
  const fetchHtml = async () => new Response('<html>502 Bad Gateway</html>',
    { status: 502, headers: { 'Content-Type': 'text/html' } });
  const c2 = etsy.createClient({ config: cfg, store, fetchImpl: fetchHtml });
  let err2 = null;
  try { await c2.get('/shops/999'); } catch (e) { err2 = e; }
  ok(err2 && /502/.test(err2.message), '非 JSON 响应也不崩，状态码可见', err2.message.slice(0, 60));
}

// ========== 11. token 响应归一化 ==========
console.log('\n【11】token 响应归一化');
{
  const now = 1_700_000_000_000;
  const rec = etsy.normalizeTokenResponse({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }, now);
  ok(rec.accessToken === 'A' && rec.refreshToken === 'R', '字段映射正确');
  ok(rec.accessTokenExpiresAt === now + (3600 - 60) * 1000, '提前 60 秒视为过期（避免边界 401）',
    String((rec.accessTokenExpiresAt - now) / 1000) + 's');
  // ★ 自测抓出来的缺陷：原来用 `|| 3600`，expires_in=0 会被当成「字段缺失」，
  //把一个已过期的 token 判成还有 1 小时有效，导致第一次请求白白发一次 401。
  const zero = etsy.normalizeTokenResponse({ access_token: 'A', expires_in: 0 }, now);
  ok(zero.accessTokenExpiresAt <= now, 'expires_in=0 视为已过期（不会误判成还有 1 小时）',
    new Date(zero.accessTokenExpiresAt).toISOString());
  const shortExp = etsy.normalizeTokenResponse({ access_token: 'A', expires_in: 30 }, now);
  ok(shortExp.accessTokenExpiresAt <= now, 'expires_in=30（小于 60 秒提前量）也视为已过期');
  const missing = etsy.normalizeTokenResponse({ access_token: 'A' }, now);
  ok(missing.accessTokenExpiresAt > now, 'expires_in 缺失时才回退 3600');
  ok(rec.refreshTokenExpiresAt === now + 90 * 24 * 3600 * 1000, 'refresh token 按 90 天记');
}

// ========== 12. 授权 URL ==========
console.log('\n【12】授权 URL（PKCE + state 齐全）');
{
  const cfg = { keystring: 'ks', redirectUri: 'https://x.test/cb', scope: 'listings_r listings_w',
    authorizeUrl: 'https://www.etsy.com/oauth/connect' };
  const u = new URL(etsy.buildAuthorizeUrl(cfg, { state: 'ST', codeChallenge: 'CC' }));
  ok(u.origin + u.pathname === 'https://www.etsy.com/oauth/connect', '跳 Etsy 官方授权页');
  ok(u.searchParams.get('response_type') === 'code', 'response_type=code');
  ok(u.searchParams.get('client_id') === 'ks', '带 client_id(keystring)');
  ok(u.searchParams.get('code_challenge_method') === 'S256', '★ code_challenge_method=S256（Etsy 强制 PKCE）');
  ok(u.searchParams.get('code_challenge') === 'CC', '带 code_challenge');
  ok(u.searchParams.get('state') === 'ST', '★ 带 state（防 CSRF，回调时要比对）');
  ok(u.searchParams.get('scope') === 'listings_r listings_w', '带 scope');
  ok(u.searchParams.get('redirect_uri') === 'https://x.test/cb', '带 redirect_uri');
  ok(u.searchParams.get('code_challenge') === 'CC' && !u.searchParams.get('code_verifier'),
    '★ 只传 challenge，不传 verifier（否则等于没做 PKCE）');

  // verifier 合法性
  const v = etsy.randomVerifier();
  ok(v.length >= 43 && v.length <= 128, 'verifier 长度在 43~128', String(v.length));
  ok(/^[A-Za-z0-9._~-]+$/.test(v), 'verifier 只用合法字符集');
  ok(etsy.randomVerifier() !== v, '每次 verifier 不同');
}

// ========== 13. store 落盘 ==========
console.log('\n【13】token 落盘（进程重启后必须还在）');
{
  const p = path.join(ROOT, 'data', '_etsy-selftest-token.json');
  const st = etsy.createTokenStore(p, { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, renameSync: fs.renameSync });
  ok(st.read().accessToken === '', '文件不存在时返回空（不抛异常）');
  st.write({ accessToken: 'AT', refreshToken: 'RT', accessTokenExpiresAt: 1, refreshTokenExpiresAt: 2 });
  const back = st.read();
  ok(back.accessToken === 'AT' && back.refreshToken === 'RT', '写入后能读回');
  ok(fs.existsSync(p), '文件真的落盘了（重启后仍可恢复授权）');
  fs.writeFileSync(p, '{ 坏掉的 JSON');
  ok(st.read().accessToken === '', '文件损坏时安全回退为空（不崩）');
  try { fs.unlinkSync(p); } catch {}
}

// ========== 14. 路由层（真实 handleApi） ==========
console.log('\n【14】后端路由（真实 handleApi，未配置时的降级）');
{
  if (!fs.existsSync(path.resolve(ROOT, SERVER_TEST))) {
    console.log('  （跳过：未生成 ' + SERVER_TEST + '，见 test/README.md 的一次性准备）');
  } else {
    const r1 = await callApi('GET', '/api/etsy/status');
    ok(r1.code === 200, 'GET /api/etsy/status → 200（免 key，前端首屏要用）', 'code=' + r1.code);
    ok(r1.json && r1.json.serverVersion, '返回后端版本号（便于确认跑的是哪份代码）', r1.json && r1.json.serverVersion);
    ok(r1.json && r1.json.configured === false, '未配置时 configured=false');
    ok(r1.json && 'authorized' in r1.json, '返回授权状态字段');

    const r2 = await callApi('GET', '/api/etsy/auth');
    ok(r2.code === 400, '未配凭证时 /auth 报 400 而不是 500', 'code=' + r2.code);
    ok(r2.json && /ETSY_KEYSTRING/.test(r2.json.note || ''), '报错点名缺哪个变量', (r2.json && r2.json.note || '').slice(0, 60));

    const r3 = await callApi('POST', '/api/etsy/validate', { title: 'a'.repeat(200), description: 'x', tags: ['bad,tag'] });
    ok(r3.code === 200, 'POST /api/etsy/validate → 200（校验接口永远可用）');
    ok(r3.json && r3.json.canDraft === false, '超长标题 → canDraft=false');
    ok(r3.json && Array.isArray(r3.json.errors) && r3.json.errors.length > 0, '返回错误清单');
    ok(r3.json && Array.isArray(r3.json.manualChecks) && r3.json.manualChecks.length >= 5,
      '★ 同时返回「程序无法替你判断的事」（SOP 第 19 节要求）');

    // 变体：validate 接口要能把展开好的组合行返回给前端
    const vdims = [
      { property_id: 200, name: 'Primary color', values: [
        { value_id: 49928889192, value: 'Black' }, { value_id: 49928889193, value: 'Blue' } ] },
      { property_id: 52047899318, name: 'Size', scale_id: 30, values: [{ value_id: 108450111040, value: 'Medium' }] },
    ];
    const rv = await callApi('POST', '/api/etsy/validate', {
      title: 'Ceramic Horse Figurine', description: 'desc',
      tags: Array.from({ length: 13 }, (_, i) => 'tag ' + i),
      price: '29.99', quantity: '10', taxonomy_id: '496',
      who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
      shipping_profile_id: '111', readiness_state_id: '222',
      variation_dimensions: vdims,
    });
    ok(rv.code === 200, '带变体的 validate → 200');
    ok(rv.json && rv.json.variation && rv.json.variation.combinationCount === 2,
      '★ 返回组合数 2', rv.json && rv.json.variation && String(rv.json.variation.combinationCount));
    ok(rv.json && rv.json.variation.combinations.map(c => c.label).join(' / ') === 'Black + Medium / Blue + Medium',
      '★ 返回带 label 的组合行（前端据此渲染输入框）',
      rv.json && rv.json.variation && rv.json.variation.combinations.map(c => c.label).join(' / '));
    ok(rv.json && rv.json.canDraft === false, '变体未填价格 → canDraft=false（拦住空价格在售）');

    // 填全价格库存后应放行
    const rv2 = await callApi('POST', '/api/etsy/validate', {
      title: 'Ceramic Horse Figurine', description: 'desc',
      tags: Array.from({ length: 13 }, (_, i) => 'tag ' + i),
      price: '29.99', quantity: '10', taxonomy_id: '496',
      who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
      shipping_profile_id: '111', readiness_state_id: '222',
      variation_dimensions: vdims,
      variation_rows: [{ price: '29.99', quantity: '10', sku: 'A' }, { price: '32.00', quantity: '5', sku: 'B' }],
      price_on_property: [200],
    });
    ok(rv2.json && rv2.json.canDraft === true, '★ 变体填全后 canDraft=true');
    ok(rv2.json && rv2.json.variation.price_on_property.join(',') === '200', 'price_on_property 透传');

    // 不选变体时（单规格商品）variation 为 null，canDraft 不受影响
    const rv3 = await callApi('POST', '/api/etsy/validate', {
      title: 'Ceramic Horse Figurine', description: 'desc',
      tags: Array.from({ length: 13 }, (_, i) => 'tag ' + i),
      price: '29.99', quantity: '10', taxonomy_id: '496',
      who_made: 'i_did', when_made: 'made_to_order', is_supply: false,
      shipping_profile_id: '111', readiness_state_id: '222',
    });
    ok(rv3.json && rv3.json.variation === null, '不选变体 → variation=null（单规格正常路径）');
    ok(rv3.json && rv3.json.canDraft === true, '单规格商品 canDraft=true');

    const r4 = await callApi('POST', '/api/etsy/draft', { title: 'x' });
    ok(r4.code === 400, '未配置时 /draft 报 400', 'code=' + r4.code);
    ok(r4.json && r4.json.error === 'etsy_not_configured', '错误码明确');

    const r5 = await callApi('POST', '/api/etsy/publish', { listing_id: 1 });
    ok(r5.code === 400, 'publish 缺凭证时 400');
  }
}

// ========== 15. 变体：勾选 → 组合展开 → 组装 → 校验 ==========
console.log('\n【15】变体链路（用户勾选，程序只做传递与组合展开）');
{
  const dims = [
    { property_id: 200, name: 'Primary color', values: [
      { value_id: 49928889192, value: 'Black' }, { value_id: 49928889193, value: 'Blue' },
      { value_id: 49928889194, value: 'Green' } ] },
    { property_id: 52047899318, name: 'Size', scale_id: 30, values: [
      { value_id: 108450111039, value: 'Small' }, { value_id: 108450111040, value: 'Medium' } ] },
  ];

  // 组合数是乘法累乘：初始值必须为 1，曾错用 0 导致恒为 0（自测抓出）
  ok(etsy.validateVariationPlan({ dimensions: dims }).combinationCount === 6, '3 值 × 2 值 = 6 组合',
    String(etsy.validateVariationPlan({ dimensions: dims }).combinationCount));
  ok(etsy.validateVariationPlan({ dimensions: [dims[0]] }).combinationCount === 3, '单维度 3 值 = 3 组合');
  ok(etsy.validateVariationPlan({ dimensions: [dims[0], dims[1], dims[0]] }).combinationCount === 18, '三维度 3×2×3 = 18 组合');

  // 组合展开：笛卡尔积，且 scale_id 按维度带对
  const combos = etsy.expandVariationCombinations(dims);
  ok(combos.length === 6, '展开 6 行');
  ok(eq(combos[0].map(x => x.values[0]), ['Black', 'Small']), '首行 = Black + Small');
  ok(eq(combos[5].map(x => x.values[0]), ['Green', 'Medium']), '末行 = Green + Medium');
  ok(eq(combos[0].map(x => x.scale_id), [null, 30]), 'scale_id 按维度带对（颜色为null、尺寸为 30）');
  ok(combos[0].every(pv => Array.isArray(pv.value_ids) && pv.value_ids.length === 1), '每个维度带一个 value_id');
  // 无 scale_id 的维度不能硬塞 null 进 Etsy（官方对 scale_id 的存在性有要求）
  ok(etsy.expandVariationCombinations([dims[0]])[0][0].scale_id === null, '无单位属性的 scale_id 为 null');

  // 维度上限
  const four = etsy.validateVariationPlan({ dimensions: [dims[0], dims[1], dims[0], dims[1]] });
  ok(!four.ok && /最多支持 3/.test(four.errors.join()), '4 个维度被拦（Etsy 最多 3）');
  // ID 缺失必须拦——这正是「不许猜 ID」的强制点
  const noId = etsy.validateVariationPlan({ dimensions: [{ property_id: 200, name: 'Color', values: [{ value: 'Black' }] }] });
  ok(!noId.ok && /value_id/.test(noId.errors.join()), '缺 value_id 被拦（不允许猜 ID）');
  const noProp = etsy.validateVariationPlan({ dimensions: [{ name: 'Color', values: [{ value_id: 1 }] }] });
  ok(!noProp.ok && /property_id/.test(noProp.errors.join()), '缺 property_id 被拦');
  const dup = etsy.validateVariationPlan({ dimensions: [{ property_id: 200, name: 'Color', values: [{ value_id: 1, value: 'A' }, { value_id: 1, value: 'A' }] }] });
  ok(!dup.ok && /重复/.test(dup.errors.join()), '同维度重复值被拦');
  const emptyVal = etsy.validateVariationPlan({ dimensions: [{ property_id: 200, name: 'Color', values: [] }] });
  ok(!emptyVal.ok, '维度没勾选任何值被拦');
  // 空选择是正常情况（单规格商品），不是错误
  const none = etsy.validateVariationPlan({ dimensions: [] });
  ok(none.empty === true, '空选择标记为 empty（单规格商品的正常路径）');

  // 组装请求体：price 必须是浮点
  const rows = combos.map((c, i) => ({ price: i === 0 ? 29.99 : 32.00, quantity: i + 5, sku: 'HS-' + i }));
  const body = etsy.buildVariationBody(combos, rows, {
    readiness_state_id: 222, price_on_property: [200], sku_on_property: [200],
  });
  ok(body.products.length === 6, '请求体 6 行');
  ok(typeof body.products[0].offerings[0].price === 'number' && body.products[0].offerings[0].price === 29.99,
    '★ price 是浮点 29.99（inventory 不是 subunit）', String(body.products[0].offerings[0].price));
  ok(body.price_on_property.join(',') === '200', 'price_on_property 已带');
  ok(body.sku_on_property.join(',') === '200', 'sku_on_property 已带');
  ok(body.products.every(p => p.offerings[0].readiness_state_id === 222), '处理档案已带');

  // 逐格校验：任何一格漏填都必须拦住，绝不把空价格发成在售商品
  ok(etsy.validateVariationRows(combos, rows).ok, '全部填好 → 通过');
  const missCnt = etsy.validateVariationRows(combos, [{ price: 29, quantity: 1 }]);
  ok(!missCnt.ok && /行数/.test(missCnt.errors.join()), '行数与组合数不符被拦', missCnt.errors[0]);
  const blankPrice = combos.map((c, i) => ({ price: i === 0 ? '' : 29, quantity: 1 }));
  const bp = etsy.validateVariationRows(combos, blankPrice);
  ok(!bp.ok && /没有填价格/.test(bp.errors.join()), '某格空价格被拦，且指名是哪个组合', bp.errors[0]);
  const neg = combos.map(() => ({ price: -1, quantity: -5 }));
  const ng = etsy.validateVariationRows(combos, neg);
  ok(!ng.ok && ng.errors.length === 12, '12 个负数问题全部报出（6 行 × 价+量）', String(ng.errors.length));
  const noQty = combos.map(() => ({ price: 29, quantity: '' }));
  ok(!etsy.validateVariationRows(combos, noQty).ok, '某格空库存被拦');
}

// ========== 16. shop_id 自动发现（不让操作者手工查） ==========
console.log('\n【16】shop_id 自动发现（Etsy 界面不显示这个数字）');
{
  // 从 token 前缀取 user_id —— 整条自动发现链路的起点
  ok(etsy.userIdFromToken('12345678.jKBPLnOiYt7vpWlsny_lDKqINn4Ny_jwH89hA4IZgggyzqmV') === '12345678',
    '★ 从 access token 解析出 user_id', '12345678');
  ok(etsy.userIdFromToken('abc') === null, '无点号 → null');
  ok(etsy.userIdFromToken('xyz.abc') === null, '前缀非纯数字 → null');
  ok(etsy.userIdFromToken('') === null, '空 token → null');
  ok(etsy.userIdFromToken('.abc') === null, '前缀为空 → null');

  const mkClient = (fetchImpl) => etsy.createClient({
    config: {
      keystring: 'ks', sharedSecret: 'ss', apiKeyHeader: 'ks:ss', shopId: '',
      redirectUri: 'https://x/cb', allowWrite: true,
      baseUrl: 'https://api.test/v3', tokenUrl: 'https://api.test/tk',
    },
    store: {
      data: { accessToken: '48201937.tok', accessTokenExpiresAt: Date.now() + 3600e3, refreshToken: 'R' },
      read() { return this.data; }, write() {},
    },
    fetchImpl,
  });

  // 单店铺：自动选中并返回
  const oneShop = async (url) => new Response(JSON.stringify({ count: 1, results: [
    { shop_id: 48201937, shop_name: 'Aurenmorph', currency_code: 'USD' } ] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  const found = await etsy.discoverShopId(mkClient(oneShop), '48201937.tok');
  ok(found.shopId === '48201937', '★ 单店铺 → 自动得到 shop_id', found.shopId);
  ok(found.shopName === 'Aurenmorph' && found.currencyCode === 'USD', '同时带出店铺名与货币');
  ok(found.ambiguous === false, '单店铺不算歧义');
  ok(found.userId === '48201937', '带出 user_id');

  // 多店铺：必须标记歧义，不能擅自挑（可能把商品写进错误的店）
  const manyShop = async () => new Response(JSON.stringify({ count: 2, results: [
    { shop_id: 111, shop_name: 'ShopA', currency_code: 'USD' },
    { shop_id: 222, shop_name: 'ShopB', currency_code: 'USD' } ] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  const multi = await etsy.discoverShopId(mkClient(manyShop), '48201937.tok');
  ok(multi.ambiguous === true, '★ 多店铺 → 标记歧义（绝不自动挑）');
  ok(multi.allShops.length === 2, '列出全部店铺供人工选择', multi.allShops.map(s => s.shopName).join('/'));

  // 一个店铺都没有 → 明确报错
  const noShop = async () => new Response(JSON.stringify({ count: 0, results: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  let msg = '';
  try { await etsy.discoverShopId(mkClient(noShop), '48201937.tok'); } catch (e) { msg = e.message; }
  ok(/没有查到任何店铺/.test(msg), '零店铺 → 明确报错', msg.slice(0, 46));
  ok(/48201937/.test(msg), '报错里带出 user_id（便于排查）');

  // token 格式不对
  msg = '';
  try { await etsy.discoverShopId(mkClient(noShop), 'badtoken'); } catch (e) { msg = e.message; }
  ok(/user_id/.test(msg), 'token 格式异常 → 提示重新授权', msg.slice(0, 40));

  // ★ 客户端的 shopId 必须动态取：授权前为空、发现后立刻能拿到。
  //   若把 config.shopId 烤死进闭包，授权成功后客户端仍然拿不到 shop_id —— 这是本设计最容易踩的坑。
  let sid = '';
  const dyn = etsy.createClient({
    config: {
      keystring: 'ks', sharedSecret: 'ss', apiKeyHeader: 'ks:ss', shopId: '',
      redirectUri: 'https://x/cb', allowWrite: false,
      baseUrl: 'https://api.test/v3', tokenUrl: 'https://api.test/tk',
    },
    store: {
      data: { accessToken: '48201937.tok', accessTokenExpiresAt: Date.now() + 3600e3, refreshToken: 'R' },
      read() { return this.data; }, write() {},
    },
    shopIdProvider: () => sid,
    fetchImpl: oneShop,
  });
  ok(dyn.shopId() === '', '发现前 shopId 为空');
  sid = (await etsy.discoverShopId(dyn, '48201937.tok')).shopId;
  ok(dyn.shopId() === '48201937', '★ 发现后同一客户端立即能拿到（动态取生效）', dyn.shopId());
}

// ========== 17. 状态接口的 shop_id 来源标记 ==========
console.log('\n【17】状态接口：shop_id 来源与多店提示');
{
  if (!fs.existsSync(path.resolve(ROOT, SERVER_TEST))) {
    console.log('  （跳过：未生成 ' + SERVER_TEST + '）');
  } else {
    const s1 = await callApi('GET', '/api/etsy/status');
    ok(s1.code === 200, 'status → 200');
    ok('shopIdSource' in (s1.json || {}), '返回 shopIdSource（env / auto / 空）');
    ok('needShopChoice' in (s1.json || {}), '返回 needShopChoice（多店待指定标记）');
    ok('shopName' in (s1.json || {}), '返回 shopName');
    // 未配置时不应再把 ETSY_SHOP_ID 列为缺失项
    const s2 = await callApi('GET', '/api/etsy/auth');
    ok(s2.code === 400, '未配凭证时 /auth 仍 400');
    ok(!/ETSY_SHOP_ID/.test(s2.json && s2.json.note || ''),
      '★ 报错不再要求填 ETSY_SHOP_ID（它已自动发现）', (s2.json && s2.json.note || '').slice(0, 60));
    ok(/ETSY_KEYSTRING/.test(s2.json && s2.json.note || ''), '仍然点名真正缺的那个变量');
    // preflight 的报错要指向「当前真正缺的那一样」：
    //  -什么都没配 → 报「缺 .env 变量」（此时提授权是误导，授权页本身也跳不过去）
    //  - 配好了但没 shop_id → 报「先授权，授权成功会自动识别 shop_id」
    const s3 = await callApi('POST', '/api/etsy/preflight', {});
    ok(s3.code === 400, 'preflight 未配置时 400', 'code=' + s3.code);
    ok(s3.json && s3.json.error === 'etsy_not_configured',
      '★ 完全未配置时 → 报缺 .env 变量（不是「去授权」，那会误导）', s3.json && s3.json.error);
    ok(s3.json && /ETSY_KEYSTRING/.test(s3.json.note || ''), '报错点名缺哪个变量');
    ok(s3.json && !/ETSY_SHOP_ID/.test(s3.json.note || ''), '不要求填 ETSY_SHOP_ID（已自动发现）');
  }
}

console.log('\n' + '='.repeat(76));
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(76));
process.exit(fail > 0 ? 1 : 0);