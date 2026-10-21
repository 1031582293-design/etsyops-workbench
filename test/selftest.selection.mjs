/* 选品数字员工自测（零网络依赖：mock everbee 客户端 + mock AI）
 *
 * 覆盖：字符串解析、蓝海词池过滤、海选过滤、IP 规则、利润计算、
 *       孤爆/交叉核验、评级、完整 7 阶段跑通（done / need_keywords / need_relax）、
 *       AI 失败不阻塞、报告落盘/列表/删除。
 * 运行：node test/selftest.selection.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import {
  parseMoney, parseInt_, parseGrowth, parseMonths, calcProfit, ipScan,
  filterKeywordPool, normalizeBestseller, filterListings, shopCrossCheck,
  gradeCandidates, buildReport, createSelectionAgent,
  diffThresholds, describeThresholdDiff,
  hasCJK, sanitizeEnSeed, translateSeed, parseSeedList, ruleExpandSeeds, expandSeeds,
} from '../etsy-selection.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const storeFile = join(__dir, '..', '.tmp-selection-test.json');

let pass = 0, fail = 0;
function check(ok, name, extra = '') {
  if (ok) { pass++; console.log('  \u2713 ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

/* ---------- mock 数据（字段格式照抄 2026-10-21 实测 find_bestsellers 返回） ---------- */
function bestRow(over = {}) {
  return Object.assign({
    listing_id: 1001,
    'Product': 'Custom Ceramic Mug Personalized Photo Coffee Cup',
    'Shop Name': 'MockShopA',
    'Price': '$24.00',
    'Sales': '120',
    'Revenue': '$2,880',
    'Trends': [10, 11, 12, 11, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30],
    'Growth Rate': '35%',
    'Total Sales': '1,200',
    'Total Reviews': '45',
    'Listing Age': '5 Mo.',
    'Total Favorites': '900',
    'Avg. Reviews': '82',
    'Total Views': '40,000',
    'Category': 'Home & Living',
    'Shop Age': '24 Mo.',
    'Visibility Score': '90',
    'Conversion Rate': '2.10%',
    'Total Shop Sales': '4,000',
    'Listing Type': 'physical',
  }, over);
}
function kwSug(keyword, vol, score, competition = 50) {
  return { keyword, vol, score, competition, cpc: 0.4, id: 'k_' + keyword };
}

/* mock everbee：keyword() + callTool('find_bestsellers' / 'view_listing_tags')
 * keywordRes 支持三种写法：数组（所有词同一份）、函数 (term)=>数组、对象 {term: 数组} */
function mockEverbee({ keywordRes, rowsByKw, tagsJson, failFirstFind = false, emptyKw = false }) {
  let findCalls = 0;
  const listFor = (term) => {
    if (typeof keywordRes === 'function') return keywordRes(term) || [];
    if (Array.isArray(keywordRes)) return keywordRes;
    if (keywordRes && typeof keywordRes === 'object') return keywordRes[term] || [];
    return [];
  };
  return {
    keyword: async (term) => {
      const list = emptyKw ? [] : listFor(term);
      return {
        term, exact: null, total: null, nearest: '',
        suggestions: list,
        empty: list.length === 0,
        tries: emptyKw ? 3 : 1,
      };
    },
    callTool: async (name, args = {}) => {
      if (name === 'find_bestsellers') {
        findCalls++;
        if (failFirstFind && findCalls === 1) return {}; // 模拟「空壳响应」，应触发一次重试
        const kw = args.query || '';
        return { rows: (rowsByKw && rowsByKw[kw]) || [] };
      }
      if (name === 'view_listing_tags') {
        return tagsJson || { tags: [{ tag: 'ceramic mug' }, { tag: 'custom coffee cup' }] };
      }
      throw new Error('mock 未实现工具 ' + name);
    },
    _findCalls: () => findCalls,
  };
}
const mockAi = async () => '**#1001**：主打「宠物纪念」人群，加customize名字字段。\n\n整体建议：先测 #1001。';

