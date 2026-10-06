// 零依赖服务器：既是静态文件托管（供 CloudStudio / 任意云端环境），
// 也是公众号真实 API 的安全代理（把 AppSecret 留在服务端，前端只调本机 /api）。
// 仅用 Node 内置模块（node:http / node:https / node:fs / node:path / node:url），
// 无需 npm install，npm start 即可监听 process.env.PORT || 3000。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as etsy from './etsy-api.js';

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

/* ---------- 运行记录存储层 ----------
   目标：工作流画布的「运行历史」要落库。
   当前用 JSON 文件（零依赖、够用、可直接 human-readable 排查）；
   接口设计成 CRUD 形状，将来要换 SQLite 只需替换本层实现，上层调用不用改。
   数据落在 server.js 同级的 data/ 目录下。*/
const DATA_DIR = join(ROOT, 'data');
const RUNS_FILE = join(DATA_DIR, 'runs.json');
const RUNS_MAX = 500;                 // 最多保留 500 条，超出丢最旧的

function readRuns() {
  try {
    const txt = readFileSync(RUNS_FILE, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeRuns(arr) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const keep = arr.slice(-RUNS_MAX);
    // 原子写：先写临时文件再 rename，避免进程被杀时留下半截 JSON
    const tmp = RUNS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(keep, null, 2), 'utf8');
    renameSync(tmp, RUNS_FILE);
  } catch (e) {
    console.error('[runs] 写入失败：', e && e.message);
  }
}
// 追加一条记录。
// ⚠️ 必须**同步落盘**再返回：画布点「运行」后会立刻 PATCH 上报第一步进度，
// 若这里只写内存并防抖延迟，PATCH 会查不到刚建的记录 → 404。
function appendRun(rec) {
  const arr = readRuns();
  arr.push(rec);
  writeRuns(arr);
  return rec;
}
function updateRun(id, patch) {
  const arr = readRuns();
  const i = arr.findIndex(r => r.id === id);
  if (i < 0) return null;
  arr[i] = Object.assign({}, arr[i], patch, { updatedAt: Date.now() });
  writeRuns(arr);
  return arr[i];
}

/* ===================== Etsy Open API v3（凭证留服务端） =====================
   所有 Etsy 网络出口都在 etsy-api.js 里，本文件只负责：
     1) 组装客户端（配置 + token 落盘 + 日志）
     2) 把 /api/etsy/* 路由接出去
   关键安全约定：
     - shared secret / refresh token 永不出现在任何响应里；
     - OAuth 回调（/api/etsy/callback）必须在 API_KEY 白名单里，
       否则店主的浏览器从 Etsy 跳回来时没有 key，会被我们自己拦住 → 授权永远失败；
     - 写操作额外受 ETSY_ALLOW_WRITE=1 开关限制（.env 控制），默认只读。*/

const ETSY_CFG = etsy.etsyConfig(process.env);
const ETSY_TOKEN_FILE = join(DATA_DIR, 'etsy-token.json');
const ETSY_OAUTH_STATE_FILE = join(DATA_DIR, 'etsy-oauth-state.json');
const etsyStore = etsy.createTokenStore(ETSY_TOKEN_FILE, { readFileSync, writeFileSync, mkdirSync, renameSync });
const etsyLog = (...a) => console.log('[etsy]', ...a);

// ★ 自动发现到的 shop_id 也落盘（data/ 已gitignore）。
//   为什么不在 .env 里：Etsy 界面上任何地方都不显示数字 shop_id，让操作者手工找不现实。
//   授权成功后从 token 前缀取 user_id → 查 /users/{user_id}/shops 反查出来，存这里。
//   优先级：.env 的 ETSY_SHOP_ID（多店时手动指定） > 自动发现并落盘的值。
const ETSY_SHOP_FILE = join(DATA_DIR, 'etsy-shop.json');
function readDiscoveredShop() {
  try {
    const d = JSON.parse(readFileSync(ETSY_SHOP_FILE, 'utf8'));
    return { shopId: String(d.shopId || ''), shopName: d.shopName || '', userId: String(d.userId || ''), at: Number(d.at || 0) };
  } catch { return { shopId: '', shopName: '', userId: '', at: 0 }; }
}
function writeDiscoveredShop(rec) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ETSY_SHOP_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    renameSync(tmp, ETSY_SHOP_FILE);
    return true;
  } catch (e) { etsyLog('shop_id 落盘失败：' + (e && e.message)); return false; }
}

const etsyClient = etsy.createClient({
  config: ETSY_CFG,
  store: etsyStore,
  log: etsyLog,
  // shop_id 动态取：客户端不再缓存配置里的值，而是每次问这个函数。
  // 这样授权后即使 .env 里没填 ETSY_SHOP_ID，后续调用也能自动用上。
  shopIdProvider: () => ETSY_CFG.shopId || readDiscoveredShop().shopId,
});

function etsyConfigured() {
  // shop_id 不再是「配置好的前提」：没填也能授权成功，之后由 discoverShopId 补上。
  // 只有 keystring + redirectUri 才是硬前提。
  return Boolean(ETSY_CFG.apiKeyHeader && ETSY_CFG.redirectUri);
}

function etsyCurrentShopId() {
  return ETSY_CFG.shopId || readDiscoveredShop().shopId || '';
}

// 前置数据缓存实例（模块级，跨请求复用；6 小时自动过期）
const _etsyPreflight = etsy.createPreflight(etsyClient);
function etsyPreflightFor(force) {
  if (force) _etsyPreflight.invalidate();
  return _etsyPreflight;
}

// 授权流程的临时状态（PKCE verifier + state）。生命周期只有一次授权，存内存即可（重启则需重新授权）。
let _etsyPendingAuth = null; // { state, verifier, at }

function etsyAuthState() {
  const t = etsyStore.read();
  const shop = readDiscoveredShop();
  const sid = etsyCurrentShopId();
  return {
    configured: etsyConfigured(),
    hasCredentials: Boolean(ETSY_CFG.apiKeyHeader),
    hasShopId: Boolean(sid),
    // shop_id 是自动发现的，页面上要能区分「需要先授权」和「已就绪」
    shopIdSource: ETSY_CFG.shopId ? 'env' : (shop.shopId ? 'auto' : ''),
    hasRedirectUri: Boolean(ETSY_CFG.redirectUri),
    redirectUri: ETSY_CFG.redirectUri,
    scope: ETSY_CFG.scope,
    allowWrite: ETSY_CFG.allowWrite,
    authorized: Boolean(t.accessToken || t.refreshToken),
    shopId: sid,
    shopName: shop.shopName || '',
    // 已授权但还没拿到 shop_id（多店场景需要人确认），前端据此提示选店
    needShopChoice: Boolean(t.refreshToken) && !sid,
    accessTokenExpiresAt: t.accessTokenExpiresAt || 0,
    refreshTokenExpiresAt: t.refreshTokenExpiresAt || 0,
    // 距refresh token 过期不足 30 天就提示店主重新授权，避免某天早上突然全链路401
    refreshTokenExpiringSoon:
      Boolean(t.refreshTokenExpiresAt) && t.refreshTokenExpiresAt - Date.now() < 30 * 24 * 3600 * 1000,
  };
}

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

