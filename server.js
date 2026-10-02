// 零依赖服务器：既是静态文件托管（供 CloudStudio / 任意云端环境），
// 也是公众号真实 API 的安全代理（把 AppSecret 留在服务端，前端只调本机 /api）。
// 仅用 Node 内置模块（node:http / node:https / node:fs / node:path / node:url），
// 无需 npm install，npm start 即可监听 process.env.PORT || 3000。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

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
  } catch { /* 没有 .env 则忽略，回退到系统环境变量 / 模拟模式 */ }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 允许跨域的前端源（Cloudflare Pages 前端需访问本后端）。逗号分隔可配多个，* 表示任意。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://etsyops-workbench.pages.dev,http://localhost:3000').split(',').map(s => s.trim());
// 可选 API Key：设置了之后，发布/上传等写操作接口必须携带正确 key，挡住公开隧道的滥用。
const API_KEY = process.env.API_KEY || '';
function corsHeaders(res, req) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

/* ===================== 飞书文档拉取代理 ===================== */
// 把飞书应用凭证留在服务端，前端只调本机 /api/feishu/fetch，避免 AppSecret 暴露在前端。
// 支持 docx / wiki / 旧版 doc 三种文档链接。
const FS_APP_ID = process.env.FEISHU_APP_ID || '';
const FS_SECRET = process.env.FEISHU_APP_SECRET || '';
const FS_BASE = (process.env.FEISHU_BASE || 'https://open.feishu.cn').replace(/\/$/, '');
let fsTokenCache = { token: '', expiresAt: 0 };

function feishuConfigured() {
  return Boolean(FS_APP_ID && FS_SECRET);
}

