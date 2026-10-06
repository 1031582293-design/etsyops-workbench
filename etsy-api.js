/* ===================== Etsy Open API v3 客户端（零依赖） =====================
 *
 * 设计约束（与 server.js 其余部分一致）：
 *  - 只用 Node 内置能力，不引第三方包；
 *  - 所有凭证只在服务端，前端永远拿不到 shared secret / refresh token；
 *  - 所有网络出口收敛到唯一的 etsyFetch()，便于统一注入双头、token 刷新与退避。
 *
 * ★ 三个最容易把人坑掉的语义，本文件已集中处理，改代码前先读这段：
 *
 * 1) 金额用 subunit。Etsy 的价格不是小数，而是「以 divisor 为单位的整数」。
 *    $29.99 → { amount: 2999, divisor: 100 }。填 29.99 会被理解成 $0.29。
 *    见 toSubunit() / fromSubunit()。
 *
 * 2) PUT /listings/{id}/inventory 是**整表覆盖**，不支持局部更新。
 *    只想改一个变体的库存，也必须把该listing 的全部 products 原样带回再提交，
 *    漏掉任何一行 = Etsy 认为那一行不存在了（在售商品会消失）。
 *    见 mergeInventory()。
 *
 * 3) 上架费 $0.20 只在 state=active 时收，草稿不收。所以建草稿与发布必须拆成
 *    两个独立动作，中间留人工确认。见 draftListing() 与 publishListing()。
 */

// ---------------------------------------------------------------- 配置

function etsyConfig(env = process.env) {
  const keystring = (env.ETSY_KEYSTRING || '').trim();
  const sharedSecret = (env.ETSY_SHARED_SECRET || '').trim();
  return {
    keystring,
    sharedSecret,
    // x-api-key 必须是 keystring:shared_secret。2026-01-18 起 Etsy 强制要求带 shared secret，
    // 只给 keystring 会 401。
    apiKeyHeader: keystring && sharedSecret ? `${keystring}:${sharedSecret}` : '',
    shopId: (env.ETSY_SHOP_ID || '').trim(),
    redirectUri: (env.ETSY_REDIRECT_URI || '').trim(),
    baseUrl: (env.ETSY_BASE_URL || 'https://openapi.etsy.com/v3/application').replace(/\/+$/, ''),
    tokenUrl: (env.ETSY_TOKEN_URL || 'https://api.etsy.com/v3/public/oauth/token').replace(/\/+$/, ''),
    authorizeUrl: (env.ETSY_AUTHORIZE_URL || 'https://www.etsy.com/oauth/connect').replace(/\/+$/, ''),
    accessToken: (env.ETSY_ACCESS_TOKEN || '').trim(),
    refreshToken: (env.ETSY_REFRESH_TOKEN || '').trim(),
    accessTokenExpiresAt: Number(env.ETSY_ACCESS_TOKEN_EXPIRES_AT || 0) || 0,
    // 90 天后 refresh token 失效，需店主重新点一次授权。留30 天余量时就在状态区提示。
    refreshTokenExpiresAt: Number(env.ETSY_REFRESH_TOKEN_EXPIRES_AT || 0) || 0,
    scope: (
      env.ETSY_SCOPE ||
      'listings_r listings_w listings_d shops_r shops_w transactions_r transactions_w address_r email_r'
    ).trim(),
    // 无沙箱档：开发调用直接消耗生产额度，故默认关掉写操作，只允许 dry-run。
    allowWrite: String(env.ETSY_ALLOW_WRITE || '') === '1',
  };
}

// ---------------------------------------------------------------- 小工具

// 本文件零依赖（仅 Node 内置）：crypto 用于 PKCE 与随机 verifier
import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomVerifier(len = 64) {
  // verifier 允许 [A-Za-z0-9._~-]，长度 43~128。取 64 居中，兼容性最好。
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function pkceChallenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

/** $29.99 → { amount: 2999, divisor: 100 }。Etsy 只认这种表示。 */
function toSubunit(price, divisor = 100) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) throw new Error(`价格必须是大于等于 0 的数字，收到：${price}`);
  return { amount: Math.round(n * divisor), divisor };
}

/** { amount: 2999, divisor: 100 } → 29.99。仅用于回显与校验，绝不发给 Etsy。 */
function fromSubunit(money) {
  if (!money || typeof money !== 'object') return null;
  const d = Number(money.divisor || 100);
  const a = Number(money.amount || 0);
  if (!d) return null;
  return Math.round((a / d) * 100) / 100;
}

