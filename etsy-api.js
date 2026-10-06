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
 *
 * 4) shop_id 不需要人工填。Etsy 授权返回的 access_token 形如 `{user_id}.{token}`，
 *    从前缀就能直接拿到 user_id；再用 getShopByOwnerUserId
 *    （GET /users/{user_id}/shops）反查出自己的 shop_id。见 discoverShopId()。
 *    这条链路让操作者一个数字都不用手工查——Etsy 界面上任何位置都不显示 shop_id。
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
    // ★ shop_id 现在是**可选**的：留空时会在授权成功后自动发现并落盘（见 discoverShopId）。
    //   保留这个配置项是为了覆盖「一个账号授权了多个店、想指定用哪个店」的情况。
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

/* 从 access_token 里取 user_id。
   Etsy 的 access_token 格式是 `{user_id}.{token}`，例如
   `12345678.jKBPLnOiYt7vpWlsny_lDKqINn4Ny_jwH89hA4IZgggyzqmV_bmQHGJ3HOHH2DmZxOJn5V1qQFnVP9bCn9jnrggCRz`
   —— 点号前那段就是 user_id。这是整条自动发现链路的起点：
   **不需要用户去 Etsy 界面上找 shop_id**（Etsy 任何界面都不显示它）。

   安全说明：这里只取出数字部分做URL 拼接，不把 token 本身往任何地方输出。 */
function userIdFromToken(accessToken) {
  const s = String(accessToken || '');
  const i = s.indexOf('.');
  if (i <= 0) return null;
  const head = s.slice(0, i);
  return /^\d+$/.test(head) ? head : null;
}

/* 自动发现自己的 shop_id。
   链路：access_token → user_id → GET /users/{user_id}/shops → shop_id / shop_name。

   为什么需要这个：Etsy 的界面上（Shop Manager、店铺网址、开发者后台）都不直接显示
   数字 shop_id，让操作者手工找是不现实的；而所有写操作（建草稿、改库存、发货）
   的 URL 里都必须带它。见 README「shop_id 不用手工填」的说明。 */
async function discoverShopId(client, accessToken) {
  const userId = userIdFromToken(accessToken);
  if (!userId) {
    throw new Error('无法从 access token 里解析出 user_id（token 格式应为 {user_id}.{token}），请重新授权一次');
  }
  const d = await client.get(`/users/${userId}/shops`);
  const shops = Array.isArray(d.results) ? d.results : (d && d.shop_id ? [d] : []);
  if (!shops.length) {
    throw new Error(`已解析出 user_id=${userId}，但该用户下没有查到任何店铺。请确认授权的是店铺账号本人。`);
  }
  const first = shops[0];
  return {
    userId: String(userId),
    shopId: String(first.shop_id),
    shopName: first.shop_name || '',
    currencyCode: first.currency_code || '',
    // 一个账号可能有多个店：只有 1 个时自动采用；有多个时必须让人明确选，
    // 否则可能把商品写进错误的店铺——那是要收拾的烂摊子。
    ambiguous: shops.length > 1,
    allShops: shops.map(s => ({ shopId: String(s.shop_id), shopName: s.shop_name || '', currencyCode: s.currency_code || '' })),
  };
}

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

/** { amount: 2999, divisor: 100, currency_code: 'USD' } → 29.99。仅用于回显与校验，绝不发给 Etsy。 */
function fromSubunit(money) {
  if (!money || typeof money !== 'object') return null;
  const d = Number(money.divisor || 100);
  const a = Number(money.amount || 0);
  if (!d) return null;
  return Math.round((a / d) * 100) / 100;
}

