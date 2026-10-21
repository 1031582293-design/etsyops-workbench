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

/* mock everbee：keyword() + callTool('find_bestsellers' / 'view_listing_tags') */
function mockEverbee({ keywordRes, rowsByKw, tagsJson, failFirstFind = false }) {
  let findCalls = 0;
  return {
    keyword: async (term) => ({
      term, exact: null, total: null, nearest: '',
      suggestions: keywordRes || [kwSug(term, 1000, 200)],
    }),
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

  console.log('【8】完整 7 阶段（ceramic mug 场景，mock 数据）');
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
  check(r1.status === 'done', 'status=done', JSON.stringify(r1));
  check(typeof r1.reportId === 'string' && r1.reportId.startsWith('sel-'), 'reportId 生成');
  check(eb._findCalls() === 5, 'find_bestsellers 共 5 次调用（5 词，无空壳）', 'got ' + eb._findCalls());
  const rep = agent.reportGet(r1.reportId);
  check(Boolean(rep), '报告已落盘');
  check(rep.markdown.includes('【预估数据，需要人工二次复核】'), '报告强制标注预估数据');
  for (const sec of ['## 1. 任务摘要', '## 2. S/A/B/C 候选清单', '## 3. 淘汰清单与原因', '## 4. 风险标签', '## 5. 差异化建议（AI）', '## 6. 人工复核清单']) {
    check(rep.markdown.includes(sec), '报告含「' + sec + '」');
  }
  check(rep.data.eliminated.length >= 5, '超价款进淘汰清单（含原因）', '淘汰 ' + rep.data.eliminated.length
    + '，首条：' + (rep.data.eliminated[0] ? rep.data.eliminated[0].reason : '无'));
  check(rep.data.eliminated.every(e => e.reason && e.reason.length > 3), '淘汰原因非空');
  check(rep.markdown.includes('宠物纪念') || rep.markdown.includes('先测'), 'AI 建议写入报告');
  check(stages.some(s => s.startsWith('stage7:100')), '进度走满');
  check(agent.reportsList().length === 1, '报告列表 1 条');
  check(agent.reportDelete(r1.reportId) === true && agent.reportsList().length === 0, '删除报告');
  check(agent.reportGet(r1.reportId) === null, '删除后取不到');

  console.log('【9】分支：蓝海词不足 → need_keywords');
  const ebFew = mockEverbee({ keywordRes: [kwSug('tiny mug', 500, 100)] });
  const agentFew = createSelectionAgent({ everbee: ebFew, ai: mockAi, storeFile });
  const r2 = await agentFew.run('tiny mug');
  check(r2.status === 'need_keywords' && r2.pool.length === 1, 'need_keywords + 词池回传', JSON.stringify(r2).slice(0, 120));

  console.log('【10】分支：候选不足 → need_relax → 放宽重跑');
  // 构造：词池够，但所有商品 $74 超价（默认档 12-35 全灭）
  const rowsExp = { 'kw0': [bestRow({ 'Price': '$74.00' }), bestRow({ listing_id: 2, 'Price': '$74.00' })] };
  const ebExp = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsExp });
  const agentExp = createSelectionAgent({ everbee: ebExp, ai: mockAi, storeFile });
  const r3 = await agentExp.run('ceramic mug');
  check(r3.status === 'need_relax', '默认档 → need_relax', JSON.stringify(r3).slice(0, 140));
  const r4 = await agentExp.run('ceramic mug', { relaxed: true });
  check(r4.status === 'done', '宽松档重跑 → done', JSON.stringify(r4).slice(0, 140));
  const repR = agentExp.reportGet(r4.reportId);
  check(repR.relaxed === true && repR.markdown.includes('宽松'), '宽松档标注');

  console.log('【11】AI 挂了不阻塞报告');
  const ebAi = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsKw });
  const agentAi = createSelectionAgent({ everbee: ebAi, ai: async () => { throw new Error('额度用尽'); }, storeFile });
  const r5 = await agentAi.run('ceramic mug');
  check(r5.status === 'done', 'AI 失败仍 done', JSON.stringify(r5).slice(0, 120));
  check(agentAi.reportGet(r5.reportId).markdown.includes('AI 分析失败'), '报告标注 AI 失败原因');

  console.log('【12】空壳响应重试（find_bestsellers 首次返回空 → 重试后拿到数据）');
  const ebEmpty = mockEverbee({ keywordRes: kwPool, rowsByKw: rowsKw, failFirstFind: true });
  const agentEmpty = createSelectionAgent({ everbee: ebEmpty, ai: mockAi, storeFile });
  const r6 = await agentEmpty.run('ceramic mug');
  check(r6.status === 'done' && ebEmpty._findCalls() >= 6, '空壳重试后继续', 'findCalls=' + ebEmpty._findCalls());

  console.log('【13】未授权错误透传');
  const ebAuth = {
    keyword: async () => { const e = new Error('EverBee 未授权'); e.code = 'everbee_not_authorized'; throw e; },
    callTool: async () => { throw new Error('x'); },
  };
  const agentAuth = createSelectionAgent({ everbee: ebAuth, ai: mockAi, storeFile });
  const r7 = await agentAuth.run('ceramic mug');
  check(r7.status === 'error' && /未授权/.test(r7.message), 'error + 明确指引', r7.message);

  console.log('【14】词根为空');
  const r8 = await createSelectionAgent({ everbee: mockEverbee({}) }).run('  ');
  check(r8.status === 'error' && /词根/.test(r8.message), '空词根报错');

  // 清理
  rmSync(storeFile, { force: true });

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('自测脚本异常：', e); process.exit(1); });