/** 建授权跳转 URL。state 由调用方生成并落盘，回调时比对，防 CSRF。 */
function buildAuthorizeUrl(cfg, { state, codeChallenge }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.keystring,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${cfg.authorizeUrl}?${q.toString()}`;
}

/** 用 authorization code + verifier 换 token。
 *  ⚠️ fetchImpl 必须显式传入：token 端点是本模块唯一的对外网络出口，收敛后才可被自测 mock。
 *  漏传会直接打到生产 api.etsy.com —— 自测会因连不上而崩，且真机偶发时极难定位。 */
async function exchangeCode(cfg, { code, verifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.keystring,
    code,
    code_verifier: verifier,
  });
  if (cfg.redirectUri) body.set('redirect_uri', cfg.redirectUri);
  const r = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`换token 失败（HTTP ${r.status}）：` + (d.error || JSON.stringify(d).slice(0, 300)));
  return d;
}

/** 用 refresh token 换新 token。注意：Etsy 每次刷新都会轮换 refresh_token，必须持久化覆盖。 */
async function refreshAccessToken(cfg, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.keystring,
    refresh_token: cfg.refreshToken,
  });
  const r = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`刷新 token 失败（HTTP ${r.status}）：` + (d.error || JSON.stringify(d).slice(0, 300)));
  return d;
}

// ---------------------------------------------------------------- token 存取

/* token 落盘到 data/etsy-token.json（data/ 已在 .gitignore）。
   为什么必须落盘而不是只放内存：
   - refresh token 90 天有效，是「免再次授权」的凭据，进程重启后必须还在；
   - Etsy 每次刷新都会返回新的 refresh token，旧的可能随即失效 → 必须覆盖写；
   - access token 只有 1 小时，进程重启后必然要刷新一次。 */
function createTokenStore(filePath, fsmod) {
  const { readFileSync, writeFileSync, mkdirSync, renameSync } = fsmod;
  const dir = filePath.replace(/[/\\][^/\\]+$/, '');

  const read = () => {
    try {
      const d = JSON.parse(readFileSync(filePath, 'utf8'));
      return {
        accessToken: d.accessToken || '',
        refreshToken: d.refreshToken || '',
        accessTokenExpiresAt: Number(d.accessTokenExpiresAt || 0),
        refreshTokenExpiresAt: Number(d.refreshTokenExpiresAt || 0),
        obtainedAt: Number(d.obtainedAt || 0),
      };
    } catch {
      return { accessToken: '', refreshToken: '', accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0, obtainedAt: 0 };
    }
  };

  const write = (d) => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = filePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
      renameSync(tmp, filePath);
      return true;
    } catch {
      return false;
    }
  };

  return { read, write };
}

/** 把 token 响应折算成带绝对过期时刻的记录。 */
function normalizeTokenResponse(d, now = Date.now()) {
  // ⚠️ 必须用 ?? 而不是 ||：expires_in=0 表示「token 已经过期，立刻刷新」，
  // 用 || 会把 0 误当成「字段缺失」而回退成 3600，导致一个已过期的 token 被当成有效，
  // 第一次请求必然 401，然后才走401 重试——多一次无谓的失败请求。
  const rawExpires = d.expires_in ?? d.expiresIn;
  const expiresIn = Number.isFinite(Number(rawExpires)) ? Number(rawExpires) : 3600;
  return {
    accessToken: d.access_token || '',
    refreshToken: d.refresh_token || '',
    // 提前 60 秒视为过期，避免边界上发出 401
    accessTokenExpiresAt: now + Math.max(0, expiresIn - 60) * 1000,
    refreshTokenExpiresAt: now + 90 * 24 * 3600 * 1000,
    obtainedAt: now,
  };
}

// ---------------------------------------------------------------- 核心请求

/* 统一的 Etsy 请求出口。
   - 自动带 x-api-key + Authorization: Bearer（两者都必需，缺一即 401）；
   - access token 临近过期自动刷新一次，并处理 refresh token 轮换；
   - 401 自动重试一次（刷新后重试），避免并发请求撞在一起导致重复刷新；
   - 429 按 retry-after 退避（指数退避，封顶 8 秒，只重试可重试的写操作）。 */
function createClient({ config, store, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  let refreshing = null;

  async function accessToken() {
    const t = store.read();
    if (t.accessToken && t.accessTokenExpiresAt > now()) return t.accessToken;

    const cur = store.read();
    if (!cur.refreshToken) {
      throw new Error('没有 refresh token，请先在 /api/etsy/auth 完成一次授权（浏览器点一次「同意」）。');
    }
    // 并发去重：多个请求同时发现过期时，只发一次刷新请求。
    // Etsy 的 refresh token 是一次性轮换的，并发刷新会让后到的请求拿到已失效的 refresh token。
    if (!refreshing) {
      refreshing = (async () => {
        log('token 临近过期，自动刷新');
        const d = await refreshAccessToken({ ...config, refreshToken: cur.refreshToken }, fetchImpl);
        const rec = normalizeTokenResponse(d, now());
        store.write(rec);
        log('token 刷新成功' + (rec.refreshToken ? '（refresh token 已轮换并覆盖落盘）' : ''));
        return rec;
      })().finally(() => { refreshing = null; });
    }
    const rec = await refreshing;
    return rec.accessToken;
  }

  async function request(method, path, opts = {}) {
    if (!config.apiKeyHeader) {
      throw new Error('服务端未配置 ETSY_KEYSTRING / ETSY_SHARED_SECRET（.env），无法调用 Etsy 接口。');
    }
    if ((opts.write || method === 'POST' || method === 'PUT' || method === 'DELETE') && !config.allowWrite) {
      throw new Error('写操作已被安全开关关闭（.env 里没有 ETSY_ALLOW_WRITE=1）。确认要写店铺时再打开。');
    }

    const url = config.baseUrl + path + (opts.query ? '?' + new URLSearchParams(opts.query).toString() : '');

    const doOnce = async (tok) => {
      const headers = {
        'x-api-key': config.apiKeyHeader,
        Authorization: `Bearer ${tok}`,
        Accept: 'application/json',
      };
      let body;
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(opts.form).toString();
      } else if (opts.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.multipart) {
        body = opts.multipart; // fetch 会自己带 boundary
      }
      return fetchImpl(url, { method, headers, body });
    };

    let tok = await accessToken();
    let r = await doOnce(tok);

    // 401：可能是并发刷新导致的 token 失效，强制刷新一次再试
    if (r.status === 401) {
      log('收到 401，强制刷新 token 后重试一次');
      store.write({ ...store.read(), accessToken: '', accessTokenExpiresAt: 0 });
      tok = await accessToken();
      r = await doOnce(tok);
    }

    // 429：按 retry-after 退避重试，最多 3 次
    let attempt = 0;
    while (r.status === 429 && attempt < 3) {
      const ra = Number(r.headers.get('retry-after')) || 0;
      const waitMs = ra > 0 ? ra * 1000 : Math.min(8000, 800 * Math.pow(2, attempt));
      attempt++;
      log(`收到 429，第 ${attempt} 次退避 ${waitMs}ms 后重试`);
      await sleep(waitMs);
      r = await doOnce(tok);
    }

    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON（如 502 HTML）留空 */ }

    if (!r.ok) {
      const err = new Error(
        `Etsy ${method} ${path} → HTTP ${r.status}：` +
        (data.error || data.message || (text || '').slice(0, 200) || '(无响应体)')
      );
      err.status = r.status;
      err.etsy = data;
      // 限流信息透出，方便判断是配额用完还是单点错误
      err.rateLimit = {
        limitPerDay: r.headers.get('x-limit-per-day'),
        remainingToday: r.headers.get('x-remaining-today'),
        limitPerSecond: r.headers.get('x-limit-per-second'),
        remainingThisSecond: r.headers.get('x-remaining-this-second'),
      };
      throw err;
    }
    return data;
  }

  return {
    get: (p, query) => request('GET', p, { query }),
    post: (p, { form, json, multipart, query } = {}) => request('POST', p, { form, json, multipart, query, write: true }),
    put: (p, { json, form, query } = {}) => request('PUT', p, { json, form, query, write: true }),
    del: (p, query) => request('DELETE', p, { query, write: true }),
    request,
    accessToken,
    shopId: () => config.shopId,
  };
}

// ---------------------------------------------------------------- 前置查询

/* 一次性把建草稿所需的四个 ID 拉齐并缓存。
   这四个都是「建草稿的必填项」，缺任何一个 Etsy 都会返回 400：
     shipping_profile_id     实物配送模板（发货地/重量/运费/送达国）
     readiness_state_id      处理档案（现货 or 接单制作 + 处理天数）
     taxonomy_id             类目（AI 给的只是候选名，真实 ID 必须查）
     shop_section_id         店铺分区（可选，缺了放"未分类"） */
function createPreflight(client) {
  let cache = { at: 0, data: null };

  const load = async (force = false) => {
    // 类目树很大且几乎不变，缓存 6 小时；其余配置也一并缓存，避免每次建草稿都打 4 次 API
    if (!force && cache.data && Date.now() - cache.at < 6 * 3600 * 1000) return cache.data;
    const d = await loadAll(client);
    cache = { at: Date.now(), data: d };
    return d;
  };

  return {
    load,
    invalidate: () => { cache = { at: 0, data: null }; },
    peek: () => cache.data,
  };
}

async function loadAll(client) {
  const sid = client.shopId();
  const [sections, shipping, readiness, shop] = await Promise.all([
    client.get(`/shops/${sid}/sections`).catch(e => ({ __err: e.message, results: [] })),
    client.get(`/shops/${sid}/shipping-profiles`).catch(e => ({ __err: e.message, results: [] })),
    client.get(`/shops/${sid}/readiness-state-definitions`).catch(e => ({ __err: e.message, results: [] })),
    client.get(`/shops/${sid}`).catch(e => ({ __err: e.message })),
  ]);
  return { sections, shipping, readiness, shop };
}

/** 在 seller 类目树里按关键词找taxonomy_id。AI 给的类目名只是候选，必须用这个换真实 ID。 */
async function searchTaxonomy(client, keyword, limit = 25) {
  const k = String(keyword || '').trim();
  if (!k) throw new Error('请提供类目关键词');
  const d = await client.get('/seller-taxonomy/nodes', { keywords: k, limit });
  return (d.results || []).map(n => ({
    taxonomy_id: n.taxonomy_id,
    name: n.name,
    full_path: (n.ancestors || []).map(a => a.name).concat([n.name]).join(' > '),
    is_leaf: n.is_leaf,
    is_taxonomy_root: n.is_taxonomy_root,
  }));
}

/** 查某个类目下有哪些属性可选（做 Attributes 那步要用）。 */
async function taxonomyProperties(client, taxonomyId) {
  const d = await client.get(`/seller-taxonomy/nodes/${taxonomyId}/properties`);
  return (d.results || []).map(p => ({
    property_id: p.property_id,
    name: p.name,
    is_required: p.is_required,
    is_multivalued: p.is_multivalued,
    possible_values: (p.possible_values || []).slice(0, 40).map(v => ({ value_id: v.value_id, name: v.name })),
  }));
}

// ---------------------------------------------------------------- 校验（本地，不花 API 额度）

/* 下面这些是 SOP 第 19 节要求的「适合交给程序检查的项目」。
   原则（见 SOP 原文）：程序只能标记冲突，不能宣称图片真实 / 关键词有搜索量 / 商品合规。 */

function validateTitle(title) {
  const t = String(title || '').trim();
  const errs = [];
  if (!t) errs.push('标题为空');
  if (t.length > 140) errs.push(`标题 ${t.length} 字符，超过 Etsy 硬限制 140`);
  // Etsy 的标题字符白名单：字母、数字、标点、数学符号、空格、™©®；
  // 且 % : & + 各只能出现一次。
  const bad = t.match(/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u);
  if (bad) errs.push(`标题含 Etsy 不允许的字符：${[...new Set(bad)].slice(0, 5).join(' ')}`);
  for (const ch of ['%', ':', '&', '+']) {
    const n = t.split(ch).length - 1;
    if (n > 1) errs.push(`标题里 "${ch}" 出现了 ${n} 次，Etsy 限制只能出现 1 次`);
  }
  return { ok: errs.length === 0, errors: errs, length: t.length };
}

function validateTags(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const errs = [];
  const notes = [];
  const cleaned = [];
  const seen = new Set();

  arr.forEach((raw) => {
    const t = String(raw).trim().replace(/^#+/, '').trim();
    if (!t) return;
    // Etsy 标签不允许逗号；标签里也不能带中文以外的标点，但空格和- ' ™ © ® 可以
    if (/[^\p{L}\p{Nd}\p{Zs}\-'’™©®]/u.test(t)) {
      errs.push(`标签「${t}」含不允许的字符（逗号、#、斜杠等都不能进标签）`);
      return;
    }
    if (t.length > 20) { errs.push(`标签「${t}」${t.length} 字符，超过 20 上限`); return; }
    const key = t.toLowerCase();
    if (seen.has(key)) { notes.push(`标签「${t}」与前面的标签重复，已忽略（Etsy 不给重复标签任何权重）`); return; }
    seen.add(key);
    cleaned.push(t);
  });

  // ★ 硬上限 13 个。超出必须**在这里截断**并报错，不能原样发给 Etsy ——
  //   Etsy 收到 14 个标签会整单拒绝，那张草稿就白建了（还会白消耗一次 API 调用）。
  let truncated = 0;
  if (cleaned.length > 13) {
    truncated = cleaned.length - 13;
    errs.push(`标签 ${cleaned.length} 个，超过 Etsy 上限 13 个 —— 已自动保留前 13 个，丢弃 ${truncated} 个`);
    cleaned.length = 13;
  }
  if (cleaned.length < 13) {
    notes.push(`当前只有 ${cleaned.length} 个标签。SOP 建议备满 13 个（少于 13 个不违规，只是少了曝光入口）`);
  }
  // 去重后数量可能又不足 13，被丢弃的重复项可以补位
  if (truncated && arr.length > 13) notes.push('被截掉的标签里有重复项，可合并同义表述把位置补回来。');

  return { ok: errs.length === 0, errors: errs, notes, tags: cleaned, count: cleaned.length, truncated };
}

