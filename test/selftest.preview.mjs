/**
 * 预览卡顿修复 自测
 * 重点：外网占位图已移除、渲染按需、防抖
 */
import fs from 'node:fs';

const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };
// 去掉注释行再检查「真实代码里是否还有外网图」
const code = html.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

console.log('='.repeat(72));
console.log('预览卡顿修复自测');
console.log('='.repeat(72));

console.log('\n【1】★ 移除 picsum.photos 外网占位图（本次卡顿主因）');
{
  // 注：cdn.jsdelivr.net 的两处是 docx/pdf 解析库（按需加载，不参与渲染），
  // 所以只断言「没有把外网 URL 赋给 <img> 的 src」。
  const imgAssign = code.match(/\$\(['"]#[^'"]*['"]\)\.src\s*=\s*["']https?:\/\//g) || [];
  ok(imgAssign.length === 0, '没有把外网 URL 赋给任何元素的 src', imgAssign.join(' | '));
  ok(!code.includes('picsum'), '代码里不再出现 picsum');
  ok(html.includes('PLACEHOLDER_COVER'), '定义了本地占位图常量');
  ok(html.includes("data:image/svg+xml;charset=utf-8"), '占位图是内联 SVG data URI');
  // data URI 必须是自包含的
  const m = html.match(/const PLACEHOLDER_COVER = 'data:image\/svg\+xml[^']*'\s*\+\s*encodeURIComponent\(([\s\S]*?)\);/);
  ok(!!m, 'SVG 完整内联在常量里');
  if (m) {
    const svg = m[1];
    ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'SVG 有正确的 xmlns');
    ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg.replace(/http:\/\/www\.w3\.org\/2000\/svg/g,'')), 'SVG 内无外部引用');
  }
}

console.log('\n【2】占位图只在需要时设一次（避免重复触发）');
{
  ok(html.includes("if($('#prevCover').getAttribute('src') !== cover)"), '有真实封面时先比对再赋值');
  ok(html.includes("if(!$('#prevCover').getAttribute('src')) $('#prevCover').src = PLACEHOLDER_COVER"), '占位图仅在无 src 时设一次');
  // 初始 <img> 不应带外网 src
  ok(/<img class="cover" id="prevCover"[^>]*>/.test(html), '预览 img 标签存在');
  const tag = html.match(/<img class="cover" id="prevCover"[^>]*>/)[0];
  ok(!/src=/.test(tag), '初始标签无 src 属性（不给任何外网请求机会）');
}

console.log('\n【3】选标题不再触发重渲染');
{
  const iTop = html.indexOf("const top = d.top || d.titles[0]");
  const seg = html.slice(iTop, iTop + 2200);
  ok(!/renderPreview\(\)/.test(seg), '标题主框/候选区代码里无 renderPreview() 调用');
  ok(seg.includes('markPreviewStale()'), '改为标记预览过期');
  ok(html.includes('function markPreviewStale()'), 'markPreviewStale 已定义');
  ok(html.includes('let __previewStale = false'), '有预览过期状态变量');
}

console.log('\n【4】进入排版步才渲染（按需）');
{
  ok(html.includes("if(n===4){"), 'goStep 第4 步有专门处理');
  const i = html.indexOf("if(n===4){");
  const seg = html.slice(i, i + 400);
  ok(!seg.includes('renderPreview(') && seg.includes("tip.style.display = 'block'"), '进入排版步不自动渲染，只显示提示条');
  ok(html.includes('id="reRenderBtn"'), '有「刷新预览」按钮');
  ok(html.includes('id="reRenderLiteBtn"'), '有「极速预览（不含图）」按钮');
  ok(html.includes("'预览已更新'") && html.includes("'极速预览已更新'"), '两种模式都提示耗时');
  ok(html.includes('极速预览不加载任何图片'), '提示条说明了极速预览的取舍');
}