/* ★ 生稿任务缓存（模块顶层，供handleApi 与文件末尾的清理定时器共同访问）
   把「长时间单连接」改成「短连接提交 + 短连接轮询」：
   AI 生稿需 25~55 秒，若浏览器一直挂在同一连接上读响应体，经过 Cloudflare Tunnel 时
   该连接会在正文传完前被掐断 → 页面永远转圈/未响应（已实测：后端日志显示"出稿成功"、
   curl 能完整收到，只有浏览器收不到）。现在 POST /api/ai/generate 立刻返回 jobId，
   前端每 3 秒 GET /api/ai/job?id=xxx 查结果，每次都是短连接。
   ⚠️ 必须声明在模块顶层：曾误放在 handleApi 函数内部，导致末尾清理定时器报
   ReferenceError: _genJobs is not defined。 */
const _genJobs = new Map(); // id -> { status:'running'|'done'|'error', content, note, at }
let _genJobSeq = 0;

async function handleApi(req, res) {
  const p = (req.url || '').split('?')[0];
  corsHeaders(res, req);

  // 可选 API Key 防护：除状态/出口 IP/AI 状态探测外，写操作接口必须携带正确 key。
  // 注意：此 key 是「后端接口防护 key」（来自 .env 的 API_KEY），与智谱 AI_API_KEY 完全无关。
  // 前端 key 来自 Cloudflare 构建变量 WECHAT_API_KEY 或网址 ?apikey=；若后端设了而前端没带/带错会被统一拦截——下方给出明确区分的报错，避免与智谱 key 混淆。
  // 注意：/api/logs 不在下方白名单里 → 它属于「写操作级」保护，未设API_KEY 时也可读，
  // 一旦 .env 设了 API_KEY 则必须带 key，杜绝公网任何人读取后端日志。
  // Etsy 的两个特殊放行：
  //  - /api/etsy/callback：店主浏览器从 Etsy 跳回来时，地址栏里不可能带我们的 x-api-key，
  //    若不放行 → 授权 100% 失败。它靠 state 校验防 CSRF，安全性由 state 承担。
  //  - /api/etsy/status：前端首屏要靠它判断显示「未配置 / 未授权 / 已就绪」哪一屏，
  //    它只返回布尔状态，不泄露任何密钥。
  const ETSY_OPEN_PATHS = ['/api/etsy/callback', '/api/etsy/status'];
  if (API_KEY && p !== '/api/wechat/status' && p !== '/api/wechat/ip' && p !== '/api/ai/status'
      && !ETSY_OPEN_PATHS.includes(p)) {
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

  // 保活心跳：生稿/生图可能耗时 30~180秒，期间隧道/浏览器连接若空闲可能被中间层掐断。
  // 前端在等待长任务时会周期性打这个极轻量的接口，维持连接不中断。
  if (p === '/api/ping' && req.method === 'GET') {
    return json(res, 200, { ok: true, t: Date.now(), v: SERVER_VERSION });
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

  // 后端运行日志（诊断用）：start-backend.bat 把 stdout/stderr 重定向到 backend.log，
  // 这里读取末尾若干行，让排查者无需截图即可判断「是隧道断、还是后端进程崩了」。
  // 安全：日志可能含 AppSecret / AI key / 手机号等，统一做脱敏后再返回。
  if (p === '/api/logs' && req.method === 'GET') {
    const url2 = new URL(req.url, 'http://localhost');
    const n = Math.min(500, Math.max(20, parseInt(url2.searchParams.get('n') || '120', 10) || 120));
    try {
      const raw = await readFile(join(ROOT, 'backend.log'), 'utf8');
      const lines = raw.split('\n');
      const tail = lines.slice(-n).join('\n').replace(/\r/g, '');
      // 脱敏：sk-xxx 形态的 key、appid、access_token、以及长串 secret
      const safe = tail
        .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***REDACTED***')
        .replace(/(secret|token|apikey|api_key|password)\s*[=:]\s*\S+/gi, '$1=***REDACTED***')
        .replace(/\bwx[0-9a-f]{16}\b/gi, 'wx****REDACTED')
        .replace(/[A-Za-z0-9_\-]{60,}/g, '***REDACTED***');
      return json(res, 200, {
        ok: true,
        totalLines: lines.length,
        showing: Math.min(n, lines.length),
        note: '日志内容已脱敏。若要看崩溃原因，搜 uncaughtException / unhandledRejection / Error。',
        log: safe,
      });
    } catch (e) {
      return json(res, 404, { ok: false, error: 'log_missing', note: '读不到 backend.log：' + e.message + '（若刚改完 bat 还没重启后端，则该文件还不存在）' });
    }
  }

  // 浏览器端错误上报：前端出问题时自动把报错 POST 到这里，由后端写进 backend.log。
  // 这样排查者直接看 /api/logs 就能拿到用户看到的真实报错，不必截图、不必猜。
  // 不在免 key 白名单里：设了 API_KEY 时需带 key，避免公网被人灌垃圾日志。
  if (p === '/api/client-log' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const where = String(b.where || '').slice(0, 120);
      const msg = String(b.msg || '').slice(0, 500);
      const detail = String(b.detail || '').slice(0, 800);
      console.error('[前端报错] ' + where + ' :: ' + msg + (detail ? ' || ' + detail : ''));
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error('[client-log] 接收失败：', e && e.message);
      return json(res, 200, { ok: true });
    }
  }

  /* ---------- 运行记录（工作流画布的运行历史）----------
     POST /api/runs        新建一条运行记录（画布点「运行」时调用）
     PATCH /api/runs?id=   更新某条记录（每完成一步就上报一次进度）
     GET  /api/runs        读取历史（倒序，最多 limit 条）
     DELETE /api/runs?id=  删除单条；不带 id 则清空
     这些接口只存元数据（步骤名/耗时/字数/状态），不存稿件正文，避免文件无限膨胀。*/
  if (p === '/api/runs' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const rec = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        employee: String(b.employee || '').slice(0, 60),
        runName: String(b.runName || '').slice(0, 120),
        configName: String(b.configName || '').slice(0, 60),
        files: Array.isArray(b.files) ? b.files.slice(0, 20).map(f => String(f).slice(0, 120)) : [],
        status: 'running',           // running | paused | done | failed
        steps: Array.isArray(b.steps) ? b.steps.slice(0, 20).map(st => ({
          key: String(st.key || '').slice(0, 30),
          title: String(st.title || '').slice(0, 60),
          ms: Number(st.ms) || 0,
          state: String(st.state || 'done').slice(0, 12),   // ok | fail | skip
          note: String(st.note || '').slice(0, 200),
        })) : [],
        words: 0,
        draftMediaId: String(b.draftMediaId || '').slice(0, 80),
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      appendRun(rec);
      console.log('[runs] 新建运行记录 ' + rec.id + ' · ' + (rec.employee || '-') + ' · ' + (rec.runName || '-'));
      return json(res, 200, rec);
    } catch (e) {
      console.error('[runs] 新建失败：', e && e.message);
      return json(res, 500, { error: 'runs_create_failed', note: e.message });
    }
  }

  if (p === '/api/runs' && req.method === 'PATCH') {
    try {
      const _u = new URL(req.url, 'http://localhost');
      const id = _u.searchParams.get('id') || '';
      const b = await readJson(req);
      const patch = {};
      if (b.status !== undefined) patch.status = String(b.status).slice(0, 12);
      if (b.steps !== undefined) patch.steps = Array.isArray(b.steps) ? b.steps.slice(0, 20).map(st => ({
        key: String(st.key || '').slice(0, 30),
        title: String(st.title || '').slice(0, 60),
        ms: Number(st.ms) || 0,
        state: String(st.state || 'done').slice(0, 12),
        note: String(st.note || '').slice(0, 200),
      })) : [];
      if (b.words !== undefined) patch.words = Number(b.words) || 0;
      if (b.draftMediaId !== undefined) patch.draftMediaId = String(b.draftMediaId).slice(0, 80);
      if (b.error !== undefined) patch.error = String(b.error).slice(0, 300);
      const out = updateRun(id, patch);
      if (!out) return json(res, 404, { error: 'run_not_found', note: '运行记录不存在（可能已被清理）' });
      return json(res, 200, out);
    } catch (e) {
      console.error('[runs] 更新失败：', e && e.message);
      return json(res, 500, { error: 'runs_update_failed', note: e.message });
    }
  }

  if (p === '/api/runs' && req.method === 'GET') {
    try {
      const _u = new URL(req.url, 'http://localhost');
      const limit = Math.min(parseInt(_u.searchParams.get('limit') || '30', 10) || 30, RUNS_MAX);
      const emp = _u.searchParams.get('employee') || '';
      let arr = readRuns().slice().reverse();
      if (emp) arr = arr.filter(r => r.employee === emp);
      return json(res, 200, { total: arr.length, runs: arr.slice(0, limit) });
    } catch (e) {
      return json(res, 500, { error: 'runs_read_failed', note: e.message });
    }
  }

  if (p === '/api/runs' && req.method === 'DELETE') {
    try {
      const _u = new URL(req.url, 'http://localhost');
      const id = _u.searchParams.get('id');
      if (id) {
        const arr = readRuns();
        const kept = arr.filter(r => r.id !== id);
        writeRuns(kept);
        return json(res, 200, { ok: true, deleted: arr.length - kept.length });
      }
      writeRuns([]);
      return json(res, 200, { ok: true, deleted: 'all' });
    } catch (e) {
      return json(res, 500, { error: 'runs_delete_failed', note: e.message });
    }
  }

  // AI 生稿：按前端传来的生稿要求（prompt）把素材稿（manuscript）生成为公众号文案
  if (p === '/api/ai/generate' && req.method === 'POST') {
    if (!aiConfigured()) {
      console.error('[ai/generate] 拒绝：服务端未配置 AI');
      return json(res, 400, { error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY（请在 .env 填写后重启后端）。' });
    }
    try {
      const b = await readJson(req);
      const manuscript = (b.manuscript || '').trim().slice(0, 15000);
      const prompt = (b.prompt || '').trim();
      if (!manuscript) return json(res, 400, { error: 'bad_request', note: '缺少 manuscript（素材文稿）' });
      if (!prompt) return json(res, 400, { error: 'bad_request', note: '缺少 prompt（生稿要求）' });

      // async 模式：只提交任务，立刻返回 jobId（前端改走轮询）
      if (b.async) {
        const id = 'g' + Date.now().toString(36) + (_genJobSeq++);
        _genJobs.set(id, { status: 'running', at: Date.now() });
        console.log('[ai/generate] 已受理任务 ' + id + '（异步轮询模式）');
        (async () => {
          const t0 = Date.now();
          try {
            const content = await aiGenerate(prompt, '【原始素材】\n' + manuscript);
            _genJobs.set(id, { status: 'done', content, at: Date.now() });
            console.log('[ai/generate] 任务 ' + id + ' 出稿成功 ' + content.length + ' 字，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
          } catch (e) {
            _genJobs.set(id, { status: 'error', note: (e && e.message) || '未知错误', at: Date.now() });
            console.error('[ai/generate] 任务 ' + id + ' 失败：', e && e.message);
          }
        })();
        return json(res, 200, { jobId: id, poll: '/api/ai/job?id=' + id });
      }

      const _t0 = Date.now();
      console.log('[ai/generate] 收到同步请求 origin=' + (req.headers.origin || '(无)') + ' ua=' + String(req.headers['user-agent'] || '').slice(0, 60));
      const content = await aiGenerate(prompt, '【原始素材】\n' + manuscript);
      console.log('[ai/generate] 出稿成功 ' + content.length + ' 字，耗时 ' + ((Date.now() - _t0) / 1000).toFixed(1) + 's');
      return json(res, 200, { content });
    } catch (e) {
      console.error('[ai/generate] 生稿失败：', e && e.message);
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

  // 轮询生稿任务结果（每次都是短连接）
  if (p === '/api/ai/job' && req.method === 'GET') {
    const _u = new URL(req.url, 'http://localhost');
    const id = _u.searchParams.get('id') || '';
    const from = parseInt(_u.searchParams.get('from') || '0', 10) || 0;
    const job = _genJobs.get(id);
    if (!job) return json(res, 404, { error: 'job_not_found', note: '任务不存在或已过期（请重新生稿）' });
    if (job.status === 'error') {
      job.takenAt = Date.now();
      return json(res, 200, { status: 'error', error: 'ai_error', note: job.note });
    }
    if (job.status === 'done') {
      // ⚠️ 关键：done 时**不再一次性返回全文**。
      // 实测：7448 字的稿件（约 20KB JSON）经隧道到浏览器会被截断（只剩约 1/3），
      // 表现为「一直转圈 / 页面未响应」；而 curl 能完整收到 → 是浏览器侧的大响应问题。
      // 改为分片：done 只报总长度与分片大小，前端再用 from=<offset> 逐片取，每片都是小响应。
      job.takenAt = Date.now();
      const CHUNK = 1200; // 每片 1200 字，JSON 约 4KB，足够小
      const total = job.content.length;
      // from >= total 说明已取完（重复请求最后一片时from 已是 total）
      if (from >= total) {
        return json(res, 200, { status: 'done', from, end: total, total, content: '', note: '已取完' });
      }
      const chunk = job.content.slice(from, from + CHUNK);
      const end = from + chunk.length;
      const finished = end >= total;
      return json(res, 200, {
        status: finished ? 'done' : 'chunk',
        from, end, total,
        content: chunk,
        note: finished ? '' : ('内容分片传输中，已取' + end + '/' + total + ' 字'),
      });
    }
    return json(res, 200, { status: 'running', waited: Math.round((Date.now() - job.at) / 1000) });
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
      const titles = content.split('\n')
        .map(s => s.replace(/^\s*\d+[.、)]\s*|\*\*/g, '').replace(/[「」【】"']/g, '').trim())
        .filter(Boolean).slice(0, 8);
      if (!titles.length) throw new Error('AI 未返回有效标题：' + content.slice(0, 200));
      // 第 1 个视为「最推荐」：画布一键执行时直接采用它；
      // 工具页则把它放主框（可重选），其余作为候选项。
      // 同时把字数带上，便于前端做长度体检。
      const items = titles.map((t, i) => ({ t, i, len: t.length, top: i === 0 }));
      return json(res, 200, { titles, items, top: titles[0] });
    } catch (e) {
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

  // AI 生成封面图（智谱 CogView，OpenAI 兼容 images/generations）
  if (p === '/api/ai/image' && req.method === 'POST') {
    if (!aiConfigured()) {
      console.error('[ai/image] 拒绝：服务端未配置 AI');
      return json(res, 400, { error: 'ai_not_configured', note: '服务端未配置 AI_API_KEY（请在 .env 填写后重启后端）。' });
    }
    const _t0 = Date.now();
    try {
      const b = await readJson(req);
      const prompt = (b.prompt || '').trim();
      const size = (b.size || '1440x720').trim();
      if (!prompt) return json(res, 400, { error: 'bad_request', note: '缺少 prompt（封面图描述）' });
      const r = await aiImage(prompt, size);
      console.log('[ai/image] 生图成功 url=' + (r.url ? '有' : '无') + ' b64=' + (r.b64 ? r.b64.length + '字符' : '无') +
        ' 耗时 ' + ((Date.now() - _t0) / 1000).toFixed(1) + 's');
      return json(res, 200, r);
    } catch (e) {
      console.error('[ai/image] 生图失败：', e && e.message);
      return json(res, 502, { error: 'ai_error', note: e.message });
    }
  }

/* ===================== Etsy Open API v3 =====================
     GET/POST  /api/etsy/status     配置与授权状态自检（不花API 额度）
     GET       /api/etsy/auth       生成 PKCE 并302 跳 Etsy 授权页
     GET       /api/etsy/callback   OAuth 回调（换 token；★必须在 API_KEY 白名单内）
     POST      /api/etsy/preflight  拉店铺分区/配送模板/处理档案/店铺信息（缓存 6 小时）
     GET       /api/etsy/taxonomy   按关键词搜类目，换真实 taxonomy_id
     GET       /api/etsy/properties 查某类目下可选属性
     POST      /api/etsy/validate   本地校验标题/标签/必填项/变体（不花额度；变体时返回展开好的组合行）
     POST      /api/etsy/draft      建草稿 + 传图 + 属性 + 库存（★停在 draft）
     POST      /api/etsy/publish    单独一步 state=active（★上架费在这一步才产生）
     POST      /api/etsy/deactivate 下架止损（比删除温和）
     GET       /api/etsy/inventory  读线上整表库存（改库存前必须先读）
     POST      /api/etsy/inventory  整表覆盖式改库存（内部会 GET→合并→PUT）
  */

  // 授权状态自检：不消耗任何 Etsy 额度，前端首屏就调它决定显示哪一屏
  if (p === '/api/etsy/status' && req.method === 'GET') {
    return json(res, 200, Object.assign({ ok: true, serverVersion: SERVER_VERSION }, etsyAuthState()));
  }

  // 发起授权：生成 PKCE 对，302 跳 Etsy 授权页。
  // 店主只需在浏览器点一次「同意」，90 天内不用再来。
  if (p === '/api/etsy/auth' && req.method === 'GET') {
    if (!ETSY_CFG.keystring) {
      return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 ETSY_KEYSTRING / ETSY_SHARED_SECRET（请在 .env 填写后重启后端）。' });
    }
    if (!ETSY_CFG.redirectUri) {
      return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 ETSY_REDIRECT_URI（必须是已在 Etsy App 里登记的 https 地址）。' });
    }
    try {
      const state = etsy.b64url(etsy.randomVerifier(24));
      const verifier = etsy.randomVerifier(64);
      const codeChallenge = await etsy.pkceChallenge(verifier);
      _etsyPendingAuth = { state, verifier, at: Date.now() };
      etsyLog('已生成 PKCE，跳转授权页scope=' + ETSY_CFG.scope);
      res.writeHead(302, {
        Location: etsy.buildAuthorizeUrl(ETSY_CFG, { state, codeChallenge }),
        'Cache-Control': 'no-store',
      });
      return res.end();
    } catch (e) {
      return json(res, 500, { error: 'etsy_auth_error', note: e.message });
    }
  }

  // OAuth 回调：Etsy 带着 code 跳回来。必须免 API_KEY（浏览器从 Etsy 跳过来时没有我们的 key）。
  if (p === '/api/etsy/callback' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code') || '';
    const state = u.searchParams.get('state') || '';
    const deny = u.searchParams.get('error') || '';

    if (deny) {
      etsyLog('店主拒绝了授权：' + deny);
      return redirectWithMsg(res, '授权被拒绝', '你在 Etsy 上点了「拒绝」，没有拿到访问权限。');
    }
    if (!code) return redirectWithMsg(res, '缺少授权码', 'Etsy 没有返回 code，请重新点一次授权。');

    const pend = _etsyPendingAuth;
    _etsyPendingAuth = null; // 一次性，无论成败都清掉
    if (!pend || pend.state !== state) {
      return redirectWithMsg(res, '授权校验失败', 'state 不匹配（可能是这次授权请求不是本后端发起的，或已超时）。请重新点一次授权。');
    }

    try {
      const d = await etsy.exchangeCode(ETSY_CFG, { code, verifier: pend.verifier }, fetch);
      const rec = etsy.normalizeTokenResponse(d);
      etsyStore.write(rec);
      etsyLog('★授权成功，已拿到 token（refresh token 已落盘 ' + ETSY_TOKEN_FILE + '）');

      // ★ 自动发现 shop_id：从 token 前缀取 user_id → 查该用户的店铺。
      //   这样操作者完全不用手工找shop_id（Etsy 界面上任何地方都不显示它）。
      //   .env 里已填 ETSY_SHOP_ID 时以配置为准（多店场景指定用哪个店）。
      let shopHint = '';
      if (ETSY_CFG.shopId) {
        try {
          const shop = await etsyClient.get(`/shops/${ETSY_CFG.shopId}`);
          shopHint = '已连上你在 .env 里指定的店铺：' + (shop.shop_name || ('shop_id=' + ETSY_CFG.shopId));
          writeDiscoveredShop({ shopId: String(ETSY_CFG.shopId), shopName: shop.shop_name || '', userId: etsy.userIdFromToken(rec.accessToken) || '', at: Date.now() });
        } catch (e) {
          shopHint = '⚠️ token 已拿到，但读取 .env 里指定的店铺失败：' + e.message;
        }
      } else {
        try {
          const found = await etsy.discoverShopId(etsyClient, rec.accessToken);
          if (found.ambiguous) {
            // 一个账号多个店：绝不自动挑一个（可能把商品写错店），明确列出让店主选
            const list = found.allShops.map(s => s.shopName + '（' + s.shopId + '）').join('、');
            shopHint = '该账号下有多个店铺：' + list + '。为避免写错店，请联系管理员在 .env 里用 ETSY_SHOP_ID 指定其中一个。';
            etsyLog('⚠️ 多店铺账号，需人工指定：' + list);
          } else {
            writeDiscoveredShop({ shopId: found.shopId, shopName: found.shopName, userId: found.userId, at: Date.now() });
            shopHint = '已自动识别店铺：' + found.shopName + '（shop_id=' + found.shopId + '）。' +
              (found.currencyCode ? '货币=' + found.currencyCode + '。' : '') +
              '这个数字已自动保存，不需要你手工填。';
            etsyLog('★已自动发现 shop_id=' + found.shopId + '（' + found.shopName + '），已落盘 ' + ETSY_SHOP_FILE);
          }
        } catch (e) {
          // 授权本身是成功的，只是自动发现失败——不能因此让店主以为授权失败了
          shopHint = '授权成功，但自动识别店铺失败：' + e.message + '。请把 .env 里的 ETSY_SHOP_ID 填上（店铺网址最后那串数字）。';
          etsyLog('⚠️ 自动发现 shop_id 失败：' + e.message);
        }
      }
      return redirectWithMsg(res, '授权成功', shopHint + ' 现在可以回工作台「Etsy 商品」页建草稿了。');
    } catch (e) {
      etsyLog('换 token 失败：' + e.message);
      return redirectWithMsg(res, '授权失败', e.message);
    }
  }

  // 前置数据：店铺分区 / 配送模板 / 处理档案 / 店铺信息 —— 这四个 ID 是建草稿的必填项
  if (p === '/api/etsy/preflight' && req.method === 'POST') {
    // ⚠️ 检查顺序：先看shop_id（= 授权过没有），再看凭证配没配。
    //   反过来的话，"还没授权"会被"凭证没配"盖掉，提示方向就错了 ——
    //   正确引导是「先点授权」，因为授权成功会自动带出 shop_id。
    const _sid = etsyCurrentShopId();
    if (etsyAuthState().authorized && !_sid) {
      return json(res, 400, { error: 'shop_id_unknown', note: '已授权但不知道该用哪个店铺（可能是多店铺账号）。请在 .env 里加 ETSY_SHOP_ID 指定一个店后重启。' });
    }
    if (!etsyConfigured()) {
      return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 ETSY_KEYSTRING / ETSY_SHARED_SECRET / ETSY_REDIRECT_URI（.env），无法读取店铺数据。' });
    }
    const sid = _sid;
    if (!sid) {
      return json(res, 400, { error: 'shop_id_unknown', note: '还不知道你的 shop_id。请先完成一次授权（页面点「连接 Etsy 店铺」），授权成功时会自动识别并保存。' });
    }
    try {
      const b = await readJson(req);
      const pre = etsyPreflightFor(b.force);
      const d = await pre.load(Boolean(b.force));
      return json(res, 200, {
        ok: true,
        shopId: sid,
        shop: d.shop && !d.shop.__err ? {
          shop_id: d.shop.shop_id, shop_name: d.shop.shop_name, currency_code: d.shop.currency_code,
          num_listings_active: d.shop.num_listings_active, shop_url: d.shop.url,
        } : { error: d.shop && d.shop.__err },
        sections: (d.sections.results || []).map(s => ({ id: s.shop_section_id, title: s.title, num: s.num_listings })),
        shippingProfiles: (d.shipping.results || []).map(s => ({ id: s.shipping_profile_id, title: s.title, origin: s.origin_country_iso, delivery: s.delivery_time_min, maxDelivery: s.delivery_time_max })),
        readinessStates: (d.readiness.results || []).map(s => ({ id: s.readiness_state_id, title: s.title, processing_min: s.processing_time_min, processing_max: s.processing_time_max, is_made_to_order: s.is_made_to_order })),
        warnings: [
          d.sections.__err && '店铺分区读取失败：' + d.sections.__err,
          d.shipping.__err && '配送模板读取失败：' + d.shipping.__err,
          d.readiness.__err && '处理档案读取失败：' + d.readiness.__err,
        ].filter(Boolean),
        note: '实物商品建草稿必须有 shipping_profile_id 与 readiness_state_id；类目 taxonomy_id 请用 /api/etsy/taxonomy 按关键词查。',
      });
    } catch (e) {
      etsyLog('preflight 失败：' + e.message);
      return json(res, 502, { error: 'etsy_error', note: e.message });
    }
  }

  // 类目搜索：AI 给的类目名只是候选，必须换成真实 taxonomy_id 才能建草稿
  if (p === '/api/etsy/taxonomy' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    try {
      const r = await etsy.searchTaxonomy(etsyClient, u.searchParams.get('q') || '', 25);
      return json(res, 200, { ok: true, count: r.length, results: r });
    } catch (e) {
      return json(res, 502, { error: 'etsy_error', note: e.message });
    }
  }

  // 查某类目下的可选属性（做 Attributes 那步要用）
  if (p === '/api/etsy/properties' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const tid = u.searchParams.get('taxonomy_id') || '';
    if (!tid) return json(res, 400, { error: 'bad_request', note: '缺少 taxonomy_id' });
    try {
      const r = await etsy.taxonomyProperties(etsyClient, tid);
      return json(res, 200, { ok: true, taxonomy_id: Number(tid), properties: r });
    } catch (e) {
      return json(res, 502, { error: 'etsy_error', note: e.message });
    }
  }

  // 本地校验：能在建草稿之前拦下的错误，绝不浪费 API 额度（SOP 第 19 节）
  if (p === '/api/etsy/validate' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const v = etsy.validateDraftInput(b);
      const t = etsy.validateTitle(b.title);
      const g = etsy.validateTags(b.tags);
      // 变体计划（若前端选了变体）：算组合数、列问题、**把展开好的组合行返回给前端**，
      // 前端据此渲染每格的价格/库存输入框。整个过程不请求 Etsy、不消耗额度。
      const plan = etsy.validateVariationPlan({ dimensions: b.variation_dimensions });
      let variation = null;
      if (!plan.empty) {
        const combos = plan.ok ? etsy.expandVariationCombinations(b.variation_dimensions) : [];
        const rows = Array.isArray(b.variation_rows) ? b.variation_rows : [];
        const rowCheck = plan.ok ? etsy.validateVariationRows(combos, rows) : { ok: true, errors: [] };
        variation = Object.assign({}, plan, {
          combinations: combos.map(c => ({
            label: c.map(pv => (pv.values || [])[0]).join(' + '),
            property_values: c,
          })),
          rowErrors: rowCheck.errors,
          // 价格变化的属性要记进 price_on_property，否则 Etsy 不会按变体分别定价
          price_on_property: (b.price_on_property || []).map(Number),
          quantity_on_property: (b.quantity_on_property || []).map(Number),
          sku_on_property: (b.sku_on_property || []).map(Number),
        });
      }
      return json(res, 200, {
        ok: true,
        canDraft: v.ok && (variation ? variation.ok && variation.rowErrors.length === 0 : true),
        errors: v.errors.concat(variation ? variation.errors.concat(variation.rowErrors) : []),
        title: t,
        tags: g,
        variation,
        // 程序只能标记机械性问题，不能替人判断材质/授权/图片真实性（SOP 第 19 节明确要求）
        manualChecks: [
          '材质与认证是否有事实依据（AI 不能猜）',
          '商品是否符合 Etsy 创意标准（自己制作 / 设计 / 采购）',
          '图片权利与生产合作方角色是否已核实',
          '每款总价与利润是否已按成本核算',
          '配送承诺与处理时间是否真的能做到',
        ],
      });
    } catch (e) {
      return json(res, 400, { error: 'bad_request', note: e.message });
    }
  }

  // 建草稿：传图 + 属性 + 库存一次做完，但**停在 draft**。
  // 草稿不上架、不计上架费，可以放心在后台反复看。
  if (p === '/api/etsy/draft' && req.method === 'POST') {
    if (!etsyConfigured()) return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 Etsy 凭证。' });
    try {
      const b = await readJson(req);
      const v = etsy.validateDraftInput(b);
      if (!v.ok) {
        return json(res, 400, { error: 'validation_failed', note: '建草稿前校验没通过（已阻止请求，未消耗 Etsy 额度）：', errors: v.errors });
      }
      const imgCount = (b.images || []).length;
      if (imgCount > 20) {
        return json(res, 400, { error: 'too_many_images', note: `图片 ${imgCount} 张，超过 Etsy 上限 20 张。` });
      }

      // 变体：如果前端选了维度，在提交前再校验一次（不信任前端结果），
      //并把「组合矩阵 + 每行价格库存」组装成 products 交给 draftListing。
      //⚠️ 这一步是「用户勾选 → 程序传递」的关键：property_id / value_id 全部来自
      //    /api/etsy/properties 的真实查询结果，全程没有猜测成分。
      let variationSummary = null;
      if (Array.isArray(b.variation_dimensions) && b.variation_dimensions.length) {
        const plan = etsy.validateVariationPlan({ dimensions: b.variation_dimensions });
        if (!plan.ok) {
          return json(res, 400, {
            error: 'variation_invalid',
            note: '变体设置有问题（已阻止请求，未消耗 Etsy 额度）：',
            errors: plan.errors,
          });
        }
        const combos = etsy.expandVariationCombinations(b.variation_dimensions);
        const rows = Array.isArray(b.variation_rows) ? b.variation_rows : [];
        const rowCheck = etsy.validateVariationRows(combos, rows);
        if (!rowCheck.ok) {
          return json(res, 400, {
            error: 'variation_rows_invalid',
            note: '变体的价格或库存没填完整（已阻止请求，未消耗 Etsy 额度）：',
            errors: rowCheck.errors,
          });
        }
        const mv = combos[0].length;
        b.max_variations_supported = mv;
        // 3 个变体维度时必须显式带 max_variations_supported=3，否则 Etsy 返回 409
        b.products = etsy.buildVariationBody(combos, rows, {
          readiness_state_id: b.readiness_state_id,
          price_on_property: b.price_on_property,
          quantity_on_property: b.quantity_on_property,
          sku_on_property: b.sku_on_property,
        }).products;
        variationSummary = {
          dimensionCount: mv, combinationCount: combos.length,
          labels: combos.map(c => c.map(pv => (pv.values || [])[0]).join(' + ')),
        };
        etsyLog('变体：' + mv + ' 个维度 × ' + combos.length + ' 个组合');
      }

      const _td = Date.now();
      etsyLog('开始建草稿：' + (b.title || '').slice(0, 40) + '… 图片 ' + imgCount + ' 张');
      const r = await etsy.draftListing(etsyClient, b);
      etsyLog('★草稿已建 listing_id=' + r.listing_id + '（state=' + r.state + '）耗时 ' + ((Date.now() - _td) / 1000).toFixed(1) + 's');
      return json(res, 200, {
        ok: true,
        listing_id: r.listing_id,
        state: r.state,
        images: r.images,
        properties: r.properties,
        inventory: r.inventory,
        variation: variationSummary,
        note: '草稿已建立，尚未发布（Etsy 上架费 $0.20 只在发布时产生）。请到 Shop Manager → Listings 里核对一遍，确认无误再点「确认发布」。',
      });
    } catch (e) {
      etsyLog('建草稿失败：' + e.message);
      return json(res, 502, { error: 'etsy_error', note: e.message, status: e.status || 0, etsy: e.etsy || null, rateLimit: e.rateLimit || null });
    }
  }

  // 发布：单独一步，人工点确认才走。这里才会产生上架费。
  if (p === '/api/etsy/publish' && req.method === 'POST') {
    if (!etsyConfigured()) {
      return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 Etsy 凭证（ETSY_KEYSTRING / ETSY_SHARED_SECRET / ETSY_SHOP_ID / ETSY_REDIRECT_URI）。' });
    }
    try {
      const b = await readJson(req);
      const lid = Number(b.listing_id || 0);
      if (!lid) return json(res, 400, { error: 'bad_request', note: '缺少 listing_id' });
      const _tp = Date.now();
      etsyLog('★发布 listing ' + lid + '（上架费 $0.20 在这一步产生）');
      const r = await etsy.publishListing(etsyClient, lid);
      etsyLog('发布完成 state=' + r.state + ' 耗时 ' + ((Date.now() - _tp) / 1000).toFixed(1) + 's');
      return json(res, 200, { ok: true, listing_id: lid, state: r.state, url: 'https://www.etsy.com/listing/' + lid, note: '已发布。Etsy 最多需要 48 小时才把它收录进搜索，这期间去买家端页面自查一遍首图裁切、变体价格与库存。' });
    } catch (e) {
      return json(res, 502, { error: 'etsy_error', note: e.message, status: e.status || 0 });
    }
  }

  // 下架止损：发现价差/错误库存/误导图片时，先下架再改，别让错误持续接单
  if (p === '/api/etsy/deactivate' && req.method === 'POST') {
    if (!etsyConfigured()) {
      return json(res, 400, { error: 'etsy_not_configured', note: '服务端未配置 Etsy 凭证（ETSY_KEYSTRING / ETSY_SHARED_SECRET / ETSY_SHOP_ID / ETSY_REDIRECT_URI）。' });
    }
    try {
      const b = await readJson(req);
      const lid = Number(b.listing_id || 0);
      if (!lid) return json(res, 400, { error: 'bad_request', note: '缺少 listing_id' });
      const r = await etsy.deactivateListing(etsyClient, lid, String(b.reason || '').slice(0, 200));
      etsyLog('已下架 listing ' + lid);
      return json(res, 200, { ok: true, listing_id: lid, state: r.state, note: '已下架。链接保留但不参与搜索，也不会继续接单。' });
    } catch (e) {
      return json(res, 502, { error: 'etsy_error', note: e.message });
    }
  }

  // 读线上整表库存 —— 改库存前必须先读它（Etsy 的 PUT 是整表覆盖）
  if (p === '/api/etsy/inventory' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const lid = Number(u.searchParams.get('listing_id') || 0);
    if (!lid) return json(res, 400, { error: 'bad_request', note: '缺少 listing_id' });
    try {
      const mv = Number(u.searchParams.get('max_variations_supported') || 3);
      const d = await etsy.getInventory(etsyClient, lid, mv);
      return json(res, 200, {
        ok: true,
        listing_id: lid,
        products: (d.products || []).map(p => ({
          sku: p.sku,
          property_values: p.property_values,
          offerings: (p.offerings || []).map(o => ({
            offering_id: o.offering_id,
            quantity: o.quantity,
            is_enabled: o.is_enabled,
            price: o.price ? o.price.amount / (o.price.divisor || 100) : null,
          })),
        })),
        price_on_property: d.price_on_property || [],
        quantity_on_property: d.quantity_on_property || [],
        sku_on_property: d.sku_on_property || [],
        note: '这是线上当前的完整库存表。修改时只会替换你指定的变体，其余行会原样保留 —— 但前提是不要跳过这一步直接盲改。',
      });
    } catch (e) {
      return json(res, 502, { error: 'etsy_error', note: e.message });
    }
  }

  // 改库存：内部强制「GET 整表 → 内存合并 → 整表 PUT」，杜绝只提交一行把其他商品误删
  if (p === '/api/etsy/inventory' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const lid = Number(b.listing_id || 0);
      if (!lid) return json(res, 400, { error: 'bad_request', note: '缺少 listing_id' });
      if (!Array.isArray(b.patches) || !b.patches.length) {
        return json(res, 400, { error: 'bad_request', note: '缺少 patches（要修改的变体数组）' });
      }
      const mv = Number(b.max_variations_supported || 3);
      const cur = await etsy.getInventory(etsyClient, lid, mv);
      const merged = etsy.mergeInventory(cur, b.patches);
      const q = { max_variations_supported: String(mv) };
      await etsyClient.put(`/listings/${lid}/inventory`, { json: merged.body, query: q });
      etsyLog('库存已更新 listing ' + lid + '：改了 ' + merged.applied + ' 个变体，保留 ' + merged.untouched + ' 个');
      return json(res, 200, {
        ok: true, listing_id: lid,
        applied: merged.applied, untouched: merged.untouched, total: merged.total,
        note: `已整表提交：修改 ${merged.applied} 个变体，原样保留 ${merged.untouched} 个。`,
      });
    } catch (e) {
      etsyLog('改库存失败：' + e.message);
      return json(res, 502, { error: 'etsy_error', note: e.message, status: e.status || 0 });
    }
  }


  // ★ Etsy 路由必须放在下面这个「公众号未配置」闸门**之前**：
//   否则只配了 Etsy、没配公众号的部署会在这里被提前 400 拦掉，Etsy 功能整体不可用。
  if (!wechatConfigured()) {
    return json(res, 400, { error: 'not_configured', note: '服务端未配置公众号凭证（WECHAT_APPID / WECHAT_APPSECRET）。' });
  }

  // 上传封面图（永久素材）
  if (p === '/api/wechat/upload' && req.method === 'POST') {
    const _tu = Date.now();
    try {
      const b = await readJson(req);
      console.log('[wechat/upload] 收到上传 base64长度=' + String(b.data || '').length + ' 文件名=' + (b.filename || '(默认)'));
      if (!b.data) return json(res, 400, { error: 'bad_request', note: '缺少 data(base64)' });
      const r = await uploadPermanentImage(b.filename || 'cover.png', b.data);
      console.log('[wechat/upload] ★上传成功 media_id=' + (r && r.media_id) +
        ' 耗时 ' + ((Date.now() - _tu) / 1000).toFixed(1) + 's');
      return json(res, 200, r);
    } catch (e) {
      console.error('[wechat/upload] 上传失败：', e && e.message, e && e.wx ? JSON.stringify(e.wx) : '');
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
    const _td = Date.now();
    try {
      const b = await readJson(req);
      const a = b.articles?.[0] || b;
      console.log('[wechat/draft] 收到写草稿请求 标题=' + JSON.stringify(String(a.title || '').slice(0, 40)) +
        ' 正文=' + String(a.content || '').length + '字节 thumb=' + (a.thumb_media_id ? '有' : '无'));
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
        only_fans_can_comment: a.only_fans_can_comment ?? 1,
      });
      console.log('[wechat/draft] ★草稿写入成功 media_id=' + (result && result.media_id) +
        ' 耗时 ' + ((Date.now() - _td) / 1000).toFixed(1) + 's');
      return json(res, 200, result);
    } catch (e) {
      console.error('[wechat/draft] 写入失败：', e && e.message, e && e.wx ? JSON.stringify(e.wx) : '');
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

// OAuth 回调后的落地页：给店主一句人话，不丢一个裸 404
function redirectWithMsg(res, title, msg) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f7f8fa;margin:0;padding:60px 20px;display:flex;justify-content:center}
.card{max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:36px}
h1{font-size:20px;margin:0 0 14px}p{font-size:14px;line-height:1.7;color:#374151;margin:0 0 12px}
.code{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;font-size:13px;color:#111827;word-break:break-all}
a{display:inline-block;margin-top:18px;font-size:14px;color:#2563eb;text-decoration:none}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p>
<p class="code">/api/etsy/callback</p>
<a href="https://etsyops-workbench.pages.dev/">← 回到工作台</a></div></body></html>`;
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function json(res, code, obj) {
  let body;
  try { body = JSON.stringify(obj); }
  catch (e) { body = JSON.stringify({ error: 'serialize_error', note: '响应体过大或无法序列化：' + (e && e.message) }); code = 502; }
  const buf = Buffer.from(body, 'utf8');
  // 必须显式给 Content-Length（含字节数，不是字符数）。
  // 否则 Node 会用 chunked 分块传输，chunked 响应穿过 Cloudflare Tunnel 时
  // 末尾的结束分块容易丢失，浏览器就表现为「后端已出稿但页面一直转圈/未响应」。
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    // no-transform：要求中间层（Cloudflare 边缘）不要对本响应做 Brotli/gzip 动态压缩。
    // 实测：边缘会给隧道 JSON 加 content-encoding: br（605 字节 vs 未压缩 1166 字节），
    // Edge 在「已收到响应头、正在读取正文」这一步解压 brotli 时挂住 → 页面报未响应。
    'Cache-Control': 'no-store, no-transform',
    // ⚠️ 不要再设 Connection: close。
    // 设了 Content-Length 后响应长度已明确，本就不会走 chunked，close 是多余且有害的：
    // 实测经 Cloudflare Tunnel，新建连接要 ~11 秒，而连接复用后只要 ~0.4 秒。
    // Connection: close 会强制浏览器每次都重建连接 → 3 秒一次的轮询根本追不上，
    // 表现为「每次轮询都等十几秒、页面像卡死」。必须让连接保持可复用。
  });
  res.end(buf);
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
  // Etsy 侧的启动自检：把「缺哪个变量导致 Etsy 用不了」在启动时就打清楚，
  // 避免操作者重启后到页面里才发现白发一通请求。
  if (etsyConfigured()) {
    const st = etsyAuthState();
    const sid = st.shopId;
    console.log(`  etsy: ON (${sid ? 'shop ' + sid + (st.shopName ? ' · ' + st.shopName : '') + '（来源：' + (st.shopIdSource === 'env' ? '.env' : '自动发现') + '）' : 'shop 未知'}, 已授权=${st.authorized}, 写操作=${st.allowWrite ? '开' : '关（ETSY_ALLOW_WRITE 未设）'})`);
    if (!st.authorized) console.log('⚠️ etsy: 凭证已配但尚未授权，请在页面点「连接 Etsy 店铺」完成一次授权（授权成功时会自动识别 shop_id，不用手工填）。');
    if (st.authorized && !sid) console.log('⚠️ etsy: 已授权但还不知道 shop_id（可能是多店铺账号）。请在 .env 加 ETSY_SHOP_ID 指定用哪个店后重启。');
    if (!ETSY_CFG.allowWrite) console.log('ℹ️ etsy: 写操作已关闭（安全默认）。要建草稿请在 .env 加 ETSY_ALLOW_WRITE=1 后重启。');
  } else {
    const miss = [];
    if (!ETSY_CFG.apiKeyHeader) miss.push('ETSY_KEYSTRING + ETSY_SHARED_SECRET');
    if (!ETSY_CFG.redirectUri) miss.push('ETSY_REDIRECT_URI');
    // 不再把 ETSY_SHOP_ID 列进缺失项：它会在授权成功时自动发现
    console.log('  etsy: OFF（缺 ' + miss.join('、') + '；不影响公众号与 AI 功能）');
    console.log('ℹ️ etsy: ETSY_SHOP_ID 无需填写，授权成功时会从 token 自动识别并存盘。');
  }
});

// 定期清理 10 分钟前受理但从未被查询的生稿任务，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of _genJobs) {
    // 已完成的再多留 2 分钟（容忍某一轮轮询响应被隧道掐断后重试），之后才清；
    // 一直没人取的（还在跑或前端已放弃）超过 10 分钟也清掉，防止内存堆积。
    if (job.takenAt ? now - job.takenAt > 2 * 60 * 1000 : now - job.at > 10 * 60 * 1000) {
      _genJobs.delete(id);
    }
  }
}, 30 * 1000).unref?.();
