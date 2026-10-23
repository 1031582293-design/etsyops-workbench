/* ===================== 模板中文 → 英文 翻译引擎 =====================
 *
 * 为什么单独抽出来：
 *   上传模板里「材质 / 变体维度 / 变体值 / 属性 / 类目关键词」等字段，
 *   店主习惯填中文，但 Etsy 只收英文。这些字段不是「整句翻译」，而是
 *   「术语直替 + 结构化拆分」，通用翻译引擎一定会翻歪（兽装→beast costume）。
 *   所以分两层：
 *     1) 术语表（glossary）：确定性地直替 fursuit 专有名词 + Etsy 属性名，
 *        不经过任何模型，绝不翻错；
 *     2) 引擎（TMT 机器翻译 / AI 精翻）：术语表没覆盖到的残留中文才交给引擎。
 *
 * 术语表可被 data/translate-glossary.json 覆盖（店主自己增删），
 * 结构是 { "中文": "English" }，服务端加载时 merge 到默认表之上。
 *
 * 零依赖：只用 Node 内置 crypto / https。
 */

import * as crypto from 'crypto';
import * as https from 'https';

/* ---------- 默认术语表 ----------
 * 分两类混在一个表里（加载时不分家，最长匹配自动处理优先级）：
 *   A. Etsy 属性名（变体维度 dim / 普通属性 attr 的「名」）→ 英文属性名
 *   B. fursuit / 手工 通用术语（自由文本直替）→ 英文叫法 */
export const DEFAULT_GLOSSARY = {
  // —— Etsy 变体属性名 / 普通属性名（dim、attr 的「名」用）——
  '颜色': 'Primary color', '主色': 'Primary color', '颜色名': 'Primary color',
  '尺寸': 'Size', '尺码': 'Size', '大小': 'Size',
  '材质': 'Material', '材料': 'Material',
  '风格': 'Style', '款式': 'Style',
  '长度': 'Length', '宽度': 'Width', '高度': 'Height',
  '容量': 'Capacity', '重量': 'Weight', '版本': 'Version',
  // —— fursuit / 手工 通用术语 ——
  '兽装': 'fursuit', '兽头': 'fursuit head', '兽头底': 'head base', '头基': 'head base',
  '爪子': 'paws', '爪': 'paw', '尾巴': 'tail',
  '树脂眼睛': 'resin eyes', '树脂眼': 'resin eyes', '眼睛': 'eyes',
  '羊毛毡': 'needle felt', '针毡': 'needle felt',
  '软陶': 'polymer clay', '3D打印': '3D printed',
  '泡棉': 'foam', 'EVA泡棉': 'EVA foam', '三明治网布': 'sandwich mesh',
  '松紧带': 'elastic', '拉链': 'zipper', '刺绣': 'embroidery',
  '手工': 'handmade', '手工制作': 'handmade', '手作': 'handmade',
  '定制': 'custom', '可定制': 'customizable', '按需定制': 'made to order',
  '陶瓷': 'ceramic', '马克杯': 'mug', '纪念牌': 'plaque', '宠物': 'pet',
};

/* 判断是否含中文（CJK 统一表意文字）。 */
export function hasCJK(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text == null ? '' : text));
}

/* 用户术语表 merge 到默认表之上（用户的同名条目优先）。 */
export function loadGlossary(extra) {
  const out = Object.assign({}, DEFAULT_GLOSSARY);
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* 术语表直替：把文本里命中的术语按「最长优先」替换成英文。
 * 单遍扫描 —— 替换结果是英文、不含中文，不会被二次替换。
 * 大小写不敏感（i 标志），这样「eva泡棉」「3d打印」也能命中「EVA泡棉」「3D打印」。 */
export function applyGlossary(text, glossary) {
  const src = String(text == null ? '' : text);
  if (!src) return src;
  const keys = Object.keys(glossary)
    .filter(k => k)
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return src;
  const re = new RegExp(keys.map(escapeRegExp).join('|'), 'gi');
  return src.replace(re, (m) => {
    // 命中的原文大小写可能不同（eva泡棉），需要按「实际命中」回查原值：
    const hit = keys.find(k => k.toLowerCase() === m.toLowerCase());
    return hit ? glossary[hit] : m;
  });
}

/* 变体维度名：术语表直替（属性名映射）。若仍有中文，交由引擎兜底。 */
export function translateDim(text, glossary) {
  return applyGlossary(text, glossary);
}

/* 普通属性列：格式「属性名=值;属性名=值」。
 *   - 属性名：术语表直替（Material），仍有中文再交给引擎；
 *   - 属性值：术语表直替 + 引擎。
 * 统一走 viaEngine：术语表直替后无中文就跳过引擎（与 translateField 一致）。 */
export async function translateAttr(text, glossary, engine) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  const viaEngine = async (t) => {
    const g = applyGlossary(t, glossary);
    return hasCJK(g) ? await engine(g) : g;
  };
  const parts = raw.split(/[;；]/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) { out.push(await viaEngine(part)); continue; }
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    const finalName = await viaEngine(name);
    const enVal = await viaEngine(val);
    out.push(finalName + '=' + enVal);
  }
  return out.join('; ');
}

/* field 感知的翻译入口。field ∈ material / dim / varval / attr / keyword / note */
export async function translateField(field, text, glossary, engine) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  if (!hasCJK(raw)) return raw;   // 已经是英文，原样返回，绝不碰
  switch (field) {
    case 'dim': {
      const out = translateDim(raw, glossary);
      return hasCJK(out) ? await engine(out) : out;
    }
    case 'attr':
      return translateAttr(raw, glossary, engine);
    default: {   // material / varval / keyword / note
      const out = applyGlossary(raw, glossary);
      return hasCJK(out) ? await engine(out) : out;
    }
  }
}

