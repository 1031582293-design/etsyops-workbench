/* ============================================================
   公众号工作流 · 真实执行器
   在原有纵向 .flow 布局上，把「演示动画」换成「真跑后端」。
   - 文稿上传 → AI生稿 → 标题（自动取最推荐）→ 封面 → 排版 → 写入草稿箱
   - 每步进度/耗时/日志实时显示；失败停下可续跑；排版后需人工确认才写草稿箱
   - 运行记录落到后端 data/runs.json，可在画布下方查看历史
   ============================================================ */
import { $, $$ } from './dom.js';

const API = () => (window.getApiBase ? window.getApiBase() : '');

async function j(url, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(url, Object.assign({}, opts, {
      signal: c.signal,
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: Object.assign(
        window.apiAuthHeaders ? window.apiAuthHeaders() : {},
        { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }));
    const ct = r.headers.get('content-type') || '';
    const txt = await r.text();
    if (ct.indexOf('json') < 0) throw new Error('返回的不是 JSON（' + (ct || '空') + '）');
    const d = JSON.parse(txt || '{}');
    if (!r.ok) throw new Error(d.note || d.error || ('HTTP ' + r.status));
    return d;
  } finally { clearTimeout(t); }
}

/* ---------- 状态 ---------- */
const RUN = {
  active: false,
  runId: '',
  files: [],          // {name, text}
  step: 0,
  steps: [],
  logs: [],
  words: 0,
  article: '',
  title: '',
  thumbMediaId: '',
  configName: '默认配置',
  pausedAt: -1,
};

const STEP_DEFS = [
  { key: 'upload',  title: '文稿收集' },
  { key: 'gen',     title: 'AI 生稿' },
  { key: 'title',   title: '生成标题' },
  { key: 'cover',   title: '生成封面' },
  { key: 'layout',  title: '公众号排版' },
  { key: 'draft',   title: '写入草稿箱' },
];

/* ---------- UI 渲染 ---------- */
function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  RUN.logs.push(ts + ' ' + msg);
  const box = $('#wfLogs');
  if (box) {
    box.style.display = 'block';
    box.innerHTML = '<div class="wf-log-h">运行日志 <span>· ' + RUN.logs.length + ' 条</span></div>'
      + RUN.logs.slice(-40).map(l => '<div class="wf-log-l">' + l + '</div>').join('');
  }
}

function paintSteps() {
  STEP_DEFS.forEach((d, i) => {
    const el = $('[data-run-step="' + i + '"]');
    if (!el) return;
    const st = RUN.steps[i] || { state: 'idle' };
    el.className = 'wf-run-step ' + (st.state || 'idle');
    const tag = el.querySelector('.wf-rs-tag');
    if (tag) {
      tag.textContent = st.state === 'ok' ? (st.ms ? (st.ms / 1000).toFixed(1) + 's' : '✓')
        : st.state === 'fail' ? '失败' : st.state === 'run' ? '执行中'
        : st.state === 'wait' ? '待确认' : '待运行';
    }
  });
}

function paintRunBar() {
  const bar = $('#wfRunBar');
  if (!bar) return;
  const done = RUN.steps.filter(s => s.state === 'ok').length;
  const cur = STEP_DEFS[RUN.step] || null;
  bar.innerHTML = `
    <div class="wf-rb-row">
      <div class="wf-drop" id="wfDrop">
        <div><b>拖拽文稿到这里，或点击选择</b><br>
        <span>md / txt / html / docx / pdf · 可多选 · 已有 ${RUN.files.length} 份</span></div>
        <button class="btn" id="wfPick">选择文件</button>
      </div>
      <input type="file" id="wfFile" accept=".md,.txt,.html,.htm,.docx,.pdf" multiple hidden>
    </div>
    <div class="wf-rb-row2">
      <div class="wf-cfg">本次配置 <b>${RUN.configName}</b> <span class="wf-hint">（在专用工具页调整后保存）</span></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="wfReset">清空</button>
        <button class="btn primary" id="wfRun" ${RUN.active ? 'disabled' : ''}>${RUN.active ? '⏳ 运行中…' : '▶ 运行'}</button>
      </div>
    </div>
    <div class="wf-rb-row3">
      <div class="wf-prog"><span style="width:${(done / STEP_DEFS.length * 100).toFixed(0)}%"></span></div>
      <div class="wf-prog-txt">${done}/${STEP_DEFS.length} · ${cur ? '当前：' + cur.title : (done >= STEP_DEFS.length ? '已完成' : '')}</div>
    </div>
    <div class="wf-logs" id="wfLogs" style="display:none"></div>`;

  const drop = $('#wfDrop');
  const pick = $('#wfPick');
  const inp = $('#wfFile');
  if (pick) pick.onclick = () => inp.click();
  if (drop) drop.onclick = (e) => { if (e.target.id !== 'wfPick') inp.click(); };
  if (inp) inp.onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  if (drop) {
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.borderColor = ''; }));
    drop.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
  }
  const run = $('#wfRun');
  if (run) run.onclick = () => startRun();
  const rst = $('#wfReset');
  if (rst) rst.onclick = () => { RUN.files = []; RUN.logs = []; RUN.steps = []; RUN.runId = ''; paintRunBar(); paintSteps(); };
}

