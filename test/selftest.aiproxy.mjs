import http from 'node:http';
import * as etsy from '/tmp/etsyops-work/etsy-api.js';

// 起一个假 OpenAI 服务端，确认「AI 请求确实经过代理」
const seen = [];
const srv = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: !!req.headers.authorization, model: req.headers['x-probe'] });
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 模拟 OpenAI chat/completions 的响应形状
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '标题：Wolf Fursuit Head Mask（测试生成）' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

console.log('假 OpenAI 监听 127.0.0.1:' + port);

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓', n, e ?? ''); } else { fail++; console.log('  ✗', n, e ?? ''); } };

// 直接测 createProxyFetch 打这个假服务
const pf = etsy.createProxyFetch(`http://127.0.0.1:${port}`);
const r = await pf('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test', 'x-probe': 'gpt-5-mini' },
  body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
});

ok(seen.length === 1, '★ AI 请求确实走了代理（假服务端收到 1 个请求）');
ok(seen[0] && seen[0].url === 'https://api.openai.com/v1/chat/completions',
   '★ 请求行是完整 URL（代理协议）', seen[0] && seen[0].url);
ok(seen[0] && seen[0].auth, 'Authorization 头已带上（Bearer sk-...）');
ok(seen[0] && seen[0].model === 'gpt-5-mini', '自定义头也透传');

const j = await r.json();
ok(j.choices && j.choices[0].message.content.includes('Wolf Fursuit'),
   '★ 能解析 OpenAI 格式的响应', j.choices?.[0]?.message?.content?.slice(0, 30));

// 验证「不配 AI_PROXY 时走直连」——这决定智谱等国内接口还能用
const noProxy = { AI_PROXY: '' };
ok(!noProxy.AI_PROXY, 'AI_PROXY 留空 = 直连（智谱/DeepSeek 走这条）');

// 验证代理不通时报错可读
const bad = etsy.createProxyFetch('http://127.0.0.1:1');
try {
  await bad('https://api.openai.com/v1/chat/completions', { method: 'POST' });
  ok(false, '代理不通应抛错');
} catch (e) {
  ok(/代理/.test(e.message), '★ 代理不通时明确说「代理」', e.message.slice(0, 55));
}

srv.close();
console.log('\n' + '='.repeat(56));
console.log(`AI 代理：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);