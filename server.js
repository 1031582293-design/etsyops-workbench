// 零依赖服务器：既是静态文件托管（供 CloudStudio / 任意云端环境），
// 也是公众号真实 API 的安全代理（把 AppSecret 留在服务端，前端只调本机 /api）。
// 仅用 Node 内置模块（node:http / node:https / node:fs / node:path / node:url），
// 无需 npm install，npm start 即可监听 process.env.PORT || 3000。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

// 后端自身版本号（git 短提交号），供前端状态区显示，便于确认“正在跑的是哪份代码”
const SERVER_VERSION = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() || 'unknown';
  } catch { return 'unknown'; }
})();

// 零依赖读取 .env（不引入 dotenv 依赖；.env 已被 .gitignore 忽略，凭证不入库）
function loadDotEnv() {
  try {
    const txt = readFileSync(join(ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* 没有 .env 则忽略，回退到系统环境变量 */ }
}
loadDotEnv();

// 崩溃兜底：单个请求的未捕获异常/未处理拒绝不应搞死整个进程（否则隧道转发不到本地 → 前端报“无法连接后端”）
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack || e));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 允许跨域的前端源（Cloudflare Pages 前端需访问本后端）。逗号分隔可配多个，* 表示任意。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://etsyops-workbench.pages.dev,http://localhost:3000').split(',').map(s => s.trim());
// 可选 API Key：设置了之后，发布/上传等写操作接口必须携带正确 key，挡住公开隧道的滥用。
const API_KEY = process.env.API_KEY || '';
function corsHeaders(res, req) {
  // 回显来源（没有 origin 时放行 *），确保 pages.dev / localhost / 127.0.0.1 / file:// 等任意页面 fetch 都不被浏览器 CORS 拦截
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Vary', 'Origin');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/* ===================== 公众号 API 代理 ===================== */
const WX_APPID = process.env.WECHAT_APPID || '';
const WX_SECRET = process.env.WECHAT_APPSECRET || '';
const WX_AUTHOR = process.env.WECHAT_AUTHOR || '';
const WX_BASE = 'https://api.weixin.qq.com';
let tokenCache = { token: '', expiresAt: 0 };

function wechatConfigured() {
  return Boolean(WX_APPID && WX_SECRET);
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }
  const url = `${WX_BASE}/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.access_token) {
    const err = new Error('获取 access_token 失败：' + JSON.stringify(data));
    err.wx = data;
    throw err;
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

// 把 base64 图片以 multipart 形式上传为「永久图片素材」，返回 media_id
async function uploadPermanentImage(filename, base64) {
  const token = await getAccessToken();
  const buf = Buffer.from(base64, 'base64');
  const boundary = '----EtsyOpsWxBoundary' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${WX_BASE}/cgi-bin/material/add_material?access_token=${token}&type=image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body,
  });
  const data = await r.json();
  if (!data.media_id) {
    const err = new Error('上传封面素材失败：' + JSON.stringify(data));
    err.wx = data;
    throw err;
  }
  return { media_id: data.media_id, url: data.url };
}

async function addDraft(article) {
  const token = await getAccessToken();
  const r = await fetch(`${WX_BASE}/cgi-bin/draft/add?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ articles: [article] }),
  });
  const data = await r.json();
  if (!data.media_id) {
    const err = new Error('创建草稿失败：' + JSON.stringify(data));
    err.wx = data;
    throw err;
  }
  return { media_id: data.media_id };
}

// 获取草稿箱列表（no_content=1 不返回正文，减轻体积）
async function getDraftList(offset = 0, count = 20) {
  const token = await getAccessToken();
  const r = await fetch(`${WX_BASE}/cgi-bin/draft/batchget?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, count, no_content: 1 }),
  });
  const d = await r.json();
  if (d.errcode) throw Object.assign(new Error('获取草稿箱失败：' + JSON.stringify(d)), { wx: d });
  return d;
}

// 获取已发布文章列表
async function getPublishedList(offset = 0, count = 20) {
  const token = await getAccessToken();
  const r = await fetch(`${WX_BASE}/cgi-bin/freepublish/batchget?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, count }),
  });
  const d = await r.json();
  if (d.errcode) throw Object.assign(new Error('获取已发布文章失败：' + JSON.stringify(d)), { wx: d });
  return d;
}

