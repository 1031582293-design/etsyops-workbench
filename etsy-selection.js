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
  const { seed, th, relaxed, keywordPool, eliminated, candidates, aiAdvice, aiError, jobNote } = ctx;
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
  L.push('- 词根：`' + seed + '`；蓝海词池 ' + keywordPool.length + ' 个'
    + '（' + keywordPool.slice(0, 8).map((k) => '`' + k.keyword + '`').join('、') + (keywordPool.length > 8 ? ' 等' : '') + '）');
  L.push('- 海选关键词 ' + Math.min(th.keywords_to_search, keywordPool.length) + ' 个，原始候选 ' + ctx.rawCount + ' 条，'
    + '通过阈值筛选 ' + ctx.filteredCount + ' 条，IP/风险淘汰 ' + eliminated.length + ' 条，最终评级 ' + candidates.length + ' 条。');
  const grades = { S: 0, A: 0, B: 0, C: 0 };
  candidates.forEach((c) => { grades[c.grade] = (grades[c.grade] || 0) + 1; });
  L.push('- 评级分布：S=' + grades.S + ' / A=' + grades.A + ' / B=' + grades.B + ' / C=' + grades.C
    + (grades.S + grades.A > 0 ? '。**S/A 优先测款**，C 仅观察。' : '。暂无 S/A，建议换词根或放宽阈值后再跑。'));
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
      const rows = Array.isArray(data && data.rows) ? data.rows
        : (Array.isArray(data && data.results) ? data.results : []);
      return rows;
    };
    let rows = await once();
    if (!rows.length) { await new Promise((r) => setTimeout(r, 500)); rows = await once(); }
    return rows;
  }

  /* 完整 7 阶段。onProgress(stage, pct, message) 汇报进度。
   * 返回 {status:'done'|'need_keywords'|'need_relax'|'error', ...} */
  async function run(seed, overrides = {}, onProgress = () => {}) {
    const relaxed = Boolean(overrides.relaxed);
    const th = Object.assign({}, DEFAULT_THRESHOLDS, relaxed ? RELAXED_THRESHOLDS : {}, overrides);
    delete th.relaxed;
    const s = String(seed || '').trim();
    if (!s) return { status: 'error', message: '词根为空' };

    try {
      /* Stage1 词根扩词 */
      onProgress('stage1', 5, '扩词中：' + s);
      const kwRes = await everbee.keyword(s, { per_page: 40 });
      const pool = filterKeywordPool(kwRes, th);
      log('Stage1 蓝海词 ' + pool.length + '/' + (th.min_keywords) + ' 个下限');
      if (pool.length < th.min_keywords) {
        return {
          status: 'need_keywords',
          pool,
          message: '蓝海词只有 ' + pool.length + ' 个（阈值要求 ≥' + th.min_keywords
            + '）。可以：①换个词根 ②放宽阈值（搜索量 ' + th.search_volume_min + '-' + th.search_volume_max
            + ' → 宽松档 ' + RELAXED_THRESHOLDS.search_volume_min + '-' + RELAXED_THRESHOLDS.search_volume_max + '）再跑。',
        };
      }

      /* Stage2 批量海选 */
      const topKw = pool.slice(0, th.keywords_to_search);
      onProgress('stage2', 15, '海选 ' + topKw.length + ' 个词（每词 ' + th.results_per_keyword + ' 条）…');
      const raw = [];
      const seenIds = new Set();
      for (let i = 0; i < topKw.length; i++) {
        const kw = topKw[i].keyword;
        const rows = await bestsellers(kw, th);
        log('Stage2 「' + kw + '」 返回 ' + rows.length + ' 行');
        for (const row of rows) {
          const n = normalizeBestseller(row, kw);
          if (n && n.listing_id && !seenIds.has(n.listing_id)) { seenIds.add(n.listing_id); raw.push(n); }
        }
        onProgress('stage2', 15 + Math.round((i + 1) / topKw.length * 25), '海选 ' + (i + 1) + '/' + topKw.length + ' 词完成');
      }
      const passed = filterListings(raw, th);
      // 被阈值筛掉的款也进淘汰清单（最多记 8 条），让报告能解释「为什么没看到某款」
      const passedIds = new Set(passed.map((c) => c.listing_id));
      const rejectedByThreshold = raw
        .filter((c) => !passedIds.has(c.listing_id))
        .slice(0, 8)
        .map((c) => ({ listing_id: c.listing_id, title: c.title, reason: rejectReason(c, th) }));
      const filtered = passed.slice(0, th.max_candidates);
      log('Stage2 原始 ' + raw.length + ' → 阈值后 ' + filtered.length);
      if (filtered.length < th.min_candidates && !relaxed) {
        return {
          status: 'need_relax',
          rawCount: raw.length, filteredCount: filtered.length,
          rejectedPreview: rejectedByThreshold.slice(0, 5).map((r) => r.reason),
          message: '候选只有 ' + filtered.length + ' 条（阈值要求 ≥' + th.min_candidates
            + '，当前默认档较严：价格 ' + th.price_min + '-' + th.price_max + '、评价≤' + th.max_reviews
            + '、上架≤' + th.listing_age_max_months + ' 个月）。要不要放宽到宽松档重跑？数据不会浪费，重跑只多花约 1 分钟。',
        };
      }

      /* Stage3+5 单品诊断 + 利润 + IP（数据在 Stage2 已带回，这里归一） */
      onProgress('stage3', 45, '诊断 ' + filtered.length + ' 个候选（标签/IP/利润）…');
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
        onProgress('stage3', 45 + Math.round((i + 1) / Math.max(1, tagTargets.length) * 10), '标签 ' + (i + 1) + '/' + tagTargets.length);
      }
      if (!candidates.length) {
        // 全军覆没（比如全被 IP 淘汰）：按 skill 意图这属于候选不足
        if (!relaxed) return { status: 'need_relax', rawCount: raw.length, filteredCount: filtered.length, message: '候选全部被风险规则淘汰（' + eliminated.length + ' 条）。可放宽阈值换词重跑。' };
      }

      /* Stage4 店铺交叉核验 */
      onProgress('stage4', 60, '店铺交叉核验…');
      candidates = shopCrossCheck(candidates);

      /* Stage6 评级 + AI 差异化 */
      onProgress('stage6', 70, '评级 + AI 差异化分析…');
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
            + 'EverBee 数据为预估值，你的输出也会被标注需人工复核。用简体中文。';
          const usr = '词根：' + s + '\n候选：\n' + JSON.stringify(compact, null, 1)
            + '\n\n请输出：1) 每个候选 1-2 句差异化方向（怎么做出不同：人群/场景/材质/文案角度，别照抄原款）；'
            + '2) 一段 80 字以内的整体建议（先测哪个、放弃哪个）。直接输出 Markdown，不要寒暄。';
          aiAdvice = await ai(sys, usr);
        }
      } catch (e) { aiError = String((e && e.message) || e); }

      /* Stage7 报告 */
      onProgress('stage7', 90, '生成报告…');
      const md = buildReport({
        seed: s, th, relaxed, keywordPool: pool,
        eliminated, candidates: ranked,
        rawCount: raw.length, filteredCount: filtered.length,
        aiAdvice, aiError,
        jobNote: relaxed ? '本次使用宽松阈值档（在默认档候选不足后放宽）。' : '',
      });
      const reportId = 'sel-' + Date.now().toString(36);
      const rec = {
        id: reportId, seed: s, createdAt: Date.now(), relaxed,
        thresholds: th,
        summary: {
          grades: ranked.reduce((m, c) => { m[c.grade] = (m[c.grade] || 0) + 1; return m; }, {}),
          candidates: ranked.length, eliminated: eliminated.length,
          keywords: pool.length,
        },
        markdown: md,
        data: { pool, ranked, eliminated },
      };
      if (storeFile) {
        const arr = readReports(); arr.push(rec); writeReports(arr);
      }
      onProgress('stage7', 100, '完成');
      log('选品报告完成：' + reportId + '（候选 ' + ranked.length + '）');
      return { status: 'done', reportId, candidates: ranked.length, eliminated: eliminated.length };
    } catch (e) {
      const code = (e && e.code) || '';
      log('选品流程失败：' + (e && e.message));
      return {
        status: 'error',
        code,
        message: (e && e.code) === 'everbee_not_authorized' ? 'EverBee 未授权，先到「Listing 优化师」页连接 EverBee。' : String((e && e.message) || e),
      };
    }
  }

  return { run, reportsList, reportGet, reportDelete, DEFAULT_THRESHOLDS, RELAXED_THRESHOLDS };
}
