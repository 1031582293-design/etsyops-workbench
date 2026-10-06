import { EMPLOYEES } from './data/employees.js';
import { $, $$ } from './dom.js';

let currentEmp = EMPLOYEES[0].id;

export function setCurrentEmp(id) { currentEmp = id; }
export function getCurrentEmp() { return currentEmp; }

export function renderWfSide() {
  const groups = { 电商: [], 自媒体: [] };
  EMPLOYEES.forEach(e => groups[e.cat].push(e));
  let html = '';
  for (const g of ['电商', '自媒体']) {
    html += `<div class="grp">${g}数字员工</div>`;
    html += groups[g].map(e => `
      <div class="wf-emp ${e.id === currentEmp ? 'active' : ''}" data-emp="${e.id}">
        <div class="mini" style="background:${e.color}">${e.icon}</div>
        <div><div class="nm">${e.name}</div><div class="st">${e.nodes.length} 节点</div></div>
      </div>`).join('');
  }
  $('#wfSide').innerHTML = html;
}

export function renderWfCanvas() {
  const e = EMPLOYEES.find(x => x.id === currentEmp);
  const head = `<div class="wf-head">
    <div class="big" style="background:${e.color}">${e.icon}</div>
    <div><h2>${e.name}</h2><div class="tag">${e.tagline}</div></div>
    <div class="wf-actions">
      <button class="btn" id="resetBtn">↺ 重置</button>
      <button class="btn primary" id="runBtn">${e.id === 'wechat' ? '⚡ 去运行台' : '▶ 演示工作流'}</button>
    </div>
  </div>`;
  const flow = e.nodes.map((n, i) => `
    <div class="node" data-i="${i}">
      <div class="step">${i + 1}</div>
      <div class="nbody">
        <div class="ntitle">${n.t} <span class="nskill">⚡ ${n.skill}</span></div>
        <div class="ndesc">${n.d}</div>
        <div class="nout">📦 交付：${n.out}</div>
      </div>
      <div class="status-tag" data-i="${i}"></div>
    </div>
    ${i < e.nodes.length - 1 ? '<div class="connector"><div class="flow-line"></div></div>' : ''}
  `).join('');
  // 公众号工作流是「可执行」的：底部挂真实运行台
  const runBar = e.id === 'wechat' ? `
    <div class="wf-runbar" id="wfRunBar"></div>
    <div class="wf-confirm" id="wfConfirm" style="display:none"></div>
    <div class="wf-history" id="wfHistory" style="display:none"></div>` : '';
  $('#wfCanvas').innerHTML = head + `<div class="flow">${flow}</div>` + runBar;
  if (e.id === 'wechat') {
    // 动态 import，避免非公众号工作流加载这段逻辑
    import('./wechat-run.js').then(m => {
      m.paintWechatRunBar();
      m.loadRunHistory('wechat');
    }).catch(err => console.error('[wechat-run] 加载失败', err));
  }
  $('#runBtn').onclick = () => runWorkflow();
  $('#resetBtn').onclick = () => { renderWfCanvas(); renderWfDetail(); };
}

export function renderWfDetail() {
  const e = EMPLOYEES.find(x => x.id === currentEmp);
  $('#wfDetail').innerHTML = `
    <h4>数字员工档案</h4>
    <div class="info-row"><div class="k">角色</div><div class="v">${e.role}</div></div>
    <div class="info-row"><div class="k">状态</div><div class="v">${e.status === 'run' ? '运行中' : e.status === 'learn' ? '学习中' : '待命'}</div></div>
    <div class="info-row"><div class="k">内置节点</div><div class="v">${e.nodes.length} 个（按 SOP 串联）</div></div>
    <div class="info-row"><div class="k">协作对象</div><div class="v">${e.cat === '电商' ? '选品→Listing→客服→数据→广告' : '内容主编→各平台运营→数据复盘'}</div></div>
    ${e.tool ? `<a class="btn primary" href="${window.withApi(e.tool)}" target="_blank" rel="noopener" style="text-decoration:none;width:100%;justify-content:center;margin:12px 0 4px">打开专用工具 ↗</a>` : ''}
    <h4 style="margin-top:18px">交付成果</h4>
    <div class="deliver" id="deliverBox">
      ${e.deliverables.map(d => `
        <div class="deliver-item"><div class="di">✓</div><div><div class="dt">${d.t}</div><div class="dd">${d.d}</div></div></div>`).join('')}
    </div>`;
}

function toastTip(msg){
  let el = document.getElementById('wfTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wfTip';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:28px;'
      + 'background:rgba(20,24,34,.94);color:#fff;padding:10px 18px;border-radius:10px;'
      + 'font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:80vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el.__t);
  el.__t = setTimeout(()=>{ el.style.display = 'none'; }, 4000);
}

export function runWorkflow() {
  const e0 = EMPLOYEES.find(x => x.id === currentEmp);

  // ★ 公众号工作流下方挂的是「真实运行台」（会真调后端、落库、记日志），
  //   所以这里的假动画必须让路——否则用户看到「点了运行，节点全变绿」
  //   却什么都没发生，完全是误导。
  if (e0 && e0.id === 'wechat') {
    const bar = $('#wfRunBar');
    if (bar) {
      bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const run = $('#wfRun');
      if (run) { run.focus(); run.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    toastTip('下方是真实运行台：先拖入文稿，再点「▶ 运行」才会真正执行');
    return;
  }

  // 演示模式（仅用于尚未接入真实后端的展示型工作流）
  const runBtn = $('#runBtn');
  runBtn.disabled = true; runBtn.textContent = '⏳ 演示动画中…';
  const e = EMPLOYEES.find(x => x.id === currentEmp);
  const nodes = $$('.node');
  const tags = $$('.status-tag');
  const deliverBox = $('#deliverBox');
  deliverBox.innerHTML = `<div class="empty">工作流执行中，数字员工正在串联各节点…</div>`;
  nodes.forEach(n => n.classList.remove('active', 'done'));
  tags.forEach(t => t.className = 'status-tag');

  let i = 0;
  function step() {
    if (i > 0) {
      nodes[i - 1].classList.remove('active'); nodes[i - 1].classList.add('done');
      tags[i - 1].className = 'status-tag done'; tags[i - 1].textContent = '✓ 完成';
    }
    if (i >= nodes.length) { finish(); return; }
    nodes[i].classList.add('active'); tags[i].className = 'status-tag run'; tags[i].textContent = '● 执行中';
    i++;
    setTimeout(step, 950);
  }
  function finish() {
    runBtn.disabled = false; runBtn.textContent = '▶ 重新演示';
    deliverBox.innerHTML = e.deliverables.map(d => `
      <div class="deliver-item"><div class="di">✓</div><div><div class="dt">${d.t}</div><div class="dd">${d.d}</div></div></div>`).join('');
  }
  setTimeout(step, 300);
}

// 侧边员工列表点击（仅绑定一次）
export function bindWfSide(onSelect) {
  $('#wfSide').addEventListener('click', ev => {
    const item = ev.target.closest('[data-emp]');
    if (!item) return;
    setCurrentEmp(item.dataset.emp);
    onSelect();
  });
}
