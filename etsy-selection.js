/* 选品数字员工（Stage1~7 轻量编排）
 *
 * 数据从哪来（全部来自工具，不脑补）：
 *   - 关键词池：everbee.keyword()（复用 etsy-everbee.js 的 get_keyword 封装）
 *   - 商品海选：everbee.callTool('find_bestsellers', {...}) —— 实测一次带回
 *     listing/店铺/趋势/转化全套字段（2026-10-21 用 ceramic mug 实测过），
 *     所以 Stage3/4 不再逐个调 get_listing/get_shop，调用数从 100+ 压到 ~6。
 *   - 利润：本地算（Etsy 费率公开固定），不依赖任何 profit MCP。
 *   - IP 风险：规则扫描（品牌/角色词硬淘汰），最终人工复核。
 *   - 差异化建议与评语：AI（etsyAiGenerate，失败不阻塞报告）。
 *
 * ⚠️ EverBee 全部是预估数据，报告强制标注【预估数据，需要人工二次复核】。
 *
 * 报告落 data/selection-reports.json（data/ 已 gitignore，两台各记各的，同 social-posts）。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/* ---------- skill 默认阈值（用户可覆盖；relax=true 时换宽松档） ---------- */
export const DEFAULT_THRESHOLDS = {
  price_min: 12, price_max: 35,
  min_monthly_sales: 20, max_monthly_sales: 300,
  max_reviews: 80,
  listing_age_max_months: 6,
  search_volume_min: 100, search_volume_max: 8000,
  min_keywords: 8,            // Stage1 蓝海词下限（skill：>=8 进入 Stage2）
  keywords_to_search: 5,      // Stage2 实际海选的关键词数
  results_per_keyword: 20,    // 每词海选条数（find_bestsellers max_results）
  min_candidates: 5,          // Stage2 候选下限（skill：>=5 进入 Stage3）
  max_candidates: 12,         // 进入评分的上限，控制报告可读性
  deep_tags: 4,               // 拉标签深挖的候选数（每个 1 次调用）
  cost_rate: 0.30,            // 成本占售价比例（POD 经验值，报告里可改）
  offsite_ads: false,         // 是否计站外广告费 12%
};
export const RELAXED_THRESHOLDS = {
  price_min: 8, price_max: 60,
  min_monthly_sales: 10, max_monthly_sales: 1000,
  max_reviews: 500,
  listing_age_max_months: 12,
  search_volume_min: 50, search_volume_max: 20000,
  min_keywords: 3,
};

/* ---------- 阈值的人话说法 ----------
 * 页面与报告要能写出「当前 ceramic cup 搜不到，已把搜索量下限 100 放宽到 50」，
 * 而不是甩一句「候选不足」。只报**真正变了**的那几项，别把所有阈值都念一遍。 */
export const THRESHOLD_LABELS = {
  price_min: '价格下限', price_max: '价格上限',
  min_monthly_sales: '月销下限', max_monthly_sales: '月销上限',
  max_reviews: '评价上限', listing_age_max_months: '上架月数上限',
  search_volume_min: '搜索量下限', search_volume_max: '搜索量上限',
  min_keywords: '蓝海词下限',
};

export function diffThresholds(from, to) {
  const out = [];
  for (const k of Object.keys(THRESHOLD_LABELS)) {
    const a = from ? from[k] : null, b = to ? to[k] : null;
    if (a == null || b == null || a === b) continue;
    out.push({ key: k, label: THRESHOLD_LABELS[k], from: a, to: b });
  }
  return out;
}

/* 把成对的上下限合并成区间说法：「价格区间 $12-35 → $8-60」 */
export function describeThresholdDiff(diffs) {
  const list = Array.isArray(diffs) ? diffs : [];
  const used = new Set();
  const parts = [];
  const get = (k) => list.find((d) => d.key === k);
  const pair = (k1, k2, label, unit) => {
    const a = get(k1), b = get(k2);
    if (!a || !b) return;
    parts.push(label + ' ' + unit + a.from + '-' + b.from + ' → ' + unit + a.to + '-' + b.to);
    used.add(k1); used.add(k2);
  };
  pair('price_min', 'price_max', '价格区间', '$');
  pair('min_monthly_sales', 'max_monthly_sales', '月销量区间', '');
  for (const d of list) if (!used.has(d.key)) parts.push(d.label + ' ' + d.from + ' → ' + d.to);
  return parts.join('、');
}

/* ---------- 中文关键词 → 英文搜索词 ----------
 * 为什么不直接用中文搜 EverBee：Etsy 的搜索量数据是按英文查询词统计的，
 * 中文词在 EverBee 里根本不存在。所以中文框只当「翻译入口」，
 * 真正拿去搜的永远是英文框里的词（翻译结果会回填到英文框，用户可以改）。 */
export function hasCJK(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text == null ? '' : text));
}

