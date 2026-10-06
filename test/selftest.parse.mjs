/** docx/pdf 真解析 + 发布反馈 自测 */
import fs from 'node:fs';
const run = fs.readFileSync('src/wechat-run.js', 'utf8');
const pub = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };
const code = s => s.split('\n')
  .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join('\n');

console.log('='.repeat(72));
console.log('文档解析 + 发布反馈 自测');
console.log('='.repeat(72));

console.log('\n【1】★ docx/pdf 必须真解析（这是稿子对不上的根因）');
{
  const rc = code(run);
  // 块注释内部（/* ... */）也含旧写法说明，所以只检查 readOne 函数体本身
  const ro = run.slice(run.indexOf('async function readOne'));
  const roEnd = ro.indexOf('\n}');
  const readOne = ro.slice(0, roEnd < 0 ? 1200 : roEnd);
  ok(!readOne.includes('文件：已载入'), 'readOne 里不再返回「文件：已载入」占位符');
  ok(!readOne.includes('如需自动抽取文字'), '不再提示「请到专用工具页解析」');
  ok(readOne.includes("return await docxToText(await read('buf'))"), 'docx 分支直接返回解析结果');
  ok(readOne.includes("return await pdfToText(await read('buf'))"), 'pdf 分支直接返回解析结果');

  ok(run.includes('async function docxToText('), '有 docx 解析函数');
  ok(run.includes('async function pdfToText('), '有 pdf 解析函数');
  ok(run.includes("if (n.endsWith('.docx'))"), 'readOne 里按 .docx 分支走真解析');
  ok(run.includes("if (n.endsWith('.pdf'))"), 'readOne 里按 .pdf 分支走真解析');
  ok(run.includes("await read('buf')"), '按二进制方式读取（docx/pdf 需要 ArrayBuffer）');
  ok(run.includes('window.mammoth.convertToHtml'), '用 mammoth 转 docx');
  ok(run.includes('pdfjsLib.getDocument'), '用 pdfjs 读 pdf');
}

console.log('\n【2】解析库按需加载 + 缓存');
{
  ok(run.includes('const CDN = \'https://cdn.jsdelivr.net/npm\''), '统一 CDN 常量');
  ok(run.includes('const _scriptCache = {}'), '有脚本缓存');
  ok(run.includes('if (_scriptCache[src]) return _scriptCache[src];'), '命中缓存直接复用');
  ok(run.includes('delete _scriptCache[src]'), '加载失败会清缓存（可重试）');
  ok(run.includes("if(!window.mammoth) throw new Error('mammoth 未就绪')"), 'mammoth 未就绪时明确报错');
  ok(run.includes("if(!pdfjsLib) throw new Error('pdfjs 未就绪')"), 'pdfjs 未就绪时明确报错');
  ok(run.includes('GlobalWorkerOptions.workerSrc'), 'pdf worker 路径已配');
}

console.log('\n【3】★ 解析失败/空内容必须拦下并告知（否则 AI 自由发挥）');
{
  ok(run.includes('if (t.length < 20){'), '少于 20 字视为解析失败并跳过');
  ok(run.includes('可能不是正文文件'), '日志明确说明原因');
  ok(run.includes("if (!t || !t.trim()) { log('⚠ ' + f.name + ' 内容为空，已跳过')"), '空内容明确跳过');
  ok(run.includes("catch (e) { throw new Error('docx 解析失败：' + e.message); }"), 'docx 失败带原因');
  ok(run.includes("catch (e) { throw new Error('pdf 解析失败：' + e.message); }"), 'pdf 失败带原因');
  // 关键：不能把占位符塞进 files
  const i = run.indexOf('RUN.files.push');
  const before = run.slice(Math.max(0, i - 900), i);
  ok(before.includes('t.length < 20'), '短内容检查在入表之前');
}

console.log('\n【4】★ 发布必须有即时反馈（用户说「点了没反应」）');
{
  ok(pub.includes('function showPublishBanner('), '有顶部固定结果条函数');
  ok(pub.includes("position:fixed") && pub.includes('z-index:10001'), '结果条固定在顶部不受滚动影响');
  ok(pub.includes("el.style.display = 'block'"), '结果条默认隐藏、调用才显示');
  ok(pub.includes("el.__t = setTimeout"), '12 秒后自动收起');
  const i = pub.indexOf("$('#publish').onclick=async");
  const seg = pub.slice(i, i + 900);
  ok(seg.includes("_pb.disabled = true; _pb.textContent = '⏳ 发布中…'"), '点击后立刻禁用按钮并改文案');
  ok(seg.includes('正在发布到草稿箱…'), '立刻弹出「发布中」提示');
  ok(pub.includes('showPublishBanner(true, real'), '成功/未配置都会弹顶部条');
  ok(pub.includes("'<b>✅ 已写入真实草稿箱</b>"), '成功条含media_id 与标题');
  ok(pub.includes("'<b>⚠ 未配置凭证，未写入</b>"), '未配置凭证时也明确告知');
  ok(pub.includes("} finally {\n    _pb.disabled = false; _pb.textContent = '📥 发布到草稿箱';"), 'finally 恢复按钮（失败也能恢复）');
  ok(pub.includes('showPublishBanner(false,'), '失败也弹红色条');
  ok(pub.includes('40164'), '失败提示里列出常见错误码');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