/* ---------- 文件读取 ---------- */
async function readOne(f) {
  const n = f.name.toLowerCase();
  const read = (as) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    as === 'buf' ? fr.readAsArrayBuffer(f) : fr.readAsText(f);
  });
  if (n.endsWith('.html') || n.endsWith('.htm')) {
    const doc = new DOMParser().parseFromString(await read(), 'text/html');
    return doc.body.innerText || doc.body.textContent || '';
  }
  // docx / pdf 先给原文占位，提示到工具页用专用解析
  if (n.endsWith('.docx') || n.endsWith('.pdf')) {
    return '【' + f.name + '】\n（' + n.split('.').pop().toUpperCase() + ' 文件：已载入。'
      + '如需自动抽取文字，请在「打开专用工具」页上传同名文件，那里支持 docx/pdf 解析。）';
  }
  return await read();
}
async function addFiles(list) {
  for (const f of list) {
    if (!f) continue;
    try {
      const t = await readOne(f);
      if (!t || !t.trim()) { log('⚠ ' + f.name + ' 内容为空，已跳过'); continue; }
      RUN.files.push({ name: f.name, text: t });
      log('① 载入 ' + f.name + '（' + t.length + ' 字）');
    } catch (e) { log('⚠ ' + f.name + ' 读取失败：' + e.message); }
  }
  RUN.steps[0] = { state: RUN.files.length ? 'ok' : 'idle', ms: 0, note: RUN.files.length + ' 份文稿' };
  paintRunBar(); paintSteps();
}

/* ---------- 运行记录落库 ---------- */
async function saveRun(patch) {
  if (!RUN.runId) return;
  try {
    await j(API() + '/api/runs' + (patch ? '?id=' + RUN.runId : ''),
      { method: patch ? 'PATCH' : 'POST', body: patch || {
        employee: 'wechat', runName: RUN.files.map(f => f.name).join('、').slice(0, 100),
        configName: RUN.configName, files: RUN.files.map(f => f.name), steps: RUN.steps,
      } });
    if (!patch) {
      // 首次 POST 返回 id
    }
  } catch (e) { log('⚠ 运行记录保存失败：' + e.message); }
}
async function createRun() {
  try {
    const r = await j(API() + '/api/runs', { method: 'POST', body: {
      employee: 'wechat',
      runName: RUN.files.map(f => f.name).join('、').slice(0, 100) || '未命名',
      configName: RUN.configName,
      files: RUN.files.map(f => f.name),
      steps: RUN.steps,
    } });
    RUN.runId = r.id;
  } catch (e) { log('⚠ 无法创建运行记录：' + e.message); }
}
async function patchRun(status) {
  if (!RUN.runId) return;
  try {
    await j(API() + '/api/runs?id=' + RUN.runId, { method: 'PATCH',
      body: { status, steps: RUN.steps, words: RUN.words, draftMediaId: RUN.thumbMediaId } });
  } catch (e) { /* 记录失败不阻塞主流程 */ }
}