/**
 * 把「可能是 Money 对象、也可能是裸数字」的价格统一成浮点。
 *
 * ★ 这是 inventory 读写格式不对称的桥：
 *   - Etsy **读回** inventory 时，offerings[].price 是 Money 对象 {amount, divisor}；
 *   - Etsy **写入** inventory 时，offerings[].price 要浮点（官方原文 "assign a float
 *     equal to amount divided by divisor" / "set your price as a float value"）。
 *   整表覆盖时必须先把读回来的对象归一化成浮点，否则未修改的行会带着对象格式写回去。
 *   （对比：createDraftListing 的表单里 price 是 subunit 整数，与这里规则相反，
 *    两处不要互相照抄。）
 */
function toFloatPrice(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') return fromSubunit(v);   // Money → 浮点
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
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

/*把「fetch 抛出来的网络错误」翻译成能据此行动的一句话。
   为什么要专门做这件事：Node 的 fetch 在**还没拿到HTTP 响应**时只会抛一个
   `TypeError: fetch failed`， cause 里才有真信息（DNS 失败 / 连接被拒 / 超时 / TLS 中断）。
   不挖出来的话，页面��显示「授权失败：fetch failed」，排查时完全不知道该查网络还是查参数。
   —— 2026-07-06 就因为这个裸报错卡住过一次：机器开着 VPN，网络其实通，但无从判断。*/
function explainFetchFailure(err, what) {
  const c = (err && err.cause) || {};
  const code = c.code || err.code || '';
  const msg = c.message || '';
  const bits = [];
  if (code) bits.push('code=' + code);
  if (msg) bits.push('msg=' + msg);
  // 常见成因 → 人能看懂的处理动作
  let advice = '';
  if (/ENOTFOUND|EAI_AGAIN/i.test(code + msg)) {
    advice = '域名解析失败：这台机器连不上该域名。检查网络/DNS，或确认 VPN 是否正确接管了流量。';
  } else if (/ECONNREFUSED/i.test(code + msg)) {
    advice = '连接被拒绝：目标端口没有服务在听。若你开过代理，检查代理是否已断开或端口变了。';
  } else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ESOCKETTIMEDOUT/i.test(code + msg)) {
    advice = '连接超时：请求在超时时间内没有任何响应。常见于需要代理才能访问的站点，' +
      '或网络不通。若刚重启过代理/隧道，等它稳定后重试一次。';
  } else if (/ECONNRESET|EPIPE|socket hang up/i.test(code + msg)) {
    advice = '连接被中断：可能是 VPN 切换、代理重连，或对方中断了长连接。重试一次通常就好了。';
  } else if (/CERT|SSL|TLS/i.test(code + msg + (c.name || ''))) {
    advice = 'TLS/证书错误：常见于代理做了 SSL 拦截。试试把该域名加入代理的直连/绕过列表。';
  } else if (/UND_ERR_SOCKET|UND_ERR|EPROTO/i.test(code + msg)) {
    advice = '底层网络错误：连接建立或传输阶段失败。若刚开启/切换 VPN，多半是切换瞬间的抖动，稍后重试。';
  } else {
    advice = '属于网络层失败（还没收到 HTTP 响应就断了），不是 Etsy 返回的业务错误。';
  }
  return `${what}网络请求失败：${err && err.message ? err.message : '未知错误'}` +
    (bits.length ? `（${bits.join('，')}）` : '') + '。' + advice;
}

/** 用 authorization code + verifier 换 token。
 *  ⚠️ fetchImpl 必须显式传入：token 端点是本模块唯一的对外网络出口，收敛后才可被自测 mock。
 *  漏传会直接打到生产 api.etsy.com —— 自测会因连不上而崩，且真机偶发时极难定位。 */
