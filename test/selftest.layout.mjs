/** 排版引擎自测 */
import { STYLES, mdToWechat, pickStyle, listStyles, stylesByGroup, buildPreviewDoc } from '../src/layout/engine.mjs';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('排版引擎自测（xy-mp-layout 接入）');
console.log('='.repeat(72));

console.log('\n【1】15 种风格完整载入');
{
  ok(STYLES.length === 15, '共 15 种风格', STYLES.length + ' 种');
  ok(STYLES.every(s => s.id && s.name && s.css), '每种都有 id/name/css');
  ok(new Set(STYLES.map(s => s.id)).size === 15, 'id 无重复');
  ok(STYLES.some(s => s.id === 'minimal'), '含 minimal');
  ok(STYLES.some(s => s.id === 'course'), '含 course（课程讲义）');
  ok(STYLES.some(s => s.id === 'event'), '含 event（活动公告）');
  ok(listStyles().length === 15, 'listStyles 返回全部');
  ok(Object.keys(stylesByGroup()).length >= 3, '按分组可用', Object.keys(stylesByGroup()).join('/'));
  ok(pickStyle('不存在的风格').id === STYLES[0].id, '未知风格回退到第一个');
}

console.log('\n【2】★ 核心：样式必须摊平到元素（微信后台会丢 <style>）');
{
  const md = '# 标题\n\n这是一段正文，包含**加粗**。\n\n## 小标题\n\n> 引用内容\n\n- 列表项';
  const r = mdToWechat(md, 'minimal');
  ok(r.html.indexOf('<style') === -1, '输出里没有 <style> 标签');
  ok(!/class="/.test(r.html), '输出里没有 class 属性');
  ok(!/ id="/.test(r.html), '输出里没有 id 属性');
  ['<p style="', '<h2 style="', '<blockquote style="', '<strong style="'].forEach(k => {
    ok(r.html.includes(k), '有 inline style：' + k);
  });
  // 样式要真的包含属性值，不是空style
  // 注意：style 属性里可能含双引号（font-family 的 "Segoe UI"），所以不能用 [^"]+
  const pm = r.html.match(/<p style="([\s\S]*?)">(?!)/);
  const pStyle = (pm && pm[1]) || (r.html.split('<p style="')[1] || '').split('">')[0];
  ok(pStyle.includes('font-size'), 'p 的 style 含 font-size（从 body 继承下来）');
  ok(pStyle.includes('line-height'), 'p 的 style 含 line-height');
  ok(pStyle.includes('margin'), 'p 自身的 margin 也在（未被继承覆盖）');
}

console.log('\n【3】Markdown 各语法都能转');
{
  const md = `# 标题\n\n正文段落。\n\n## 二级\n\n### 三级\n\n> 引用\n\n- 项1\n- 项2\n\n1. 有序1\n\n\`\`\`\ncode block\n\`\`\`\n\n行内 \`code\` 与 [链接](https://x.com) 与 **粗**\n\n---\n\n结尾`;
  const r = mdToWechat(md, 'medium');
  ok(r.html.includes('<h2'), 'h2');
  ok(r.html.includes('<h3'), 'h3');
  ok(r.html.includes('<blockquote'), 'blockquote');
  ok(r.html.includes('<ul'), 'ul');
  ok(r.html.includes('<li'), 'li');
  ok(r.html.includes('<pre'), 'pre 代码块');
  ok(r.html.includes('<hr'), 'hr 分隔线');
  ok(r.html.includes('<a href="https://x.com"'), '链接');
  ok(r.firstTitle === '标题', '首个 h1 被提取为标题', r.firstTitle);
  ok(r.html.indexOf('<h1') === -1, '首个 h1 不进正文（skill 规则第3条）');
}

console.log('\n【4】伪元素装饰已降级为真实边框');
{
  const r = mdToWechat('## 标题\n\n正文', 'minimal');
  const h2Style = (r.html.split('<h2 style="')[1] || '').split('">')[0];
  ok(h2Style.includes('border-left'), 'h2 的 :before 装饰变成真实边框', h2Style.slice(-46));
  ok(h2Style.includes('padding-left'), 'h2 有对应内边距');
  ok(r.html.indexOf(':before') === -1, '输出里没有 :before 伪元素');
}

console.log('\n【5】只在浏览器生效的样式被剔除');
{
  const r = mdToWechat('## 标题\n\n正文\n\n> 引用', 'verge');
  ['float', 'position', 'box-shadow', 'text-shadow', 'transform', 'transition', 'animation'].forEach(p => {
    ok(!new RegExp('(^|;)\\s*' + p + '\\s*:').test(r.html), '未输出 ' + p);
  });
}

console.log('\n【6】XSS 安全');
{
  const r = mdToWechat('正文 <script>alert(1)</script> & "引号"', 'minimal');
  ok(r.html.indexOf('<script>') === -1, 'script 标签被转义');
  ok(r.html.includes('&lt;script&gt;'), '转义为实体');
  ok(r.html.includes('&amp;'), '& 被转义');
}

console.log('\n【7】预览文档与发布内容一致');
{
  const md = '# 我的文章\n\n正文内容。\n\n## 小节\n\n- a\n- b';
  const prev = buildPreviewDoc(md, 'stripe', '备用标题');
  ok(prev.startsWith('<!DOCTYPE html>'), '预览是完整 HTML 文档');
  ok(prev.includes('<style>'), '预览带<style>（本地看可以，粘贴时会被丢）');
  ok(prev.includes('stripe'), '预览标注了风格 id');
  const r = mdToWechat(md, 'stripe');
  ok(prev.includes(r.html.slice(0, 60)), '预览正文与发布正文同源');
  ok(prev.includes('我的文章'), '预览含标题');
}

console.log('\n【8】空稿不崩');
{
  const r = mdToWechat('', 'minimal');
  ok(typeof r.html === 'string', '空稿返回字符串');
  const r2 = mdToWechat(null, 'minimal');
  ok(typeof r2.html === 'string', 'null 安全');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