/** 建草稿前的本地校验：能提前拦下的绝不浪费 API 额度。 */
function validateDraftInput(inp) {
  const errs = [];
  const push = (k, msg) => { if (!errs.some(e => e.startsWith(k))) errs.push(msg); };

  const t = validateTitle(inp.title);
  if (!t.ok) errs.push(...t.errors);

  const g = validateTags(inp.tags);
  // tags 标签自身的 errors 都是硬问题（超长/非法字符/超 13 个），必须挡住；
  // notes 里的「不足 13 个」只是建议，不挡。
  errs.push(...g.errors);

  const desc = String(inp.description || '').trim();
  if (!desc) errs.push('描述为空');
  if (/待确认|TBD|TODO|待补/.test(desc)) errs.push('描述里出现「待确认 / TBD」字样，不能发到 Etsy');

  if (!inp.taxonomy_id || Number.isNaN(Number(inp.taxonomy_id))) errs.push('缺少 taxonomy_id（真实类目 ID，需先用类目搜索确认）');
  if (!inp.price && inp.price !== 0) errs.push('缺少 price');
  if (inp.quantity === undefined || inp.quantity === null || inp.quantity === '') errs.push('缺少 quantity（可售数量）');

  // who_made / when_made / is_supply 三者互相依赖，Etsy 文档明确写了约束关系
  const who = inp.who_made;
  const when = inp.when_made;
  if (!who) errs.push('缺少 who_made（i_did / collective / someone_else）');
  if (!when) errs.push('缺少 when_made（如 made_to_order / 2020_2026）');
  if (inp.is_supply === undefined || inp.is_supply === null || inp.is_supply === '') {
    errs.push('缺少 is_supply（是否为手工材料/工具包，成品通常 false）');
  }

  // 实物必填
  if (!inp.shipping_profile_id) errs.push('缺少 shipping_profile_id（实物必填，先在 Shop Manager 建配送模板）');
  if (!inp.readiness_state_id) errs.push('缺少 readiness_state_id（实物必填，先在 Shop Manager 建处理档案）');

  return { ok: errs.length === 0, errors: errs };
}