async function main() {
  rmSync(storeFile, { force: true });

  console.log('【1】字符串解析');
  check(parseMoney('$74.50') === 74.5 && parseMoney('$2,880') === 2880, 'parseMoney 去逗号/美元符');
  check(parseInt_('1,200') === 1200 && parseInt_('') === null, 'parseInt_ 空值 → null');
  const g1 = parseGrowth('29% ↓'), g2 = parseGrowth('35%'), g3 = parseGrowth('0%');
  check(g1.pct === 29 && g1.dir === 'down', 'parseGrowth ↓', JSON.stringify(g1));
  check(g2.dir === 'up' && g3.dir === 'flat', 'parseGrowth ↑/→');
  check(parseMonths('7 Mo.') === 7 && parseMonths('—') === null, 'parseMonths');

  console.log('【2】利润计算（Etsy 费率固定）');
  const p = calcProfit(24, { cost_rate: 0.3 });
  // 24 - 7.2成本 - (0.20 + 1.56 + 0.72 + 0.25=2.73) = 14.07
  check(p.net === 14.07, '净利 $24 → 14.07', JSON.stringify(p));
  check(p.margin === 58.6, '毛利率 58.6%', String(p.margin));
  const pAds = calcProfit(24, { cost_rate: 0.3, offsite_ads: true });
  check(pAds.fees > p.fees, '开站外广告费用变高');

  console.log('【3】IP 规则扫描');
  check(ipScan(['Custom Pokemon Mug']).risk === 'high', 'pokemon → high');
  check(ipScan(['Custom Ceramic Mug']).risk === 'low', '普通词 → low');

  console.log('【4】蓝海词池过滤');
  const thDefault = createSelectionAgent({ everbee: mockEverbee({}), ai: mockAi }).DEFAULT_THRESHOLDS;
  const pool = filterKeywordPool({
    exact: kwSug('ceramic mug', 5000, 300),
    suggestions: [
      kwSug('custom ceramic mug', 1200, 250),
      kwSug('ceramic coffee mug', 90, 250),      // 低于 100 → 排除
      kwSug('ceramic mug', 5000, 300),            // 与 exact 重复（大小写归一）→ 去重
      kwSug('CERAMIC MUG', 5000, 300),
      kwSug('huge mug', 50000, 400),              // 超上限 → 排除
      kwSug('mug with lid', 800, 100),
      kwSug(null, 500, 100),                      // 空词 → 排除
    ],
  }, thDefault);
  check(pool.length === 3, '过滤后 3 个（ceramic mug / custom ceramic mug / mug with lid）', JSON.stringify(pool.map(k => k.keyword)));
  check(pool[0].keyword === 'ceramic mug', 'score 降序，exact 在前');
  check(pool.filter(k => k.keyword === 'ceramic mug').length === 1, 'exact 与 suggestions 去重');

  console.log('【5】商品海选归一 + 阈值过滤');
  const n1 = normalizeBestseller(bestRow(), 'custom ceramic mug');
  check(n1.price === 24 && n1.est_sales === 120 && n1.total_reviews === 45, '字段归一', JSON.stringify({ price: n1.price, sales: n1.est_sales }));
  check(n1.growth_dir === 'up' && n1.trend_dir === 'up', '增长方向自算', JSON.stringify({ g: n1.growth_dir, t: n1.trend_dir }));
  check(parseMonths('—') === null && parseInt_('') === null, '空/占位符 → null（防 0 冒充）');
  const filtered = filterListings([
    n1,
    normalizeBestseller(bestRow({ 'Price': '$74.00' }), 'custom ceramic mug'),   // 超价
    normalizeBestseller(bestRow({ 'Sales': '5' }), 'custom ceramic mug'),        // 销量不足
    normalizeBestseller(bestRow({ 'Growth Rate': '29% ↓' }), 'custom ceramic mug'), // 下滑
    normalizeBestseller(bestRow({ 'Total Reviews': '999' }), 'custom ceramic mug'), // 评价超限
    normalizeBestseller(bestRow({ 'Listing Age': '30 Mo.' }), 'custom ceramic mug'), // 太老
    normalizeBestseller(bestRow({ listing_id: 1002 }), 'custom ceramic mug'),
  ], thDefault);
  check(filtered.length === 2, '阈值过滤留 2 条', 'got ' + filtered.length);

  console.log('【6】店铺交叉核验 + 孤爆');
  const cc = shopCrossCheck([
    Object.assign({}, n1),                                                       // MockShopA 1200/4000=30%
    Object.assign({}, n1, { listing_id: 1003, shop: 'MockShopB', keyword: 'custom ceramic mug' }),
    Object.assign({}, n1, { listing_id: 1004, shop: 'MockShopC', keyword: 'custom ceramic mug' }),
    Object.assign({}, n1, { listing_id: 1005, shop: 'MockShopD', keyword: 'custom ceramic mug', total_shop_sales: 1300 }), // 92% → 孤爆
  ]);
  check(cc[0].demand_credible === true && cc[0].kw_shop_count === 4, '同词 4 店 → 需求可信');
  check(cc[3].solo_boom === true, '占全店 92% → 孤爆', JSON.stringify(cc[3].shop_share));
  check(cc[0].solo_boom === false, '占 30% → 非孤爆');

  console.log('【7】评级');
  const graded = gradeCandidates(cc);
  check(graded.every(c => ['S', 'A', 'B', 'C'].includes(c.grade)), '等级合法');
  check(graded[3].score < graded[0].score, '孤爆款分数更低');

  console.log('【9】中文 → 英文（翻译入口）');
  const aiZh = async () => '  "Ceramic Mug"  ';
  const tr = await translateSeed(aiZh, '陶瓷马克杯');
  check(tr.translated === true && tr.en === 'ceramic mug', '翻译结果洗净（去引号/小写）', JSON.stringify(tr));
  const trEn = await translateSeed(aiZh, 'ceramic mug');
  check(trEn.translated === false && trEn.en === 'ceramic mug', '英文输入不调 AI，原样返回');
  check(hasCJK('陶瓷马克杯') && !hasCJK('ceramic mug'), 'hasCJK 判定');
  check(sanitizeEnSeed('ceramic mug') === 'ceramic mug', 'sanitizeEnSeed 保留正常词');
  check(sanitizeEnSeed('English: pet memorial plaque') === 'pet memorial plaque', '去掉「英文：」前缀');
  check(sanitizeEnSeed('1. ceramic mug') === 'ceramic mug', '去掉序号');
  check(sanitizeEnSeed('陶瓷马克杯') === '', '★ 洗完还带中文 → 返回空（宁可报错也不乱搜）');
  check(sanitizeEnSeed('') === '' && sanitizeEnSeed('——') === '', '空/纯符号 → 空');
  let trErr = null;
  try { await translateSeed(async () => '这是中文', '马克杯'); } catch (e) { trErr = e; }
  check(trErr && /没给出可用/.test(trErr.message), 'AI 返回中文 → 抛错（不拿中文去搜）');
  let trNoAi = null;
  try { await translateSeed(null, '马克杯'); } catch (e) { trNoAi = e; }
  check(trNoAi && /未配置 AI/.test(trNoAi.message), '没有 AI 时明确报错');

  console.log('【10】词根扩词 + 阈值差异（人话）');
  check(parseSeedList('ceramic mug\npottery mug\n', []).length === 2, 'parseSeedList 按行拆');
  check(parseSeedList('ceramic mug，pottery mug、stoneware mug', []).length === 3, '中英文逗号/顿号都拆');
  check(parseSeedList('ceramic mug', ['ceramic mug']).length === 0, '排除已有词根');
  check(parseSeedList('a very long listing title with many words here', []).length === 0, '太长的不当词根');
  check(parseSeedList('pokemon mug', []).length === 1, '（IP 词由后续 IP 扫描拦截，不在解析阶段删）');
  const ruleSeeds = ruleExpandSeeds('custom ceramic mug');
  check(ruleSeeds.includes('ceramic mug') && ruleSeeds.includes('mug'), '规则扩词：去修饰词 + 取中心词', JSON.stringify(ruleSeeds));
  check(ruleExpandSeeds('mug').every(s => /^(handmade|custom|personalized) /.test(s)), '单词词根 → 加修饰词扩');
  const exAi = await expandSeeds(async () => 'ceramic mug\npottery mug', 'odd widget', { max: 4 });
  check(exAi.source === 'ai' && exAi.seeds.length === 2, 'AI 扩词可用', JSON.stringify(exAi));
  const exFallback = await expandSeeds(async () => { throw new Error('额度用尽'); }, 'custom ceramic mug');
  check(exFallback.source === 'rule' && exFallback.seeds.length > 0 && /额度用尽/.test(exFallback.aiError), 'AI 挂了 → 规则扩词兜底');
  const diffs = diffThresholds({ price_min: 12, price_max: 35, max_reviews: 80 }, { price_min: 8, price_max: 60, max_reviews: 80 });
  check(diffs.length === 2, 'diffThresholds 只报真正变了的项');
  check(describeThresholdDiff(diffs) === '价格区间 $12-35 → $8-60', '上下限合并成区间说法', describeThresholdDiff(diffs));

  console.log('【11】完整 7 阶段（ceramic mug 场景，mock 数据）');
  const rowsKw = {};
  rowsKw['ceramic mug'] = [
    bestRow({ listing_id: 1900, 'Shop Name': 'ShopSeed', 'Total Shop Sales': '4,000' }),
    bestRow({ listing_id: 1901, 'Shop Name': 'ShopSeed2', 'Total Shop Sales': '4,000' }),
    bestRow({ listing_id: 1902, 'Shop Name': 'ShopSeed3', 'Total Shop Sales': '4,000' }),
    bestRow({ listing_id: 1903, 'Shop Name': 'ShopSeed4', 'Price': '$74.00' }), // 超价 → 淘汰清单
  ];
  for (let i = 0; i < 6; i++) {
    const kw = 'kw' + i;
    rowsKw[kw] = [
      bestRow({ listing_id: 2000 + i, 'Shop Name': 'ShopKw' + i, 'Total Shop Sales': '4,000' }),
      bestRow({ listing_id: 2100 + i, 'Shop Name': 'ShopKw2' + i, 'Total Shop Sales': '4,000' }),
      bestRow({ listing_id: 2200 + i, 'Shop Name': 'ShopKw3' + i, 'Total Shop Sales': '4,000' }),
      bestRow({ listing_id: 2300 + i, 'Shop Name': 'ShopKw4' + i, 'Price': '$74.00' }), // 超价 → 淘汰清单
    ];
  }
  const kwPool = [kwSug('ceramic mug', 5000, 300)].concat(
    Array.from({ length: 9 }, (_, i) => kwSug('kw' + i, 800 + i * 100, 200 - i * 10)));
  const eb = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsKw, tagsJson: { tags: [{ tag: 'ceramic mug' }] } });
  const agent = createSelectionAgent({ everbee: eb, ai: mockAi, storeFile });
  const stages = [];
  const r1 = await agent.run('ceramic mug', {}, (stage, pct, msg) => stages.push(stage + ':' + pct + ':' + msg));
  check(r1.status === 'done', 'status=done', JSON.stringify(r1).slice(0, 120));
  check(typeof r1.reportId === 'string' && r1.reportId.startsWith('sel-'), 'reportId 生成');
  check(eb._findCalls() === 5, 'find_bestsellers 共 5 次调用（5 词，无空壳）', 'got ' + eb._findCalls());
  check(Array.isArray(r1.adjust) && r1.adjust.length === 0, '一次命中 → 不做自动调整');
  const rep = agent.reportGet(r1.reportId);
  check(Boolean(rep), '报告已落盘');
  check(rep.markdown.includes('【预估数据，需要人工二次复核】'), '报告强制标注预估数据');
  for (const sec of ['## 1. 任务摘要', '## 2. S/A/B/C 候选清单', '## 3. 淘汰清单与原因', '## 4. 风险标签', '## 5. 差异化建议（AI）', '## 6. 人工复核清单']) {
    check(rep.markdown.includes(sec), '报告含「' + sec + '」');
  }
  check(rep.markdown.includes('自动调整记录：无'), '报告写明「未放宽、未扩词」');
  check(rep.data.eliminated.length >= 5, '超价款进淘汰清单（含原因）', '淘汰 ' + rep.data.eliminated.length
    + '，首条：' + (rep.data.eliminated[0] ? rep.data.eliminated[0].reason : '无'));
  check(rep.data.eliminated.every(e => e.reason && e.reason.length > 3), '淘汰原因非空');
  check(rep.markdown.includes('宠物纪念') || rep.markdown.includes('先测'), 'AI 建议写入报告');
  check(stages.some(s => s.startsWith('stage7:100')), '进度走满');
  check(agent.reportsList().length === 1, '报告列表 1 条');
  check(agent.reportDelete(r1.reportId) === true && agent.reportsList().length === 0, '删除报告');
  check(agent.reportGet(r1.reportId) === null, '删除后取不到');

  console.log('【12】自动放宽阈值（价格 45 美元默认档全灭 → 放宽到 8-60 恢复）');
  const rows45 = {
    'ceramic mug': Array.from({ length: 5 }, (_, i) => bestRow({
      listing_id: 3000 + i, 'Shop Name': 'PriceShop' + i, 'Total Shop Sales': '4,000', 'Price': '$45.00',
    })),
  };
  const ebRelax = mockEverbee({ keywordRes: kwPool, rowsByKw: rows45 });
  const agentRelax = createSelectionAgent({ everbee: ebRelax, ai: mockAi, storeFile });
  const rRelax = await agentRelax.run('ceramic mug');
  check(rRelax.status === 'done', '自动放宽后 done（不需要用户点按钮）', JSON.stringify(rRelax).slice(0, 160));
  const relaxTxt = (rRelax.adjust || []).map(a => a.text).join(' | ');
  check(/自动放宽阈值/.test(relaxTxt) && /价格区间 \$12-35 → \$8-60/.test(relaxTxt), '调整记录写清放宽了哪项到哪', relaxTxt.slice(0, 160));
  const repRelax = agentRelax.reportGet(rRelax.reportId);
  check(repRelax.relaxed === true, '报告标记宽松档');
  check(repRelax.markdown.includes('自动放宽阈值') && repRelax.markdown.includes('价格区间'), '报告里也写了放宽记录');
  check(ebRelax._findCalls() >= 6, '放宽后重新海选（价格区间变了必须重查）', 'findCalls=' + ebRelax._findCalls());

  console.log('【13】自动扩词（原词根数据太薄 → AI 给替代词根后恢复）');
  const rowsExpand = {};
  for (let i = 0; i < 5; i++) {
    rowsExpand['kw' + i] = [
      bestRow({ listing_id: 4000 + i, 'Shop Name': 'ExpShop' + i, 'Total Shop Sales': '4,000' }),
      bestRow({ listing_id: 4100 + i, 'Shop Name': 'ExpShop2' + i, 'Total Shop Sales': '4,000' }),
      bestRow({ listing_id: 4200 + i, 'Shop Name': 'ExpShop3' + i, 'Total Shop Sales': '4,000' }),
    ];
  }
  rowsExpand['ceramic mug'] = [
    bestRow({ listing_id: 4300, 'Shop Name': 'SeedHit1', 'Total Shop Sales': '4,000' }),
    bestRow({ listing_id: 4301, 'Shop Name': 'SeedHit2', 'Total Shop Sales': '4,000' }),
    bestRow({ listing_id: 4302, 'Shop Name': 'SeedHit3', 'Total Shop Sales': '4,000' }),
  ];
  const kwThin = (term) => (term === 'ceramic mug' ? kwPool : [kwSug('odd widget', 300, 100)]);
  const aiExpand = async (sys, usr) => (/候选：/.test(usr) ? '**#4300**：把祝福和宠物品种绑定。\n\n整体建议：先测 #4300。' : 'ceramic mug\npottery mug');
  const ebThin = mockEverbee({ keywordRes: kwThin, rowsByKw: Object.assign({ 'odd widget': [bestRow({ listing_id: 5001, 'Shop Name': 'ThinShop' })] }, rowsExpand) });
  const agentThin = createSelectionAgent({ everbee: ebThin, ai: aiExpand, storeFile });
  const rThin = await agentThin.run('odd widget');
  check(rThin.status === 'done', '扩词后 done', JSON.stringify(rThin).slice(0, 160));
  check((rThin.seedsSearched || []).includes('ceramic mug'), '扩出来的词真的去搜了', JSON.stringify(rThin.seedsSearched));
  check((rThin.adjust || []).some(a => /AI 扩词/.test(a.text)), '调整记录写明 AI 扩词来源');
  const repThin = agentThin.reportGet(rThin.reportId);
  check(repThin.markdown.includes('实际搜索词根') && repThin.markdown.includes('ceramic mug'), '报告列出实际搜过的词根');

  console.log('【14】关掉自动介入 → 回到老行为（need_relax 等用户点按钮）');
  // $45：默认档（12-35）全灭；宽松档（8-60）能过 —— 用来看手工放宽的效果
  const rowsExp74 = {
    'ceramic mug': Array.from({ length: 5 }, (_, i) => bestRow({
      listing_id: 6000 + i, 'Shop Name': 'ManualShop' + i, 'Total Shop Sales': '4,000', 'Price': '$45.00',
    })),
  };
  const ebExp = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsExp74 });
  const agentExp = createSelectionAgent({ everbee: ebExp, ai: mockAi, storeFile });
  const r3 = await agentExp.run('ceramic mug', { auto: false });
  check(r3.status === 'need_relax', 'auto=false → need_relax', JSON.stringify(r3).slice(0, 140));
  const r4 = await agentExp.run('ceramic mug', { relaxed: true });
  check(r4.status === 'done', '手工宽松档重跑 → done', JSON.stringify(r4).slice(0, 140));
  const repR = agentExp.reportGet(r4.reportId);
  check(repR.relaxed === true && repR.markdown.includes('宽松'), '宽松档标注');

  console.log('【15】★ 取数空壳 ≠ 词冷门（必须报取数失败，不能报「蓝海词 0 个」）');
  const ebEmptyKw = mockEverbee({ emptyKw: true });
  const rEmptyAll = await createSelectionAgent({ everbee: ebEmptyKw, ai: mockAi }).run('ceramic cup');
  check(rEmptyAll.status === 'error' && rEmptyAll.code === 'everbee_empty', 'status=error / code=everbee_empty', JSON.stringify(rEmptyAll).slice(0, 160));
  check(/不是这个词冷门/.test(rEmptyAll.message), '文案明确说是取数问题，不是词冷门');
  check(!/放宽|换个词根/.test(rEmptyAll.message), '不再误导用户去换词/放宽');

  console.log('【16】AI 挂了不阻塞报告');
  const ebAi = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsKw });
  const agentAi = createSelectionAgent({ everbee: ebAi, ai: async () => { throw new Error('额度用尽'); }, storeFile });
  const r5 = await agentAi.run('ceramic mug');
  check(r5.status === 'done', 'AI 失败仍 done', JSON.stringify(r5).slice(0, 120));
  check(agentAi.reportGet(r5.reportId).markdown.includes('AI 分析失败'), '报告标注 AI 失败原因');

  console.log('【17】find_bestsellers 空壳（首次返回 {} → 结构异常识别 + 重试）');
  const ebEmpty = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsKw, failFirstFind: true });
  const agentEmpty = createSelectionAgent({ everbee: ebEmpty, ai: mockAi, storeFile });
  const r6 = await agentEmpty.run('ceramic mug');
  check(r6.status === 'done' && ebEmpty._findCalls() >= 6, '空壳重试后继续', 'findCalls=' + ebEmpty._findCalls());

  console.log('【18】未授权错误透传');
  const ebAuth = {
    keyword: async () => { const e = new Error('EverBee 未授权'); e.code = 'everbee_not_authorized'; throw e; },
    callTool: async () => { throw new Error('x'); },
  };
  const agentAuth = createSelectionAgent({ everbee: ebAuth, ai: mockAi, storeFile });
  const r7 = await agentAuth.run('ceramic mug');
  check(r7.status === 'error' && /未授权/.test(r7.message), 'error + 明确指引', r7.message);

  console.log('【19】词根为空');
  const r8 = await createSelectionAgent({ everbee: mockEverbee({}) }).run('  ');
  check(r8.status === 'error' && /词根/.test(r8.message), '空词根报错');

  console.log('【20】页面结构（中文框 / 译按钮 / 调整记录 / 脚本可解析）');
  const html = readFileSync(join(__dir, '..', 'selection-scout.html'), 'utf8');
  check(html.includes('id="seedZh"') && html.includes('id="seed"'), '中英两个搜索框都在');
  check(html.includes('id="btnZh2En"') && html.includes('/api/selection/translate'), '有「译 →」按钮并调翻译接口');
  check(html.includes('id="adjustBox"') && html.includes('自动调整记录'), '有自动调整记录区');
  check(html.includes('id="optAuto"'), '有「自动放宽/扩词」开关');
  const scriptM = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  let scriptOk = false;
  try { new Function(scriptM[1]); scriptOk = true; } catch (e) { console.log('    ' + e.message); }
  check(scriptOk, '页面内联脚本语法可解析');

  // 清理
  rmSync(storeFile, { force: true });

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('自测脚本异常：', e); process.exit(1); });