// 粉丝总数（优先 datacube 累计；订阅号等无权限时回退 user/get 首页 total）
async function getFansTotal() {
  const token = await getAccessToken();
  const y = new Date(Date.now() - 86400000);
  const ds = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  try {
    const r = await fetch(`${WX_BASE}/cgi-bin/datacube/getusercumulate?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ begin_date: ds, end_date: ds }),
    });
    const d = await r.json();
    if (d.list && d.list.length) return d.list[d.list.length - 1].cumulate_user;
  } catch { /* 忽略，走回退 */ }
  const r = await fetch(`${WX_BASE}/cgi-bin/user/get?access_token=${token}`);
  const d = await r.json();
  return d.total ?? null;
}

// 图文数据概览（最近 days 天）；需认证服务号·数据统计权限，无权限抛错由调用方捕获
async function getArticleSummary(days = 7) {
  const token = await getAccessToken();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = await fetch(`${WX_BASE}/cgi-bin/datacube/getarticlesummary?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ begin_date: fmt(new Date(Date.now() - days * 86400000)), end_date: fmt(new Date()) }),
  });
  const d = await r.json();
  if (d.errcode) throw Object.assign(new Error('获取图文数据失败（需认证服务号·数据统计权限）：' + JSON.stringify(d)), { wx: d });
  return d;
}

/* ===================== AI 生稿（OpenAI 兼容接口，凭证留服务端） ===================== */
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4-flash'; // 注意：deepseek-chat 老模型名已于 2026-07-24 停用
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 300000; // 长文生稿可能要 1~3 分钟
const AI_IMAGE_MODEL = process.env.AI_IMAGE_MODEL || 'cogview-3-flash'; // 免费生图档；升级画质改 cogview-4（约0.06元/次）

function aiConfigured() {
  return Boolean(AI_API_KEY);
}

async function aiGenerate(systemPrompt, userPrompt) {
  const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.7,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const d = await r.json().catch(() => ({}));
  let content = d.choices?.[0]?.message?.content;
  if (!content) {
    const _sum = (() => { try { return JSON.stringify(d).slice(0, 400); } catch { return '(响应体过大，无法序列化)'; } })();
    throw new Error('AI 接口返回异常：' + _sum);
  }
  // 长度兜底（不再因超长报过错）：正常公众号文案远不到 8000 字；极个别模型失控输出时截断到前 8000 字，
  // 保证「始终出稿」而非中断。配合下方 max_tokens 硬上限，正常生稿基本不会触达此分支。
  if (content.length > 8000) content = content.slice(0, 8000);
  return content;
}