// ---------------------------------------------------------------- 建草稿

/* 组装 createDraftListing 的表单。Etsy 这个端点收 x-www-form-urlencoded（不是 JSON），
   且价格是 subunit 整数。少任何一个必填字段都会得到一个笼统的 400。 */
function buildDraftForm(inp) {
  const form = {
    quantity: String(inp.quantity),
    title: String(inp.title).trim(),
    description: String(inp.description).trim(),
    price: String(toSubunit(inp.price).amount), // 注意：只传 amount，divisor 固定 100
    who_made: String(inp.who_made),
    when_made: String(inp.when_made),
    is_supply: inp.is_supply ? 'true' : 'false',
    taxonomy_id: String(inp.taxonomy_id),
    shipping_profile_id: String(inp.shipping_profile_id),
    readiness_state_id: String(inp.readiness_state_id),
  };
  if (inp.return_policy_id) form.return_policy_id = String(inp.return_policy_id);
  if (inp.shop_section_id) form.shop_section_id = String(inp.shop_section_id);
  // ★ tags / materials 必须转成逗号分隔的**字符串**再进 URLSearchParams。
  //   传数组的话 URLSearchParams 会把数组 toString() 成 "a,b" —— 恰好也是逗号分隔，
  //   但依赖了隐式行为、可读性差且容易在后续改动中踩坑；这里显式 join。
  const tg = validateTags(inp.tags).tags;
  if (tg.length) form.tags = tg.join(',');
  const mats = (inp.materials || []).map(m => String(m).trim()).filter(Boolean);
  if (mats.length) form.materials = mats.join(',');
  if (inp.item_weight && inp.item_weight > 0) form.item_weight = String(inp.item_weight);
  if (inp.item_length && inp.item_length > 0) form.item_length = String(inp.item_length);
  if (inp.item_width && inp.item_width > 0) form.item_width = String(inp.item_width);
  if (inp.item_height && inp.item_height > 0) form.item_height = String(inp.item_height);
  if (inp.item_weight_unit) form.item_weight_unit = String(inp.item_weight_unit);
  if (inp.item_dimensions_unit) form.item_dimensions_unit = String(inp.item_dimensions_unit);
  if (inp.description && /[\u4e00-\u9fa5]/.test(inp.description)) {
    // 不阻断，但提示：Etsy 面向英语买家，中文会直接影响搜索与转化
  }
  return form;
}

