import { EMPLOYEES, KPIS, FEED, SOCIAL } from './data/employees.js';
import { $ } from './dom.js';

function statusPill(s) {
  const map = { run: ['run', '运行中'], idle: ['idle', '待命'], learn: ['learn', '学习中'] };
  const [cls, txt] = map[s] || map.idle;
  return `<span class="pill ${cls}"><span class="dot"></span>${txt}</span>`;
}

export function renderKPIs() {
  $('#kpiRow').innerHTML = KPIS.map(k => `
    <div class="kpi">
      <div class="label">${k.label}</div>
      <div class="val">${k.val}</div>
      <div class="delta ${k.up ? 'up' : 'down'}">${k.up ? '▲' : '▼'} ${k.delta}</div>
    </div>`).join('');
}

export function empCard(e) {
  const toolBtn = e.tool
    ? `<a class="emp-tool-btn" href="${window.withApi(e.tool)}" target="_blank" rel="noopener">打开专用工具 ↗</a>`
    : '';
  return `<div class="emp-card" data-emp="${e.id}">
    <div class="top">
      <div class="emp-ava" style="background:${e.color}">${e.icon}</div>
      <div><h3>${e.name}</h3><div class="role">${e.role} · ${e.cat}</div></div>
    </div>
    <div class="desc">${e.tagline}</div>
    <div class="meta">${statusPill(e.status)}<span>${e.nodes.length} 个工作节点</span></div>
    ${toolBtn ? `<div class="emp-foot">${toolBtn}</div>` : ''}
  </div>`;
}

export function renderEmpGrids() {
  $('#empGrid').innerHTML = EMPLOYEES.map(empCard).join('');
  $('#empGridEcom').innerHTML = EMPLOYEES.filter(e => e.cat === '电商').map(empCard).join('');
  $('#empGridSocial').innerHTML = EMPLOYEES.filter(e => e.cat === '自媒体').map(empCard).join('');
}

export function renderFeed() {
  $('#actFeed').innerHTML = `<div class="section-title" style="margin:6px 8px 8px"><span class="bar"></span>实时动态</div>` +
    FEED.map(f => `
    <div class="feed-item">
      <div class="feed-ico" style="background:${f.c}">${f.ico}</div>
      <div><div class="ft">${f.t}</div><div class="fd">${f.d}</div></div>
      <div class="ftime">${f.time}</div>
    </div>`).join('');
}

export function renderSocial() {
  $('#socialGrid').innerHTML = SOCIAL.map(s => `
    <div class="social-card"${s.id ? ` data-id="${s.id}"` : ''}>
      <div class="head">
        <div class="ico" style="background:${s.c}">${s.icon}</div>
        <div><div class="pname">${s.name}</div><div class="phandle">${s.handle}</div></div>
      </div>
      <div class="metrics">
        <div class="m"><div class="mv" data-f="fans">${s.fans}</div><div class="ml">粉丝</div></div>
        <div class="m"><div class="mv" data-f="views">${s.views}</div><div class="ml">曝光</div></div>
        <div class="m"><div class="mv">${s.eng}</div><div class="ml">互动率</div></div>
        <div class="m"><div class="mv" style="font-size:13px">${s.post}</div><div class="ml">今日产出</div></div>
      </div>
      <div class="pstat"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:${s.st === '活跃' ? 'var(--good)' : s.st === '待群发' ? 'var(--warn)' : 'var(--text-faint)'}"></span>${s.st}</div>
      <div class="mini-prog"><i style="width:${s.prog}%"></i></div>
      ${s.id === 'wechat' ? `<a class="social-link" href="${window.withApi('wechat-dashboard.html')}" target="_blank" rel="noopener">查看真实数据 ↗</a>` : ''}
    </div>`).join('');

  const sched = [
    '08:00 小红书笔记', '12:00 抖音短视频', '15:00 微信公众号', '18:00 TikTok Reels', '20:00 Instagram 图文', '21:00 抖音直播预告'
  ];
  $('#socialSchedule').innerHTML = sched.map((s, i) => {
    const [time, txt] = s.split(' ');
    return `${i ? '<span class="pipe-arrow">→</span>' : ''}<div class="pipe-step">🕐 ${time}<br><span style="color:var(--text-dim);font-weight:500">${txt}</span></div>`;
  }).join('');

  // 接入真实公众号数据（无后端时静默保留静态数据）
  refreshWechatMatrix();
}

// 媒体矩阵「微信公众号」卡片拉取真实数据（best-effort，失败不影响其余展示）
async function refreshWechatMatrix() {
  const base = window.getApiBase ? window.getApiBase() : '';
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!base && !local) return;
  try {
    const r = await fetch((base || '') + '/api/wechat/overview', { headers: window.apiAuthHeaders ? window.apiAuthHeaders() : {} });
    if (!r.ok) return;
    const d = await r.json();
    const card = document.querySelector('.social-card[data-id="wechat"]');
    if (!card) return;
    if (d.fans != null) {
      card.querySelector('[data-f="fans"]').textContent = fmtNum(d.fans);
      card.querySelector('.pstat').innerHTML = '<span class="dot" style="width:7px;height:7px;border-radius:50%;background:var(--good)"></span>已接入真实数据';
    }
    if (d.articleStats && d.articleStats.length) {
      const tot = d.articleStats.reduce((a, b) => a + (b.int_page_read_count || 0), 0);
      card.querySelector('[data-f="views"]').textContent = fmtNum(tot);
    }
  } catch { /* 忽略：保留静态展示 */ }
}

function fmtNum(n) {
  if (n == null) return n;
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
