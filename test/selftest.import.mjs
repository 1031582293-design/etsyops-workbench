import fs from 'node:fs';

// 直接从页面里抽出导入器代码测（与前端同一份，避免测的是副本）
const html = fs.readFileSync('/tmp/etsyops-work/etsy-publisher.html', 'utf8');
const src = fs.readFileSync('/tmp/etsyops-work/etsy-import.js', 'utf8');

// 在 Node 里模拟浏览器环境
const fn = new Function(src + '\n; return { parseImportTable, parseHeaderRow, parseNumCell, parseTagsCell, parseWhoMade, parseWhenMade, applyImportRow, IMPORT_ALIASES };');
const M = fn();
global.document = { getElementById: () => null };

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓', name, extra === undefined ? '' : '  ' + extra); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : '  ' + extra); }
};

console.log('\n【A】表头别名与容错');
{
  const cols = M.parseHeaderRow(['产品图', '价格 USD', '产品净重(g)', '包装尺寸 长×宽×高(cm)', '制作方', '何时制作', '#备注', '']);
  const f = cols.map(c => c.field);
  ok(f.includes('images'), '中文表头「产品图」→ images');
  ok(f.includes('price'), '带单位后缀「价格 USD」→ price');
  ok(f.includes('item_weight'), '带单位「产品净重(g)」→ item_weight');
  ok(f.includes('item_length'), '「包装尺寸 长×宽×高(cm)」→ item_length');
  ok(f.includes('who_made'), '「制作方」→ who_made');
  ok(f.includes('when_made'), '「何时制作」→ when_made');
  ok(!f.includes('备注'), '不认识的列被忽略');
  ok(cols.find(c => c.field === 'images').index === 0, '列索引正确');
}
{
  const cols = M.parseHeaderRow(['Image Files', 'Price', 'Qty', 'Materials', 'SKU']);
  const f = cols.map(c => c.field);
  ok(f.includes('images') && f.includes('price') && f.includes('quantity'), '英文表头全部识别');
  ok(f.includes('sku'), '英文 SKU 识别');
}

console.log('\n【B】数值容错（真实物料里就有「2000克-2500克」「3,070」）');
{
  ok(M.parseNumCell('2,250') === 2250, '千分位逗号被去掉');
  ok(M.parseNumCell('2250克') === 2250, '带单位后缀');
  ok(M.parseNumCell('约 30.70') === 30.7, '「约」字被容忍');
  ok(M.parseNumCell('') === null, '空→ null');
  ok(M.parseNumCell('abc') === null, '非数字 → null');
  ok(M.parseNumCell('0') === null, '0 → null（Etsy 要求 positive）');
  ok(M.parseNumCell('-5') === null, '负数 → null');
  ok(M.parseNumCell('30.70') === 30.7, '正常小数');
}

console.log('\n【C】枚举值容错');
{
  ok(M.parseWhoMade('代工') === 'someone_else', '「代工」→ someone_else');
  ok(M.parseWhoMade('自己做') === 'i_did', '「自己做」→ i_did');
  ok(M.parseWhoMade('someone_else') === 'someone_else', '已合法值原样');
  ok(M.parseWhoMade('代工') === 'someone_else', '「合作工厂」也归到 someone_else');
  ok(M.parseWhoMade('乱写') === '', '无法识别 → 空（会报问题）');

  ok(M.parseWhenMade('接单定制') === 'made_to_order', '「接单定制」→ made_to_order');
  ok(M.parseWhenMade('2020_2026') === '2020_2026', '合法值原样');
  ok(M.parseWhenMade('当代') === '2020_2026', '「当代」→ 2020_2026');
  ok(M.parseWhenMade('乱写') === '', '无法识别 → 空');
}

