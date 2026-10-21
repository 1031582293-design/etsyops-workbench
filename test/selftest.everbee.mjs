/* EverBee MCP 模块自测（零网络依赖，纯 mock fetchImpl）
 *
 * 覆盖：纯函数、授权码兑换、token 刷新、网络错误重试、空响应重试、
 *       批量顺序、未授权/禁止访问映射、状态接口。
 * 运行：node test/selftest.everbee.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { createEverbee, normalizeKeyword, parseRpcBody, MCP_ENDPOINT } from '../etsy-everbee.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const storeFile = join(__dir, '..', '.tmp-everbee-test.json');

let pass = 0, fail = 0;
function check(ok, name, extra = '') {
  if (ok) { pass++; console.log('  \u2713 ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

function mockFetch() {
  const calls = [];
  const routes = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body || '', headers: opts.headers || {} });
    for (const r of routes) {
      if (r.test && !r.test(url, opts)) continue;
      if (r.err) { const e = new Error(r.err); throw e; }
      const body = typeof r.body === 'function' ? r.body(url, opts) : r.body;
      return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, text: async () => body ?? '{}' };
    }
    return { status: 404, ok: false, text: async () => '{}' };
  };
  f.calls = calls;
  f.on = (route) => { routes.push(route); return f; };
  return f;
}

/* 构造一份已授权的状态文件 */
function seedState(tok = null) {
  const st = {
    clientId: 'test-client',
    redirectUri: 'http://127.0.0.1:3000/api/everbee/callback',
    pending: null,
    token: tok || {
      access: 'ACC', refresh: 'REF', scope: 'keywords:read', clientId: 'test-client',
      obtainedAt: Date.now(), expiresAt: Date.now() + 86400000 * 60,
    },
  };
  return JSON.stringify(st);
}