async function exchangeCode(cfg, { code, verifier }, fetchImpl = fetch, timeoutMs = 30000) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.keystring,
    code,
    code_verifier: verifier,
  });
  if (cfg.redirectUri) body.set('redirect_uri', cfg.redirectUri);
  let r;
  try {
    r = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // ★ 显式超时：Etsy 正常响应在 1 秒内，30 秒还没回来说明网络有问题，
      //   没有这个上限时fetch 可能挂几分钟，页面就一直空着。
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 网络层失败 → 翻译成能据此排查的话，而不是把 "fetch failed" 甩给用户
    throw Object.assign(new Error(explainFetchFailure(e, '换 token 的')), { cause: e, isNetworkError: true });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 业务层错误：Etsy 给了明确的 error 字段，补上「该怎么办」。
    // ★ 判断依据必须同时看 error_description：Etsy 的 redirect_uri 不匹配返回的是
    //   { error: "invalid_grant", error_description: "redirect_uri mismatch" }，
    //   只看 error 字段会被误判成「授权码失效」，给出完全错误的指引。
    const detail = d.error || JSON.stringify(d).slice(0, 300);
    const full = (d.error || '') + ' ' + (d.error_description || '');
    let extra = '';
    if (/redirect_uri/i.test(full)) {
      extra = ' → 请确认 .env 里的 ETSY_REDIRECT_URI 与 Etsy App 登记的 Callback URL 一字不差。';
    } else if (/invalid_grant|invalid_code|expired/i.test(d.error || '')) {
      extra = ' → 授权码已失效或被用过一次（Etsy 的 code 只能用一次）。请重新点一次授权。';
    } else if (/unauthorized_client|invalid_client/i.test(d.error || '')) {
      extra = ' → keystring 或 shared secret 不对。请检查 .env 里这两项有没有复制错（尤其尾部空格）。';
    }
    const suffix = d.error_description && d.error_description !== d.error ? '（' + d.error_description + '）' : '';
    throw new Error(`换 token 失败（HTTP ${r.status}）：${detail}${suffix}${extra}`);
  }
  return d;
}

