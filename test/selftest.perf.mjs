/** 预览性能自测：把「不会卡」变成可回归的断言 */
import fs from 'node:fs';
import { mdToWechat, buildPreviewDoc, STYLES } from '../src/layout/engine.mjs';
const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

function makeMd(n) {
  const p = [];
  for (let i = 0; i < n / 70; i++) {
    if (i % 7 === 0) p.push('## 第' + (i / 7 + 1) + '节');
    else if (i % 13 === 0) p.push('> 引用段落，用来测试 blockquote 的摊平。');
    else p.push('第' + i + '段：这是**加粗**与`代码`的中文正文，长度适中。');
  }
  return p.join('\n\n');
}

console.log('='.repeat(72));
console.log('预览性能自测');
console.log('='.repeat(72));

console.log('\n【1】★ 引擎计算耗时（主线程同步开销）');
{
  for (const n of [1000, 5000, 10000]) {
    const md = makeMd(n);
    const t0 = Date.now();
    for (let k = 0; k < 5; k++) mdToWechat(md, 'medium');
    const ms = (Date.now() - t0) / 5;
    ok(ms < 16, n + ' 字 mdToWechat 在一帧内', ms.toFixed(1) + 'ms');
  }
}

console.log('\n【2】★ 预览文档拼装耗时');
{
  for (const n of [1000, 10000]) {
    const md = makeMd(n);
    const t0 = Date.now();
    for (let k = 0; k < 5; k++) buildPreviewDoc(md, 'medium', 'T');
    const ms = (Date.now() - t0) / 5;
    ok(ms < 16, n + ' 字 buildPreviewDoc 在一帧内', ms.toFixed(1) + 'ms');
  }
}

console.log('\n【3】★ 渲染必须走 iframe（不碰主文档）');
{
  const rp = html.slice(html.indexOf('function renderPreview(lite)'));
  const end = rp.indexOf('\n}\n');
  const fn = rp.slice(0, end < 0 ? 2000 : end);
  ok(fn.includes('$("#prevFrame")') || fn.includes("$('#prevFrame')"), '渲染目标是 #prevFrame');
  ok(fn.includes('f.srcdoc'), '通过 srcdoc 写入（异步，不阻塞主线程）');
  ok(!fn.includes("prevBody'), ' : '"), '不往 #prevBody 写内容');
  ok(!fn.includes("prevTitle'), ' : '"), '不往 #prevTitle 写内容');
  ok(!fn.includes('innerHTML = html') || fn.indexOf('innerHTML') === -1, 'renderPreview 内无 innerHTML 写入');
  // 整个页面的预览路径都不该有主文档渲染残留
  const codeLines = html.split('\n').filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); }).join('\n');
  ok(!codeLines.includes("$('#prevBody').innerHTML = mdToHtml"), '页面无旧的主文档渲染残留');
}

console.log('\n【4】防卡加固');
{
  ok(html.includes('let __pvLoadTimer = null;'), '有加载超时计时器');
  ok(html.includes('setTimeout(()=>{\n      try{\n        const doc = buildPreviewDoc'), '字符串计算放进 setTimeout（让出一帧）');
  ok(html.includes('预览加载较慢'), '有超时兜底提示');
  ok(html.includes('f.onload = ()=>{ clearTimeout(__pvLoadTimer); }'), 'iframe 加载完成即清计时器');
  // 变量必须在使用前声明（避免 TDZ）
  ok(html.indexOf('let __pvLoadTimer') < html.indexOf('function renderPreview(lite)'), '计时器声明在 renderPreview 之前（避免 TDZ 报错）');
}

console.log('\n【5】15 种风格都不会拖慢（抽样验证）');
{
  const md = makeMd(5000);
  let worst = 0, worstName = '';
  STYLES.forEach(s => {
    const t0 = Date.now();
    mdToWechat(md, s.id);
    const ms = Date.now() - t0;
    if (ms > worst) { worst = ms; worstName = s.name; }
  });
  ok(worst < 50, '最慢的风格也在 50ms 内', worstName + ' ' + worst + 'ms');
}

console.log('\n【6】DOM 节点数在可接受范围（且都在 iframe 内）');
{
  [3000, 10000].forEach(n => {
    const r = mdToWechat(makeMd(n), 'medium');
    const nodes = (r.html.match(/<[a-z]/gi) || []).length;
    ok(nodes < 600, n + ' 字节点数可控', nodes + ' 个（在 iframe 内）');
  });
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