/* 把 AI 吐出来的东西洗成一个干净的英文搜索词；洗不干净就返回 ''（宁可报错也别乱搜） */
export function sanitizeEnSeed(text) {
  let s = String(text == null ? '' : text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  s = s
    .replace(/^[\s`"'*•\-–—]+/, '')
    .replace(/[\s`"'*。，,；;：:]+$/, '')
    .replace(/^\d+[.、)\]]\s*/, '')
    .replace(/^(english|en|translation|translate|keyword|search(\s+term)?|英文|翻译|关键词)\s*[:：]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.includes(':') || s.includes('：')) s = s.split(/[:：]/).pop().trim(); // 去掉「英文：xxx」这类前缀
  if (hasCJK(s)) return '';                    // 还带中文 = 翻译失败
  if (!/[a-z]/i.test(s)) return '';
  const words = s.split(' ').filter(Boolean);
  s = words.slice(0, 6).join(' ');
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s.toLowerCase();
}

/* ai(system, user) => Promise<string> */
export async function translateSeed(ai, text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new Error('要翻译的内容为空');
  if (!hasCJK(raw)) return { zh: '', en: raw, translated: false };
  if (typeof ai !== 'function') throw new Error('未配置 AI，无法把中文翻成英文（可直接在英文框填英文词）');
  const sys = '你是 Etsy 选品关键词翻译器。把用户给的中文商品词翻译成「Etsy 买家真的会搜」的英文关键词短语。'
    + '要求：1) 只输出英文关键词本身，1~3 个单词的名词短语；2) 全小写，不加冠词 the/a，不要标点、不要引号、不要编号；'
    + '3) 不要解释、不要中文、不要换行多条；4) 用 Etsy 上的通用叫法'
    + '（例：陶瓷马克杯→ceramic mug；宠物纪念牌→pet memorial plaque；毛绒兽装头套→fursuit head）。';
  const out = await ai(sys, '中文：' + raw + '\n只输出英文关键词：');
  const en = sanitizeEnSeed(out);
  if (!en) {
    throw new Error('AI 没给出可用的英文关键词（原始输出：' + String(out || '').slice(0, 80) + '）');
  }
  return { zh: raw, en, translated: true, raw: String(out || '').trim().slice(0, 120) };
}

/* ---------- 词根扩词 ----------
 * 什么时候扩：蓝海词池不够、或海选候选不够，且已经放宽过阈值仍然不够。
 * 先让 AI 给「Etsy 买家真会搜」的同义/上位词；AI 不可用或给出的词不能用时，
 * 退回规则扩词（去修饰词、取中心词），保证离线也能跑。 */
export function parseSeedList(text, exclude = []) {
  const bad = new Set((exclude || []).map((x) => String(x || '').toLowerCase().trim()));
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    for (const piece of line.split(/[,，、;；|]+/)) {
      const s = sanitizeEnSeed(piece.replace(/^[\s\-*•\d.)、]+/, ''));
      if (!s || bad.has(s)) continue;
      if (s.split(' ').length > 4) continue;          // 太长的是标题，不是词根
      if (out.includes(s)) continue;
      out.push(s);
    }
  }
  return out;
}

export function ruleExpandSeeds(seed) {
  const s = String(seed == null ? '' : seed).toLowerCase().trim();
  if (!s) return [];
  const words = s.split(/\s+/).filter(Boolean);
  const out = [];
  const push = (x) => {
    const v = String(x || '').trim();
    if (!v || v === s || out.includes(v)) return;
    if (ipScan(v).hits.length) return;             // 带品牌/角色词的一律不要
    out.push(v);
  };
  if (words.length >= 2) {
    push(words.slice(1).join(' '));                // 去掉最前面的修饰词
    push(words.slice(-1).join(' '));               // 只留中心词（最宽）
  } else {
    push('handmade ' + s);                         // 单词词根往上找：手工/定制/个性化
    push('custom ' + s);
    push('personalized ' + s);
  }
  return out.slice(0, 3);
}

export async function expandSeeds(ai, seed, opts = {}) {
  const s = String(seed == null ? '' : seed).trim();
  const exclude = [s].concat(opts.exclude || []);
  const max = Math.max(1, Number(opts.max) || 4);
  let aiError = null;
  if (typeof ai === 'function') {
    const sys = '你是 Etsy 选品助手。用户在 Etsy 上按某个英文词根找不到足够数据，需要你给替代词根。'
      + '要求：1) 给 4 个 Etsy 买家真的会搜的英文名词短语（1~3 个词），可以是同义词、上位词、常见叫法；'
      + '2) 全小写，不带标点、不带编号、不带解释；3) 不含任何品牌、动漫角色、明星名（避免侵权）；4) 每行一个。';
    const usr = '词根：' + s + '\n（该词在 EverBee 数据里太少，需要扩词）';
    try {
      const out = await ai(sys, usr);
      const list = parseSeedList(out, exclude).slice(0, max);
      if (list.length) return { source: 'ai', seeds: list, aiError: null };
      aiError = 'AI 没给出可用词根（原始输出：' + String(out || '').slice(0, 60) + '）';
    } catch (e) {
      aiError = String((e && e.message) || e);
    }
  }
  const list = ruleExpandSeeds(s).filter((x) => !exclude.map((y) => String(y).toLowerCase()).includes(x)).slice(0, max);
  return { source: 'rule', seeds: list, aiError };
}

/* ---------- 解析工具（EverBee 返回的是 "$74.50" / "29% ↓" / "7 Mo." 这类字符串） ---------- */
export function parseMoney(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}
export function parseInt_(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9-]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}
/* "29% ↓" → {pct:29, dir:'down'}；"0%" → {pct:0, dir:'flat'}；"12%" → {pct:12, dir:'up'} */
export function parseGrowth(v) {
  const s = String(v == null ? '' : v);
  const pct = parseInt_(s);
  const dir = /↓|down/i.test(s) ? 'down' : (/↑|up/i.test(s) ? 'up' : (pct && pct > 0 ? 'up' : 'flat'));
  return { pct: pct == null ? 0 : pct, dir };
}
/* "7 Mo." → 7 */
export function parseMonths(v) {
  const n = parseInt_(v);
  return n == null ? null : n;
}

/* ---------- IP 规则扫描（品牌/角色词硬淘汰；判断权最终在人） ---------- */
export const IP_TERMS = [
  'disney', 'pixar', 'marvel', 'dc comics', 'pokemon', 'pikachu', 'hello kitty',
  'sanrio', 'kuromi', 'cinnamoroll', 'stitch', 'bluey', 'squid game', 'stranger things',
  'nintendo', 'super mario', 'zelda', 'star wars', 'baby yoda', 'mandalorian',
  'harry potter', 'barbie', 'peppa pig', 'paw patrol', 'taylor swift', 'bridgerton',
  'spiderman', 'spider-man', 'batman', 'superman', 'mickey', 'minnie', 'winnie the pooh',
  'stitch', 'grinch', 'labubu', 'pop mart', 'chiikawa',
];
export function ipScan(texts) {
  const s = (Array.isArray(texts) ? texts.join(' ') : String(texts || '')).toLowerCase();
  const hits = IP_TERMS.filter((t) => s.includes(t));
  return { risk: hits.length > 0 ? 'high' : 'low', hits };
}

/* ---------- 本地利润测算（Etsy 费率公开固定，2026-10 核对） ----------
 * 上架费 $0.20/件 + 交易佣金 6.5% + 收款处理 3% + $0.25（美国站）
 * （+ 站外广告 12%，可选）。返回 {fees, net, margin}，全是美元。 */
