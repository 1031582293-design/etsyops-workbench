/**
 * 封面关键词提炼 + 极速预览 自测
 */
import fs from 'node:fs';

const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

/* 抽真实函数 */
function grab(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  let d = 0; const open = html.indexOf('{', i);
  for (let k = open; k < html.length; k++) {
    if (html[k] === '{') d++; else if (html[k] === '}') { d--; if (d === 0) return html.slice(i, k + 1); }
  }
}
const di = html.indexOf('const COVER_DICT');
const a0 = html.indexOf('[', di);
let d2 = 0, a1 = a0;
for (let k = a0; k < html.length; k++) { if (html[k] === '[') d2++; else if (html[k] === ']') { d2--; if (d2 === 0) { a1 = k; break; } } }
const COVER_DICT = eval(html.slice(a0, a1 + 1));
const pickKeywords = eval('(' + grab('pickKeywords') + ')');
const autoCoverScene = eval('(' + grab('autoCoverScene') + ')');
let MOCK = { '#title': '', '#src': '' };
globalThis.$ = (s) => ({ get value() { return MOCK[s] ?? ''; } });

console.log('='.repeat(72));
console.log('封面关键词提炼 + 极速预览自测');
console.log('='.repeat(72));

console.log('\n【1】★ 圣诞稿必须提炼出「圣诞」（用户报的 bug）');
{
  MOCK['#title'] = '提前布局！Etsy圣诞季产品优化全攻略';
  MOCK['#src'] = `测试 视频脚本：Hi，大家好，我是来自新零售的 Mengqi。今天想跟大家聊一个我觉得很多 Etsy 卖家现在就该开始重视的问题：圣诞季准备。
因为我发现，很多卖家还是会陷入一个误区：觉得做传统市场太多已经有一点点卷了。
比如：更偏送礼的标题 更有节日氛围的首图 更明确的使用场景 更适合 holiday 买家的文案。`;
  const r = autoCoverScene();
  ok(r.includes('圣诞'), '提炼结果含「圣诞」', JSON.stringify(r));
  ok(!r.includes('测试 视频脚本'), '不含「测试 视频脚本」这类废话');
  ok(!r.includes('我是来自新'), '不含「我是来自新」这类碎片');
  const segs = r.split(/[，,]/).map(x => x.trim());
  ok(segs.every(s => s.length >= 2 && s.length <= 8), '每段都是 2~8 字的词，不是长句碎片', r);
}

console.log('\n【2】不含 Dad/Kid 等无关联词');
{
  const r = autoCoverScene();
  ok(!/\b(Dad|Kid|Teacher)\b/i.test(r), '不含无关英文词', JSON.stringify(r));
}

console.log('\n【3】词典去重（圣诞 与 圣诞季 只留一个）');
{
  MOCK['#title'] = '圣诞季全攻略';
  MOCK['#src'] = '圣诞季要提前准备，圣诞礼物最好卖，圣诞装饰也很关键。';
  const r = autoCoverScene();
  const words = r.split(/[，,]/);
  ok(words.length === new Set(words).size, '结果无完全重复词', JSON.stringify(r));
  ok(!words.some(w => w.includes('圣诞') && words.some(x => x !== w && x.includes('圣诞'))),
     '不存在包含关系的重复（如 圣诞 + 圣诞季）', JSON.stringify(r));
}

console.log('\n【4】其他题材');
{
  const cases = [
    ['手作花束 diy教程', '今天教大家做一款手工花束，用鲜花和包装纸就能完成，适合送礼。', ['手作', '花束', 'diy']],
    ['咖啡拉花入门', '手冲咖啡与拉花技巧分享，适合咖啡爱好者。', ['咖啡']],
    ['儿童玩具选购', '给三岁小孩挑玩具，材质安全最重要。', ['玩具', '儿童']],
  ];
  for (const [t, b, expect] of cases) {
    MOCK['#title'] = t; MOCK['#src'] = b;
    const r = autoCoverScene();
    ok(expect.some(w => r.includes(w)), `「${t}」→ 命中预期词`, JSON.stringify(r));
  }
}

