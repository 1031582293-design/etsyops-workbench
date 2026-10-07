/** 排版接入工作台 自测：画布 + 工具页 */
import fs from 'node:fs';
import { mdToWechat, STYLES } from '../src/layout/engine.mjs';
const run = fs.readFileSync('src/wechat-run.js', 'utf8');
const pub = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('排版接入工作台 自测');
console.log('='.repeat(72));

console.log('\n【1】★ 画布发布的 content 必须摊平（散版的根因）');
{
  ok(run.includes("from './layout/engine.mjs'"), '画布引入了排版引擎');
  ok(run.includes('layoutStyle:'), '状态里有排版风格');
  const bd = run.slice(run.indexOf('function buildDraftPayload'));
  ok(bd.includes('mdToWechat('), 'buildDraftPayload 用 mdToWechat');
  ok(bd.includes('content: r.html'), 'content 传的是摊平后的 html');
  // 不能直接塞原始 body
  ok(!/content:\s*p\.body/.test(bd), '不再把原始 body 直接当content');
}

console.log('\n【2】画布可选15 种风格');
{
  ok(run.includes('id="wfStyleSel"'), '画布有风格下拉框');
  ok(run.includes('STYLES.map('), '下拉框用引擎的 STYLES 填充');
  ok(run.includes("stl.onchange"), '切换已绑定');
  ok(run.includes('pickStyle(stl.value).name'), '切换后日志显示风格名');
  ok(run.includes("'④ 排版完成（'"), '步骤④日志会写明用了哪种风格');
  ok(run.includes('样式已摊平可粘进公众号'), '日志明确说明样式已摊平');
}

console.log('\n【3】★ 工具页预览与发布都走引擎');
{
  ok(pub.includes('function mdToWechat('), '引擎已内联进工具页');
  ok(pub.includes('function buildPreviewDoc('), '有 buildPreviewDoc');
  ok(pub.includes('buildPreviewDoc(raw, state.tpl, title)'), '预览走 buildPreviewDoc');
  ok(pub.includes('const r = mdToWechat($(\'#src\').value, state.tpl);'), '发布走 mdToWechat');
  ok(pub.includes('可直接粘进公众号后台，不散版'), '发布预览里说明了摊平效果');
}

console.log('\n【4】工具页 15 种风格选择器（替代原4 套模板）');
{
  const n = (pub.match(/data-tpl="/g) || []).length;
  ok(n === 15, '共 15 种风格可选', n + ' 种');
  ok(pub.includes('id="tpls"'), '有 tpls 容器');
  ['推荐', '经典媒体', '科技与商业', '深度与报道'].forEach(g => {
    ok(pub.includes('>' + g + '</div>'), '分组：' + g);
  });
  ['minimal', 'course', 'event', 'medium', 'wired', 'verge', 'magazine', 'stripe', 'apple', 'ft', 'linear', 'github', 'notion', 'editorial', 'newspaper'].forEach(id => {
    ok(pub.includes('data-tpl="' + id + '"'), '含风格 ' + id);
  });
  ok(pub.includes('data-tpl="default"') === false, '旧的 default 模板已移除');
  ok(pub.includes('data-tpl="wenyi"') === false, '旧的 wenyi 模板已移除');
}

console.log('\n【5】★ 端到端：草稿内容必须无 <style>/class');
{
  const md = '# 我的公众号文章\n\n## 第一节\n\n正文段落，**加粗**与`代码`。\n\n> 引用\n\n- 要点一\n- 要点二\n\n---\n\n结尾。';
  const r = mdToWechat(md, 'medium');
  ok(r.html.indexOf('<style') === -1, '输出无 <style>');
  ok(!/class=/.test(r.html), '输出无 class');
  ok(/<p style="/.test(r.html), '段落有 inline style');
  ok(/<h2 style="/.test(r.html), '小标题有 inline style');
  ok(/<ul style="/.test(r.html), '列表有 inline style');
  ok(r.firstTitle === '我的公众号文章', '标题已提取', r.firstTitle);
  // 每种风格都要能出摊平 HTML
  let allOk = true;
  STYLES.forEach(s => {
    const x = mdToWechat(md, s.id);
    if (!x.html || x.html.indexOf('<style') >= 0 || x.html.indexOf('font-size') < 0) allOk = false;
  });
  ok(allOk, '15 种风格都能产出带字号的摊平 HTML');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