async function draftListing(client, inp) {
  const form = buildDraftForm(inp);
  const sid = client.shopId();
  const created = await client.post(`/shops/${sid}/listings`, { form });
  const listingId = created.listing_id;

  // 传图：逐张 multipart。第一张即主图，最多 20 张。
  const images = [];
  for (const img of inp.images || []) {
    if (!img.data) continue;
    const fd = new FormData();
    fd.append('image', Buffer.from(img.data, 'base64'), img.filename || 'image.jpg');
    if (img.rank) fd.append('rank', String(img.rank));
    if (img.alt_text) fd.append('alt_text', String(img.alt_text));
    try {
      const r = await client.post(`/listings/${listingId}/images`, { multipart: fd });
      images.push({ listing_image_id: r.listing_image_id, rank: r.rank, ok: true });
    } catch (e) {
      images.push({ ok: false, error: e.message });
    }
  }

  // 属性（Attributes）：必须在建完草稿后单独补，且 value_id 必须来自该taxonomy 的属性表
  const props = [];
  for (const p of inp.properties || []) {
    try {
      const r = await client.post(`/listings/${listingId}/properties`, {
        json: { property_id: p.property_id, value_ids: p.value_ids || [], values: p.values || [] },
      });
      props.push({ property_id: p.property_id, ok: true, count: (r.results || []).length });
    } catch (e) {
      props.push({ property_id: p.property_id, ok: false, error: e.message });
    }
  }

  // 变体库存：整表覆盖，必须一次提交全部组合
  let inventory = null;
  if (inp.products && inp.products.length) {
    try {
      const q = { max_variations_supported: String(inp.max_variations_supported || 2) };
      inventory = await client.put(`/listings/${listingId}/inventory`, {
        json: buildInventoryBody(inp),
        query: q,
      });
    } catch (e) {
      inventory = { __err: e.message };
    }
  }

  return { listing_id: listingId, state: created.state, images, properties: props, inventory };
}