// 获取 tenant_access_token（企业内部应用，app_id + app_secret），带缓存
async function getFsToken() {
  if (fsTokenCache.token && Date.now() < fsTokenCache.expiresAt - 60000) return fsTokenCache.token;
  const r = await fetch(`${FS_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FS_APP_ID, app_secret: FS_SECRET }),
  });
  const d = await r.json();
  if (!d.tenant_access_token) throw Object.assign(new Error('获取飞书 tenant_access_token 失败：' + JSON.stringify(d)), { fs: d });
  fsTokenCache = { token: d.tenant_access_token, expiresAt: Date.now() + (d.expire || 7200) * 1000 };
  return fsTokenCache.token;
}

// 从飞书链接解析文档类型与标识
function parseFeishuUrl(url) {
  let m = url.match(/\/docx\/([a-zA-Z0-9]+)/);
  if (m) return { type: 'docx', id: m[1] };
  m = url.match(/\/wiki\/([a-zA-Z0-9]+)/);
  if (m) return { type: 'wiki', id: m[1] };
  m = url.match(/\/doc\/([a-zA-Z0-9]+)/);
  if (m) return { type: 'doc', id: m[1] };
  throw new Error('无法识别的飞书链接（仅支持 docx / wiki / doc 文档）');
}

// 取 docx 纯文本正文
async function fsDocxRaw(token, docId) {
  const r = await fetch(`${FS_BASE}/open-apis/docx/v1/documents/${docId}/raw_content`, {
    method: 'GET', headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  if (d.code !== 0) throw Object.assign(new Error('获取飞书 docx 正文失败：' + JSON.stringify(d)), { fs: d });
  return d.data?.content || '';
}

// 取 docx 标题
async function fsDocxTitle(token, docId) {
  try {
    const r = await fetch(`${FS_BASE}/open-apis/docx/v1/documents/${docId}`, {
      method: 'GET', headers: { Authorization: 'Bearer ' + token },
    });
    const d = await r.json();
    return d.data?.document?.title || '';
  } catch { return ''; }
}

// 解析 wiki 节点 → 返回底层 docx/doc 标识
async function fsResolveWiki(token, wikiToken) {
  const r = await fetch(`${FS_BASE}/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}&node_type=wiki`, {
    method: 'GET', headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  if (d.code !== 0) throw Object.assign(new Error('解析飞书 wiki 失败：' + JSON.stringify(d)), { fs: d });
  const obj = d.data?.node?.obj;          // 'docx' | 'doc' | 'sheet' | 'mindnote' ...
  const nodeToken = d.data?.node?.node_token;
  if (obj === 'docx') return { type: 'docx', id: nodeToken };
  if (obj === 'doc') return { type: 'doc', id: nodeToken };
  throw new Error('wiki 节点类型暂不支持（仅支持 docx / doc）：' + obj);
}

// 取旧版 doc 纯文本正文
async function fsDocRaw(token, docId) {
  const r = await fetch(`${FS_BASE}/open-apis/doc/v2/raw_content?doc_id=${docId}`, {
    method: 'GET', headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  if (d.code !== 0) throw Object.assign(new Error('获取飞书 doc 正文失败：' + JSON.stringify(d)), { fs: d });
  return d.data?.content || '';
}

// 统一入口：根据链接真实拉取飞书文档正文
async function fetchFeishuDoc(url) {
  const token = await getFsToken();
  const parsed = parseFeishuUrl(url);
  if (parsed.type === 'wiki') {
    const resolved = await fsResolveWiki(token, parsed.id);
    if (resolved.type === 'docx') {
      const [content, title] = await Promise.all([fsDocxRaw(token, resolved.id), fsDocxTitle(token, resolved.id)]);
      return { title, content };
    }
    return { title: '', content: await fsDocRaw(token, resolved.id) };
  }
  if (parsed.type === 'doc') {
    return { title: '', content: await fsDocRaw(token, parsed.id) };
  }
  const [content, title] = await Promise.all([fsDocxRaw(token, parsed.id), fsDocxTitle(token, parsed.id)]);
  return { title, content };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

async function handleApi(req, res) {
  const p = (req.url || '').split('?')[0];
  corsHeaders(res, req);

  // 可选 API Key 防护：除状态/出口 IP 探测外，写操作接口必须携带正确 key
  if (API_KEY && p !== '/api/wechat/status' && p !== '/api/wechat/ip' && p !== '/api/feishu/status') {
    const url = new URL(req.url, 'http://localhost');
    const provided = req.headers['x-api-key'] || url.searchParams.get('key');
    if (provided !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_api_key', note: '缺少或错误的 API Key' }));
      return;
    }
  }

  // 绑定状态检测
  if (p === '/api/wechat/status' && req.method === 'GET') {
    return json(res, 200, {
      configured: wechatConfigured(),
      appid: wechatConfigured() ? WX_APPID.slice(0, 4) + '****' + WX_APPID.slice(-4) : '',
      note: wechatConfigured()
        ? '已检测到公众号凭证，发布将写入真实草稿箱。'
        : '未配置 WECHAT_APPID / WECHAT_APPSECRET（请在 .env 或系统环境变量中设置），当前前端为模拟发布。',
    });
  }

  // 出口 IP（用于公众号 IP 白名单）
  if (p === '/api/wechat/ip' && req.method === 'GET') {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      return json(res, 200, { ip: d.ip });
    } catch {
      return json(res, 200, { ip: 'unknown', note: '无法探测出口 IP' });
    }
  }

  /* ---- 飞书文档真实拉取 ---- */
  if (p === '/api/feishu/status' && req.method === 'GET') {
    return json(res, 200, {
      configured: feishuConfigured(),
      note: feishuConfigured()
        ? '已检测到飞书凭证，可真实拉取文档。'
        : '未配置 FEISHU_APP_ID / FEISHU_APPSECRET（请在 .env 或系统环境变量中设置），飞书拉取不可用。',
    });
  }

  if (p === '/api/feishu/fetch' && req.method === 'POST') {
    if (!feishuConfigured()) {
      return json(res, 400, { error: 'not_configured', note: '服务端未配置飞书凭证（FEISHU_APP_ID / FEISHU_APPSECRET）。' });
    }
    try {
      const b = await readJson(req);
      if (!b.url) return json(res, 400, { error: 'bad_request', note: '缺少 url' });
      const { title, content } = await fetchFeishuDoc(b.url);
      if (!content) return json(res, 502, { error: 'empty_content', note: '飞书文档正文为空（可能是无权限或文档类型不支持）。' });
      return json(res, 200, { ok: true, title, content });
    } catch (e) {
      return json(res, 502, { error: 'feishu_error', note: e.message, fs: e.fs || null });
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
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
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
  console.log(`EtsyOps server running at http://${HOST}:${PORT} (wechat proxy: ${wechatConfigured() ? 'ON' : 'OFF'})`);
});