export function calcProfit(price, opts = {}) {
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return null;
  const costRate = Number(opts.cost_rate ?? 0.30);
  const cost = +(p * costRate).toFixed(2);
  const listing = 0.20, txn = p * 0.065, pay = p * 0.03 + 0.25;
  const ads = opts.offsite_ads ? p * 0.12 : 0;
  const fees = +(listing + txn + pay + ads).toFixed(2);
  const net = +(p - cost - fees).toFixed(2);
  const margin = p > 0 ? +(net / p * 100).toFixed(1) : 0;
  return { price: p, cost, fees, net, margin, costRate, offsiteAds: Boolean(opts.offsite_ads) };
}

/* ---------- Stage1：蓝海词池 ---------- */
export function filterKeywordPool(keywordResult, th) {
  const list = Array.isArray(keywordResult && keywordResult.suggestions)
    ? keywordResult.suggestions.filter(Boolean) : [];
  const seedExact = keywordResult && keywordResult.exact ? [keywordResult.exact] : [];
  const all = seedExact.concat(list)
    .filter((k) => k.vol != null && k.vol >= th.search_volume_min && k.vol <= th.search_volume_max);
  // 去重（大小写归一），按 score 降序（score 缺失的排后面）
  const seen = new Set();
  const uniq = [];
  for (const k of all.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = String(k.keyword || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(k);
  }
  return uniq;
}

/* ---------- Stage2/3：商品海选过滤 + 字段归一 ----------
 * row = find_bestsellers 的一行（字段名带空格，如 "Shop Name"）。 */
export function normalizeBestseller(row, kw) {
  if (!row || typeof row !== 'object') return null;
  const growth = parseGrowth(row['Growth Rate']);
  const trends = Array.isArray(row.Trends) ? row.Trends.map(Number).filter((n) => isFinite(n)) : [];
  // 自算趋势方向：末 3 点均值 vs 首 3 点均值（不依赖 EverBee 的口径）
  let trendDir = 'flat';
  if (trends.length >= 6) {
    const head = trends.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const tail = trends.slice(-3).reduce((a, b) => a + b, 0) / 3;
    trendDir = tail > head * 1.05 ? 'up' : (tail < head * 0.95 ? 'down' : 'flat');
  }
  return {
    listing_id: row.listing_id,
    keyword: kw,
    title: String(row['Product'] || ''),
    shop: String(row['Shop Name'] || ''),
    price: parseMoney(row['Price']),
    est_sales: parseInt_(row['Sales']),           // EverBee 预估口径，非后台真实值
    est_revenue: parseMoney(row['Revenue']),
    growth_pct: growth.pct, growth_dir: growth.dir,
    total_sales: parseInt_(row['Total Sales']),
    total_reviews: parseInt_(row['Total Reviews']),
    listing_age_months: parseMonths(row['Listing Age']),
    favorites: parseInt_(row['Total Favorites']),
    views: parseInt_(row['Total Views']),
    category: String(row['Category'] || ''),
    shop_age_months: parseMonths(row['Shop Age']),
    visibility: parseInt_(row['Visibility Score']),
    cvr: (() => { const v = parseMoney(row['Conversion Rate']); return v == null ? null : v; })(),
    total_shop_sales: parseInt_(row['Total Shop Sales']),
    listing_type: String(row['Listing Type'] || ''),
    trends,
    trend_dir: trendDir,
  };
}

export function filterListings(cands, th) {
  return cands.filter((c) => {
    if (c.price == null || c.price < th.price_min || c.price > th.price_max) return false;
    if (c.est_sales == null || c.est_sales < th.min_monthly_sales || c.est_sales > th.max_monthly_sales) return false;
    if (c.total_reviews != null && c.total_reviews > th.max_reviews) return false;
    if (c.listing_age_months != null && c.listing_age_months > th.listing_age_max_months) return false;
    if (c.growth_dir === 'down' || (c.growth_pct || 0) < 0) return false; // skill：排除下滑款
    return true;
  });
}

/* 未过阈值的原因（用于淘汰清单，让报告能解释「为什么没看到某款」） */
export function rejectReason(c, th) {
  if (c.price != null && (c.price < th.price_min || c.price > th.price_max)) {
    return '价格 ' + money(c.price) + ' 超出 ' + th.price_min + '-' + th.price_max + ' 区间';
  }
  if (c.est_sales != null && (c.est_sales < th.min_monthly_sales || c.est_sales > th.max_monthly_sales)) {
    return '预估销量 ' + c.est_sales + ' 超出 ' + th.min_monthly_sales + '-' + th.max_monthly_sales;
  }
  if (c.total_reviews != null && c.total_reviews > th.max_reviews) {
    return '累计评价 ' + c.total_reviews + ' 超上限 ' + th.max_reviews;
  }
  if (c.listing_age_months != null && c.listing_age_months > th.listing_age_max_months) {
    return '上架 ' + c.listing_age_months + ' 个月超上限 ' + th.listing_age_max_months;
  }
  if (c.growth_dir === 'down' || (c.growth_pct || 0) < 0) return '销量下滑，按规则排除';
  return '未通过阈值筛选';
}

/* ---------- Stage4：店铺交叉核验 ----------
 * 同关键词候选里出现 >=3 个不同店铺稳定出单 → 需求可信（skill 硬规则）。
 * 孤爆：本 listing 销量占全店 70%+ → 单款撑店，风险高。 */
export function shopCrossCheck(cands) {
  const byKw = {};
  for (const c of cands) (byKw[c.keyword] = byKw[c.keyword] || new Set()).add(String(c.shop).toLowerCase());
  return cands.map((c) => {
    const shopCount = byKw[c.keyword] ? byKw[c.keyword].size : 0;
    const share = (c.total_sales != null && c.total_shop_sales != null && c.total_shop_sales > 0)
      ? c.total_sales / c.total_shop_sales : null;
    const soloBoom = share != null && share >= 0.7;
    return Object.assign({}, c, {
      kw_shop_count: shopCount,
      demand_credible: shopCount >= 3,
      solo_boom: soloBoom,
      shop_share: share == null ? null : +(share * 100).toFixed(0),
    });
  });
}

/* ---------- Stage6：S/A/B/C 评级 ---------- */
export function gradeCandidates(cands) {
  return cands.map((c) => {
    let s = 0; const pros = []; const cons = [];
    if (c.growth_dir === 'up' || c.growth_pct > 0) { s += 15; pros.push('销量正增长'); }
    else pros.push('销量持平（无下滑）');
    if (c.trend_dir === 'up') { s += 10; pros.push('近 30 点趋势向上'); }
    if (c.trend_dir === 'down') { s -= 10; cons.push('趋势向下'); }
    if (c.cvr != null) {
      if (c.cvr >= 2) { s += 15; pros.push('转化率 ' + c.cvr + '%（高于 2%）'); }
      else if (c.cvr >= 1) { s += 8; pros.push('转化率 ' + c.cvr + '%'); }
      else cons.push('转化率偏低 ' + c.cvr + '%');
    }
    if ((c.visibility || 0) >= 80) { s += 10; pros.push('曝光得分 ' + c.visibility); }
    if (c.profit && c.profit.margin >= 25) { s += 15; pros.push('毛利率 ' + c.profit.margin + '%'); }
    else if (c.profit && c.profit.margin >= 15) { s += 8; pros.push('毛利率 ' + c.profit.margin + '%'); }
    else if (c.profit) cons.push('毛利率仅 ' + c.profit.margin + '%');
    if (c.demand_credible) { s += 10; pros.push('同词 ' + c.kw_shop_count + ' 店出单，需求可信'); }
    else cons.push('同词仅 ' + c.kw_shop_count + ' 店出单');
    if (c.solo_boom) { s -= 20; cons.push('疑似孤爆（占全店销量 ' + c.shop_share + '%）'); }
    if (c.shop_age_months != null && c.shop_age_months < 6) { s -= 5; cons.push('店铺很新（' + c.shop_age_months + ' 个月），数据不稳'); }
    s = Math.max(0, Math.min(100, s));
    const grade = s >= 75 ? 'S' : (s >= 60 ? 'A' : (s >= 45 ? 'B' : 'C'));
    return Object.assign({}, c, { score: s, grade, pros, cons });
  });
}

/* ---------- Stage7：Markdown 报告（固定六段结构） ---------- */
const money = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));
const int_ = (v) => (v == null ? '—' : String(v));

