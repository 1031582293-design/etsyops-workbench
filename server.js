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

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

async function handleApi(req, res) {
  const p = (req.url || '').split('?')[0];

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
    if (p.startsWith('/api/')) return await handleApi(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EtsyOps server running at http://${HOST}:${PORT} (wechat proxy: ${wechatConfigured() ? 'ON' : 'OFF'})`);
});