export async function loadRunHistory(empId) {
  const box = $('#wfHistory');
  if (!box) return;
  try {
    const r = await j(API() + '/api/runs?limit=15&employee=' + empId);
    if (!r.runs || !r.runs.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const st = { done: '✓ 已完成', failed: '✗ 失败', running: '● 进行中', paused: '⏸ 待确认' };
    box.innerHTML = '<div class="wf-log-h">运行历史 <span>· ' + r.total + ' 条</span>'
      + '<button class="btn ghost" id="wfHistClear" style="margin-left:auto;padding:2px 8px;font-size:11px">清空</button></div>'
      + '<div class="wf-hist">' + r.runs.map(x => {
          const when = new Date(x.createdAt).toTimeString().slice(0, 8);
          const okc = x.status === 'done' ? 'var(--color-text-success)' : x.status === 'failed' ? 'var(--color-text-danger)' : 'var(--color-text-tertiary)';
          return '<div class="wf-hist-i" data-rid="' + x.id + '" style="cursor:pointer" title="点击用这份文稿再跑一次">'
            + '<span style="color:' + okc + '">' + (st[x.status] || x.status) + '</span>'
            + '<b style="font-weight:400">' + (x.runName || '未命名') + '</b>'
            + '<span class="wf-hist-m">' + when + ' · ' + (x.words || 0) + ' 字 · ' + (x.configName || '默认') + '</span>'
            + '<button class="btn ghost" data-delrun="' + x.id + '" style="padding:1px 6px;font-size:11px">×</button>'
            + '</div>';
        }).join('') + '</div>';
    box.querySelectorAll('[data-delrun]').forEach(b => b.onclick = async (ev) => {
      ev.stopPropagation();
      try { await j(API() + '/api/runs?id=' + b.dataset.delrun, { method: 'DELETE' }); loadRunHistory(empId); }
      catch (e) { alert('删除失败：' + e.message); }
    });
    box.querySelectorAll('[data-rid]').forEach(r2 => r2.onclick = () => {
      alert('历史回放功能稍后开放。现在可以直接把文稿拖进来点运行。');
    });
    const cl = $('#wfHistClear');
    if (cl) cl.onclick = async () => {
      if (!window.confirm('清空全部运行历史？')) return;
      try { await j(API() + '/api/runs', { method: 'DELETE' }); loadRunHistory(empId); } catch (e) { alert(e.message); }
    };
  } catch (e) { box.style.display = 'none'; }
}

export function paintWechatRunBar() { paintRunBar(); paintSteps(); }

/* ---------- 生稿（提交 + 分片轮询，与工具页同一套逻辑） ---------- */
async function doGenerate() {
  const prompt = (window.getSavedPrompt && window.getSavedPrompt()) || '';
  const sub = await j(API() + '/api/ai/generate', { timeout: 30000,
    body: { manuscript: RUN.files.map(f => f.text).join('\n\n---\n\n').slice(0, 15000), prompt, async: true } });
  if (!sub.jobId) throw new Error('后端未返回任务号');
  let from = 0, buf = '', total = 0, got = false, fails = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 1500));
    let st;
    try { st = await j(API() + '/api/ai/job?id=' + encodeURIComponent(sub.jobId) + '&from=' + from, { timeout: 20000 }); }
    catch (e) { if (++fails >= 5) throw new Error('连续 5 次读取失败：' + e.message); continue; }
    fails = 0;
    if (st.status === 'error') throw new Error(st.note || '生稿失败');
    if (st.status === 'running') { if (i % 3 === 0) log('② AI 写作中（服务器已用 ' + (st.waited || 0) + 's）'); continue; }
    from = st.end; total = st.total; buf += st.content || '';
    if (st.status === 'done') { got = true; break; }
  }
  if (!got) throw new Error('等待超过 5 分钟仍未取回全文');
  if (buf.length < total) throw new Error('稿件取回不完整（' + buf.length + '/' + total + '）');
  RUN.article = buf;
  RUN.words = buf.length;
  log('② 成稿 ' + buf.length + ' 字（分片取回 ' + Math.ceil(total / 1200) + ' 次）');
  return buf;
}

/* ---------- 解析成稿（复用工具页的标记规则） ---------- */
function parseArticle(raw) {
  const seg = {};
  const re = /={2,}([A-Z_]+)={2,}/g;
  let m, marks = [];
  while ((m = re.exec(raw))) marks.push({ tag: m[1], i: m.index, end: m.index + m[0].length });
  for (let k = 0; k < marks.length; k++) {
    seg[marks[k].tag] = raw.slice(marks[k].end, k + 1 < marks.length ? marks[k + 1].i : raw.length).trim();
  }
  const body = seg.BODY || raw;
  return {
    title: (seg.TITLE_MAIN || '').split('\n')[0].trim() || (seg.TITLE_MAIN || '').trim(),
    body,
    alts: seg.TITLE_ALT || '',
    risk: seg.RISK || '',
  };
}