/* ---------- 引擎：腾讯云机器翻译 TMT（TC3-HMAC-SHA256） ---------- */

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmacSha(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function httpsRequest(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('腾讯云 TMT HTTP ' + res.statusCode + '：' + data.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('腾讯云 TMT 连接超时（' + timeoutMs + 'ms）')));
    req.write(body);
    req.end();
  });
}

/* 生成 TC3-HMAC-SHA256 签名头（纯函数，不碰网络，便于单测）。
 * 返回 { headers, payload, timestamp, date }。timestamp 可由调用方传入做确定性测试。 */
export function tmtSignedHeaders(payload, opts = {}) {
  const { secretId, secretKey, region = 'ap-guangzhou', timestamp } = opts;
  if (!secretId || !secretKey) throw new Error('腾讯云 TMT 未配置：.env 需要 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
  const host = 'tmt.tencentcloudapi.com';
  const service = 'tmt';
  const action = 'TextTranslate';
  const version = '2018-03-21';
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256hex(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp2str(ts)}\n${credentialScope}\n${sha256hex(canonicalRequest)}`;
  const secretDate = hmacSha('TC3' + secretKey, date);
  const secretService = hmacSha(secretDate, service);
  const secretSigning = hmacSha(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    payload,
    timestamp: ts,
    date,
    stringToSign,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(ts),
      'X-TC-Version': version,
      'X-TC-Region': region,
      'Authorization': authorization,
    },
  };
}

function timestamp2str(ts) { return String(ts); }

/* 单条中文 → 英文（TextTranslate，Source=auto Target=en）。transport 可注入用于单测。 */
export async function translateTMT(text, opts = {}) {
  const { secretId, secretKey, region = 'ap-guangzhou', timeoutMs = 15000, transport } = opts;
  const payload = JSON.stringify({ SourceText: text, Source: 'auto', Target: 'en', ProjectId: 0 });
  const signed = tmtSignedHeaders(payload, { secretId, secretKey, region });
  const host = 'tmt.tencentcloudapi.com';

  const body = await (transport || httpsRequest)({
    hostname: host, path: '/', method: 'POST', headers: signed.headers,
  }, payload, timeoutMs);

  let d;
  try { d = JSON.parse(body); } catch { throw new Error('腾讯云 TMT 返回非 JSON：' + body.slice(0, 200)); }
  if (d && d.Response && d.Response.Error) {
    throw new Error('腾讯云 TMT 报错：' + d.Response.Error.Code + ' ' + d.Response.Error.Message);
  }
  const out = d && d.Response && d.Response.TargetText;
  if (typeof out !== 'string' || !out) throw new Error('腾讯云 TMT 返回异常：' + body.slice(0, 200));
  return out;
}

/* ---------- 引擎：AI 精翻（OpenAI 兼容 chat） ----------
 * aiFn 是 (system, user) => Promise<string>，由调用方注入（server.js 的 etsyAiGenerate）。 */
export async function translateViaAI(aiFn, text) {
  if (typeof aiFn !== 'function') throw new Error('未配置 AI，无法精翻（可直接在字段里手填英文）');
  const sys = '你是 Etsy 商品字段翻译器。把下面的中文翻成地道的英文（Etsy listing 用语）。'
    + '规则：1) 只输出翻译后的英文，不要解释、不要引号、不要编号、不要重复原文；'
    + '2) 专有名词保持原样（如 EVA、fursuit）；3) 短词用 Etsy 通用叫法'
    + '（例：陶瓷→ceramic；羊毛毡→needle felt；兽装头套→fursuit head）。';
  const out = await aiFn(sys, '中文：' + text + '\n英文：');
  const en = cleanAiEn(out);
  if (!en) throw new Error('AI 没给出可用英文（原始输出：' + String(out || '').slice(0, 80) + '）');
  return en;
}

function cleanAiEn(out) {
  let s = String(out == null ? '' : out).split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
  s = s
    .replace(/^[\s`"'*•\-–—]+/, '')
    .replace(/[\s`"'*。，,；;：:]+$/, '')
    .replace(/^\d+[.、)\]]\s*/, '')
    .replace(/^(english|en|translation|translate|英文|翻译)\s*[:：]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (hasCJK(s)) return '';   // 还带中文 = 翻译失败
  if (!/[a-z]/i.test(s)) return '';
  return s;
}

/* ---------- 引擎工厂：术语表先直替，残留中文才交给引擎 ---------- */

export function makeTmtEngine(glossary, opts) {
  return async (text) => {
    const g = applyGlossary(text, glossary);
    if (!hasCJK(g)) return g;
    return translateTMT(g, opts);
  };
}

export function makeAiEngine(glossary, aiFn) {
  return async (text) => {
    const g = applyGlossary(text, glossary);
    if (!hasCJK(g)) return g;
    return translateViaAI(aiFn, g);
  };
}

/* ---------- 批量：并发池 + 单条错误隔离 ----------
 * items: [{ field, text }]；返回与输入等长的 [{ field, zh, en, ok, note? }]。
 * 任一条失败不影响其余（note 记录原因），页面据此显示「哪几条没翻成」。 */
export async function translateAll(items, glossary, engine, { concurrency = 6 } = {}) {
  const arr = items || [];
  const out = new Array(arr.length);
  let cursor = 0;
  async function worker() {
    while (cursor < arr.length) {
      const i = cursor++;
      const it = arr[i];
      try {
        out[i] = { field: it.field, zh: it.text, en: await translateField(it.field, it.text, glossary, engine), ok: true };
      } catch (e) {
        out[i] = { field: it.field, zh: it.text, en: '', ok: false, note: String((e && e.message) || e) };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, arr.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
