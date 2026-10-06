/** 极速预览(lite) 结构安全自测——重点防止再次出现「预览只有标题」/「切样式没反应」 */
import fs from 'node:fs';
const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('极速预览结构安全自测');
console.log('='.repeat(72));

console.log('\n【1】★ 不得重建外层容器（那会造成标题条重复 + id 丢失）');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  ok(!lite.includes('outerHTML'), '不使用 outerHTML 替换 #article');
  ok(lite.includes('art.innerHTML = frame'), '只替换 #article 的内部 HTML');
  ok(!/wx-top/.test(lite), 'lite 内不重建 wx-top（那本来就��� #article 外面）');
  // 页面原始结构里 wx-top 只有一个
  const count = (html.match(/公众号文章预览/g) || []).length;
  ok(count <= 2, '「公众号文章预览」字样不超过 2 处（结构+注释）', count + ' 处');
}

console.log('\n【2】★ 必须保留原有 id，否则后续逻辑找不到元素');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  for (const id of ['prevTitle', 'prevAuthor', 'prevDate', 'prevBody', 'prevCover']) {
    ok(lite.includes('id="' + id + '"'), '保留 id=' + id);
  }
  ok(!lite.includes('id="articleLite"'), '不引入新的 articleLite id（会造成两份预览）');
}

console.log('\n【3】★ applyTplStyle 必须有防御（原来拿不到 h1 就抛错，onclick 链断掉）');
{
  const ats = html.slice(html.indexOf('function applyTplStyle'), html.indexOf('function applyTplStyle') + 900);
  ok(ats.includes('if(!a) return;'), '#article 不存在时安全返回');
  ok(ats.includes("if(h1) h1.setAttribute"), 'h1 存在才设置样式');
  ok(ats.includes("if(h2) h2.setAttribute"), 'h2 也设置（原来只设 h1）');
  // 排除注释行后再检查（注释里引用了旧写法做说明）
  const atsCode = ats.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/a\.querySelector\('h1'\)\.setAttribute/.test(atsCode), '不再裸调用 querySelector(...).setAttribute');
}

console.log('\n【4】lite 渲染后立即套用主题色/字号/模板');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  ok(lite.includes('--theme'), '套用主题色 state.color');
  ok(lite.includes("art2.style.fontSize = state.size"), '套用字号 state.size');
  ok(lite.includes('applyTplStyle()'), '套用模板样式（切模板才立刻可见）');
  ok(html.includes('if(lite){ renderPreviewLite(); applyTplStyle(); return 0; }'), 'renderPreview 的 lite 分支也再套一次');
}

console.log('\n【5】lite 确实渲染正文（不能只出标题）');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  ok(lite.includes("parts.push('<p>'"), '正文按段落生成 <p>');
  ok(lite.includes("parts.push('<h2>'"), '标题生成 <h2>');
  ok(lite.includes("parts.push('<blockquote>'"), '引用生成 <blockquote>');
  ok(lite.includes("parts.push('<hr>'"), '分隔线生成 <hr>');
  ok(lite.includes("parts.length"), '正文内容参与组装');
  ok(!lite.includes('若正文为空') || lite.includes('if(!raw) return'), '空正文有明确提前返回');
  ok(lite.includes('inCode'), '代码块被跳过（lite 不渲染代码块）');
}

console.log('\n【6】分两批插入 + 复用 inline()');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  ok(lite.includes('parts.slice(0, half)'), '第一批插入前半');
  ok(lite.includes('parts.slice(half)'), '第二批延后插入后半');
  ok(lite.includes('setTimeout('), '延后用 setTimeout（让出主线程）');
  ok(lite.includes('inline(esc('), '复用页面原有 inline()，加粗等样式一致');
  ok(lite.includes("const esc = t => String(t)"), '所有文本经 esc 转义，防注入');
}

console.log('\n【7】一键清空预览（长稿下页面能恢复流畅）');
{
  ok(html.includes('id="clearPreviewBtn"'), '有「清空预览」按钮');
  const cl = html.slice(html.indexOf("$('#clearPreviewBtn').onclick"), html.indexOf("$('#clearPreviewBtn').onclick") + 1200);
  ok(cl.includes('id="prevBody"'), '清空后重建必要 id');
  ok(cl.includes('id="prevTitle"'), '保留标题 id');
  ok(cl.includes('发布不受影响') || cl.includes('发布不需要预览'), '明确告知发布不依赖预览');
  ok(html.includes('__previewStale = true'), '清空后标记预览待更新');
}

console.log('\n【8】lite 不加载任何图片');
{
  const lite = html.slice(html.indexOf('function renderPreviewLite'), html.indexOf('// 内联 SVG 占位封面'));
  ok(lite.includes('id="prevCover" style="display:none"'), '封面 img 直接隐藏且无 src');
  ok(!/prevCover'\)\.src =/.test(lite), '不给封面赋任何 src');
  ok(lite.includes('if(inCode){ continue; }'), '代码块内的内容不渲染（常含大段文本）');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