console.log('\n【5】输入预览加防抖');
{
  ok(html.includes('let __previewTimer = null;'), '有防抖计时器');
  ok(html.includes('if(__previewTimer) clearTimeout(__previewTimer);'), '重复输入会重置计时');
  ok(html.includes('__previewTimer = setTimeout(()=>{ __previewTimer = null; safeRenderLite(); }, 400);'),
     '停止输入 400ms 后才渲染（且用 lite 模式）');
}

console.log('\n【6】渲染完成后清理过期标记');
{
  ok(/__previewStale = false;[\s\S]{0,120}previewTip/.test(code), 'renderPreview 末尾清标记并隐藏提示');
}

console.log('\n【7】生稿后仍不渲染（前一轮的修复不能被破坏）');
{
  const i = html.indexOf('· 解析完成：标题');
  const seg = html.slice(i, i + 900).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/renderPreview\(\)/.test(seg), '生稿成功后不调用 renderPreview');
}

console.log('\n【8】排版相关交互仍能触发渲染（功能不被削弱）');
{
  ok(html.includes("state.tpl=t.dataset.tpl; applyTplStyle(); safeRender(true);"), '切模板仍实时预览（走安全渲染）');
  ok(html.includes("state.color=s.dataset.c; safeRender(true);"), '切配色仍实时预览（走安全渲染）');
  ok(html.includes("state.size=+s.dataset.s; safeRender(true);"), '切字号仍实时预览（走安全渲染）');
}


/* ===== 追加：封面图安全加载（22:25 新增） ===== */
console.log('\n' + '='.repeat(72));
console.log('封面图加载安全 自测');
console.log('='.repeat(72));
{
  const h2 = fs.readFileSync('wechat-publisher.html', 'utf8');
  const c2 = h2.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  let p2 = 0, f2 = 0;
  const ok2 = (c, m, x = '') => { if (c) { p2++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { f2++; console.log('  ✗ ' + m + '  ' + x); } };

  ok2(h2.includes('function loadCoverSafe('), '有安全加载函数');
  ok2(h2.includes('function finishCoverImg('), '有加载结果处理函数');
  ok2(h2.includes('id="coverLoading"'), '有「加载中」提示容器');
  ok2(h2.includes("img.onload = "), '先绑 onload 再设 src');
  ok2(h2.includes("img.onerror = "), '绑了 onerror');
  ok2(h2.includes('setTimeout(') && /loadCoverSafe|finishCoverImg/.test(h2), '有超时兜底');
  ok2(h2.includes('加载超时'), '超时有明确提示文案');
  ok2(c2.includes("img.style.display = 'none'"), '加载中先隐藏 img，避免未就绪阻塞');
  // 执行顺序：生图回调里先 img.style.display='none'，再调 loadCoverSafe()（内部才赋 src）
  const _fn = h2.slice(h2.indexOf('function loadCoverSafe'), h2.indexOf('function loadCoverSafe') + 700);
  const _onload = _fn.indexOf('img.onload');
  const _src= _fn.indexOf('img.src = src');
  ok2(_onload > 0 && _src > _onload, '先绑 onload/onerror 再赋 src（顺序正确）', 'onload@' + _onload + ' src@' + _src);
  ok2(h2.indexOf('function loadCoverSafe') < h2.indexOf("$('#genCoverBtn').onclick"), 'loadCoverSafe 定义在调用之前');
  ok2(h2.includes('img.complete && img.naturalWidth > 0'), '处理缓存命中的情况');
  ok2(h2.includes("'/api/wechat/upload-url'"), '生图后自动上传给微信（后端抓图，绕开浏览器）');
  ok2(h2.includes('可直接「跳过，去排版」') || h2.includes('可直接'), '提示可直接进入排版');
  // 关键：不允许「直接给 img.src 赋值后不做任何兜底」的老写法
  ok2(!/\$\('#coverImg'\)\.src = src;/.test(c2), '不再裸赋值 coverImg.src');
  // 失败时必须仍然能继续
  ok2(h2.includes('不影响后续'), '加载失败也明确告知可继续');

  pass += p2; fail += f2;
  console.log('\n  本组：通过 ' + p2 + ' 项，失败 ' + f2 + ' 项');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
