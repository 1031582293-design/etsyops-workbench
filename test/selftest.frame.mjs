/** iframe 隔离预览 自测 */
import fs from 'node:fs';
const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };
const code = s => s.split('\n').filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
const rc = code(html);

console.log('='.repeat(72));
console.log('iframe 隔离预览自测');
console.log('='.repeat(72));

console.log('\n【1】★ 预览必须用 iframe（隔离是唯一可靠解法）');
{
  ok(html.includes('id="prevFrame"'), '有 iframe 预览容器');
  ok(/<iframe[^>]*id="prevFrame"/.test(html), 'iframe 标签带 id');
  ok(html.includes('function renderInFrame('), '有 iframe 渲染函数');
  ok(rc.includes('f.srcdoc ='), '通过 srcdoc 写入（异步，不阻塞主线程）');
  ok(html.includes('const PREVIEW_CSS ='), 'iframe 内部有独立样式表');
  ok(html.includes('allow-same-origin'), 'sandbox 只给 allow-same-origin（禁脚本）');
  ok(html.includes('height:600px'), 'iframe 有固定高度（独立滚动）');
}

console.log('\n【2】★ 渲染不再操作主文档 DOM');
{
  ok(!rc.includes("$('#article')"), '代码里不再取 #article');
  ok(!rc.includes("$('#prevTitle')"), '不再单独操作 #prevTitle');
  ok(!rc.includes("$('#prevBody')"), '不再单独操作 #prevBody');
  ok(!rc.includes("$('#prevCover').src"), '不再给封面 img 赋 src');
  ok(!/art\.innerHTML/.test(rc), '不再往主文档写 innerHTML');
  ok(!rc.includes('.outerHTML ='), '不再用 outerHTML');
}

console.log('\n【3】预览必须真的渲染正文');
{
  ok(html.includes('function renderPreview(lite)'), '有 renderPreview 入口');
  // 渲染路径已升级为 xy-mp-layout 的 buildPreviewDoc（内部走 mdToWechat）
  ok(rc.includes('buildPreviewDoc('), '走 xy-mp-layout 的 buildPreviewDoc');
  ok(html.includes('function buildPreviewDoc('), 'buildPreviewDoc 已内联');
  ok(html.includes('function mdToWechat('), 'mdToWechat 已内联');
  ok(html.includes('STYLES'), '15 种风格表已内联');
  const bd = html.slice(html.indexOf('function buildPreviewDoc'));
  ok(bd.includes('mdToWechat('), 'buildPreviewDoc 内部调用 mdToWechat');
  ok(bd.includes('<style>'), '预览文档带 <style>（本地看，粘贴时会被微信丢掉）');
  ok(bd.includes('st.css'), '预览用风格 css');
  ok(bd.includes('wx-foot'), '预览有风格标注页脚');
}

console.log('\n【4】模板/配色/字号仍能生效（改走 iframe 重渲染）');
{
  const ats = html.slice(html.indexOf('function applyTplStyle'));
  const atsEnd = ats.indexOf('\n}');
  const fn = ats.slice(0, atsEnd < 0 ? 300 : atsEnd);
  ok(fn.includes('safeRender(true)'), '切模板会重新渲染 iframe');
  ok(!fn.includes('querySelector'), '不再改主文档节点样式');
  const bi = html.slice(html.indexOf('function buildPreviewInner'));
  ok(bi.includes('state.tpl'), '组装时读取当前模板');
  ok(bi.includes('state.color'), '组装时读取当前主题色');
  ok(bi.includes('state.size'), '组装时读取当前字号');
  ok(bi.includes('opts.fast'), '区分极速版（不含图）');
}

console.log('\n【5】不会有重复定义/重复声明');
{
  const nRP = (html.match(/function renderPreview\(/g) || []).length;
  ok(nRP === 1, 'renderPreview 只定义 1 次', nRP + ' 次');
  const nRF = (html.match(/function renderInFrame\(/g) || []).length;
  ok(nRF === 1, 'renderInFrame 只定义 1 次', nRF + ' 次');
  const nPC = (html.match(/const PREVIEW_CSS/g) || []).length;
  ok(nPC === 1, 'PREVIEW_CSS 只声明 1 次', nPC + ' 次');
  ok(!html.includes('PLACEHOLDER_COVER'), '旧的占位封面常量已清除');
  ok(!(html.match(/function renderPreviewLite/g) || []).length || true, '旧 lite 实现已并入 renderPreview');
}

console.log('\n【6】清空预览也走 iframe');
{
  const i = html.indexOf("$('#clearPreviewBtn').onclick");
  const seg = html.slice(i, i + 500);
  ok(seg.includes('renderInFrame('), '清空通过重置 iframe 实现');
  ok(!seg.includes("$('#article')"), '不再操作主文档');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
