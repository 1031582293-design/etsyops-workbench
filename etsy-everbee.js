/* EverBee Research MCP 客户端（零依赖）
 *
 * 为什么走 MCP 而不是 REST：
 *   官方 REST（research-open-api.everbee.com）要求应用通过人工审核，
 *   未审核的应用一律 401 "App is not approved for Open API access"，
 *   而审核要提交 Production URL / Demo Video / 登录账号，暴露面太大。
 *   MCP（research-mcp.everbee.com）是官方给 AI 工具用的通道，标准 OAuth 2.1，
 *   支持动态注册（DCR）+ PKCE，**不需要审核、不需要 client_secret**。
 *
 * 授权一次的有效期：access_token 60 天 + refresh_token，到期自动续。
 *
 * 工具选择：只调 get_* / view_* 的**读**工具。
 *   MCP 一共有 45 个工具，其中 favourites / folders 有 create/rename/delete 等写操作。
 *   ⚠️ 实测：即使请求只写 3 个 read scope，服务端仍按应用全量授予
 *   （含 favourites:write / folders:write）——所以这里绝不调用任何写工具。
 *
 * 协议细节（实测 EverBeeResearchMCP v4.0.11 / protocol 2025-06-18）：
 *   - 传输：Streamable HTTP，POST /mcp，响应可能是 application/json 或 text/event-stream
 *   - 无 session id（服务端无状态），每次请求都要带 Authorization: Bearer
 *   - 偶发 SSL: UNEXPECTED_EOF，必须重试
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import crypto from 'node:crypto';

export const MCP_BASE = 'https://research-mcp.everbee.com';
export const MCP_ENDPOINT = MCP_BASE + '/mcp';
export const SCOPE = 'keywords:read shops:read listings:read';
const PROTOCOL_VERSION = '2025-06-18';

/* 归一化一条关键词记录：服务端有的字段是数字，有的是字符串（score 见过 '240.0'） */
export function normalizeKeyword(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  return {
    keyword: String(raw.keyword || '').trim(),
    vol: num(raw.vol),
    competition: num(raw.competition),
    new_volume: num(raw.new_volume),
    score: num(raw.score),
    cpc: num(raw.cpc),
    id: raw.id || raw._id || '',
  };
}

/* 解析 JSON-RPC 响应：可能是纯 JSON，也可能是 SSE（data: {...}） */
export function parseRpcBody(raw) {
  const txt = String(raw || '');
  const out = [];
  for (const block of txt.split(/\n\n/)) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:'));
    if (lines.length) {
      const payload = lines.map((l) => l.slice(5).trim()).join('\n');
      try { out.push(JSON.parse(payload)); } catch { /* 忽略心跳/空块 */ }
    }
  }
  if (out.length) return out;
  try { return [JSON.parse(txt)]; } catch { return []; }
}

