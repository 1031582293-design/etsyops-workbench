/**
 * 工作流画布运行台 自测
 * 从真实文件里抽代码/结构来断言，不重写实现。
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

const run = fs.readFileSync('src/wechat-run.js', 'utf8');
const wf = fs.readFileSync('src/workflow.js', 'utf8');
const css = fs.readFileSync('src/styles/components.css', 'utf8');
const pub = fs.readFileSync('wechat-publisher.html', 'utf8');

console.log('='.repeat(72));
console.log('工作流画布运行台自测');
console.log('='.repeat(72));

console.log('\n【1】保持纵向布局 + 画布接入');
{
  ok(wf.includes('<div class="flow">'), '原有纵向 .flow 布局保留未改');
  ok(wf.includes("id === 'wechat'"), '仅公众号工作流挂运行台');
  ok(wf.includes('id="wfRunBar"'), '运行台容器已插入画布');
  ok(wf.includes('id="wfHistory"'), '运行历史容器已插入');
  ok(wf.includes('id="wfConfirm"'), '确认弹层容器已插入');
  ok(wf.includes("import('./wechat-run.js')"), '动态加载执行器（不影响其它工作流）');
  ok(/renderWfSide|renderWfCanvas/.test(wf), '侧栏与画布渲染函数保留');
}

console.log('\n【2】六步流程与失败策略（方案A：停下等人）');
{
  for (const k of ['upload', 'gen', 'title', 'cover', 'layout', 'draft']) {
    ok(run.includes("key: '" + k + "'"), '含步骤 ' + k);
  }
  ok(run.includes("state: 'fail'"), '失败时标记 fail');
  ok(run.includes("patchRun('failed')"), '失败状态落库');
  ok(/patchRun\('failed'\)/.test(run) && /body: \{ status,/.test(run), 'failed 状态通过 PATCH 传给后端');
  ok(!run.includes("state: 'skip'"), '不做「跳过继续」（按用户选的方案A）');
}

console.log('\n【3】排版后人工确认闸门');
{
  ok(run.includes("state: 'wait'"), '排版后进入 wait 状态');
  ok(run.includes("patchRun('paused')"), '暂停状态落库');
  ok(run.includes('showConfirm()'), '弹确认层');
  ok(run.includes('id="wfCfOk"'), '有「确认写入草稿箱」按钮');
  ok(run.includes('id="wfCfNo"'), '有「再改改」按钮');
  ok(run.includes('startRun(5)'), '确认后从第6 步续跑');
  // 关键：不能一口气跑到底
  const iConfirm = run.indexOf('showConfirm()');
  const iDraft = run.indexOf("key: 'draft', title: '写入草稿箱', state: 'ok'");
  ok(iConfirm > -1 && iDraft > -1, '写入草稿箱在确认之后执行');
}

console.log('\n【4】标题自动化（画布用最推荐）');
{
  ok(run.includes('r.top ||'), '画布直接采用接口返回的最推荐 top');
  ok(run.includes("note: '采用最推荐'"), '日志写明采用最推荐');
  ok(pub.includes('id="titleTopInput"'), '工具页有最推荐主框');
  ok(pub.includes('id="titleList"'), '工具页保留候选列表');
  ok(pub.includes("const top = d.top || d.titles[0]"), '工具页同样优先用 top');
  ok(pub.includes('★ 最推荐标题（可直接编辑）'), '主框标注为最推荐');
  ok(pub.includes("$('#titleTopInput').oninput"), '主框可手动编辑并同步');
}

console.log('\n【5】运行历史落库');
{
  ok(run.includes("API() + '/api/runs'"), '调用落库接口');
  ok(run.includes("method: 'POST'"), '新建用 POST');
  ok(run.includes("method: 'PATCH'"), '更新用 PATCH');
  ok(run.includes("method: 'DELETE'"), '支持删除');
  ok(run.includes('loadRunHistory'), '有加载历史函数');
  ok(run.includes('id="wfHistClear"'), '有清空历史按钮');
  ok(run.includes("data-delrun"), '单条历史可删除');
  ok(run.includes("patchRun('done')"), '全部完成时落库 done');
}

console.log('\n【6】上传入口');
{
  ok(run.includes('拖拽文稿到这里'), '有拖拽上传区');
  ok(run.includes('id="wfFile"'), '有文件选择 input');
  ok(run.includes('id="wfDrop"'), '有拖拽落点');
  ok(run.includes('addFiles'), '有 addFiles 处理');
  ok(run.includes('accept=".md,.txt,.html,.htm,.docx,.pdf"'), '支持多格式');
  ok(run.includes('multiple'), '支持多选');
}

console.log('\n【7】进度与日志');
{
  ok(run.includes('wf-prog'), '有进度条');
  ok(run.includes("done / STEP_DEFS.length"), '进度按已完成步数算');
  ok(run.includes('wf-logs'), '有日志区');
  ok(run.includes('运行日志'), '日志有标题');
  ok(run.includes('RUN.logs.push'), '日志逐条累积');
  ok(run.includes('ms: Date.now() - s0'), '每步记录耗时');
  ok(run.includes("toFixed(1) + 's'"), '耗时以秒显示');
  ok(run.includes("(st.ms / 1000).toFixed(1)"), '步骤标签上的耗时也按秒显示');
}

console.log('\n【8】生稿复用分片逻辑（与工具页一致）');
{
  ok(run.includes("'/api/ai/generate'"), '调用生稿接口');
  ok(run.includes('async: true'), '用异步任务模式');
  ok(run.includes("'/api/ai/job?id='"), '轮询任务');
  ok(run.includes('&from='), '分片取回（这是修过卡死的关键）');
  ok(run.includes('buf.length < total'), '校验取回完整性');
  ok(run.includes('for (let i = 0; i < 200; i++)'), '轮询上限约 5 分钟');
}

console.log('\n【9】样式齐备（浅色主题下也可读）');
{
  for (const c of ['.wf-runbar', '.wf-drop', '.wf-prog', '.wf-logs', '.wf-log-l',
                   '.wf-run-step.run', '.wf-run-step.ok', '.wf-run-step.fail',
                   '.wf-run-step.wait', '.wf-confirm', '.wf-hist-i']) {
    ok(css.includes(c), '有样式 ' + c);
  }
  ok(css.includes('--text-faint') || css.includes('--text-dim'), '使用主题变量而非硬编码颜色');
}

console.log('\n【10】安全：文件名与内容不注入 HTML');
{
  ok(run.includes("RUN.files.map(f => f.name)"), '文件名只作数据传递');
  ok(pub.includes("f.name.replace(/[<>]/g,'')"), '工具页文件名已过滤尖括号');
  ok(!run.includes('innerHTML = RUN.files'), '未把文件名直接塞 innerHTML');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);