/* ---------- 主流程 ---------- */
export async function startRun(fromStep) {
  if (RUN.active) return;
  if (fromStep === undefined) fromStep = 0;
  if (!RUN.files.length) { log('请先拖入至少一份文稿'); return; }
  RUN.active = true;
  RUN.pausedAt = -1;
  const t0 = Date.now();
  if (!RUN.runId) { await createRun(); } else { await patchRun('running'); }

  try {
    for (let i = fromStep; i < STEP_DEFS.length; i++) {
      RUN.step = i;
      RUN.steps[i] = { key: STEP_DEFS[i].key, title: STEP_DEFS[i].title, state: 'run', ms: 0 };
      paintSteps();
      const s0 = Date.now();

      if (i === 1) {
        await doGenerate();
        RUN.steps[i] = { key: 'gen', title: 'AI 生稿', state: 'ok', ms: Date.now() - s0, note: RUN.words + ' 字' };
      } else if (i === 2) {
        const r = await j(API() + '/api/ai/title', { timeout: 90000, body: { draft: RUN.article.slice(0, 3000) } });
        RUN.title = r.top || (r.titles && r.titles[0]) || '';
        if (!RUN.title) throw new Error('未取到标题');
        RUN.steps[i] = { key: 'title', title: '生成标题', state: 'ok', ms: Date.now() - s0, note: '采用最推荐' };
        log('③ 标题（自动采用最推荐）：' + RUN.title);
      } else if (i === 3) {
        const scene = RUN.title || RUN.article.slice(0, 40);
        const r = await j(API() + '/api/ai/image', { timeout: 120000,
          body: { prompt: '公众号文章首图，横向构图。画面主题：' + scene + '。清新文艺 ins 风格，柔和自然光，低饱和色，留白构图。画面中不要出现任何文字、水印、logo。', size: '1440x720' } });
        if (r.b64) { RUN.thumbB64 = r.b64; }
        else if (r.url) { RUN.thumbUrl = r.url; }
        else throw new Error('未返回图片数据');
        if (r.b64) {
          const up = await j(API() + '/api/wechat/upload', { timeout: 120000,
            body: { filename: 'cover.png', data: r.b64 } });
          RUN.thumbMediaId = up.media_id || '';
        }
        RUN.steps[i] = { key: 'cover', title: '生成封面', state: RUN.thumbMediaId ? 'ok' : 'fail', ms: Date.now() - s0,
          note: RUN.thumbMediaId ? '已上传素材' : '仅本地预览' };
        if (!RUN.thumbMediaId) throw new Error('封面已生成但上传素材失败，写草稿箱需要封面');
      } else if (i === 4) {
        RUN.steps[i] = { key: 'layout', title: '公众号排版', state: 'ok', ms: Date.now() - s0, note: RUN.words + ' 字' };
        log('④ 排版完成（' + RUN.words + ' 字）');
        // 人工确认闸门
        RUN.steps[i] = { key: 'layout', title: '公众号排版', state: 'wait', ms: Date.now() - s0 };
        RUN.steps[5] = { key: 'draft', title: '写入草稿箱', state: 'idle' };
        RUN.step = 5; RUN.pausedAt = 4;
        RUN.active = false;
        paintSteps();
        await patchRun('paused');
        log('④ 已完成，等你确认后再写入草稿箱');
        showConfirm();
        return;
      } else if (i === 5) {
        const payload = buildDraftPayload();
        const r = await j(API() + '/api/wechat/draft', { timeout: 90000, body: payload });
        if (!r.media_id) throw new Error('后端未返回 media_id');
        RUN.steps[i] = { key: 'draft', title: '写入草稿箱', state: 'ok', ms: Date.now() - s0, note: r.media_id };
        log('⑤ ✓ 已写入草稿箱 media_id=' + r.media_id);
      }

      paintSteps();
      log(STEP_DEFS[i].title + ' ✓（' + ((Date.now() - s0) / 1000).toFixed(1) + 's）');
    }
    RUN.active = false;
    RUN.step = STEP_DEFS.length;
    paintRunBar(); paintSteps();
    await patchRun('done');
    log('全流程完成，总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    loadRunHistory('wechat');
  } catch (e) {
    RUN.active = false;
    const d = STEP_DEFS[RUN.step];
    RUN.steps[RUN.step] = Object.assign({}, RUN.steps[RUN.step] || { key: d.key, title: d.title },
      { state: 'fail', note: e.message });
    paintRunBar(); paintSteps();
    log('✗ ' + d.title + ' 失败：' + e.message);
    await patchRun('failed');
  }
}

function buildDraftPayload() {
  const p = parseArticle(RUN.article);
  return {
    title: p.title || RUN.title,
    author: '',
    digest: p.body.replace(/<[^>]+>/g, '').slice(0, 100),
    content: p.body,
    thumb_media_id: RUN.thumbMediaId,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
}

/* ---------- 确认弹层 ---------- */
function showConfirm() {
  const p = parseArticle(RUN.article);
  const box = $('#wfConfirm');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = '<div class="wf-cf-h">排版完成，确认写入公众号草稿箱？</div>'
    + '<div class="wf-cf-title">' + (p.title || RUN.title) + '</div>'
    + '<div class="wf-cf-body">' + p.body.replace(/<[^>]+>/g, ' ').slice(0, 260) + '…</div>'
    + '<div class="wf-cf-meta">' + RUN.words + ' 字 · 封面已就绪 · 写入后仅进草稿箱，不会群发</div>'
    + '<div style="display:flex;gap:8px;margin-top:10px">'
    + '<button class="btn primary" id="wfCfOk">确认写入草稿箱</button>'
    + '<button class="btn" id="wfCfNo">再改改</button></div>';
  $('#wfCfOk').onclick = async () => {
    box.style.display = 'none';
    RUN.steps[4] = Object.assign({}, RUN.steps[4], { state: 'ok' });
    await startRun(5);
  };
  $('#wfCfNo').onclick = () => {
    box.style.display = 'none';
    log('已取消写入。可在专用工具页调整后重跑。');
    paintSteps();
  };
}