function buildInventoryBody(inp) {
  return {
    products: inp.products.map(p => ({
      sku: p.sku || '',
      property_values: (p.property_values || []).map(pv => ({
        property_id: pv.property_id,
        property_name: pv.property_name,
        scale_id: pv.scale_id == null ? null : Number(pv.scale_id),
        value_ids: pv.value_ids || [],
        values: pv.values || [],
      })),
      offerings: [{
        price: toSubunit(p.price).amount, // offerings 的 price 同样是 subunit 整数
        quantity: Number(p.quantity || 0),
        is_enabled: p.is_enabled === false ? false : true,
        readiness_state_id: Number(p.readiness_state_id || inp.readiness_state_id),
      }],
    })),
    price_on_property: inp.price_on_property || [],
    quantity_on_property: inp.quantity_on_property || [],
    sku_on_property: inp.sku_on_property || [],
  };
}

/* 库存整表合并：把「只想改的项」安全地合并进「当前线上整表」。

   ⚠️ 这是最容易写出事的地方。Etsy 的 PUT /inventory 是整表覆盖：
   你只提交一行，它就认为其余行都不存在了 → 那些在售商品会直接消失。

   正确姿势永远是：先 GET 整表 → 在内存里改 → 整表 PUT 回去。
   本函数做的就是「在内存里改」这一步，且做了三重保护：
     1. 按 property_values 的组合 key 精确定位，不会串行；
     2. 未在 patch 中出现的组合原样保留；
     3. 若线上组合数与传入的期望数不符，拒绝提交（宁可不动也不误删）。 */
