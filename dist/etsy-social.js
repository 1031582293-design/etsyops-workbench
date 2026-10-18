/* ===================== 社媒内容生成 + 平台发布页深链 =====================
 *
 * 为什么不做 API 直连（这是本模块存在的理由，改之前先读）：
 *   工作台服务的是「店铺数量少、发布频率低」的店主。API 直连要为此背四套开发者账号、
 *   四套审核（Meta 的 App Review + 企业验证动辄数周且个人主体基本过不了）、
 *   token 轮换与存储、以及一个「看不到发布结果」的失败面 —— 换来的只是省掉一次人工登录。
 *   投入产出比明确为负，所以改为：**工作台只负责产出内容，发布交给平台自己的页面**。
 *
 * 做法：把文案 / 图片 URL / 带 utm 的链接拼成各平台的官方发布页深链
 *   （Pinterest Save 按钮、FB Share 按钮、X Tweet 按钮用的就是这些地址），
 *   店主点开 → 在他自己的账号里登录 → 内容已预填 → 点发布。
 *
 * 三条硬约束（都是踩过或明确评估过的坑）：
 *   1. **只吃 active 的 listing**。草稿没有公开 URL，发出去的是 404 链接。
 *   2. **一切拼进 URL 的值必须 encodeURIComponent**，一切拼进 HTML 的值必须 socEsc，
 *      因为 title/description 来自 AI 生成与 CSV 导入 —— 属于外部输入。
 *   3. **各平台文案结构不同，不是同一段话截四次**：Pinterest 是搜索场景要堆关键词，
 *      X 只有 280 加权字符，IG 不吃链接。
 *
 * 本文件是纯函数、不碰 DOM，便于 test/selftest.social.mjs 直接跑同一份代码。
 */

/* 各平台能力对照（deep=false 表示该平台没有可预填的发布页，只能复制内容自己去发） */
const SOCIAL_PLATFORMS = [
  {
    key: 'pinterest', name: 'Pinterest', deep: true,
    limit: 800, titleLimit: 100,
    hint: '链接 + 图片会预填；描述有时不被 Pinterest 带过去 —— 文案已复制到剪贴板，描述框空着就直接粘贴（Ctrl/⌘+V）',
    imageNote: '图片用「media」参数直接传 Etsy 图地址，无需下载',
  },
  {
    key: 'facebook', name: 'Facebook', deep: true,
    limit: 5000,
    hint: '链接 + 文字已预填；预览图由 Facebook 抓取商品页生成',
    imageNote: '图片由 Facebook 自动抓取，无需手动传',
  },
  {
    key: 'x', name: 'X', deep: true,
    limit: 280, weighted: true,
    hint: '文字 + 链接已预填；发布页不接受传图，需要图片请点「打开图片」另存后手动添加',
    imageNote: '发布页不支持带图，需手动添加',
  },
  {
    key: 'instagram', name: 'Instagram', deep: false,
    limit: 2200, manual: true,
    hint: 'Instagram 没有网页端发布入口，只能：复制文案 → 手机 App 里选图粘贴（图片也需先存到手机）',
    imageNote: '需先在手机上保存图片',
  },
  {
    key: 'weibo', name: '微博', deep: true,
    limit: 2000,
    hint: '链接 + 文字 + 图片地址已预填',
    imageNote: '图片用「pic」参数直接传 Etsy 图地址',
  },
];

const SOCIAL_PLATFORM_BY_KEY = SOCIAL_PLATFORMS.reduce((m, p) => (m[p.key] = p, m), {});

/* 同一商品反复发同一段文案会被平台判重（Pinterest 尤其），准备几种开场轮换 */
const SOCIAL_HOOKS = [
  'Fresh from the workshop —',
  'Just listed —',
  'New in the shop —',
  'Handmade and ready to ship —',
];

/* ---------------- 基础工具 ---------------- */