/** 用 refresh token 换新 token。注意：Etsy 每次刷新都会轮换 refresh_token，必须持久化覆盖。 */
async function refreshAccessToken(cfg, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.keystring,
    refresh_token: cfg.refreshToken,
  });
  let r;
  try {
    r = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    // 与 exchangeCode 同样的处理：网络层失败要给出可排查的说明，而不是裸 fetch failed
    throw Object.assign(new Error(explainFetchFailure(e, '刷新 token 的')), { cause: e, isNetworkError: true });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = d.error || JSON.stringify(d).slice(0, 300);
    let extra = '';
    if (/invalid_grant|expired|revoked/i.test(d.error || '')) {
      extra = ' → refresh token 已失效（超过 90 天或被撤销）。请在页面重新点一次「连接 Etsy 店铺」授权。';
    } else if (/unauthorized_client|invalid_client/i.test(d.error || '')) {
      extra = ' → keystring 或 shared secret 不对，请检查 .env 里这两项。';
    }
    throw new Error(`刷新 token 失败（HTTP ${r.status}）：${detail}${extra}`);
  }
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
function createClient({ config, store, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = () => {}, shopIdProvider = null }) {
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
    // ★ shop_id 动态取：若调用方给了 shopIdProvider（授权后自动发现并存盘的场景），
    //   每次都问它，而不是把 config.shopId 烤死进闭包 —— 否则授权前它还是空的，
    //   授权后即使发现了 shop_id，客户端也永远拿不到。
    shopId: () => (typeof shopIdProvider === 'function' ? (shopIdProvider() || config.shopId) : config.shopId),
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
        // ★ 这里必须传**浮点美元**，不是 subunit 整数。这是与 createDraftListing 的关键差异，
        //   写错就是 100 倍价格事故（$29.99 传成 29 → 变成 $0.29；传成 2999 → 变成 $2999）。
        //   依据：官方 updateListingInventory 描述 "assign a float equal to amount divided
        //   by divisor"，官方 Listings 教程 uploadListingInventory 示例明确写
        //   "set your price as a float value"。Money 结构只用于**读取**（响应里 price 是
        //   {amount, divisor} 对象），写入时用 amount/divisor 的商。
        price: Number(p.price),
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

  // ★ 所有行都要先把price 从 Money 对象归一化成浮点，**包括这次不打算改的行**。
  //   原因：这是整表 PUT，未命中的行也会被原样提交回去。若不归一化，那些行会带着
  //   {amount, divisor} 对象格式发出去 Etsy，写入格式错误。
  //   换句话说：这里不能"只改我要改的"，必须"把整张表转成可提交的形状"。
  for (const p of out) {
    for (const off of (p.offerings || [])) {
      if (off && off.price !== undefined) off.price = toFloatPrice(off.price);
    }
  }

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
    if (patch.price !== undefined && patch.price !== null) off.price = Number(patch.price);
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

// ---------------------------------------------------------------- 变体：由「用户选择」生成组合

/* 变体为什么这样设计（这是本文件最容易被误改的地方，改之前先读完）：
 *
 * Etsy 的变体不能靠"告诉它我有几个颜色选项"。必须给出**每个维度的property_id
 * 和每个选项的 value_id**，而这些 ID 由 Etsy 按类目决定 —— 换个类目就全变了，
 * 猜不出来、编不出来。
 *
 * 所以链路设计成「人做选择，程序做传递」：
 *   1. 程序查该类目的全部属性 → 拿到真实的 property_id / value_id；
 *   2. **用户在页面上勾选**（不是手输ID，ID 由查询结果一路带着走）；
 *   3. 程序按勾选结果展开组合矩阵（笛卡尔积）；
 *   4. 用户逐格填价格库存；
 *   5. 提交前本地校验，通过才整表 PUT。
 *
 * 这样"ID 从哪来"始终可追溯到某次真实查询，全链路没有一处是猜的。
 */

/** 校验用户的变体选择是否符合 Etsy 规则，并算出组合数。 */
function validateVariationPlan(plan) {
  const errs = [];
  const notes = [];
  const dims = Array.isArray(plan && plan.dimensions) ? plan.dimensions : [];

  if (!dims.length) {
    return { ok: false, empty: true, errors: [], notes: ['未选择任何变体维度（这属于正常情况：单规格商品本就不需要变体）'], combinationCount: 0 };
  }
  if (dims.length > 3) {
    errs.push(`选了 ${dims.length} 个变体维度，Etsy 最多支持 3 个`);
  }
  dims.forEach((d) => {
    if (!d.property_id) errs.push(`维度「${d.name || '未命名'}」缺少 property_id`);
    if (!Array.isArray(d.values) || !d.values.length) {
      errs.push(`维度「${d.name || '未命名'}」没有勾选任何值`);
    } else {
      const bad = d.values.filter(v => !v.value_id);
      if (bad.length) errs.push(`维度「${d.name || '未命名'}」有 ${bad.length} 个选项缺少 value_id`);
      const dup = new Set();
      const dups = d.values.filter(v => {
        const k = String(v.value_id);
        if (dup.has(k)) return true;
        dup.add(k);
        return false;
      });
      if (dups.length) errs.push(`维度「${d.name}」选了重复的值：${dups.map(v => v.value || v.value_id).join('、')}`);
    }
    // scale_id 只在尺寸等带单位的属性上出现（如 US numeric），必须原样带上
    if (d.scale_id === undefined || d.scale_id === null || d.scale_id === '') {
      notes.push(`维度「${d.name || '未命名'}」没有 scale_id；若该属性带单位（如鞋码尺寸），Etsy 要求提供`);
    }
  });

  // 组合数 = 各维度值数之积。
  // ⚠️ 初始值必须是 **1**，不能是 0：这是乘法累乘，0 × 任何数都等于 0，
  //   用 0 开头会让 combinationCount 恒为 0（页面据此显示的组合行数也会是错的）。
  //   同时必须显式传初始值，否则 reduce 会拿第一个 dimension 对象当初始值去乘 → NaN。
  const combinationCount = dims.reduce((n, d) => n * ((d.values || []).length || 0), 1);
  if (combinationCount > 1) {
    if (combinationCount > 50) {
      // 官方：3 变体时上限 2500，任一 *_on_property 填满时 400。但几百个组合已无人能核对
      notes.push(`组合数 ${combinationCount} 较多，发布前请务必逐格核对价格与库存`);
    }
    notes.push(`共${combinationCount} 个组合，每个组合都是独立的库存行，各自有价格与 SKU`);
  }

  return { ok: errs.length === 0, errors: errs, notes, combinationCount, dimensionCount: dims.length };
}

/** 按勾选的维度展开笛卡尔积，生成待填写的组合行（不提交）。 */
function expandVariationCombinations(dims) {
  let combos = [[]];
  for (const d of dims || []) {
    const vals = (d.values || []).filter(v => v && v.value_id);
    const next = [];
    for (const c of combos) {
      for (const v of vals) {
        next.push(c.concat([{
          property_id: Number(d.property_id),
          property_name: d.name || '',
          // scale_id 只在确实存在时带上；带上 null 会被 Etsy 判为格式错误
          scale_id: (d.scale_id === undefined || d.scale_id === null || d.scale_id === '') ? null : Number(d.scale_id),
          value_ids: [Number(v.value_id)],
          values: [v.value || ''],
        }]));
      }
    }
    combos = next;
  }
  return combos;
}

/* 把组合行 + 用户填的价格库存，组装成 PUT /inventory 的请求体。
   price 是浮点（不是 subunit），见 buildInventoryBody 上方注释。 */
function buildVariationBody(combos, perRow, opts = {}) {
  const priceOn = (opts.price_on_property || []).map(Number);
  const qtyOn = (opts.quantity_on_property || []).map(Number);
  const skuOn = (opts.sku_on_property || []).map(Number);
  const readyOn = (opts.readiness_state_on_property || []).map(Number);

  return {
    products: combos.map((pv, i) => {
      const r = perRow[i] || {};
      return {
        sku: String(r.sku || ''),
        property_values: pv,
        offerings: [{
          price: Number(r.price),          // 浮点美元
          quantity: Number(r.quantity || 0),
          is_enabled: r.is_enabled === false ? false : true,
          readiness_state_id: Number(r.readiness_state_id || opts.readiness_state_id || 0),
        }],
      };
    }),
    price_on_property: priceOn,
    quantity_on_property: qtyOn,
    sku_on_property: skuOn,
    readiness_state_on_property: readyOn,
  };
}

/** 提交前的最后一道校验：组合行逐格检查，绝不把空价格发出去。 */
function validateVariationRows(combos, perRow) {
  const errs = [];
  if (!Array.isArray(perRow) || perRow.length !== combos.length) {
    errs.push(`填写的行数（${(perRow || []).length}）与组合数（${combos.length}）不一致`);
    return { ok: false, errors: errs };
  }
  const label = (i) => combos[i].map(pv => (pv.values || [])[0]).join(' + ');
  perRow.forEach((r, i) => {
    const p = r.price;
    if (p === undefined || p === null || p === '' || Number.isNaN(Number(p))) {
      errs.push(`「${label(i)}」没有填价格`);
    } else if (Number(p) < 0) {
      errs.push(`「${label(i)}」价格是负数`);
    }
    const q = r.quantity;
    if (q === undefined || q === null || q === '') {
      errs.push(`「${label(i)}」没有填库存`);
    } else if (Number(q) < 0) {
      errs.push(`「${label(i)}」库存是负数`);
    }
    if (Number(p) > 0 && Number(q) === 0) {
      // 不阻断，但提示：零库存的组合买家能选但买不到
    }
  });
  return { ok: errs.length === 0, errors: errs };
}

export {
  etsyConfig,
  explainFetchFailure,
  userIdFromToken,
  discoverShopId,
  toSubunit,
  fromSubunit,
  toFloatPrice,
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
  validateVariationPlan,
  expandVariationCombinations,
  buildVariationBody,
  validateVariationRows,
  draftListing,
  productKey,
  mergeInventory,
  publishListing,
  deactivateListing,
  getInventory,
};