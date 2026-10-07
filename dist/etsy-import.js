/* ===================== 批量表格导入 =====================
 *
 * 为什么需要它：批量上新时，一个一个填表单不现实（每个商品 20+ 字段）。
 * 设计成「粘贴表格 → 自动填表 → 逐条确认」，而不是「粘贴表格 → 直接建草稿」——
 * 后者一旦字段错位就会批量建出错误草稿，而 Etsy 的草稿是要花上架费的。
 *
 * 为什么图片用「文件夹 + 文件名匹配」而不是 URL：
 *   表格里只能放链接，而 Etsy 传图需要真实文件字节。文件名匹配（6-狼头套-1.jpg）
 *   是批量场景唯一不需要额外基础设施的做法。
 *
 * 列名全部支持中英文与常见别名，容忍运营同事从不同表格来源粘贴。
 */

/* 列名别名表：左边是表格表头写法，右边是内部字段名。
 * 刻意做得宽松 —— 实际运营的表头往往是「产品净重(g)」这类带单位后缀的。 */
const IMPORT_ALIASES = {
  // 标识
  sku:'sku', 序号:'sku', id:'sku', 编号:'sku', 'product id':'sku',
  // 图片（文件名，不是 URL）
  images:'images', 图片:'images', 图片文件名:'images', 产品图:'images',
  'image files':'images', 'image filenames':'images', 图片文件:'images',
  // 标题与描述
  title:'title', 标题:'title', '英文标题':'title',
  description:'description', 描述:'description', 详情:'description', 详情描述:'description',
  // 标签：既支持逗号分隔字符串，也支持分号
  tags:'tags', 标签:'tags', tags列表:'tags', 关键词:'tags',
  // 价格与数量
  price:'price', 价格:'price', 售价:'price', 单价:'price',
  quantity:'quantity', 数量:'quantity', 库存:'quantity', qty:'quantity',
  // 制作信息
  who_made:'who_made', 制作方:'who_made', 谁制作:'who_made',
  when_made:'when_made', 制作时间:'when_made', 何时制作:'when_made',
  is_supply:'is_supply', 是否手工材料:'is_supply', 手工材料:'is_supply',
  materials:'materials', 材质:'materials', 材料:'materials', 制作材料:'materials',
  // 类目
  taxonomy_id:'taxonomy_id', 类目id:'taxonomy_id', category:'taxonomy_id', 类目:'taxonomy_id',
  // 物理属性
  weight:'item_weight', 净重:'item_weight', 产品净重:'item_weight', 重量:'item_weight',
  weight_unit:'item_weight_unit', 重量单位:'item_weight_unit',
  // ★ 尺寸列名在真实表格里出现过多种写法，缺一个就整列读不到值（自测抓到过）。
  //   已覆盖：长/长度、长宽高三合一、以及把「长×宽×高」写在一列里的写法。
  length:'item_length', 长:'item_length', 长度:'item_length', 商品长:'item_length',
  width:'item_width', 宽:'item_width', 宽度:'item_width', 商品宽:'item_width',
  height:'item_height', 高:'item_height', 高度:'item_height', 厚:'item_height', 商品高:'item_height',
  // 「包装尺寸 长×宽×高」这类：整列作为长度读入，三维由专门的列提供更可靠
  '包装尺寸长×宽×高':'item_length', '长×宽×高':'item_length', '尺寸长宽高':'item_length',
  // 带空格的写法（真实飞书表头就是「包装尺寸 长×宽×高(cm)」）：
  '包装尺寸 长×宽×高':'item_length', '长 × 宽 × 高':'item_length', '长× 宽 × 高':'item_length',
  'product dimensions':'item_length', 'dimensions':'item_length',
  dim_unit:'item_dimensions_unit', 尺寸单位:'item_dimensions_unit',
  // 生产伙伴
  partner:'production_partner_ids', 生产伙伴:'production_partner_ids',
  'production partner':'production_partner_ids', 工厂:'production_partner_ids',
  // 变体
  variations:'variations_json', 变体:'variations_json',
  // 其他
  audience:'audience_note', 适合人群:'audience_note', 规格:'audience_note',
  section:'shop_section_id', 分区:'shop_section_id', 店铺分区:'shop_section_id',
  return_policy:'return_policy_id', 退货政策:'return_policy_id',
};