// AI 生图（OpenAI 兼容 images/generations，智谱 CogView 系列；与文本共用 AI_API_KEY / AI_BASE_URL）
async function aiImage(prompt, size = '1440x720') {
  const r = await fetch(`${AI_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model: AI_IMAGE_MODEL, prompt, size }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const d = await r.json().catch(() => ({}));
  const item = d.data?.[0];
  if (!item) throw new Error('AI 生图返回异常：' + JSON.stringify(d).slice(0, 400));
  return { url: item.url || item.file_url || '', b64: item.b64_json || '' };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50 * 1024 * 1024) throw new Error('请求体过大（超过 50MB），请缩短素材后重试');
  }
  return JSON.parse(raw || '{}');
}

async function handleApi(req, res) {
  const p = (req.url || '').split('?')[0];
  corsHeaders(res, req);

  // 可选 API Key 防护：除状态/出口 IP/AI 状态探测外，写操作接口必须携带正确 key。
  // 注意：此 key 是「后端接口防护 key」（来自 .env 的 API_KEY），与智谱 AI_API_KEY 完全无关。
  // 前端 key 来自 Cloudflare 构建变量 WECHAT_API_KEY 或网址 ?apikey=；若后端设了而前端没带/带错会被统一拦截——下方给出明确区分的报错，避免与智谱 key 混淆。
  if (API_KEY && p !== '/api/wechat/status' && p !== '/api/wechat/ip' && p !== '/api/ai/status') {
    const url = new URL(req.url, 'http://localhost');
    const provided = req.headers['x-api-key'] || url.searchParams.get('key');
    if (!provided) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'missing_api_key', note: '后端已开启 API Key 接口防护（.env 的 API_KEY 已设置），但本次请求未携带 x-api-key。前端需在 Cloudflare Pages 设置构建变量 WECHAT_API_KEY（值与 API_KEY 一致）后重新部署，或用 ?apikey=<你的KEY> 打开本页。' }));
      return;
    }
    if (provided !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_api_key', note: '前端携带的 API Key 与后端 API_KEY 不一致（需完全相同）。请核对 Cloudflare 的 WECHAT_API_KEY 或网址 ?apikey= 的值。' }));
      return;
    }
  }

  // 绑定状态检测
  if (p === '/api/wechat/status' && req.method === 'GET') {
    return json(res, 200, {
      configured: wechatConfigured(),
      apiKeyRequired: Boolean(API_KEY),
      appid: wechatConfigured() ? WX_APPID.slice(0, 4) + '****' + WX_APPID.slice(-4) : '',
      author: WX_AUTHOR,
      serverVersion: SERVER_VERSION,
      note: wechatConfigured()
        ? '已检测到公众号凭证，发布将写入真实草稿箱。'
        : '未配置 WECHAT_APPID / WECHAT_APPSECRET（请在 .env 或系统环境变量中设置），当前前端将无法真实写入草稿箱。',
    });
  }

  // 出口 IP（用于公众号 IP 白名单）
  if (p === '/api/wechat/ip' && req.method === 'GET') {
    // 依次尝试多个探测服务（国内机器常连不上 ipify），谁通用谁；都不通才 unknown
    const IP_PROBES = [
      'https://api.ipify.org?format=json',
      'https://ip.sb/ip',
      'https://ifconfig.me/all.json',
      'https://myip.ipip.net',
    ];
    for (const url of IP_PROBES) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const text = await r.text();
        let ip = '';
        if (url.includes('ipify')) {
          try { ip = JSON.parse(text).ip; } catch {}
        } else if (url.includes('ip.sb')) {
          ip = text.trim();
        } else if (url.includes('ifconfig.me')) {
          try { ip = (JSON.parse(text).ip_addr || '').trim(); } catch {}
        } else if (url.includes('ipip.net')) {
          const m = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          ip = m ? m[1] : '';
        }
        if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
          return json(res, 200, { ip });
        }
      } catch {}
    }
    return json(res, 200, { ip: 'unknown', note: '无法探测出口 IP（请改用浏览器打开 ip.cn 获取）' });
  }

  // AI 生稿状态（前端据此决定是否展示 AI 生稿入口）
  if (p === '/api/ai/status' && req.method === 'GET') {
    return json(res, 200, {
      configured: aiConfigured(),
      apiKeyRequired: Boolean(API_KEY),
      model: aiConfigured() ? AI_MODEL : '',
      imageModel: aiConfigured() ? AI_IMAGE_MODEL : '',
      imageConfigured: aiConfigured(),
      note: aiConfigured()
        ? 'AI 生稿已就绪（' + AI_MODEL + '）；AI 生图已就绪（' + AI_IMAGE_MODEL + '）。'
        : '服务端未配置 AI_API_KEY / AI_BASE_URL / AI_MODEL（.env），AI 生稿与生图均不可用。',
    });
  }

  // AI 生稿：按前端传来的生稿要求（prompt）把素材稿（manuscript）生成为公众号文案
  if (p === '/api/ai/generate' && req.method === 'POST') {
    if (!aiConfigured()) {
      return json(res, 400, { error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY（请在 .env 填写后重启后端）。' });
    }
    try {
      const b = await readJson(req);
      const manuscript = (b.manuscript || '').trim().slice(0, 15000);
      const prompt = (b.prompt || '').trim();
      if (!manuscript) return json(res, 400, { error: 'bad_request', note: '缺少 manuscript（素材文稿）' });
      if (!prompt) return json(res, 400, { error: 'bad_request', note: '缺少 prompt（生稿要求）' });
      const content = await aiGenerate(prompt, '【原始素材】\n' + manuscript);
      return json(res, 200, { content });
    } catch (e) {
      console.error('[ai/generate] 生稿失败：', e && e.message);
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

  // AI 生成标题：基于成稿/素材生成若干候选公众号标题
  if (p === '/api/ai/title' && req.method === 'POST') {
    if (!aiConfigured()) {
      return json(res, 400, { error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY（请在 .env 填写后重启后端）。' });
    }
    try {
      const b = await readJson(req);
      const draft = (b.draft || '').trim();
      const requirement = (b.requirement || '').trim();
      if (!draft) return json(res, 400, { error: 'bad_request', note: '缺少 draft（文章正文/素材）' });
      const systemPrompt = '你是资深公众号编辑，擅长写高点击率的标题。请基于文章给出候选标题：风格贴合公众号调性，简洁有吸引力，避免标题党与绝对化承诺。';
      const userPrompt = `【文章正文/素材】\n${draft}\n\n【标题要求】\n${requirement || '吸引点击、符合公众号调性、10~24 字、给出 5 个候选'}\n\n请直接输出 5 个候选标题，每行一个，不要编号以外的解释文字。`;
      const content = await aiGenerate(systemPrompt, userPrompt);
      const titles = content.split('\n').map(s => s.replace(/^\s*\d+[.、)]\s*|\*\*/g, '').trim()).filter(Boolean).slice(0, 8);
      if (!titles.length) throw new Error('AI 未返回有效标题：' + content.slice(0, 200));
      return json(res, 200, { titles });
    } catch (e) {
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

  // AI 生成封面图（智谱 CogView，OpenAI 兼容 images/generations）
  if (p === '/api/ai/image' && req.method === 'POST') {
    if (!aiConfigured()) {
      return json(res, 400, { error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY（请在 .env 填写后重启后端）。' });
    }
    try {
      const b = await readJson(req);
      const prompt = (b.prompt || '').trim();
      const size = (b.size || '1440x720').trim();
      if (!prompt) return json(res, 400, { error: 'bad_request', note: '缺少 prompt（封面图描述）' });
      const r = await aiImage(prompt, size);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

  if (!wechatConfigured()) {
    return json(res, 400, { error: 'not_configured', note: '服务端未配置公众号凭证（WECHAT_APPID / WECHAT_APPSECRET）。' });
  }

  // 上传封面图（永久素材）
  if (p === '/api/wechat/upload' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      if (!b.data) return json(res, 400, { error: 'bad_request', note: '缺少 data(base64)' });
      const r = await uploadPermanentImage(b.filename || 'cover.png', b.data);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { error: 'wechat_error', note: e.message, wx: e.wx || null });
    }
  }

  // 上传封面图（远程 URL 版）：后端抓取图片字节后上传为永久素材，返回 media_id
  if (p === '/api/wechat/upload-url' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      let base64 = b.data;
      if (!base64 && b.url) {
        const imgRes = await fetch(b.url, { signal: AbortSignal.timeout(30000) });
        if (!imgRes.ok) throw new Error('抓取封面图失败：HTTP ' + imgRes.status);
        base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
      }
      if (!base64) return json(res, 400, { error: 'bad_request', note: '缺少 data(base64) 或 url' });
      const r = await uploadPermanentImage(b.filename || 'cover.png', base64);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { error: 'wechat_error', note: e.message, wx: e.wx || null });
    }
  }

  // 创建草稿
  if (p === '/api/wechat/draft' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const a = b.articles?.[0] || b;
      if (!a.title || !a.content) return json(res, 400, { error: 'bad_request', note: 'title / content 必填' });
      if (!a.thumb_media_id) return json(res, 400, { error: 'need_cover', note: '真实发布需上传封面图获取 thumb_media_id' });
      const result = await addDraft({
        title: a.title,
        author: a.author || '',
        digest: (a.digest || '').slice(0, 120),
        content: a.content,
        content_source_url: a.content_source_url || '',
        thumb_media_id: a.thumb_media_id,
        need_open_comment: a.need_open_comment ?? 1,
        only_fans_can_comment: a.only_fans_can_comment ?? 0,
      });
      return json(res, 200, result);
    } catch (e) {
      return json(res, 502, { error: 'wechat_error', note: e.message, wx: e.wx || null });
    }
  }

  // 数据总览（粉丝 / 草稿 / 已发布 / 图文数据）—— 供媒体矩阵与数据看板
  if (p === '/api/wechat/overview' && req.method === 'GET') {
    try {
      const [fans, drafts, published] = await Promise.allSettled([getFansTotal(), getDraftList(0, 10), getPublishedList(0, 10)]);
      let articleStats = null, articleNote = '';
      try { articleStats = (await getArticleSummary(7)).list; } catch (e) { articleNote = e.message; }
      return json(res, 200, {
        fans: fans.status === 'fulfilled' ? fans.value : null,
        fansNote: fans.status === 'rejected' ? String((fans.reason && fans.reason.message) || fans.reason) : '',
        draftTotal: drafts.status === 'fulfilled' ? (drafts.value.total_count ?? null) : null,
        drafts: drafts.status === 'fulfilled' ? drafts.value : { error: String(drafts.reason) },
        publishedTotal: published.status === 'fulfilled' ? (published.value.total_count ?? null) : null,
        published: published.status === 'fulfilled' ? published.value : { error: String(published.reason) },
        articleStats, articleNote,
      });
    } catch (e) {
      return json(res, 502, { error: 'wechat_error', note: e.message });
    }
  }

  return json(res, 404, { error: 'not_found' });
}

function json(res, code, obj) {
  let body;
  try { body = JSON.stringify(obj); }
  catch (e) { body = JSON.stringify({ error: 'serialize_error', note: '响应体过大或无法序列化：' + (e && e.message) }); code = 502; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* ===================== 静态文件服务 ===================== */
async function serveStatic(req, res) {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    const safePath = normalize(join(ROOT, urlPath)).replace(/^(\.\.[/\\])+/, '');
    if (!safePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let target = join(ROOT, urlPath);
    try {
      const st = await stat(target);
      if (st.isDirectory()) target = join(target, 'index.html');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const p = (req.url || '').split('?')[0];
    if (p.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { // 跨域预检
        corsHeaders(res, req);
        res.writeHead(204).end();
        return;
      }
      return await handleApi(req, res);
    }
    return await serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EtsyOps server running at http://${HOST}:${PORT} (wechat proxy: ${wechatConfigured() ? 'ON' : 'OFF'}, ai: ${aiConfigured() ? AI_MODEL : 'OFF'}, image: ${aiConfigured() ? AI_IMAGE_MODEL : 'OFF'})`);
});