/** HTML 转义。凡是要用 innerHTML 拼字符串的地方，外部数据都必须先过这里。 */
function socEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 去掉 Etsy 详情里的 HTML 标签（详情允许写 HTML），并压掉多余空行。 */
function socStripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 取前 n 个字符，尽量不把单词切断。 */
function socClip(s, n) {
  const t = String(s == null ? '' : s).trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

/* X 的字符计数不是 length()：
 *   链接固定算 23 个字符（不管实际多长）；
 *   中日韩等宽字符与 emoji 各算 2。
 * 不按这套算，就会出现「页面显示没超、发出去被截」。 */
const SOC_WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];
function socIsWide(cp) {
  for (let i = 0; i < SOC_WIDE_RANGES.length; i++) {
    const r = SOC_WIDE_RANGES[i];
    if (cp >= r[0] && cp <= r[1]) return true;
  }
  return false;
}
function socCount(key, text) {
  const s = String(text == null ? '' : text);
  const plat = SOCIAL_PLATFORM_BY_KEY[key];
  if (!plat || !plat.weighted) return s.length;
  const noUrl = s.replace(/https?:\/\/\S+/g, '');
  let n = (s.length - noUrl.length) > 0 ? 23 : 0;   // 出现过的链接统一按 23 算
  for (const ch of noUrl) {
    n += socIsWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return n;
}

/** 按平台规则截断（X 走加权计数，其余按 length）。 */
function socTruncate(key, text) {
  const plat = SOCIAL_PLATFORM_BY_KEY[key];
  const limit = plat ? plat.limit : 1000;
  if (socCount(key, text) <= limit) return String(text == null ? '' : text);
  let out = '';
  for (const ch of String(text)) {
    if (socCount(key, out + ch + '…') > limit) break;
    out += ch;
  }
  return out.trim() + '…';
}

/** Etsy 的 13 个标签 → hashtag（去空格与符号，只留字母数字）。 */
function socHashtags(tags, extra) {
  const base = (Array.isArray(tags) ? tags : [])
    .map(t => String(t || '').replace(/[^0-9A-Za-z]/g, ''))
    .filter(t => t.length >= 3)
    .slice(0, 13)
    .map(t => '#' + t);
  const add = Array.isArray(extra) ? extra : [];
  const seen = {};
  return base.concat(add).filter(h => {
    const k = h.toLowerCase();
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}

/* ---------------- listing 校验 ---------------- */

/* 只有 active 的 listing 才有对外的公开页面。
 * draft / inactive / expired / sold_out 一律拦下 —— 发出去点开是 404 或下架页，
 * 等于把流量和信任一起烧掉。 */
const SOCIAL_OK_STATES = ['active'];
const SOCIAL_STATE_TEXT = {
  active: '在售',
  draft: '草稿（还没发布，发出去别人打不开）',
  inactive: '已下架（链接不参与搜索，也不接单）',
  expired: '已过期（需要先续期）',
  sold_out: '已售罄（可以发，但点进去买不到）',
};

function socValidateListing(listing) {
  if (!listing || !listing.listing_id) {
    return { ok: false, state: '', reason: '没有拿到商品信息，请重新选择商品。' };
  }
  const state = String(listing.state || '').toLowerCase();
  if (SOCIAL_OK_STATES.indexOf(state) >= 0) {
    return { ok: true, state, reason: '' };
  }
  if (state === 'sold_out') {
    return { ok: true, state, warn: '这个商品已售罄。发社媒能带来流量，但点进去买不到 —— 建议先补库存。' };
  }
  return {
    ok: false,
    state,
    reason: '这个商品当前状态是「' + (SOCIAL_STATE_TEXT[state] || state || '未知') + '」，'
      + '没有对外的公开页面。发出去的链接别人打不开，所以这里先拦住。'
      + '要发社媒请先把它发布上架（active）。',
  };
}

/* ---------------- 内容生成 ---------------- */

/** 给链接加 utm，方便在平台后台看流量来源。variant 用于同一商品重复发布时区分。 */
function socWithUtm(url, platformKey, variant) {
  const u = String(url || '').trim();
  if (!u) return '';
  const sep = u.indexOf('?') >= 0 ? '&' : '?';
  let out = u + sep + 'utm_source=' + encodeURIComponent(platformKey)
    + '&utm_medium=social&utm_campaign=listing';
  if (variant) out += '&v=' + Number(variant);
  return out;
}

/**
 * 由 listing 生成各平台内容。
 * @param {object} listing  Etsy listing（含 title/description/tags/price/currency_code/url/images）
 * @param {object} opts     { variant:0-3, utm:true, extraHashtags:['#Etsy'] }
 * @returns {object} { ok, reason, image, images, link, items:{平台: {title,text,blurb,count,limit,over,deepUrl}} }
 */
function socBuildContent(listing, opts) {
  opts = opts || {};
  const v = socValidateListing(listing);
  if (!v.ok) return { ok: false, reason: v.reason, warn: v.warn || '' };

  const variant = Number(opts.variant || 0) % SOCIAL_HOOKS.length;
  const hook = SOCIAL_HOOKS[variant];

  /* 标题同样要过一遍剥离：标题来自 AI 生成或表格导入，属于外部输入。
   * 正常标题里不会有标签，这行是兜底 —— 一旦混进来，它会原样进到 Pinterest 的标题字段。 */
  const title = socStripHtml(listing.title || '');
  const desc = socStripHtml(listing.description || '');
  /* 详情第一段当卖点，再兜底到标题 —— 社媒没人读长文 */
  const firstPara = (desc.split(/\n{2,}/).find(x => x.trim().length > 20) || desc || title).trim();
  const sell = socClip(firstPara, 220);
  const price = listing.price != null && listing.price !== ''
    ? (listing.currency_code === 'USD' ? '$' : (listing.currency_code ? listing.currency_code + ' ' : '')) + listing.price
    : '';

  const rawImages = Array.isArray(listing.images) ? listing.images.filter(Boolean) : [];
  const image = String(opts.image || rawImages[0] || '');
  const baseUrl = listing.url || ('https://www.etsy.com/listing/' + listing.listing_id);
  /* utm 默认开；关掉时用原始链接。variant 进 utm，方便区分同一商品发过几次。 */
  const link = opts.utm === false ? String(baseUrl) : socWithUtm(baseUrl, 'etsy', variant);
  const tags = socHashtags(listing.tags, opts.extraHashtags || ['#Etsy', '#Handmade']);

  const out = { ok: true, warn: v.warn || '', state: v.state, image, images: rawImages, link, items: {} };

  /* Pinterest：描述里不重复放链接（链接是独立字段），关键词要密，hashtag 有用 */
  const pinDesc = hook + ' ' + sell + (price ? '\n\nPrice: ' + price : '')
    + '\n\n' + tags.slice(0, 10).join(' ');
  out.items.pinterest = {
    title: socClip(title, 100),
    text: socTruncate('pinterest', pinDesc),
    blurb: socTruncate('pinterest', pinDesc),
    image,
  };

  /* Facebook：叙述式，链接单独作为分享对象，文字里不再重复 */
  const fbText = hook + ' ' + sell + (price ? '\n\n' + price : '');
  out.items.facebook = {
    text: socTruncate('facebook', fbText + '\n\n' + link),
    blurb: socTruncate('facebook', fbText),
  };

  /* X：短、钩子开头；链接由 url 参数单独带，所以 blurb 里要留出 23 字符额度 */
  const xBlurb = socTruncate('x', hook + ' ' + socClip(sell, 150) + ' ' + tags.slice(0, 3).join(' '));
  out.items.x = {
    text: xBlurb,
    blurb: xBlurb,
    /* 复制粘贴时要把链接带上，所以 copy 版本单独给 */
    copy: xBlurb + ' ' + link,
  };

  /* Instagram：不吃链接（放 bio），hashtag 要堆够，通常单独放第一条评论 */
  const igTags = tags.slice(0, 25);
  out.items.instagram = {
    text: socTruncate('instagram',
      hook + ' ' + sell + (price ? '\n\n' + price : '') + '\n\n' + igTags.join(' ')),
    hashtags: igTags.join(' '),
  };

  /* 微博：顺带支持中文平台，链接与图片都能预填 */
  out.items.weibo = {
    text: socTruncate('weibo', hook + ' ' + sell + (price ? ' ' + price : '') + ' ' + link),
    blurb: socTruncate('weibo', hook + ' ' + sell + (price ? ' ' + price : '')),
    image,
  };

  for (const k of Object.keys(out.items)) {
    const it = out.items[k];
    const copyText = it.copy || it.text || '';
    it.count = socCount(k, copyText);
    it.limit = SOCIAL_PLATFORM_BY_KEY[k] ? SOCIAL_PLATFORM_BY_KEY[k].limit : 0;
    it.over = it.count > it.limit;
  }
  return out;
}

/* ---------------- 深链构造 ---------------- */

/**
 * 构造各平台官方发布页地址（未登录会先跳登录，登录后回到发布页且内容已预填）。
 * 全部参数都过 encodeURIComponent —— 文案里出现 & # ? 是常态（价格、标签、标题）。
 * @returns {string|null} Instagram 返回 null（它没有网页端发布入口）
 */
function socDeepLink(key, item, ctx) {
  ctx = ctx || {};
  const e = encodeURIComponent;
  const link = ctx.link || '';
  const image = ctx.image || (item && item.image) || '';
  const title = (item && item.title) || '';
  const blurb = (item && (item.blurb || item.text)) || '';

  if (key === 'pinterest') {
    /* 无预选 board 参数（官方不支持），所以页面上要提示用户选哪个 board */
    return 'https://www.pinterest.com/pin/create/button/'
      + '?url=' + e(link) + '&media=' + e(image) + '&description=' + e(blurb);
  }
  if (key === 'facebook') {
    return 'https://www.facebook.com/sharer/sharer.php'
      + '?u=' + e(link) + '&quote=' + e(blurb);
  }
  if (key === 'x') {
    /* 链接放 url 参数：X 的卡片会单独渲染，且不再占用正文额度 */
    return 'https://x.com/intent/tweet?text=' + e(blurb) + '&url=' + e(link);
  }
  if (key === 'weibo') {
    return 'https://service.weibo.com/share/share.php'
      + '?url=' + e(link) + '&title=' + e(blurb) + '&pic=' + e(image);
  }
  return null;   /* instagram 等：没有可预填的发布页 */
}

/** 平台发布页打不开时的兜底提示（深链是平台给的地址，理论上不会坏，但要有退路）。 */
const SOCIAL_FALLBACK_NOTE = '打不开？先把文案复制走，去对应 App / 网站里手动发，效果一样。';