/* 从一行表头解析出列顺序。返回 {field, index} 列表，只含能识别的列。 */
function parseHeaderRow(cells) {
  const out = [];
  cells.forEach((raw, i) => {
    const key = normalizeHeader(raw);
    if (!key) return;
    const field = IMPORT_ALIASES[key];
    // 同名字段取第一次出现的（运营常留空列在尾部）
    if (field && !out.some(o => o.field === field)) out.push({ field, index: i });
  });
  return out;
}

function normalizeHeader(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')        // 换行与多空格
    .trim()
    .toLowerCase()               // 英文别名统一小写
    // 去掉单位后缀与备注，如「产品净重(g)」「价格 USD」
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/\s+(usd|rmb|cny|元|g|kg|oz|lb|cm|mm|m|in|英寸|克|千克)$/i, '')
    .trim();
}

/* 解析数值：容忍「2,250」「2250克」「约30.70」这类写法。
 * 返回正数或 null —— 0 与非数字都视为「没填」。 */
function parseNumCell(v) {
  if (v == null) return null;
  const t = String(v).replace(/,/g, '').trim();
  if (!t) return null;
  const m = t.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* 解析标签：逗号/分号/顿号/换行都算分隔符。 */
function parseTagsCell(v) {
  return String(v == null ? '' : v)
    .split(/[,;、\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/* 解析 who_made：容忍「自己做的 / 代工 / someone_else」等写法。 */
function parseWhoMade(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return '';
  if (/i_did|自己做|自制|亲手|自产|own|self/.test(t)) return 'i_did';
  if (/collective|集体|工作室|团队/.test(t)) return 'collective';
  if (/someone_else|代工|代做|合作工厂|合作方|供应商|工厂|外协|采购/.test(t)) return 'someone_else';
  // 已经是合法枚举值就原样用
  if (/^(i_did|someone_else|collective)$/.test(t)) return t;
  return '';
}

/* 解析 when_made：选项较多，主要映射最常用的几个。 */
function parseWhenMade(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  if (/made_to_order|接单|定制|按需|预售/.test(t)) return 'made_to_order';
  if (/2020_2026|2020|当代|近年|最新/.test(t)) return '2020_2026';
  if (/2010_2019|2010/.test(t)) return '2010_2019';
  if (/2007_2009/.test(t)) return '2007_2009';
  if (/before_2007|2007前|老物/.test(t)) return 'before_2007';
  if (/^(made_to_order|\d{4}_\d{4}|before_\d{4})$/.test(t)) return t;
  return '';
}

/* 解析 is_supply：表格里常写「是/否」。 */
function parseSupply(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return null;
  if (/^(是|yes|y|true|1|手工材料是)/.test(t)) return true;
  if (/^(否|no|n|false|0|非手工)/.test(t)) return false;
  return null;
}

/* 核心：把粘贴的 TSV/CSV 解析成结构化行。
 * 返回 { columns, rows, errors } —— errors 是致命问题（会让整批无法导入）。 */
function parseImportTable(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return { columns: [], rows: [], errors: ['内容为空'] };

  // 分隔符判定：优先制表符（从 Excel/飞书直接复制就是 TSV），
  // 否则按逗号；都没命中就当单列。
  const lines = raw.split('\n').filter(l => l.trim());
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(',') ? ',' : '\t');

  const cells = lines.map(l => l.split(delim).map(c => c.trim()));

  const cols = parseHeaderRow(cells[0]);
  if (!cols.length) {
    return {
      columns: [], rows: [],
      errors: ['表头一行都没识别出来。请确认第一行是列名（如「图片 / 价格 / 数量 / 材质」），'
        + '且每行用同一个分隔符（从 Excel 复制请保持制表符）。']
    };
  }

  // 关键字段存在性检查 —— 缺这几列就没法建草稿
  const has = f => cols.some(c => c.field === f);
  const missing = [];
  if (!has('images')) missing.push('图片文件名');
  if (!has('price')) missing.push('价格');
  if (!has('quantity')) missing.push('数量');

  const rows = [];
  for (let r = 1; r < cells.length; r++) {
    const row = cells[r];
    if (!row.some(c => c)) continue;            // 跳过整行空
    const get = f => {
      const c = cols.find(x => x.field === f);
      return c ? (row[c.index] || '') : '';
    };

    const imagesRaw = get('images');
    const item = {
      _row: r + 1,
      sku: get('sku'),
      images: imagesRaw.split(/[,;、\n]/).map(s => s.trim()).filter(Boolean),
      title: get('title'),
      description: get('description'),
      tags: parseTagsCell(get('tags')),
      price: get('price').trim(),
      quantity: get('quantity').trim(),
      who_made: parseWhoMade(get('who_made')),
      when_made: parseWhenMade(get('when_made')),
      is_supply: parseSupply(get('is_supply')),
      materials: parseTagsCell(get('materials')),
      taxonomy_id: get('taxonomy_id').trim(),
      //★ get() 要用**别名表右侧的字段名**（parseHeaderRow 返回的 field），
      //   不是别名左侧的表头写法。写错时整列静默读成空 —— 不报错、只是值全丢，
      //   自测就是靠这个断言抓到的。
      item_weight: parseNumCell(get('item_weight')),
      item_weight_unit: (get('item_weight_unit') || 'g').trim().toLowerCase(),
      item_length: parseNumCell(get('item_length')),
      item_width: parseNumCell(get('item_width')),
      item_height: parseNumCell(get('item_height')),
      item_dimensions_unit: (get('item_dimensions_unit') || 'cm').trim().toLowerCase(),
      production_partner_ids: get('production_partner_ids').trim(),
      audience_note: get('audience_note').trim(),
      shop_section_id: get('shop_section_id').trim(),
      return_policy_id: get('return_policy_id').trim(),
      variations_json: get('variations').trim(),
    };

    // 逐行的字段级问题（不阻断导入，但要明确告诉用户哪一行有问题）
    const problems = [];
    if (!item.images.length) problems.push('缺图片文件名');
    if (!parseNumCell(item.price)) problems.push(`价格「${item.price}」不是有效数字`);
    if (!parseNumCell(item.quantity)) problems.push(`数量「${item.quantity}」不是有效数字`);
    if (!item.who_made) problems.push('制作方无法识别（可填 i_did / someone_else / collective）');
    if (!item.when_made) problems.push('制作时间无法识别（可填 made_to_order / 2020_2026）');
    item._problems = problems;
    rows.push(item);
  }

  const errors = [];
  if (missing.length) {
    errors.push('表格缺少必需列：' + missing.join('、')
      + '。这三个是建草稿的硬性要求，其余列可留空。');
  }
  if (!rows.length) errors.push('除了表头之外没有数据行');

  return { columns: cols, rows, errors };
}

/* 把解析结果套进页面的表单（单条预览用）。
 * 只填「识别到的字段」，不碰用户已经手填的内容。 */
function applyImportRow(item) {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
  set('fTitle', item.title);
  set('fDesc', item.description);
  set('fTags', item.tags.join(', '));
  set('fPrice', item.price);
  set('fQty', item.quantity);
  set('fMat', item.materials.join(', '));
  set('fAudience', item.audience_note);
  set('fPartner', item.production_partner_ids);
  if (item.taxonomy_id) set('fTax', item.taxonomy_id);
  const setSel = (id, v) => { if (!v) return; const el = document.getElementById(id); if (el) el.value = v; };
  setSel('fWho', item.who_made);
  setSel('fWhen', item.when_made);
  setSel('fWeightUnit', item.item_weight_unit);
  setSel('fDimUnit', item.item_dimensions_unit);
  if (item.item_weight != null) set('fWeight', item.item_weight);
  if (item.item_length != null) set('fLen', item.item_length);
  if (item.item_width != null) set('fWid', item.item_width);
  if (item.item_height != null) set('fHgt', item.item_height);
  const chk = document.getElementById('fSupply');
  if (chk && item.is_supply != null) chk.checked = item.is_supply;
}

/* ---------- AI 返回内容的解析 ----------
 *
 * 为什么要单独抽出来：这个解析最容易出错，而且出错时**静默丢内容**——
 * 模型返回了完整文案，页面却显示标题空、描述空，看起来像「AI 什么都没生成」。
 * 抽成独立纯函数后可以独立测试，也能在前后端复用。
 *
 * 容错要点（都是模型真实会犯的错）：
 *   - 可能用 markdown 粗体：`**TITLE:**`
 *   - 可能多输出说明文字（"以下是生成的 Listing："）
 *   - 描述里可能含冒号（"尺寸: 27cm"）→ 必须用「下一个已知段标题」做终止条件，
 *     而不能用「第一个冒号」
 *   - 标签可能用换行分隔而非逗号
 */
function parseAiCopy(content) {
  const raw = String(content || '');
  const out = { raw, title: '', description: '', tags: [] };
  if (!raw.trim()) return { ...out, parsed: false, empty: true };

  /* 找段起点。★ 必须返回**段标题之后的真实内容起点**，
   *   而不只是段标题的位置 —— 否则切片会把 "TITLE:" 这几个字符带进内容里
   *   （自测抓到过：标题变成 "TITLE:** Wolf Fursuit Head Mask"）。
   *   matchAll + lastIndex 组合能直接给出内容起点。 */
  const findSeg = (name) => {
    const re = new RegExp('^[ \\t]*(?:\\*\\*)?[ \\t]*' + name + '[ \\t]*(?:\\*\\*)?[ \\t]*[:：][ \\t]*', 'im');
    const m = re.exec(raw);
    return m ? { start: m.index, body: m.index + m[0].length } : null;
  };
  const tSeg = findSeg('TITLE');
  const dSeg = findSeg('DESCRIPTION');
  const gSeg = findSeg('TAGS');

  const clean = (s) => String(s || '')
    .replace(/^\s*\*\*|\*\*\s*$/g, '')     // 去 markdown 粗体
    .replace(/^[\s*_#`"'“”‘’]+|[\s*_#`"'“”‘’]+$/g, '')  // 去首尾装饰符
    .trim();

  if (tSeg) {
    // 标题到下一段（DESCRIPTION 或 TAGS）之前；只取第一行
    const end = dSeg ? dSeg.start : (gSeg ? gSeg.start : raw.length);
    out.title = clean(raw.slice(tSeg.body, end)).split('\n')[0].trim();
  }
  if (dSeg) {
    const end = gSeg ? gSeg.start : raw.length;
    out.description = clean(raw.slice(dSeg.body, end));
    // 描述里的换行保留（段落感），但去掉多余空行
    out.description = out.description.replace(/\n{3,}/g, '\n\n');
  }
  if (gSeg) {
    out.tags = raw.slice(gSeg.body)
      .split(/[,，\n]/)
      .map(x => clean(x))
      .filter(Boolean)
      .slice(0, 13);
  }

  // ★ 必须真解析出东西才算成功。parsed=false 时前端要显示 raw 原文，
  //   而不是给用户三个空框（那样会误以为 AI 没生成）。
  out.parsed = Boolean(out.title || out.description || out.tags.length);
  return out;
}