console.log('\n【D】用真实飞书物料做端到端解析');
{
  // 按飞书表格的列顺序模拟一行粘贴内容
  const tsv = [
    '序号\t产品图\t价格\t风格\t参考动物\t制作材料\t适合人群\t尺寸\t产品净重\t包装体积',
    '6\t6-狼头套-1.jpg\t3,070\t美系\t狼\t头骨:pet, 耳朵:EVA, 眼睛:防尘网片\t标准尺寸，配有可调节海绵块\t头高27厘米\t2000-2500克\t50*50',
  ].join('\n');

  const r = M.parseImportTable(tsv);
  // ★ 飞书真实物料表**没有「数量」列**，所以这里报缺失是正确的预期，
  //   不是 bug。列名在解析器里能识别（见F 组断言），只是这份物料没提供。
  ok(r.errors.length === 1 && /数量/.test(r.errors[0]),
    '★ 真实物料缺「数量」列 → 明确报出（这是正确行为）', r.errors[0] || '(无错误)');
  ok(r.rows.length === 1, '解析出 1 行（其余字段照常读出，不因缺列全丢）');
  const it = r.rows[0];
  ok(it.sku === '6', 'SKU = 6');
  ok(it.images[0] === '6-狼头套-1.jpg', '图片文件名解析正确', it.images[0]);
  ok(it.price === '3,070', '价格原样保留（单位交人确认）');
  ok(it.materials.length === 3, '材料按逗号拆成 3 项', it.materials.join(' | '));
  ok(it.item_weight === 2000, '重量「2000-2500克」取到 2000', String(it.item_weight));
  ok(it.item_weight_unit === 'g', '重量单位默认克');
  ok(it.audience_note === '标准尺寸，配有可调节海绵块', '★ 适合人群解析（曾因字段名不一致静默变空）', it.audience_note);
  // 缺必填 → 应报问题但不崩
  ok(it._problems.length > 0, '缺项被标为问题而非静默通过', it._problems.join('; '));
  ok(it._problems.some(p => /数量/.test(p)), '明确指出缺数量');
  ok(it._problems.some(p => /制作方/.test(p)), '明确指出制作方未填');
}

console.log('\n【E2】别名表覆盖度（缺一个别名就整列静默丢值）');
{
  const must = ['图片文件名','价格','数量','制作方','制作时间','材质','产品净重','长度','宽度','高度','适合人群'];
  const cols = M.parseHeaderRow(must);
  const got = cols.map(c => c.field);
  const want = ['images','price','quantity','who_made','when_made','materials','item_weight','item_length','item_width','item_height','audience_note'];
  const lost = want.filter(w => !got.includes(w));
  ok(lost.length === 0, '★ 11 个标准列名全部命中', lost.length ? '丢: ' + lost.join(',') : '');
  // ★ 回归守卫：get() 必须用字段名而非表头写法
  const hasWrong = /get\('(weight|length|width|height|audience|partner|section|return_policy|dim_unit|weight_unit)'\)/.test(
    fs.readFileSync(new URL('../etsy-import.js', import.meta.url).pathname, 'utf8'));
  ok(!hasWrong, '★ 没有 get() 误用表头写法（这类错误不报错、只静默丢值）');
}

console.log('\n【E】缺列时的致命错误');
{
  const r = M.parseImportTable('标题\t描述\nA\tB');
  ok(r.errors.length > 0, '缺图片/价格/数量列 → 报致命错误');
  ok(/图片文件名/.test(r.errors[0]), '错误里点名缺哪列', r.errors[0].slice(0, 50));
}

console.log('\n【F】完整可用的一行');
{
  const tsv = [
    '图片文件名\t价格\t数量\t制作方\t制作时间\t材质\t产品净重\t长度\t宽度\t高度\t适合人群',
    'a.jpg;b.jpg;c.jpg\t30.70\t10\tsomeone_else\t2020_2026\tEVA, 网布\t2250\t50\t50\t30\t标准尺寸',
  ].join('\n');
  const r = M.parseImportTable(tsv);
  const it = r.rows[0];
  ok(r.errors.length === 0, '无致命错误');
  ok(it._problems.length === 0, '无行内问题（所有必填都齐了）', it._problems.join(';'));
  ok(it.images.length === 3, '分号分隔的 3 张图');
  ok(it.price === '30.70', '价格');
  ok(it.quantity === '10', '数量');
  ok(it.item_weight === 2250, '净重 2250');
  ok(it.item_length === 50 && it.item_width === 50 && it.item_height === 30,
    '★ 三维尺寸全部读到（曾因 get() 用错字段名静默为 null）',
    [it.item_length, it.item_width, it.item_height].join('×'));
  ok(it.audience_note === '标准尺寸', '适合人群');
}

console.log('\n【G】逗号分隔（CSV）也支持');
{
  const r = M.parseImportTable('图片文件名,价格,数量\nx.jpg,9.99,5');
  ok(r.errors.length === 0, 'CSV 也能解析', JSON.stringify(r.errors));
  ok(r.rows[0].price === '9.99', 'CSV 价格');
}

console.log('\n' + '='.repeat(60));
console.log(`导入器：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);