export function buildReport(ctx) {
  const { seed, th, relaxed, keywordPool, eliminated, candidates, aiAdvice, aiError, jobNote, adjust, seedsSearched } = ctx;
  const L = [];
  L.push('# 选品报告 · ' + seed);
  L.push('');
  L.push('> ⚠️ **【预估数据，需要人工二次复核】** EverBee 全部为预估值，非 Etsy 后台真实数据。');
  L.push('> 生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false })
    + '　阈值档位：' + (relaxed ? '宽松' : '默认')
    + '（价格 ' + th.price_min + '-' + th.price_max + ' / 月销 ' + th.min_monthly_sales + '-' + th.max_monthly_sales
    + ' / 评价≤' + th.max_reviews + ' / 上架≤' + th.listing_age_max_months + ' 个月 / 搜索量 ' + th.search_volume_min + '-' + th.search_volume_max + '）');
  if (jobNote) L.push('> 备注：' + jobNote);
  L.push('');

  // 1. 任务摘要
  L.push('## 1. 任务摘要');
  L.push('');
  /* 词池展示：词根排第一（EverBee 扩展词里混着 "ceram mug" 这类截断变体，
     直接按 score 排会以截断词打头，看着像搜错了）。 */
  const kwShow = keywordPool.slice();
  const seedIdx = kwShow.findIndex((k) => String(k.keyword).toLowerCase() === String(seed).toLowerCase());
  if (seedIdx > 0) kwShow.unshift(kwShow.splice(seedIdx, 1)[0]);
  L.push('- 词根：`' + seed + '`；蓝海词池 ' + keywordPool.length + ' 个'
    + '（' + kwShow.slice(0, 8).map((k) => '`' + k.keyword + '`').join('、')
    + (keywordPool.length > 8 ? ' 等' : '') + '；EverBee 自动扩展，含部分截断变体）');
  if (Array.isArray(seedsSearched) && seedsSearched.length > 1) {
    L.push('- 实际搜索词根 ' + seedsSearched.length + ' 个：' + seedsSearched.map((x) => '`' + x + '`').join('、')
      + '（原词根数据不足，已扩词）');
  }
  L.push('- 海选关键词 ' + Math.min(th.keywords_to_search, kwShow.length) + ' 个，原始候选 ' + ctx.rawCount + ' 条，'
    + '通过阈值筛选 ' + ctx.filteredCount + ' 条，IP/风险淘汰 ' + eliminated.length + ' 条，最终评级 ' + candidates.length + ' 条。');
  /* 自动调整（放宽阈值 / 词根扩词）必须写进报告：
     否则用户只看到「候选 3 条」，根本不知道系统替他改了什么条件。 */
  if (Array.isArray(adjust) && adjust.length) {
    const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮';
    L.push('- **自动调整记录**（共 ' + adjust.length + ' 步，改的是搜索条件，不是数据）：');
    adjust.forEach((a, i) => L.push('- ' + (CIRCLED[i] || (i + 1) + '.') + ' ' + a.text));
  } else {
    L.push('- 自动调整记录：无（默认阈值一次命中，未放宽、未扩词）。');
  }
  const grades = { S: 0, A: 0, B: 0, C: 0 };
  candidates.forEach((c) => { grades[c.grade] = (grades[c.grade] || 0) + 1; });
  L.push('- 评级分布：S=' + grades.S + ' / A=' + grades.A + ' / B=' + grades.B + ' / C=' + grades.C
    + (grades.S + grades.A > 0 ? '。**S/A 优先测款**，C 仅观察。'
      : (relaxed ? '。暂无 S/A —— 阈值已经放宽过了，建议换一个更宽的上位词根，或手动调低月销下限/评价上限。'
        : '。暂无 S/A，建议换词根或放宽阈值后再跑。')));
  L.push('');

  // 2. 候选清单
  L.push('## 2. S/A/B/C 候选清单');
  L.push('');
  if (!candidates.length) {
    L.push('（无候选 —— 全部被阈值或风险规则筛掉，见下方淘汰清单）');
    L.push('');
  } else {
    L.push('| 级 | 商品 | 店铺 | 词 | 价格 | 预估销量 | 增长 | 转化 | 毛利 | 评分 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of candidates) {
      L.push('| **' + c.grade + '** | ' + c.title.slice(0, 40).replace(/\|/g, '/') + ' (#' + c.listing_id + ')'
        + ' | ' + c.shop.replace(/\|/g, '/')
        + ' | ' + String(c.keyword).replace(/\|/g, '/')
        + ' | ' + money(c.price)
        + ' | ' + int_(c.est_sales)
        + ' | ' + c.growth_pct + '% ' + (c.growth_dir === 'down' ? '↓' : (c.growth_dir === 'up' ? '↑' : '→'))
        + ' | ' + (c.cvr == null ? '—' : c.cvr + '%')
        + ' | ' + (c.profit ? c.profit.margin + '%（净利 ' + money(c.profit.net) + '）' : '—')
        + ' | ' + c.score + ' |');
    }
    L.push('');
    for (const c of candidates.filter((x) => x.grade === 'S' || x.grade === 'A')) {
      L.push('**' + c.grade + ' · #' + c.listing_id + ' ' + c.title.slice(0, 50) + '**');
      L.push('');
      L.push('- 亮点：' + (c.pros.join('；') || '—'));
      if (c.cons.length) L.push('- 风险：' + c.cons.join('；'));
      if (c.tags && c.tags.length) L.push('- 该款标签：' + c.tags.join('、'));
      L.push('');
    }
  }

  // 3. 淘汰清单
  L.push('## 3. 淘汰清单与原因');
  L.push('');
  if (!eliminated.length) L.push('（无）');
  for (const e of eliminated) {
    L.push('- #' + (e.listing_id || '?') + ' ' + String(e.title || '').slice(0, 50).replace(/\|/g, '/')
      + ' —— ' + e.reason);
  }
  L.push('');

  // 4. 风险标签
  L.push('## 4. 风险标签');
  L.push('');
  L.push('- IP 版权：规则扫描（品牌/角色词库 ' + IP_TERMS.length + ' 词）已执行；**未做商标库正式检索**，上架前必须人工复核。');
  L.push('- 孤爆：' + (candidates.filter((c) => c.solo_boom).length
    ? candidates.filter((c) => c.solo_boom).map((c) => '#' + c.listing_id).join('、') + ' 疑似单款撑店'
    : '候选中未发现'));
  L.push('- 需求可信度：' + (candidates.some((c) => c.demand_credible) ? '部分关键词 ≥3 店稳定出单' : '候选关键词均 <3 店出单，需求待验证'));
  L.push('- 利润模型：成本按售价 ' + Math.round(th.cost_rate * 100) + '% 估算' + (th.offsite_ads ? '（含站外广告 12%）' : '（未计站外广告）')
    + '，实际以供应链报价为准。');
  L.push('');

  // 5. 差异化建议
  L.push('## 5. 差异化建议（AI）');
  L.push('');
  if (aiError) {
    L.push('（AI 分析失败，不影响上面数据部分。原因：' + aiError + '）');
  } else if (aiAdvice) {
    L.push(aiAdvice);
    L.push('');
    L.push('> AI 只看到标题、标签、价格与预估数据，**没有看原款图片**；'
      + '「原款是什么样」的判断可能不准，执行前先打开 listing 核对。');
  } else {
    L.push('（无）');
  }
  L.push('');

  // 6. 人工复核清单
  L.push('## 6. 人工复核清单');
  L.push('');
  L.push('- [ ] 版权：把每个候选的标题/图片在 USPTO / Google Images 反查一遍（尤其 IP 词库未覆盖的新 IP）');
  L.push('- [ ] 供应链：向供应商确认实际成本、起订量、发货时效');
  L.push('- [ ] Google Trends：逐词打开 trends.google.com 看近 12 个月季节性（本报告未接 Trends 数据源）');
  L.push('- [ ] 毛利：用真实成本替换 ' + Math.round(th.cost_rate * 100) + '% 估算重算净利');
  L.push('- [ ] EverBee 数据本身：挑 2-3 个候选在 EverBee 网页版人工核对销量曲线');
  L.push('');
  return L.join('\n');
}

