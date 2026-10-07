/* 前后端 parseEtsyCopy / parseAiCopy 行为一致性自测。
 *
 * 为什么必须有这个：两端各有一份解析实现。之前后端用简单正则、前端用健壮版，
 * 结果是「队列跑出来的文案解析错了，但单条测试又是好的」——
 * 这种不一致只在真实调用路径上暴露，测试环境很难发现。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${extra ? '｜' + extra : ''}`); }
};

// 页面侧
const frontSrc = readFileSync(resolve(ROOT, 'etsy-import.js'), 'utf8');
const front = new Function(frontSrc + '\n; return { parseAiCopy };')();

// 后端侧：从 server.js 里抽出函数体执行（server.js 顶层会 listen，不能直接 import）
const srvSrc = readFileSync(resolve(ROOT, 'server.js'), 'utf8');
const fnStart = srvSrc.indexOf('function parseEtsyCopy(content) {');
if (fnStart < 0) { console.log('✗ server.js 里找不到 parseEtsyCopy'); process.exit(1); }
// 从函数声明开始截取到匹配的收尾大括号
let depth = 0, fnEnd = -1;
for (let i = srvSrc.indexOf('{', fnStart); i < srvSrc.length; i++) {
  if (srvSrc[i] === '{') depth++;
  else if (srvSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
}
const fnSrc = srvSrc.slice(fnStart, fnEnd);
const back = new Function(fnSrc + '\n; return { parseEtsyCopy };')();
console.log('后端 parseEtsyCopy 提取长度:', fnSrc.length);

const CASES = {
  'markdown 粗体': '**TITLE:** Wolf Fursuit Head Mask\n\n**DESCRIPTION:**\nMATERIALS\nEVA foam, mesh lining.\n\n**TAGS:** wolf mask, fursuit head',
  '普通格式': 'TITLE: abc\nDESCRIPTION:\n仅描述\nTAGS: a, b, c',
  '中文冒号': 'TITLE：中文标题\nDESCRIPTION：中文描述\nTAGS：a，b',
  '描述含冒号': 'TITLE: t\nDESCRIPTION:\n尺寸: 27cm\nTAGS: a,b',
  '缺 TAGS 段': 'TITLE: abc\nDESCRIPTION:\n仅描述',
  '缺 DESCRIPTION 段': 'TITLE: abc\nTAGS: a,b',
  '标签用换行分隔': 'TITLE: t\nDESCRIPTION:\nx\nTAGS: a\nb\nc',
  '空输入': '',
  '完全没按格式': '好的，这是你要的文案：Wolf mask，很可爱的狼头套。',
  '★ 标题带前导文字': 'Here is the listing:\nTITLE: Wolf Mask\nDESCRIPTION:\ndesc\nTAGS: a',
  '超 13 个标签': 'TITLE: t\nDESCRIPTION:\nd\nTAGS: ' + Array.from({ length: 16 }, (_, i) => 'tag' + i).join(', '),
  '标题多行': 'TITLE: Line one\nshould not appear\nDESCRIPTION:\nd\nTAGS: a',
};

console.log('\n【1】两端行为必须一致');
for (const [name, text] of Object.entries(CASES)) {
  const a = front.parseAiCopy(text);
  const b = back.parseEtsyCopy(text);
  ok(a.title === b.title && a.description === b.description
      && JSON.stringify(a.tags) === JSON.stringify(b.tags) && a.parsed === b.parsed,
    '两端一致：' + name,
    `\n      前端 title=${JSON.stringify(a.title).slice(0, 46)} tags=${a.tags.length} parsed=${a.parsed}`
    + `\n      后端 title=${JSON.stringify(b.title).slice(0, 46)} tags=${b.tags.length} parsed=${b.parsed}`);
}

console.log('\n【2】关键边界（两端都要对）');
const both = Object.fromEntries(Object.entries(CASES).map(([n, t]) =>
  [n, [front.parseAiCopy(t), back.parseEtsyCopy(t)]]));

// 段标题不能混进内容里
for (const [n, [a, b]] of Object.entries(both)) {
  ok(!/^TITLE/i.test(a.title) && !/^TITLE/i.test(b.title),
    '[' + n + '] 标题不含 "TITLE:" 前缀',
    JSON.stringify((a.title || '').slice(0, 40)));
}
// 粗体标记要去掉
ok(both['markdown 粗体'][0].title === 'Wolf Fursuit Head Mask',
  'markdown 粗体被正确剥掉', JSON.stringify(both['markdown 粗体'][0].title));
// 描述里的冒号不能把描述截断
ok(/\$|尺寸/.test(both['描述含冒号'][0].description),
  '描述里的冒号没有截断内容', JSON.stringify(both['描述含冒号'][0].description.slice(0, 40)));
// 空输入
for (const [n, [a, b]] of [['空输入', both['空输入']]]) {
  ok(a.parsed === false && b.parsed === false && a.empty === true && b.empty === true,
    '空输入 → parsed=false, empty=true');
}
// 没按格式输出时不能假装成功
for (const which of [0, 1]) {
  const r = both['完全没按格式'][which];
  ok(r.parsed === false, '完全没按格式 → parsed=false（前端=' + (which === 0) + '）');
  ok(typeof r.raw === 'string' && r.raw.length > 0, 'raw 原文被保留（前端=' + (which === 0) + '）');
}
// 标签上限
for (const [n, [a, b]] of [['超 13 个标签', both['超 13 个标签']]]) {
  ok(a.tags.length === 13, '前端截到 13', String(a.tags.length));
  ok(b.tags.length === 13, '后端截到 13', String(b.tags.length));
}
// 标题只取第一行
ok(both['标题多行'][0].title === 'Line one',
  '标题只取第一行', JSON.stringify(both['标题多行'][0].title));

console.log('\n【3】事实不足的判据两端一致');
const srv2 = readFileSync(resolve(ROOT, 'server.js'), 'utf8');
const feStart = srv2.indexOf('function factsEnough(item) {');
let d2 = 0, feEnd = -1;
for (let i = srv2.indexOf('{', feStart); i < srv2.length; i++) {
  if (srv2[i] === '{') d2++;
  else if (srv2[i] === '}') { d2--; if (d2 === 0) { feEnd = i + 1; break; } }
}
const factsEnough = new Function(srv2.slice(feStart, feEnd) + '\n; return { factsEnough };')().factsEnough;

// 与页面 aiRunnable 同判据
const aiRunnable = (it) => Boolean(
  (it.materials && it.materials.length) || it.audience_note || it.item_weight
  || (it.item_length && it.item_width && it.item_height));

const FACT_CASES = [
  ['只有材质', { materials: ['EVA'] }, true],
  ['只有适合人群', { audience_note: '标准尺寸' }, true],
  ['只有净重', { item_weight: 2250 }, true],
  ['完整三维', { item_length: 50, item_width: 50, item_height: 30 }, true],
  ['★ 只有 sku 和 price（不该通过）', { sku: '6', price: '3070' }, false],
  ['★ 尺寸不完整（不该通过）', { item_length: 50, item_width: 50 }, false],
  ['空对象', {}, false],
  ['零重量（0 视为没填）', { item_weight: 0 }, false],
];
for (const [n, it, want] of FACT_CASES) {
  ok(factsEnough(it) === want, '后端判据：' + n, `得到 ${factsEnough(it)}，期望 ${want}`);
  ok(aiRunnable(it) === want, '前端判据：' + n, `得到 ${aiRunnable(it)}，期望 ${want}`);
  ok(factsEnough(it) === aiRunnable(it), '两端一致：' + n);
}


/* ---- 追加：解析失败必须是非 2xx，且前端要能识别 ok:false ---- */
console.log('\n【4】解析失败的响应语义');
const srv3 = readFileSync(resolve(ROOT, 'server.js'), 'utf8');
ok(/error:\s*'parse_failed'[\s\S]{0,400}?json\(res,\s*50\d/.test(srv3)
   || /json\(res,\s*50\d[\s\S]{0,400}?error:\s*'parse_failed'/.test(srv3),
  '★ 解析失败返回 5xx（不是 200）—— 返回 200 会让页面把空字段当成功');
const frontSrc2 = readFileSync(resolve(ROOT, 'etsy-publisher.html'), 'utf8');
ok(/d\s*&&\s*d\.ok\s*===\s*false/.test(frontSrc2),
  '★ 前端 apiCall 会把 ok:false 当失败抛出（纵深防御）');
ok(!/return json\(res,\s*200,\s*\{\s*\n?\s*ok:\s*false[\s\S]{0,200}parse_failed/.test(srv3),
  '不再存在 200 + ok:false + parse_failed 的组合');

console.log('\n' + '='.repeat(60));
console.log(`追加检查：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