async function main() {
  // 预置一个「已注册客户端、未授权」的状态文件，让 authUrl 走 PKCE 分支而不是注册
  rmSync(storeFile, { force: true });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(storeFile), { recursive: true });
  writeFileSync(storeFile, JSON.stringify({
    clientId: 'test-client',
    redirectUri: 'http://127.0.0.1:3000/api/everbee/callback',
  }));

  console.log('【1】纯函数');
  check(normalizeKeyword(null) === null, 'normalizeKeyword(null) → null');
  const n = normalizeKeyword({ keyword: 'x', vol: '123', competition: 456, score: '240.0' });
  check(n.vol === 123 && n.competition === 456 && n.score === 240, '字符串数值转数字', JSON.stringify(n));
  const sse = parseRpcBody('event: message\ndata: {"result":{"a":1}}\n\n');
  check(sse.length === 1 && sse[0].result.a === 1, 'SSE 响应解析');
  const j = parseRpcBody('{"result":{"b":2}}');
  check(j.length === 1 && j[0].result.b === 2, '纯 JSON 响应解析');

  console.log('【2】authUrl 生成 PKCE 链接');
  const fx = mockFetch();
  const eb1 = createEverbee({ storeFile, fetchImpl: fx });
  const url = await eb1.authUrl('http://127.0.0.1:3000/api/everbee/callback');
  const u = new URL(url);
  check(u.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256');
  check(Boolean(u.searchParams.get('code_challenge')) && Boolean(u.searchParams.get('state')), '有 challenge + state');

  console.log('【3】exchangeCode 换 token');
  const fx2 = mockFetch().on({
    test: (u) => u.includes('/token'), method: 'POST',
    body: JSON.stringify({ access_token: 'NEWACC', refresh_token: 'NEWREF', expires_in: 5184000, scope: 'keywords:read' }),
  });
  const eb2 = createEverbee({ storeFile, fetchImpl: fx2 });
  const tok = await eb2.exchangeCode('code123', null);
  check(tok.access === 'NEWACC', '换到 access_token');
  const st2 = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(storeFile, 'utf8')));
  check(st2.token.access === 'NEWACC' && !st2.pending, 'token 已落盘、pending 已清');

  console.log('【4】网络错误重试（3 次内成功）');
  let attempts = 0;
  const fx3 = mockFetch().on({
    test: (u, o) => o && o.body && o.body.includes('"tools/call"'),
    err: 'SSL EOF', // 但只在前两次抛，第三次靠下面这个
  });
  // 重新构造：前两次抛错，第三次返回成功
  const fx3b = mockFetch();
  const eb3 = createEverbee({ storeFile, fetchImpl: fx3b });
  fx3b.on({ test: (u, o) => o && o.body && o.body.includes('"initialize"'), body: '{"result":{"serverInfo":{"name":"x","version":"1"}}}' });
  let toolCalls = 0;
  fx3b.on({
    test: (u, o) => o && o.body && o.body.includes('"tools/call"'),
    body: () => { toolCalls++; if (toolCalls < 3) { const e = new Error('SSL EOF'); throw e; } return '{"result":{"content":[{"type":"text","text":"{\\"x\\":1}"}]}}'; },
  });
  const r4 = await eb3.callTool('get_keyword', { keyword: 'a', params: {} });
  check(toolCalls === 3 && r4.x === 1, '前两次失败第三次成功', 'toolCalls=' + toolCalls);

  console.log('【5】keyword 空响应重试一次（并发时偶发空壳）');
  let kwCalls = 0;
  const fx5 = mockFetch();
  const eb5 = createEverbee({ storeFile, fetchImpl: fx5 });
  fx5.on({ test: (u, o) => o && o.body && o.body.includes('"initialize"'), body: '{"result":{"serverInfo":{"name":"x","version":"1"}}}' });
  fx5.on({
    test: (u, o) => o && o.body && o.body.includes('"tools/call"'),
    body: () => {
      kwCalls++;
      if (kwCalls === 1) return '{"result":{"content":[{"type":"text","text":"{\\"total_count\\":null,\\"results\\":[]}"}]}}';
      return '{"result":{"content":[{"type":"text","text":"{\\"searched_keyword\\":[{\\"keyword\\":\\"fursuit head\\",\\"vol\\":1170,\\"competition\\":4874,\\"score\\":240}],\\"results\\":[]}"}]}}';
    },
  });
  const r5 = await eb5.keyword('fursuit head');
  check(kwCalls === 2, '空壳触发一次重试', 'kwCalls=' + kwCalls);
  check(r5.exact && r5.exact.vol === 1170, '重试后拿到精确值', JSON.stringify(r5.exact));

  console.log('【6】lookup 顺序保持 + 未收录处理');
  const fx6 = mockFetch();
  const eb6 = createEverbee({ storeFile, fetchImpl: fx6 });
  fx6.on({ test: (u, o) => o && o.body && o.body.includes('"initialize"'), body: '{"result":{"serverInfo":{"name":"x","version":"1"}}}' });
  fx6.on({
    test: (u, o) => o && o.body && o.body.includes('"tools/call"'),
    body: (u, o) => {
      const args = JSON.parse(o.body).params.arguments;
      const kw = args.keyword;
      if (kw === 'miss-term') return '{"result":{"content":[{"type":"text","text":"{\\"results\\":[{\\"keyword\\":\\"nearby\\",\\"vol\\":5}]}"}]}}';
      return '{"result":{"content":[{"type":"text","text":"{\\"searched_keyword\\":[{\\"keyword\\":\\"' + kw + '\\",\\"vol\\":100}],\\"results\\":[]}"}]}}';
    },
  });
  const r6 = await eb6.lookup(['a', 'miss-term', 'c'], {}, { concurrency: 2 });
  check(r6.length === 3, '返回条数与输入一致', 'len=' + r6.length);
  check(r6[0].term === 'a' && r6[0].exact.vol === 100, '顺序保持 + 首条有值');
  check(r6[1].ok && !r6[1].exact && r6[1].nearest === 'nearby', '未收录 → 给最接近词', r6[1].nearest);
  check(r6[2].term === 'c', '第三条顺序正确');

  console.log('【7】未授权 / 禁止访问错误映射');
  const noTok = createEverbee({ storeFile: join(__dir, '..', '.tmp-everbee-empty.json'), fetchImpl: mockFetch() });
  rmSync(join(__dir, '..', '.tmp-everbee-empty.json'), { force: true });
  let e;
  try { await noTok.keyword('x'); } catch (err) { e = err; }
  check(e && e.code === 'everbee_not_authorized', '无 token → everbee_not_authorized', e && e.code);

  console.log('【8】status 不吐 token');
  const stNow = await eb6.status();
  check(stNow.authorized === true && stNow.daysLeft > 0, '已授权状态');
  check(!('access' in (stNow.token || {})) && !stNow.token, '★ 不暴露 token 字段', JSON.stringify(Object.keys(stNow)));

  console.log('【9】★ 空壳/异常返回必须报错，不能静默返回空（「什么词都查不到」的真因）');
  const mk = (bodyFn) => {
    const f = mockFetch();
    f.on({ test: (u, o) => o && o.body && o.body.includes('"initialize"'), body: '{"result":{"serverInfo":{"name":"x","version":"1"}}}' });
    f.on({ test: (u, o) => o && o.body && o.body.includes('"tools/call"'), body: bodyFn });
    return f;
  };
  // 9.1 isError
  const fErr = mk('{"result":{"isError":true,"content":[{"type":"text","text":"Rate limit exceeded"}]}}');
  let eToolErr = null;
  try { await createEverbee({ storeFile, fetchImpl: fErr }).callTool('get_keyword', {}); } catch (e) { eToolErr = e; }
  check(eToolErr && eToolErr.code === 'everbee_tool_error' && /Rate limit/.test(eToolErr.message), 'isError → everbee_tool_error', eToolErr && eToolErr.code);
  // 9.2 纯文本报错（没有 JSON-RPC error 字段）
  const fTxt = mk('{"result":{"content":[{"type":"text","text":"Error: quota exceeded for this month"}]}}');
  let eTxt = null;
  try { await createEverbee({ storeFile, fetchImpl: fTxt }).callTool('get_keyword', {}); } catch (e) { eTxt = e; }
  check(eTxt && eTxt.code === 'everbee_tool_error', '纯文本报错 → 抛错（以前会静默返回 _text）', eTxt && eTxt.code);
  // 9.3 content 空 + structuredContent 空
  const fEmpty = mk('{"result":{"content":[],"structuredContent":{}}}');
  let eEmpty = null;
  try { await createEverbee({ storeFile, fetchImpl: fEmpty }).callTool('get_keyword', {}); } catch (e) { eEmpty = e; }
  check(eEmpty && eEmpty.code === 'everbee_empty_payload', '空内容 → everbee_empty_payload', eEmpty && eEmpty.code);
  // 9.4 多段内容：第一段是说明文字，第二段才是 JSON
  const fMulti = mk('{"result":{"content":[{"type":"text","text":"Here are the rows:"},{"type":"text","text":"{\\"ok\\":1}"}]}}');
  const rMulti = await createEverbee({ storeFile, fetchImpl: fMulti }).callTool('get_keyword', {});
  check(rMulti && rMulti.ok === 1, '多段内容取到 JSON 那一段', JSON.stringify(rMulti));
  // 9.5 widget 形状 {view, rows} 也能解析成 suggestions
  const fWidget = mk('{"result":{"content":[{"type":"text","text":"{\\"view\\":\\"Keywords: ceramic cup\\",\\"rows\\":[{\\"keyword\\":\\"ceramic cup\\",\\"vol\\":1250},{\\"keyword\\":\\"cups ceramic\\",\\"vol\\":1573}]}"}]}}');
  const rWidget = await createEverbee({ storeFile, fetchImpl: fWidget }).keyword('ceramic cup');
  check(rWidget.exact && rWidget.exact.vol === 1250 && rWidget.suggestions.length === 2, 'widget 形状 → 仍能拿到数据', JSON.stringify({ vol: rWidget.exact && rWidget.exact.vol, n: rWidget.suggestions.length }));
  // 9.6 结构不认识 → 抛 bad_payload（不能当成「这个词没数据」）
  const fWeird = mk('{"result":{"content":[{"type":"text","text":"{\\"foo\\":1}"}]}}');
  let eWeird = null;
  try { await createEverbee({ storeFile, fetchImpl: fWeird }).keyword('ceramic cup'); } catch (e) { eWeird = e; }
  check(eWeird && eWeird.code === 'everbee_bad_payload', '结构不认识 → everbee_bad_payload', eWeird && eWeird.code);
  // 9.7 连续空壳 → empty:true + tries=3（上层据此报「取数失败」而不是「0 个蓝海词」）
  const fAlwaysEmpty = mk('{"result":{"content":[{"type":"text","text":"{\\"searched_keyword\\":[],\\"results\\":[],\\"total_count\\":0}"}]}}');
  const rAlways = await createEverbee({ storeFile, fetchImpl: fAlwaysEmpty }).keyword('nothing-here');
  check(rAlways.empty === true && rAlways.tries === 3, '连续空壳 → empty + 重试 3 次', JSON.stringify({ empty: rAlways.empty, tries: rAlways.tries }));

  rmSync(storeFile, { force: true });
  rmSync(join(__dir, '..', '.tmp-everbee-empty.json'), { force: true });

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
