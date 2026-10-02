import { $, $$ } from './dom.js';
import { renderKPIs, renderEmpGrids, renderFeed, renderSocial } from './render.js';
import {
  renderWfSide, renderWfCanvas, renderWfDetail, bindWfSide, setCurrentEmp
} from './workflow.js';

/* ===== 视图切换 ===== */
function switchView(v) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'workflow' && !$('#wfCanvas').innerHTML) {
    renderWfSide(); renderWfCanvas(); renderWfDetail();
  }
}

$$('.tab').forEach(t => (t.onclick = () => switchView(t.dataset.view)));

/* ===== 员工卡片 → 进入工作流 ===== */
['#empGrid', '#empGridEcom', '#empGridSocial'].forEach(sel => {
  $(sel).addEventListener('click', ev => {
    const card = ev.target.closest('[data-emp]');
    if (!card) return;
    setCurrentEmp(card.dataset.emp);
    switchView('workflow');
    renderWfSide(); renderWfCanvas(); renderWfDetail();
  });
});

/* ===== 工作流侧栏选择 ===== */
bindWfSide(() => {
  renderWfSide(); renderWfCanvas(); renderWfDetail();
});

/* ===== 指令框 ===== */
$('#cmdInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    alert('已收到指令：「' + e.target.value.trim() + '」\n（Demo 中指令将路由到对应数字员工并触发工作流）');
  }
});

/* ===== 初始化 ===== */
renderKPIs();
renderEmpGrids();
renderFeed();
renderSocial();
renderWfSide();
renderWfCanvas();
renderWfDetail();