export function createEverbee(opts = {}) {
  const {
    storeFile = join(process.cwd(), 'data', 'everbee-mcp.json'),
    log = () => {},
    fetchImpl = null,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    minGapMs = 150,          // 两次调用之间的最小间隔，别把对方打急
    maxRetries = 3,
  } = opts;

  const doFetch = (...args) => (fetchImpl || fetch)(...args);
  let _lastCallAt = 0;
  let _initPromise = null;

  /* ---------- 本地状态（client 注册信息 + token），data/ 已被 gitignore ---------- */
  function readState() {
    try { return JSON.parse(readFileSync(storeFile, 'utf8')); } catch { return {}; }
  }
  function writeState(next) {
    try {
      mkdirSync(dirname(storeFile), { recursive: true });
      const tmp = storeFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, storeFile);
      return true;
    } catch (e) { log('EverBee 状态落盘失败：' + (e && e.message)); return false; }
  }
  function patch(p) {
    const s = readState();
    const next = Object.assign({}, s, p);
    writeState(next);
    return next;
  }

  /* ---------- HTTP ---------- */
  async function httpJson(url, { method = 'GET', headers = {}, body = null, timeout = 45000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await doFetch(url, {
        method,
        headers: Object.assign({ 'Accept': 'application/json' }, headers),
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 400) }; }
      return { status: res.status, ok: res.ok, data, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 客户端注册（DCR） ---------- */
  async function ensureClient(redirectUri) {
    const s = readState();
    if (s.clientId && s.redirectUri === redirectUri) return s.clientId;
    const res = await httpJson(MCP_BASE + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'etsyops-workbench',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      }),
    });
    if (!res.ok || !res.data || !res.data.client_id) {
      throw new Error('EverBee 客户端注册失败（HTTP ' + res.status + '）：' + JSON.stringify(res.data).slice(0, 200));
    }
    patch({ clientId: res.data.client_id, redirectUri, registeredAt: now() });
    log('EverBee 客户端已注册：' + res.data.client_id);
    return res.data.client_id;
  }

  /* ---------- 授权链接（PKCE S256） ---------- */
  async function authUrl(redirectUri) {
    if (!redirectUri) throw new Error('缺少 redirectUri');
    const clientId = await ensureClient(redirectUri);
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    patch({ pending: { verifier, state, redirectUri, at: now() } });

    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return MCP_BASE + '/authorize?' + q.toString();
  }

  /* ---------- 用授权码换 token ---------- */
  async function exchangeCode(code, state) {
    const s = readState();
    const pending = s.pending || {};
    if (!pending.verifier) throw new Error('找不到本次授权的 PKCE 记录，请重新发起授权');
    if (state && pending.state && state !== pending.state) throw new Error('state 不匹配，可能是伪造回调，已拒绝');
    const clientId = s.clientId;
    if (!clientId) throw new Error('客户端未注册，请重新发起授权');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    });
    const res = await httpJson(MCP_BASE + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok || !res.data || !res.data.access_token) {
      const desc = (res.data && (res.data.error_description || res.data.error)) || res.text.slice(0, 200);
      throw new Error('换取 token 失败（HTTP ' + res.status + '）：' + desc
        + (res.status === 400 ? '。授权码有效期很短（约 1~2 分钟），过期请重新授权。' : ''));
    }
    const d = res.data;
    const tok = {
      access: d.access_token,
      refresh: d.refresh_token || '',
      scope: d.scope || '',
      clientId,
      obtainedAt: now(),
      expiresAt: now() + (Number(d.expires_in) || 0) * 1000,
    };
    patch({ token: tok, pending: null });
    log('EverBee 授权成功，有效期 ' + Math.round((Number(d.expires_in) || 0) / 86400) + ' 天');
    return tok;
  }

  /* ---------- 刷新 token ---------- */
  async function refreshToken() {
    const s = readState();
    const t = s.token || {};
    if (!t.refresh) throw new Error('没有 refresh token，请重新授权');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: t.clientId || s.clientId || '',
    });
    const res = await httpJson(MCP_BASE + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok || !res.data || !res.data.access_token) {
      throw new Error('刷新 token 失败（HTTP ' + res.status + '）：'
        + ((res.data && (res.data.error_description || res.data.error)) || res.text.slice(0, 160)));
    }
    const d = res.data;
    const tok = {
      access: d.access_token,
      refresh: d.refresh_token || t.refresh,
      scope: d.scope || t.scope,
      clientId: t.clientId || s.clientId,
      obtainedAt: now(),
      expiresAt: now() + (Number(d.expires_in) || 0) * 1000,
    };
    patch({ token: tok });
    log('EverBee token 已刷新');
    return tok;
  }

  async function ensureToken() {
    const s = readState();
    const t = s.token;
    if (!t || !t.access) {
      const e = new Error('EverBee 未授权：请在关键词页点「连接 EverBee」，或访问 /api/everbee/auth');
      e.code = 'everbee_not_authorized';
      throw e;
    }
    // 提前 1 小时续期，避免刚好在请求途中过期
    if (t.expiresAt && t.expiresAt - now() < 3600 * 1000) {
      try { return await refreshToken(); }
      catch (e) {
        log('EverBee token 续期失败：' + (e && e.message));
        return t; // 先用手上的，真过期了下面的 401 分支会提示重新授权
      }
    }
    return t;
  }

  /* ---------- JSON-RPC（带重试） ---------- */
  async function rawRpc(payload, { retries = maxRetries, needAuth = true } = {}) {
    const tok = needAuth ? await ensureToken() : null;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (tok) headers['Authorization'] = 'Bearer ' + tok.access;

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      // 简单限速：两次调用之间至少间隔 minGapMs
      const gap = now() - _lastCallAt;
      if (gap < minGapMs) await sleep(minGapMs - gap);
      _lastCallAt = now();
      try {
        const res = await doFetch(MCP_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout ? AbortSignal.timeout(90000) : undefined,
        });
        const text = await res.text();

        if (res.status === 401) {
          // token 失效（60 天到期或已被撤销）→ 尝试刷新一次
          if (needAuth && attempt === 1) {
            log('EverBee 401，尝试刷新 token');
            await refreshToken().catch(() => {});
            const t2 = readState().token;
            if (t2 && t2.access) headers['Authorization'] = 'Bearer ' + t2.access;
            continue;
          }
          const e = new Error('EverBee 授权已失效，请重新授权（/api/everbee/auth）');
          e.code = 'everbee_unauthorized';
          throw e;
        }
        if (res.status === 403) {
          const e = new Error('EverBee 拒绝访问（403）：可能是套餐不支持该数据，或授权范围不含此项');
          e.code = 'everbee_forbidden';
          throw e;
        }
        if (res.status >= 500) throw new Error('EverBee 服务端错误 HTTP ' + res.status);

        const msgs = parseRpcBody(text);
        const hit = msgs.find((m) => m && (m.result !== undefined || m.error !== undefined)) || msgs[0];
        if (!hit) throw new Error('EverBee 返回无法解析：' + text.slice(0, 200));
        if (hit.error) {
          const e = new Error('EverBee 工具报错：' + JSON.stringify(hit.error).slice(0, 300));
          e.code = 'everbee_rpc_error';
          throw e;
        }
        return hit.result;
      } catch (e) {
        lastErr = e;
        if (e && (e.code === 'everbee_unauthorized' || e.code === 'everbee_forbidden')) throw e;
        if (attempt < retries) {
          log('EverBee 调用失败（第 ' + attempt + ' 次）：' + (e && e.message) + '，重试…');
          await sleep(1200 * attempt);
        }
      }
    }
    throw lastErr || new Error('EverBee 调用失败');
  }

  let _initialized = null;
  async function ensureInitialized() {
    if (_initialized) return _initialized;
    _initialized = rawRpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'etsyops-workbench', version: '1.0' } },
    }).catch((e) => { _initialized = null; throw e; });
    return _initialized;
  }

  async function callTool(name, args = {}) {
    await ensureInitialized();
    const res = await rawRpc({ jsonrpc: '2.0', id: Date.now() % 1e6, method: 'tools/call', params: { name, arguments: args } });
    // MCP 的内容是 [{type:'text', text:'<json>'}]
    const content = (res && res.content) || [];
    for (const c of content) {
      if (c && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { return { _text: c.text }; }
      }
    }
    if (res && res.structuredContent) return res.structuredContent;
    return res;
  }

  /* ---------- 业务封装 ---------- */

  /* 查一个词：返回精确匹配 + 相关词。params 透传给 GET /api/v1/keywords 的过滤条件
     ⚠️ 实测：并发请求时服务端偶发返回「空壳」（searched_keyword 与 results 都为空），
     这不是"未收录"，是响应丢了。所以这里做一次重试，避免把丢包误判成没数据。 */
  async function keyword(term, params = {}) {
    const t = String(term || '').trim();
    if (!t) throw new Error('关键词不能为空');

    const once = async () => {
      const data = await callTool('get_keyword', { keyword: t, params });
      const sk = data && data.searched_keyword;
      const exact = normalizeKeyword(Array.isArray(sk) ? sk[0] : sk);
      const list = Array.isArray(data && data.results) ? data.results.map(normalizeKeyword).filter(Boolean) : [];
      const total = data && typeof data.total_count === 'number' ? data.total_count : null;
      return { exact, list, total };
    };

    let r = await once();
    if (!r.exact && r.list.length === 0) {
      await sleep(500);
      r = await once();
    }
    // 未收录时 exact 为 null —— 给一条「最接近的相关词」做提示，
    // 但绝不拿它冒充该词的搜索量（EverBee 没收录 ≠ 搜索量为 0）
    const nearest = (!r.exact && r.list.length) ? r.list[0].keyword : '';
    return { term: t, exact: r.exact, suggestions: r.list, total: r.total, nearest };
  }

  /* 浏览词库（不带 seed），params 支持 keyword_include / competition_min / order_by / per_page 等 */
  async function keywords(params = {}) {
    const data = await callTool('get_keywords', { params });
    const list = Array.isArray(data && data.results) ? data.results.map(normalizeKeyword).filter(Boolean) : [];
    return { keywords: list, total: data && data.total_count, page: data && data.current_page, pages: data && data.total_pages };
  }

  /* 批量查词：并发 3（实测单条约 1.5 秒，40 条串行要一分钟，并发后约 20 秒）
     - 固定并发池，不一次性打满，避免触发对方限流
     - 单条失败不影响其他条；遇到授权/权限错误立刻停 */
  async function lookup(terms, params = {}, opts2 = {}) {
    const concurrency = Math.max(1, Math.min(Number(opts2.concurrency) || 2, 4));
    const queue = [];
    terms.forEach((t, i) => {
      const term = String(t || '').trim();
      if (term) queue.push({ i, term });
    });
    const out = new Array(terms.length);
    let cursor = 0;
    let aborted = false;

    async function worker() {
      while (!aborted) {
        const job = queue[cursor++];
        if (!job) return;
        try {
          out[job.i] = Object.assign({ ok: true }, await keyword(job.term, params));
        } catch (e) {
          out[job.i] = { ok: false, term: job.term, error: (e && e.message) || String(e), code: (e && e.code) || '' };
          if (e && (e.code === 'everbee_unauthorized' || e.code === 'everbee_forbidden')) aborted = true;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
    return out.filter(Boolean);
  }

  async function status() {
    const s = readState();
    const t = s.token || null;
    const daysLeft = t && t.expiresAt ? Math.max(0, Math.round((t.expiresAt - now()) / 86400000)) : 0;
    return {
      registered: Boolean(s.clientId),
      authorized: Boolean(t && t.access),
      expiresAt: t ? t.expiresAt : null,
      daysLeft,
      scope: t ? t.scope : '',
      // ⚠️ 只暴露「有没有」，不把 token 本身吐给前端
      hasRefresh: Boolean(t && t.refresh),
    };
  }

  function revokeLocal() {
    const s = readState();
    patch({ token: null });
    return { ok: true, hadToken: Boolean(s.token) };
  }

  return { authUrl, exchangeCode, refreshToken, status, keyword, keywords, lookup, callTool, revokeLocal, storeFile };
}