console.log('\n【5】边界');
{
  MOCK['#title'] = ''; MOCK['#src'] = '';
  ok(autoCoverScene() === '', '空稿→ 空串');
  MOCK['#title'] = '标题'; MOCK['#src'] = '';
  ok(autoCoverScene() === '', '只有「标题」这种无意义词 → 返回空（正确）');
  MOCK['#title'] = '手作花束教程'; MOCK['#src'] = '';
  ok(autoCoverScene() === '手作，花束', '只有标题也能提炼出关键词', JSON.stringify(autoCoverScene()));
}

console.log('\n【6】画面主题可编辑（用户说「没办法改」）');
{
  ok(html.includes('画面主题（自动提炼，可直接改）'), '有明确的可编辑标签');
  ok(html.includes('id="coverPrompt"'), '有输入框');
  ok(!/<details[^>]*>\s*<summary[^>]*>[^<]*进阶/.test(html), '不再是折叠的「进阶」区（提升为主入口）');
  ok(/box\.value \|\| ''/.test(html) || /box && box\.value/.test(html), '生图时优先读输入框内容');
  ok(html.includes('if(box) box.value = scene;'), '自动提炼结果会回填进输入框供修改');
  ok(html.includes('改这里就能改画面') || html.includes('随时改'), '提示用户可改');
}

console.log('\n【7】预览架构（细节见 selftest.frame.mjs）');
{
  ok(html.includes('mdToLiteHtml(raw)'), 'lite 走轻量转换');
  ok(html.includes('function renderInFrame('), '统一交给 iframe 渲染');
  ok(html.includes('id="prevFrame"'), '有 iframe 容器');
}

console.log('\n【8】渲染前让出主线程（防事件循环被占死）');
{
  ok(html.includes('function safeRender(lite)'), '有安全渲染包装');
  ok(html.includes('setTimeout(()=>{'), 'safeRender 内部用 setTimeout 让出主线程');
  ok(html.includes("toast((lite ? '极速预览已更新' : '预览已更新')"), '显示实际渲染耗时');
}

console.log('\n【9】进入排版步不再自动渲染');
{
  const i = html.indexOf('if(n===4){');
  const seg = html.slice(i, i + 420);
  ok(!seg.includes('renderPreview('), '进入第4 步不自动渲染');
  ok(seg.includes('tip.style.display = \'block\''), '改为显示「预览未刷新」提示条');
  ok(html.includes('id="reRenderLiteBtn"'), '有「极速预览（不含图）」按钮');
  ok(html.includes('id="reRenderBtn"'), '有「刷新预览」按钮');
}

console.log('\n【10】所有高频路径都不再同步完整渲染');
{
  ok(html.includes("state.tpl=t.dataset.tpl; applyTplStyle(); safeRender(true);"), '切模板走安全渲染');
  ok(html.includes("state.color=s.dataset.c; safeRender(true);"), '切配色走安全渲染');
  ok(html.includes("state.size=+s.dataset.s; safeRender(true);"), '切字号走安全渲染');
  ok(html.includes('__previewTimer = null; safeRenderLite();'), '输入防抖走 lite');
  // 完整渲染只剩初始化两处（安全）
  // 3 处都是安全的：两处初始化 + 一处作者回填（只跑一次）
  const calls = html.split('\n').filter(l => /renderPreview\(\)/.test(l)
    && !l.trim().startsWith('//') && !l.trim().startsWith('function') && !l.trim().startsWith('if(lite)'));
  ok(calls.length === 3, '裸 renderPreview() 仅 3 处', calls.length + ' 处');
  ok(calls.some(l => l.includes('d.author')), '其中一处是作者回填（一次性，安全）');
  ok(calls.filter(l => !l.includes('typeof')).length === 2, '另两处是初始化（页面加载时跑一次，安全）');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);