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
  // 类目关键词（英文物品名）：Agent 自动搜 taxonomy 并选最末级叶子，比手填数字 ID 更省心
  taxonomy_keyword:'taxonomy_keyword', 类目关键词:'taxonomy_keyword', '类目关键字':'taxonomy_keyword',
  category_keyword:'taxonomy_keyword',
  // 个性化定制：是/否 → is_customizable
  is_customizable:'is_customizable', 是否定制:'is_customizable', 定制:'is_customizable',
  customizable:'is_customizable', '是否可定制':'is_customizable', 个性化:'is_customizable',
  // 变体维度（英文属性名，逗号分隔）：Agent 自动匹配类目属性（property_id / value_id）
  variation_dims:'variation_dims', 变体维度:'variation_dims', '变体属性':'variation_dims',
  'variation dimensions':'variation_dims',
  // 变体组合行（编号留空的那几行）的 SKU 列；价格/库存复用主表的「价格/数量」列
  variant_sku:'variant_sku', 变体sku:'variant_sku', '变体 sku':'variant_sku',
  'variation sku':'variant_sku', '组合sku':'variant_sku',
  // 普通属性（不做变体，只描述商品特征）：格式「属性名=值」分号分隔，如 Primary color=Blue; Style=Rustic
  attributes:'attributes_json', 属性:'attributes_json', 普通属性:'attributes_json',
  '商品属性':'attributes_json', 'attributes':'attributes_json',
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
  // 商品类型：physical（实物）/ digital（数字文件）
  item_type:'item_type', 商品类型:'item_type', 类型:'item_type', type:'item_type',
  'item type':'item_type', 实物或数字:'item_type',
  // 交付文件名（仅数字商品；文件字节要在页面上传，表格只记名字便于对号）
  files:'digital_file_names', 交付文件:'digital_file_names', 交付文件名:'digital_file_names',
  'digital files':'digital_file_names',
  // 店铺级编码：给料时就可以带上，省一次手选。解析后用店铺模板库校验，
  // 不在库里的 ID 会在卡片上标红（写错编码 = 建草稿被 Etsy 拒）。
  ship:'shipping_profile_id', 'shipping profile':'shipping_profile_id',
  配送模板:'shipping_profile_id', 配送模板id:'shipping_profile_id',
  ready:'readiness_state_id', 'processing profile':'readiness_state_id',
  处理档案:'readiness_state_id', 处理档案id:'readiness_state_id',
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

/* 解析 item_type：实物 physical / 数字文件 digital。
 * 默认 physical —— 现在绝大多数链接是实物，空值按实物处理不会误伤老表格。 */