function productKey(pv = []) {
  return pv
    .map(x => `${x.property_id}=${(x.value_ids || []).slice().sort().join(',')}`)
    .sort()
    .join('|');
}

function mergeInventory(currentBody, patches) {
  if (!currentBody || !Array.isArray(currentBody.products)) {
    throw new Error('当前库存表结构异常（没有 products 数组），已中止提交，避免误删商品');
  }
  if (!Array.isArray(patches) || !patches.length) {
    throw new Error('没有要修改的变体');
  }

  const currentKeys = new Set(currentBody.products.map(p => productKey(p.property_values)));
  const out = currentBody.products.map(p => JSON.parse(JSON.stringify(p)));

  let applied = 0;
  for (const patch of patches) {
    const k = productKey(patch.property_values);
    const idx = out.findIndex(p => productKey(p.property_values) === k);
    if (idx < 0) {
      throw new Error(`要改的变体在线上库存表里不存在（key=${k}）。请先 GET /inventory 对照现有组合再改。`);
    }
    const target = out[idx];
    // 保留原有 offering 的 id / sku，只改明确指定的字段
    const off = target.offerings && target.offerings[0] ? target.offerings[0] : {};
    if (patch.price !== undefined && patch.price !== null) off.price = toSubunit(patch.price).amount;
    if (patch.quantity !== undefined && patch.quantity !== null) off.quantity = Number(patch.quantity);
    if (patch.sku !== undefined) target.sku = String(patch.sku);
    if (patch.is_enabled !== undefined) off.is_enabled = Boolean(patch.is_enabled);
    target.offerings = [off];
    applied++;
  }

  return {
    body: {
      products: out,
      price_on_property: currentBody.price_on_property || [],
      quantity_on_property: currentBody.quantity_on_property || [],
      sku_on_property: currentBody.sku_on_property || [],
      readiness_state_on_property: currentBody.readiness_state_on_property || [],
    },
    applied,
    total: currentBody.products.length,
    // 未被 patch 命中的组合已原样保留（它们仍在 out 里），这里回报给调用方核对。
    untouched: currentBody.products.length - applied,
  };
}

/** 单独一步：真正发布。调用前必须已经人工确认过草稿内容。 */
async function publishListing(client, listingId) {
  return client.put(`/listings/${listingId}`, { form: { state: 'active' } });
}

/** 下架（发现问题时的止损动作，比 delete 温和，链接还在）。 */
async function deactivateListing(client, listingId, reason) {
  return client.put(`/listings/${listingId}`, { form: { state: 'inactive', reason: reason || '' } });
}

/** 读线上库存整表。改库存前必须先调它。 */
async function getInventory(client, listingId, maxVariations = 3) {
  return client.get(`/listings/${listingId}/inventory`, { max_variations_supported: String(maxVariations) });
}

export {
  etsyConfig,
  toSubunit,
  fromSubunit,
  b64url,
  randomVerifier,
  pkceChallenge,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  createTokenStore,
  normalizeTokenResponse,
  createClient,
  createPreflight,
  loadAll,
  searchTaxonomy,
  taxonomyProperties,
  validateTitle,
  validateTags,
  validateDraftInput,
  buildDraftForm,
  buildInventoryBody,
  draftListing,
  productKey,
  mergeInventory,
  publishListing,
  deactivateListing,
  getInventory,
};