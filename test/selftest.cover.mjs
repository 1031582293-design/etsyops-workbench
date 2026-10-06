/**
 * 封面图自动提炼 + 风格库 自测
 * 从 wechat-publisher.html 抽取真实函数来跑，不重写逻辑。
 */
import fs from 'node:fs';

const html = fs.readFileSync('wechat-publisher.html', 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

/* 抽函数：按大括号配对取完整函数体 */
function grabFn(name) {
  const re = new RegExp('function ' + name + '\\(');
  const i = html.search(re);
  if (i < 0) throw new Error('未找到 ' + name);
  const open = html.indexOf('{', i);
  let d = 0;
  for (let k = open; k < html.length; k++) {
    if (html[k] === '{') d++;
    else if (html[k] === '}') { d--; if (d === 0) return html.slice(i, k + 1); }
  }
  throw new Error(name + ' 括号不匹配');
}

/* mock DOM：$() 返回带 value 的对象 */
let MOCK = { '#title': '', '#src': '' };
// 用 getter，确保每次取值都读最新 MOCK（否则空稿用例会沿用上一段的值）
globalThis.$ = (sel) => ({ get value() { return MOCK[sel] ?? ''; } });

const autoCoverScene = eval('(' + grabFn('autoCoverScene') + ')');

console.log('='.repeat(72));
console.log('封面图自测：自动提炼 + 风格');
console.log('='.repeat(72));

console.log('\n【1】从真实稿件提炼画面主题');
{
  MOCK['#title'] = '杭州Etsy实操营圆满结束：学员反馈课程实用';
  MOCK['#src'] = '====TITLE_MAIN====\n杭州Etsy实操营圆满结束\n====BODY====\n' +
    '<h1>开篇</h1><p>近日，杭州Etsy线下实操营圆满落下帷幕，来自全国的学员齐聚杭州学习。</p>' +
    '<p>圣诞季准备选品、觉得做传统市场太多已经有一点点卷了。</p>' +
    '<p>垂涎做纯标品是一个误区，那里可能来的标品就一改。</p>';
  const scene = autoCoverScene();
  ok(scene.length > 0, '提炼出非空画面主题', JSON.stringify(scene));
  ok(!/=+[A-Z_]+=+/.test(scene), '已剥离 =====TITLE_MAIN===== 标记');
  ok(!/<[^>]+>/.test(scene), '已剥离 HTML 标签');
  ok(scene.length <= 60, '长度受控（生图模型对短描述响应更稳）', scene.length + ' 字');
  ok(scene.includes('Etsy'), '抓到了稿件主题关键词');
}

console.log('\n【2】空稿 / 纯标记 应返回空（提示用户先生稿）');
{
  MOCK['#title'] = ''; MOCK['#src'] = '';
  ok(autoCoverScene() === '', '空标题空正文 → 返回空串', JSON.stringify(autoCoverScene()));
  MOCK['#title'] = ''; MOCK['#src'] = '====BODY====\n====RISK====';
  ok(autoCoverScene() === '', '只有标记没有正文 → 返回空串', JSON.stringify(autoCoverScene()));
  MOCK['#title'] = '只有标题'; MOCK['#src'] = '';
  ok(autoCoverScene() === '只有标题', '只有标题也可用', JSON.stringify(autoCoverScene()));
}

console.log('\n【3】风格库（应内置 5 套，含 tail 描述且无文字类要求）');
{
  const i = html.indexOf('const COVER_STYLES_DEFAULT');
  const open = html.indexOf('[', i);
  let d = 0, close = open;
  for (let k = open; k < html.length; k++) {
    if (html[k] === '[') d++;
    else if (html[k] === ']') { d--; if (d === 0) { close = k; break; } }
  }
  const arr = eval('(' + html.slice(open, close + 1) + ')');
  ok(Array.isArray(arr) && arr.length >= 5, '内置至少 5 套风格', arr.length + ' 套');
  ok(arr.every(x => x.id && x.name && x.tail), '每套都有 id/name/tail');
  ok(new Set(arr.map(x => x.id)).size === arr.length, 'id 无重复');
  ok(arr.some(x => x.name.includes('清新')), '含「清新」类风格');
  ok(arr.some(x => x.name.includes('商务')), '含「商务」类风格');
  ok(arr.every(x => x.tail.length >= 20), '每套 tail 描述足够详细', '最短 ' + Math.min(...arr.map(x => x.tail.length)) + ' 字');
}

console.log('\n【4】风格可存为自定义（localStorage 读写）');
{
  ok(html.includes('localStorage.setItem(\'etsyops.coverStyles\''), '提供持久化保存');
  ok(html.includes("$('#saveCoverStyleBtn')"), '提供「存为风格」按钮');
  ok(html.includes('function renderCoverStyleRow()'), '提供风格切换渲染');
  ok(html.includes('COVER_STYLES.slice(0, 12)') || html.includes('.slice(0, 12)'), '自定义风格有数量上限（防无限增长）');
}

console.log('\n【5】生图不再调renderPreview（避免同步渲染卡死）');
{
  const i = html.indexOf("$('#genCoverBtn').onclick");
  const seg = html.slice(i, i + 1600);
  const end = seg.indexOf("finally");
  const body = seg.slice(0, end < 0 ? 1400 : end);
  ok(!/renderPreview\(\)/.test(body), '生图回调内不调用 renderPreview');
}

console.log('\n【6】生稿后不调renderPreview（核心修复）');
{
  const i = html.indexOf('· 解析完成：标题');
  const seg = html.slice(i, i + 900);
  // 去掉注释后再检查，避免把注释里出现的 renderPreview() 字样误判为真实调用
  const codeOnly = seg.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/renderPreview\(\)/.test(codeOnly), '生稿成功后不调用 renderPreview（长稿不再卡死）');
  ok(codeOnly.includes('预览已延后'), '明确告知预览延后到第4步');
}

console.log('\n【7】等待期可并行操作提示');
{
  ok(html.includes('可以切到第 3 步生成封面图'), '提示等待期可切到其它步骤');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);