/* ---------- 编排器 ---------- */
export function createSelectionAgent(opts = {}) {
  const {
    everbee,                 // etsy-everbee 的 client 实例（需要 .keyword() / .callTool()）
    ai = null,               // async (system, user) => string；失败不阻塞
    log = () => {},
    storeFile = null,        // 报告落盘路径；null = 不落盘（测试用）
    maxReports = 200,
  } = opts;

  function readReports() {
    try {
      const arr = JSON.parse(readFileSync(storeFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function writeReports(arr) {
    mkdirSync(dirname(storeFile), { recursive: true });
    const tmp = storeFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(arr.slice(-maxReports), null, 2), 'utf8');
    renameSync(tmp, storeFile);
  }

  function reportsList() {
    return readReports().map((r) => ({
      id: r.id, seed: r.seed, createdAt: r.createdAt, relaxed: r.relaxed,
      summary: r.summary || {},
    })).reverse(); // 新的在前
  }
  function reportGet(id) {
    return readReports().find((r) => r.id === id) || null;
  }
  function reportDelete(id) {
    const arr = readReports();
    const i = arr.findIndex((r) => r.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    writeReports(arr);
    return true;
  }

  /* find_bestsellers 带重试（SSL 偶发断连 + 空壳响应，同 keyword 的处理） */
  async function bestsellers(query, th) {
    const args = { query, max_results: th.results_per_keyword };
    if (th.price_min != null) args.price_min = th.price_min;
    if (th.price_max != null) args.price_max = th.price_max;
    const once = async () => {
      const data = await everbee.callTool('find_bestsellers', args);
      const shaped = Boolean(data && (Array.isArray(data.rows) || Array.isArray(data.results)));
      if (!shaped) {
        // 同上：结构不对就是取数失败，别当成「这个词没有商品」
        const e = new Error('find_bestsellers 返回结构异常（无 rows/results）：'
          + (() => { try { return JSON.stringify(data).slice(0, 200); } catch { return '(无法序列化)'; } })());
        e.code = 'everbee_bad_payload';
        throw e;
      }
      return Array.isArray(data.rows) ? data.rows : data.results;
    };
    const retryable = (e) => Boolean(e && (e.code === 'everbee_bad_payload' || e.code === 'everbee_empty_payload'));
    try {
      let rows = await once();
      if (!rows.length) { await new Promise((r) => setTimeout(r, 600)); rows = await once(); }
      return rows;
    } catch (e) {
      if (!retryable(e)) throw e;
      log('find_bestsellers「' + query + '」返回异常，重试一次：' + (e && e.message));
      await new Promise((r) => setTimeout(r, 900));
      return await once();
    }
  }

  /* 完整 7 阶段。onProgress(stage, pct, message, extra) 汇报进度；
   * extra.adjust = 到目前为止的自动调整记录（页面实时显示，报告里也会写）。
   * 返回 {status:'done'|'need_keywords'|'need_relax'|'error', ...} */
  async function run(seed, overrides = {}, onProgress = () => {}) {
    const s = String(seed || '').trim();
    if (!s) return { status: 'error', message: '词根为空' };

    /* auto=true（默认）：蓝海词/候选不足时自动放宽阈值，再不够自动扩词。
       想完全手工控制（老行为）就在页面高级设置里关掉 —— 关掉后就是
       「不足 → 返回 need_keywords/need_relax 等你点按钮」。 */
    const auto = overrides.auto !== false;
    const expandMax = Math.max(0, Number(overrides.expand_max != null ? overrides.expand_max : 2));
    const baseOverrides = Object.assign({}, overrides);
    delete baseOverrides.auto; delete baseOverrides.expand_max; delete baseOverrides.relaxed;

    const buildTh = (relax) => Object.assign({}, DEFAULT_THRESHOLDS, relax ? RELAXED_THRESHOLDS : {}, baseOverrides);

    let relaxed = Boolean(overrides.relaxed);
    let th = buildTh(relaxed);

    const adjust = [];             // {type:'relax'|'expand'|'note', text}
    const seedsSearched = [];
    const kwCache = new Map();     // term -> everbee.keyword() 结果（同词不重复查）
    const raw = [];                // 所有 attempt 的候选（按 listing_id 去重）
    const seenIds = new Set();
    const poolAll = [];
    const emit = (stage, pct, message) => onProgress(stage, pct, message, { adjust });

    function mergePool(list) {
      for (const k of list) {
        const key = String(k.keyword || '').toLowerCase();
        if (!key) continue;
        if (poolAll.some((x) => String(x.keyword).toLowerCase() === key)) continue;
        poolAll.push(k);
      }
    }
    function mergeRows(rows) {
      let added = 0;
      for (const r of rows) {
        if (!r || !r.listing_id || seenIds.has(r.listing_id)) continue;
        seenIds.add(r.listing_id); raw.push(r); added++;
      }
      return added;
    }

    /* ★ 词根自身必须搜一次：
         ① EverBee 的相关词里常有截断词（实测 "ceram mug"、"ceramic mugful"），拿它们海选等于搜空气；
         ② 词根本身搜索量常常超过 search_volume_max（Stage1 会把它过滤掉），
            但它是需求最集中的查询，不能因为"太热"就不看。 */
    function pickSearchKeywords(pool, term, thNow) {
      const topKw = pool.slice(0, thNow.keywords_to_search).map((k) => String(k.keyword));
      if (!topKw.some((k) => k.toLowerCase() === String(term).toLowerCase())) {
        if (topKw.length >= thNow.keywords_to_search) topKw.pop();
        topKw.unshift(term);
      }
      return topKw;
    }

    async function fetchRows(kws, thNow, term, pctFrom) {
      const out = [];
      const seen = new Set();
      for (let i = 0; i < kws.length; i++) {
        const kw = kws[i];
        const rows = await bestsellers(kw, thNow);
        log('Stage2 「' + kw + '」 返回 ' + rows.length + ' 行');
        for (const row of rows) {
          const n = normalizeBestseller(row, kw);
          if (n && n.listing_id && !seen.has(n.listing_id)) { seen.add(n.listing_id); out.push(n); }
        }
        emit('stage2', pctFrom + Math.round((i + 1) / Math.max(1, kws.length) * 20),
          '海选「' + term + '」 ' + (i + 1) + '/' + kws.length + ' 词');
      }
      return out;
    }

    /* 一次「某词根 → 蓝海词池 → 海选」。
       opts.reuse = 上一次同词根的结果：价格区间没变时只补查新增词，
       不重复消耗 EverBee 调用（放宽阈值后能省掉大半调用）。 */
    async function collect(term, thNow, opts = {}) {
      let kwRes = kwCache.get(term);
      if (!kwRes) {
        kwRes = await everbee.keyword(term, { per_page: 40 });
        kwCache.set(term, kwRes);
      }
      const pool = filterKeywordPool(kwRes, thNow);
      const kws = pickSearchKeywords(pool, term, thNow);

      const reuse = opts.reuse;
      const priceSame = Boolean(reuse) && reuse.price_min === thNow.price_min && reuse.price_max === thNow.price_max;
      let rows;
      if (priceSame && Array.isArray(reuse.rows)) {
        rows = reuse.rows.slice();
        const had = new Set(reuse.kws || []);
        const extra = kws.filter((k) => !had.has(k));
        if (extra.length) rows = rows.concat(await fetchRows(extra, thNow, term, 30));
      } else {
        rows = await fetchRows(kws, thNow, term, 15);
      }
      return { term, kwRes, pool, kws, rows, passed: filterListings(rows, thNow) };
    }

    try {
      /* ---------- Pass 1：原词根 + 当前阈值 ---------- */
      emit('stage1', 5, '扩词中：' + s);
      let cur = await collect(s, th);
      seedsSearched.push(s);
      mergePool(cur.pool);
      mergeRows(cur.rows);
      let poolShort = cur.pool.length < th.min_keywords;
      let candShort = filterListings(raw, th).length < th.min_candidates;
      log('Stage1 蓝海词 ' + cur.pool.length + '/' + th.min_keywords + ' 个下限');

      /* ★ 取数失败 ≠ 这个词冷门，必须分开说。
         2026-10-21 实测：EverBee 偶发「HTTP 200 但没有内容」，旧代码把它当成
         「这个词没数据」，页面写「蓝海词只有 0 个 → 换个词根 / 放宽阈值」，
         等于让用户去治一个不存在的病。这里直接报取数问题。 */
      if (cur.kwRes && cur.kwRes.empty && !raw.length) {
        log('Stage1 取数失败：get_keyword 连续 ' + (cur.kwRes.tries || 3) + ' 次空内容');
        return {
          status: 'error',
          code: 'everbee_empty',
          adjust, seedsSearched,
          message: 'EverBee 这次没返回任何数据（不是这个词冷门）：get_keyword「' + s + '」连续 '
            + (cur.kwRes.tries || 3) + ' 次返回空内容，find_bestsellers 也是 0 行。'
            + '常见原因：同一时间有别的选品任务在跑（并发请求 EverBee 容易拿到空壳）、代理/隧道抖动、EverBee 服务端临时异常。'
            + '等 1 分钟再点一次；连续几次都这样，重启后端再来。',
        };
      }

      /* ---------- Pass 2：自动放宽阈值（只放宽、不换词） ---------- */
      if (auto && !relaxed && (poolShort || candShort)) {
        const th2 = buildTh(true);
        const diff = diffThresholds(th, th2);
        if (diff.length) {
          const why = [];
          if (poolShort) why.push('蓝海词只有 ' + cur.pool.length + ' 个（要求 ≥' + th.min_keywords + '）');
          if (candShort) why.push('海选候选只有 ' + filterListings(raw, th).length + ' 条（要求 ≥' + th.min_candidates + '）');
          const diffTxt = describeThresholdDiff(diff);
          adjust.push({ type: 'relax', text: '「' + s + '」' + why.join('、') + ' → 自动放宽阈值：' + diffTxt + '，重跑一遍' });
          log('自动放宽阈值：' + diffTxt);
          emit('stage1', 12, '当前词搜不到足够数据，自动放宽阈值：' + diffTxt);
          const prev = { term: s, price_min: th.price_min, price_max: th.price_max, rows: cur.rows, kws: cur.kws };
          th = th2;
          relaxed = true;
          cur = await collect(s, th, { reuse: prev });
          mergePool(cur.pool);
          mergeRows(cur.rows);
          poolShort = cur.pool.length < th.min_keywords;
          candShort = filterListings(raw, th).length < th.min_candidates;
          log('放宽后 蓝海词 ' + cur.pool.length + ' 个 / 候选 ' + filterListings(raw, th).length + ' 条');
        }
      }

      /* ---------- Pass 3：自动扩词（AI 优先，规则兜底） ---------- */
      if (auto && expandMax > 0 && (poolShort || candShort)) {
        const shortTxt = '仍不足（蓝海词 ' + cur.pool.length + ' 个 / 候选 ' + filterListings(raw, th).length + ' 条）';
        emit('stage1', 18, '候选仍不足，让 AI 扩词…');
        const ex = await expandSeeds(ai, s, { exclude: seedsSearched, max: 4 });
        if (!ex.seeds.length) {
          adjust.push({ type: 'note', text: '「' + s + '」' + shortTxt + ' → 扩词也没找到可用的替代词根'
            + (ex.aiError ? '（AI 扩词失败：' + ex.aiError + '）' : '') });
        } else {
          adjust.push({ type: 'expand', text: '「' + s + '」' + shortTxt + ' → '
            + (ex.source === 'ai' ? 'AI 扩词' : '规则扩词（AI 未配置/未给词）') + '：' + ex.seeds.join('、')
            + '（最多试 ' + expandMax + ' 个，够了就停）' });
          log('扩词：' + ex.seeds.join(' / ') + '（来源 ' + ex.source + '）');
          let tried = 0;
          for (const alt of ex.seeds) {
            if (tried >= expandMax) break;
            tried++;
            emit('stage1', 20 + tried * 3, '扩词尝试「' + alt + '」…');
            const r = await collect(alt, th);
            seedsSearched.push(alt);
            mergePool(r.pool);
            const added = mergeRows(r.rows);
            adjust.push({ type: 'note', text: '扩词「' + alt + '」：蓝海词 ' + r.pool.length + ' 个、新增候选 ' + added + ' 条' });
            log('扩词「' + alt + '」 蓝海词 ' + r.pool.length + ' / 新增候选 ' + added);
            if (filterListings(raw, th).length >= th.min_candidates) break;
          }
          poolShort = poolAll.length < th.min_keywords;
          candShort = filterListings(raw, th).length < th.min_candidates;
        }
      }

      /* ---------- 汇总候选 ---------- */
      const passedAll = filterListings(raw, th);
      const filtered = passedAll.slice(0, th.max_candidates);
      // 被阈值筛掉的款也进淘汰清单（最多记 8 条），让报告能解释「为什么没看到某款」
      const okIds = new Set(passedAll.map((c) => c.listing_id));
      const rejectedByThreshold = raw
        .filter((c) => !okIds.has(c.listing_id))
        .slice(0, 8)
        .map((c) => ({ listing_id: c.listing_id, title: c.title, reason: rejectReason(c, th) }));
      log('Stage2 原始 ' + raw.length + ' → 阈值后 ' + filtered.length
        + '（词根 ' + seedsSearched.length + ' 个：' + seedsSearched.join(' / ') + '）');

      if (!filtered.length) {
        return {
          status: relaxed ? 'need_keywords' : 'need_relax',
          rawCount: raw.length, filteredCount: 0,
          adjust, seedsSearched,
          message: '这次一个候选都没选出来（原始 ' + raw.length + ' 条全被阈值/风险规则筛掉）。'
            + (adjust.length ? '已自动调整：' + adjust.map((a) => a.text).join('；') + '。' : '')
            + '建议换一个更宽的上位词根（例如把「custom ceramic mug for cat lovers」缩成「ceramic mug」），或手动调低高级设置里的月销下限/评价上限。',
        };
      }
      if (filtered.length < th.min_candidates) {
        adjust.push({ type: 'note', text: '候选只有 ' + filtered.length + ' 条，低于基准 ' + th.min_candidates + ' 条 —— 报告样本偏少，结论只作方向参考。' });
      }

      /* Stage3+5 单品诊断 + 利润 + IP（数据在 Stage2 已带回，这里归一） */
      emit('stage3', 45, '诊断 ' + filtered.length + ' 个候选（标签/IP/利润）…');
      const eliminated = rejectedByThreshold.slice();
      let candidates = [];
      for (const c of filtered) {
        const ip = ipScan([c.title, c.keyword, s]);
        if (ip.risk === 'high') {
          eliminated.push({ listing_id: c.listing_id, title: c.title, reason: 'IP 高风险（命中：' + ip.hits.join('、') + '），按规则直接淘汰，不推荐' });
          continue;
        }
        const profit = calcProfit(c.price, { cost_rate: th.cost_rate, offsite_ads: th.offsite_ads });
        candidates.push(Object.assign({}, c, { ip_hits: ip.hits, profit }));
      }
      // 少量标签深挖（每个候选 1 次调用，最多 deep_tags 个）
      const tagTargets = candidates.slice(0, th.deep_tags);
      for (let i = 0; i < tagTargets.length; i++) {
        try {
          const td = await everbee.callTool('view_listing_tags', { listing_id: String(tagTargets[i].listing_id) });
          const txt = td && typeof td === 'object' ? JSON.stringify(td) : '';
          const tags = [];
          const re = /"tag"\s*:\s*"([^"]+)"/g; let m;
          while ((m = re.exec(txt)) && tags.length < 13) tags.push(m[1]);
          candidates[i].tags = tags;
        } catch (e) { log('标签拉取失败 #' + tagTargets[i].listing_id + '：' + (e && e.message)); }
        emit('stage3', 45 + Math.round((i + 1) / Math.max(1, tagTargets.length) * 10), '标签 ' + (i + 1) + '/' + tagTargets.length);
      }
      if (!candidates.length && !relaxed) {
        // 全军覆没（比如全被 IP 淘汰）：按 skill 意图这属于候选不足
        return {
          status: 'need_relax', rawCount: raw.length, filteredCount: filtered.length,
          adjust, seedsSearched,
          message: '候选全部被风险规则淘汰（' + eliminated.length + ' 条）。' + (eliminated[0] ? '首条原因：' + eliminated[0].reason : ''),
        };
      }

      /* Stage4 店铺交叉核验 */
      emit('stage4', 60, '店铺交叉核验…');
      candidates = shopCrossCheck(candidates);

      /* Stage6 评级 + AI 差异化 */
      emit('stage6', 70, '评级 + AI 差异化分析…');
      let ranked = gradeCandidates(candidates)
        .sort((a, b) => b.score - a.score);

      let aiAdvice = null, aiError = null;
      try {
        if (ai && ranked.length) {
          const compact = ranked.map((c) => ({
            id: c.listing_id, grade: c.grade, score: c.score, title: c.title.slice(0, 80),
            price: c.price, est_sales: c.est_sales, growth: c.growth_pct + '% ' + c.growth_dir,
            cvr: c.cvr, margin: c.profit && c.profit.margin, tags: c.tags || [],
            pros: c.pros, cons: c.cons, keyword: c.keyword,
          }));
          const sys = '你是 Etsy POD 赛道的选品策划。只依据给出的预估数据给差异化建议，禁止编造数据。'
            + 'EverBee 数据为预估值，你的输出也会被标注需人工复核。用简体中文。'
            + '★ 差异化建议必须具体可执行：每条至少点明「换什么人群/场景」+「加什么元素（材质/文案/构图/配件）」+'
            + '「和原款哪里不一样」。禁止复述原标题当建议（例如"做个性化咖啡杯"这种等于没说）。';
          const usr = '词根：' + s + '\n候选：\n' + JSON.stringify(compact, null, 1)
            + '\n\n请按下面格式输出 Markdown，不要寒暄、不要重复标题：\n'
            + '### 逐个方向\n'
            + '**#listing_id（级别）**\n'
            + '- 改哪里：<人群或使用场景，例如"给养柯基的独居年轻人">\n'
            + '- 加什么：<具体元素，例如"柯基屁股造型杯柄 + 内壁釉下彩狗爪印">\n'
            + '- 差异化点：<一句话说清与原款的差别，例如"原款是通用祝福语，这款把祝福和宠物品种绑定">\n'
            + '- 定价建议：<$区间，参考候选毛利给出>\n\n'
            + '### 整体建议\n'
            + '<80 字以内：先测哪个、砍哪个、为什么>'
          aiAdvice = await ai(sys, usr);
        }
      } catch (e) { aiError = String((e && e.message) || e); }

      /* Stage7 报告 */
      emit('stage7', 90, '生成报告…');
      const md = buildReport({
        seed: s, th, relaxed, keywordPool: poolAll,
        eliminated, candidates: ranked,
        rawCount: raw.length, filteredCount: filtered.length,
        aiAdvice, aiError,
        adjust, seedsSearched,
        jobNote: relaxed ? '本次使用宽松阈值档（原阈值下数据不足，已自动放宽）。' : '',
      });
      const reportId = 'sel-' + Date.now().toString(36);
      const rec = {
        id: reportId, seed: s, createdAt: Date.now(), relaxed,
        thresholds: th,
        seedsSearched, adjust,
        summary: {
          grades: ranked.reduce((m, c) => { m[c.grade] = (m[c.grade] || 0) + 1; return m; }, {}),
          candidates: ranked.length, eliminated: eliminated.length,
          keywords: poolAll.length,
        },
        markdown: md,
        data: { pool: poolAll, ranked, eliminated },
      };
      if (storeFile) {
        const arr = readReports(); arr.push(rec); writeReports(arr);
      }
      emit('stage7', 100, '完成');
      log('选品报告完成：' + reportId + '（候选 ' + ranked.length + '，词根 ' + seedsSearched.length + ' 个）');
      return { status: 'done', reportId, candidates: ranked.length, eliminated: eliminated.length, adjust, seedsSearched };
    } catch (e) {
      const code = (e && e.code) || '';
      log('选品流程失败：' + code + ' ' + (e && e.message));
      let message = String((e && e.message) || e);
      if (code === 'everbee_not_authorized') message = 'EverBee 未授权，先到「Listing 优化师」页连接 EverBee。';
      else if (code === 'everbee_empty_payload' || code === 'everbee_bad_payload' || code === 'everbee_tool_error') {
        message = '这次是取数失败，不是词太冷门：' + message
          + '。常见原因：并发/限流/代理抖动。等 1 分钟再点一次；连续几次都这样，重启后端再来。';
      } else if (code === 'everbee_unauthorized' || code === 'everbee_forbidden') {
        message = 'EverBee 授权失效或被拒绝 → 重新连接 EverBee（' + message + '）。';
      }
      return { status: 'error', code, adjust, seedsSearched, message };
    }
  }

  return { run, reportsList, reportGet, reportDelete, DEFAULT_THRESHOLDS, RELAXED_THRESHOLDS };
}