function parseItemType(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return 'physical';
  if (/digital|数字|虚拟|下载|电子/.test(t)) return 'digital';
  if (/physical|实物|实体/.test(t)) return 'physical';
  return 'physical';
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

  /* 引号感知切分：CSV 里 "EVA, 三明治网布" 这种带逗号的字段，
     直接 split 会把一格切成两格，后面所有列全部错位（真实踩过：
     解析结果里材质显示成 "EVA、净重列拿到 g）。引号内的分隔符不切，
     "" 转义成 "。没有引号的行走原来的快速路径。 */
  function splitLine(line) {
    if (!line.includes('"')) return line.split(delim).map(c => c.trim());
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === delim) {
        out.push(cur.trim()); cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  const cells = lines.map(splitLine);

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
  const orphanVarLines = [];   // 变体组合行出现在第一个条目之前（没有归属）
  for (let r = 1; r < cells.length; r++) {
    const row = cells[r];
    if (!row.some(c => c)) continue;            // 跳过整行空
    const get = f => {
      const c = cols.find(x => x.field === f);
      return c ? (row[c.index] || '') : '';
    };
    const skuCell = get('sku').trim();
    const vdimsRaw = get('variation_dims').trim();

    /* 变体组合行：编号留空、变体维度列有值 → 不生成独立条目，
     * 归属上一条目，一行一个组合（值顺序 = 主行「变体维度」列的维度名顺序）。
     * 价格/库存复用「价格/数量」列，SKU 用「变体SKU」列。
     * 解析成 item._varTable = { dims, rows }，第 4 步选类目后自动映射 Etsy 属性。 */
    if (!skuCell && vdimsRaw){
      const last = rows[rows.length - 1];
      if (!last){ orphanVarLines.push(r + 1); continue; }
      if (!last._varTable){
        last._problems.push('第 ' + (r + 1) + ' 行是变体组合，但该条目的「变体维度」列没填维度名，这行组合被丢弃');
        continue;
      }
      last._varTable.rows.push({
        values: vdimsRaw.split(/[,;、]/).map(s => s.trim()),
        sku: get('variant_sku').trim(),
        price: get('price').trim(),
        quantity: get('quantity').trim(),
      });
      continue;
    }

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
      // 类目关键词（Agent 自动搜 taxonomy 选叶子）、定制开关、变体维度（英文属性名）
      taxonomy_keyword: get('taxonomy_keyword').trim(),
      is_customizable: parseSupply(get('is_customizable')),
      variation_dims: parseTagsCell(get('variation_dims')),
      attributes_json: get('attributes_json').trim(),
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
      item_type: parseItemType(get('item_type')),
      digital_file_names: get('digital_file_names').trim(),
      shipping_profile_id: get('shipping_profile_id').trim(),
      readiness_state_id: get('readiness_state_id').trim(),
      shop_section_id: get('shop_section_id').trim(),
      return_policy_id: get('return_policy_id').trim(),
      variations_json: get('variations_json').trim(),
    };

    // 主行声明了变体维度名 → 初始化变体表容器，后面编号留空的行就是它的组合
    if (item.variation_dims.length) item._varTable = { dims: item.variation_dims.slice(), rows: [] };

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
  if (orphanVarLines.length) {
    errors.push('第 ' + orphanVarLines.join('、') + ' 行是变体组合（编号留空），但前面没有任何条目可以归属');
  }

  return { columns: cols, rows, errors };
}

/* 把某一条条目套进页面表单。
 * ★ 有 item._form 时以它为准（那是用户在这条上编辑过的版本），
 *   没有才用导入时的原始值 —— 这样切换条目不会把手改的内容冲掉。
 * ★ 这里对空值也写进去：切到另一条时，上一条的标题必须被清掉，
 *   否则会出现「A 的标题配 B 的价格」这种串条错误。 */
function applyImportRow(item) {
  const src = item._form || item;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); };
  set('fTitle', src.title);
  set('fDesc', src.description);
  set('fTags', (src.tags || []).join('\n'));
  set('fPrice', src.price);
  set('fQty', src.quantity);
  set('fMat', (src.materials || []).join(', '));
  set('fAudience', src.audience_note);
  set('fPartner', src.production_partner_ids);
  set('fWeight', src.item_weight);
  set('fLen', src.item_length);
  set('fWid', src.item_width);
  set('fHgt', src.item_height);
  const setSel = (id, v, keepIfEmpty) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (v == null || v === '') { if (!keepIfEmpty) el.selectedIndex = 0; return; }
    el.value = v;
  };
  setSel('fWho', src.who_made, true);          // 制作方/时间是全局假设，别清空
  setSel('fWhen', src.when_made, true);
  setSel('fWeightUnit', src.item_weight_unit);
  setSel('fDimUnit', src.item_dimensions_unit);
  setSel('fItemType', src.item_type || 'physical');
  setSel('fShip', src.shipping_profile_id);
  setSel('fReady', src.readiness_state_id);
  setSel('fSection', src.shop_section_id);
  setSel('fReturn', src.return_policy_id);
  setSel('fSupply', src.is_supply == null ? null : (src.is_supply ? 'true' : 'false'));
  if (item.taxonomy_id) set('fTax', item.taxonomy_id);
}

/* 把当前表单的值收集回该条目（切条目前调用）。
 * 字段名与页面 collectForm() 保持一致，这样 _form 可以直接再喂给 applyImportRow。 */
function collectImportRowForm() {
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const num = v => { const n = Number(String(v).replace(/,/g, '').trim()); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    title: val('fTitle'), description: val('fDesc'),
    tags: val('fTags').split('\n').map(s => s.trim()).filter(Boolean),
    price: val('fPrice'), quantity: val('fQty'),
    materials: val('fMat').split(/[,，]/).map(s => s.trim()).filter(Boolean),
    audience_note: val('fAudience'), production_partner_ids: val('fPartner'),
    item_weight: num(val('fWeight')), item_weight_unit: val('fWeightUnit'),
    item_length: num(val('fLen')), item_width: num(val('fWid')), item_height: num(val('fHgt')),
    item_dimensions_unit: val('fDimUnit'),
    item_type: val('fItemType') || 'physical',
    who_made: val('fWho'), when_made: val('fWhen'),
    is_supply: val('fSupply') === 'true',
    shipping_profile_id: val('fShip'), readiness_state_id: val('fReady'),
    shop_section_id: val('fSection'), return_policy_id: val('fReturn'),
    taxonomy_id: val('fTax'),
    is_customizable: (document.getElementById('fCustom') || {}).checked || false,
  };
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
