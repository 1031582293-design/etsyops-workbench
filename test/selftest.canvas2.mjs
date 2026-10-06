/** 画布去演示 + prompt 传递 自测 */
import fs from 'node:fs';
const wf = fs.readFileSync('src/workflow.js', 'utf8');
const run = fs.readFileSync('src/wechat-run.js', 'utf8');
const pub = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('画布去演示 + prompt 传递 自测');
console.log('='.repeat(72));

console.log('\n【1】★ 公众号工作流不跑演示动画');
{
  ok(wf.includes("if (e0 && e0.id === 'wechat') {"), 'runWorkflow 里对 wechat 提前返回');
  const i = wf.indexOf('export function runWorkflow()');
  const seg = wf.slice(i, i + 900);
  ok(seg.indexOf("e0.id === 'wechat'") < seg.indexOf('演示模式'), '判断在演示逻辑之前');
  ok(seg.includes("toastTip("), '会提示用户去真实运行台');
  ok(seg.includes("$('#wfRun')"), '会聚焦到下方运行台的运行按钮');
  ok(seg.includes('演示动画中…'), '演示文案改为「演示动画中」而非「运行中」');
  ok(wf.includes("'⚡ 去运行台'"), '公众号的按钮文案改为「去运行台」');
  ok(wf.includes("'▶ 演示工作流'"), '其他工作流明确标为「演示工作流」');
  ok(wf.includes("runBtn.textContent = '▶ 重新演示'"), '演示结束文案改为「重新演示」');
  ok(wf.includes('function toastTip('), '有轻提示函数');
}

console.log('\n【2】★ prompt 必须有兜底（原来永远为空 → 报「缺少 prompt」）');
{
  // 排除注释行（注释里引用了旧写法做说明）
  const runCode = run.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  ok(!runCode.includes('window.getSavedPrompt'), '代码中不再调用 window.getSavedPrompt（跨页面拿不到）');
  ok(run.includes("localStorage.getItem('wx_ai_current_prompt')"), '从 localStorage 读共享 prompt');
  ok(run.includes('const DEFAULT_GEN_PROMPT'), '有内置兜底 prompt');
  ok(run.includes('prompt = DEFAULT_GEN_PROMPT;'), '读不到时用兜底');
  ok(run.includes('未读到已保存的生稿要求，改用内置默认要求'), '会记录一条日志说明用了兜底');
  ok(run.includes("if(!prompt) throw new Error('生稿要求为空"), '兜底也没有才报错');
  // 兜底内容本身要够用
  const m = run.match(/const DEFAULT_GEN_PROMPT = `([\s\S]*?)`;/);
  ok(!!m && m[1].length > 40, '内置兜底 prompt 内容够完整', m ? m[1].length + ' 字符' : '未找到');
}

console.log('\n【3】工具页要真的写入共享 prompt');
{
  ok(pub.includes("const PROMPT_SHARE_KEY = 'wx_ai_current_prompt'"), '定义了共享 key（与画布一致）');
  ok(pub.includes('function sharePrompt('), '有 sharePrompt');
  ok(pub.includes('function readSharedPrompt('), '有 readSharedPrompt');
  ok(pub.includes('sharePrompt(DEFAULT_PROMPT);'), '初始化时就把默认 prompt 写进共享 key');
  ok(pub.includes("sharePrompt($('#aiPrompt').value);"), '切风格时同步');
  ok(pub.includes('sharePrompt(styles[name]);'), '存风格时同步');
  ok(pub.includes("if(id==='aiPrompt') sharePrompt($('#aiPrompt').value);"), '手动编辑时同步');
  ok(pub.includes('window.getSavedPrompt = readSharedPrompt;'), '也保留全局函数（调试用）');
}

console.log('\n【4】画布配置名要真实反映用的是哪套');
{
  ok(run.includes('function syncConfigName()'), '有配置名同步函数');
  ok(run.includes("localStorage.getItem('wx_ai_styles_v1')"), '读工具页保存的风格表');
  ok(run.includes("RUN.configName = name || '默认配置';"), '匹配不到时显示默认配置');
  ok(run.includes('syncConfigName();\n  const done'), '渲染进度条时同步配置名');
  ok(run.includes('本次配置'), '进度条显示「本次配置」');
}

console.log('\n【5】没有文稿时不该假装能跑');
{
  ok(run.includes("if (!RUN.files.length) { log('请先拖入至少一份文稿'); return; }"), '无文稿直接拒绝并提示');
  const i = run.indexOf('export async function startRun');
  const seg = run.slice(i, i + 700);
  ok(seg.indexOf('!RUN.files.length') < seg.indexOf('for (let i = fromStep'), '检查在执行循环之前');
  ok(run.includes("'请先拖入至少一份文稿'"), '提示文案明确');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);
