/** 封面素材上传 + 失败续跑 自测 */
import fs from 'node:fs';
const run = fs.readFileSync('src/wechat-run.js', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('封面素材上传 + 失败续跑 自测');
console.log('='.repeat(72));

console.log('\n【1】★ 两种图片形态都要能上传（这是本次报错根因）');
{
  const fn = run.slice(run.indexOf('async function uploadCoverWithRetry'));
  ok(run.includes('async function uploadCoverWithRetry('), '有专门的上传函数');
  ok(fn.includes("r.b64") && fn.includes("'/api/wechat/upload'"), '有 b64 → 走 /upload');
  ok(fn.includes("r.url") && fn.includes("'/api/wechat/upload-url'"), '无 b64 只有 url → 走 /upload-url');
  // 关键：原来只有 if (r.b64) 才上传，现在无条件上传
  const i = fn.indexOf('uploadCoverWithRetry');
  ok(!/if \(r\.b64\)\s*\{\s*const up/.test(run), '不再把上传包在 if (r.b64) 里');
  ok(run.includes('RUN.thumbMediaId = await uploadCoverWithRetry(r, log);'), '封面步骤无条件调用上传');
  ok(run.includes("if (up && up.media_id) return up.media_id;"), '拿到 media_id 才算成功');
  ok(run.includes("lastErr = '后端未返回 media_id'"), 'media_id 缺失也算失败并记录原因');
}

console.log('\n【2】★ 速率限制要能自动重试（日志里出现过 1302）');
{
  const fn = run.slice(run.indexOf('async function uploadCoverWithRetry'));
  ok(/tries = tries \|\| 3;/.test(fn), '默认重试 3 次');
  ok(fn.includes('封面上传重试'), '重试会写日志（用户能看到在等）');
  ok(fn.includes('await new Promise(x => setTimeout(x, wait));'), '重试前有递增等待');
  ok(/const wait = i \* 8000;/.test(fn), '等待时间递增（8s/16s）');
  ok(fn.includes("log('✗ 封面上传最终失败：'"), '最终失败也有明确日志');
  ok(fn.includes("return '';"), '最终失败返回空串（由调用方判断）');
}

console.log('\n【3】★ 失败后能从失败步续跑，不必从头再来');
{
  ok(run.includes('lastFailStep: -1'), '状态里有失败步记录');
  ok(run.includes('RUN.lastFailStep = RUN.step;'), 'catch 里记录失败步');
  ok(run.includes('RUN.lastFailStep >= 0 ?') && run.includes('id="wfResume"'), '有「从失败步续跑」按钮');
  ok(run.includes('if (rsm) rsm.onclick'), '续跑按钮已绑定');
  ok(run.includes('startRun(from)'), '续跑从指定步开始');
  ok(run.includes("log('↻ 从「'"), '续跑会写日志');
  // 续跑按钮按需出现，不占位
  ok(run.includes("RUN.lastFailStep >= 0 ?"), '没失败时不显示续跑按钮');
}

console.log('\n【4】★ 续跑要复用已生成的封面图（省钱+避开速率限制）');
{
  ok(run.includes('coverImgResult: null'), '状态里保存了生图结果');
  ok(run.includes('let r = RUN.coverImgResult;'), '续跑时优先取已生成的图');
  ok(run.includes('RUN.coverImgResult = r;'), '生图后存起来');
  ok(run.includes('复用上一次生成的封面图（未重新生图）'), '复用时明确告知用户');
  ok(run.includes("if (!RUN.thumbMediaId) {"), '已拿到 media_id 则跳过重复上传');
  // 顺序：先查已有 media_id，再复用图，再上传
  const iMedia = run.indexOf('if (!RUN.thumbMediaId) {');
  const iReuse = run.indexOf('let r = RUN.coverImgResult;');
  ok(iReuse > -1 && iMedia > -1, '两处逻辑都在');
}

console.log('\n【5】上传阶段要有可见进度（否则像卡住）');
{
  ok(run.includes("note:'正在上传素材给微信…'"), '上传中会在步骤上显示提示');
  ok(run.includes("note:'正在上传素材给微信…'"), '上传期间状态保持 run');
  ok(run.includes('paintSteps();'), '上传前刷新步骤显示');
  ok(run.includes('已上传素材给微信'), '成功时注明');
  ok(run.includes("可点「重试封面」再试一次"), '失败提示里指引续跑（速率限制常见）');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
