// Etsy 字段变更监控（零依赖，只用 Node 内置模块）。
//
// 为什么需要它：Etsy 官方字段/枚举会变，工作台写死的下拉字典、后端校验、
// 下载模板 31 列都要跟着改。靠人肉盯官网不现实，这里自动盯官方 OpenAPI spec。
//
// 分三层（成本由低到高）：
//   V1 时间戳探查 —— 拉 spec 看 x-last-validated，和本地缓存比，变了才深入。
//   V2 差异 diff   —— 时间戳变了后，把「工作台写死的枚举」和「官方 spec 当前值」
//                     对比，报出具体哪个枚举/必填/类型变了。
//   错误归类       —— 建草稿失败时，从 Etsy 400 原文抓「字段/枚举疑似变更」关键词。
//
// 铁律（踩坑教训）：任何附属功能都不能拖垮上架主流程。
//   - 拉不到 spec → 静默降级（status=unchecked），绝不抛错、绝不阻塞。
//   - diff 宁可漏报、不可误报（拿不准的一律不报）。

import https from 'node:https';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------- 多源

// 优先级：官方 JSON 优先（能零依赖 JSON.parse，结构稳定）；YAML 源只做 V1 时间戳，
// 因为零依赖下不解析 YAML 结构，V2 完整 diff 只在拿到官方 JSON 时才做。
export const SCHEMA_SOURCES = [
  { name: 'etsy-official-json', url: 'https://www.etsy.com/openapi/generated/oas/3.0.0.json', json: true },
  { name: 'apievangelist-yaml', url: 'https://apis.apievangelist.com/store/etsy-shoplisting-api/etsy-shoplisting-api-openapi.yaml', json: false },
  { name: 'github-yaml', url: 'https://raw.githubusercontent.com/api-evangelist/etsy/refs/heads/main/openapi/etsy-shoplisting-api-openapi.yml', json: false },
];

// ---------------------------------------------------------------- 基准快照

// 工作台写死的枚举基准（与 etsy-api.js 的 WHEN_MADE_ENUM、前端下拉保持同步）。
// diff 就是「这份基准 vs 官方 spec 当前值」：平台改了、工作台还写旧值，就会被报出来。
export const BASELINE = {
  // createDraftListing 的 required 字段（官方 spec 明示的 7 个）
  required: ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id'],
  enums: {
    when_made: {
      type: 'string',
      enum: ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007',
        '2000_2006', '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s',
        '1920s', '1910s', '1900s', '1800s', '1700s', 'before_1700'],
    },
    who_made: { type: 'string', enum: ['i_did', 'collective', 'someone_else'] },
    item_type: { type: 'string', enum: ['physical', 'digital'] },
    item_weight_unit: { type: 'string', enum: ['g', 'kg', 'oz', 'lb'] },
    item_dimensions_unit: { type: 'string', enum: ['cm', 'mm', 'm', 'in'] },
  },
};

// ---------------------------------------------------------------- 拉取

// 直连拉文本（内置 https/http）。超时或失败一律返回 ok=false，不抛错 ——
// 拉不到 spec 只降级，不影响上架。跟随重定向最多 3 跳。
function fetchText(url, timeoutMs = 15000, redirects = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, text: '' }); }
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(u, {
      headers: { 'User-Agent': 'etsyops-schema-check/1.0', Accept: '*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(fetchText(next, timeoutMs, redirects + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, status: 0, text: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, text: '' }));
  });
}

// ---------------------------------------------------------------- 解析

// 提取 x-last-validated 时间戳（JSON 与 YAML 通用：两种引号/冒号都兼容）。
export function extractLastValidated(text) {
  if (!text) return null;
  const m = String(text).match(/x-last-validated["']?\s*[:=]\s*["']?([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  return m ? m[1] : null;
}

// 从官方 JSON 提取 createDraftListing 的 requestBody schema。
// 官方 3.0.0.json 是聚合 spec（28 个子模块拼一起），createDraftListing 藏在
// paths[*].post.operationId === 'createDraftListing' 里，逐个找。
export function extractDraftSchema(spec) {
  try {
    const paths = spec && spec.paths;
    if (!paths || typeof paths !== 'object') return null;
    for (const key of Object.keys(paths)) {
      const item = paths[key];
      if (!item || typeof item !== 'object') continue;
      for (const method of ['post', 'put']) {
        const op = item[method];
        if (op && op.operationId === 'createDraftListing') {
          const content = (op.requestBody || {}).content || {};
          const schema = (content['application/x-www-form-urlencoded']
            || content['application/json'] || {}).schema;
          if (schema) {
            return {
              required: Array.isArray(schema.required) ? schema.required.map(String) : [],
              properties: schema.properties || {},
            };
          }
        }
      }
    }
  } catch { /* 解析失败按「拿不到」处理 */ }
  return null;
}

// 取某个字段的 type + enum（enum 全部转字符串，避免数字枚举比对类型不一致）。
function fieldInfo(draftSchema, fieldName) {
  const p = draftSchema && draftSchema.properties && draftSchema.properties[fieldName];
  if (!p || typeof p !== 'object') return null;
  return {
    type: p.type || null,
    enum: Array.isArray(p.enum) ? p.enum.map(String) : null,
  };
}

// ---------------------------------------------------------------- diff（纯函数）

// 对比「工作台基准」与「官方 spec 当前值」，输出差异列表。
// 宁可漏报不误报：remote 提取失败/字段结构对不上时，返回 changed=false。
export function diffSchema(remoteDraft, baseline = BASELINE) {
  const changes = [];
  if (!remoteDraft) return { changed: false, changes, note: 'no_schema' };

  const props = remoteDraft.properties || {};
  // properties 为空 = 提取失败/结构不对，直接不报（防误报）
  if (Object.keys(props).length === 0) return { changed: false, changes, note: 'empty_properties' };

  // 1) required 增删
  const bReq = baseline.required || [];
  const rReq = remoteDraft.required || [];
  const addedReq = rReq.filter((x) => !bReq.includes(x));
  const removedReq = bReq.filter((x) => !rReq.includes(x));
  if (addedReq.length) changes.push({ kind: 'required_added', field: null, detail: '新增必填：' + addedReq.join(', ') });
  if (removedReq.length) changes.push({ kind: 'required_removed', field: null, detail: '取消必填：' + removedReq.join(', ') });

  // 2) 枚举 + 类型 diff
  for (const field of Object.keys(baseline.enums || {})) {
    const b = baseline.enums[field];
    const r = fieldInfo(remoteDraft, field);
    if (!r) {
      // 字段在官方 spec 里找不到：可能是「真被删了」，也可能是路径差异。
      // 只有在我们能确认「properties 里确实没有这个 key」时才报 —— 这里已在上面的
      // empty_properties 保护里兜住大结构错误；单字段缺失仍视为「字段被移除」。
      changes.push({ kind: 'field_removed', field, detail: field + '：官方 spec 里已无此字段' });
      continue;
    }
    if (r.type && b.type && String(r.type) !== String(b.type)) {
      changes.push({ kind: 'type_changed', field, detail: field + ' 类型：' + b.type + ' → ' + r.type });
    }
    if (Array.isArray(r.enum)) {
      const bEnum = b.enum || [];
      const added = r.enum.filter((x) => !bEnum.includes(x));
      const removed = bEnum.filter((x) => !r.enum.includes(x));
      if (added.length) changes.push({ kind: 'enum_added', field, detail: field + ' 新增枚举：+' + added.join(', ') });
      if (removed.length) changes.push({ kind: 'enum_removed', field, detail: field + ' 移除枚举：-' + removed.join(', ') });
    }
  }

  return { changed: changes.length > 0, changes };
}

// ---------------------------------------------------------------- 错误归类

// 从 Etsy 400/403 错误原文抓「疑似字段/枚举变更」关键词。
// 返回 { suspected, reason } —— 只做标记，不拦截任何流程。
export function classifySchemaError(message) {
  if (!message) return { suspected: false };
  const s = String(message);
  const hit = /unknown field|unexpected field|unrecognized field|field .{0,40} not (recognized|found)|invalid enum|not a valid enum|unexpected value|is not one of|invalid value|does not exist/i;
  if (hit.test(s)) {
    return { suspected: true, reason: '疑似 Etsy 字段/枚举变更，或传值不在当前合法范围内' };
  }
  return { suspected: false };
}

// ---------------------------------------------------------------- 完整流程

// 缓存文件结构：{ lastValidated, lastChecked(YYYY-MM-DD), status, changes }
function readCache(cacheFile) {
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return null; }
}
function writeCache(cacheFile, data) {
  try { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(data, null, 2)); } catch { /* 写不进也不影响 */ }
}

function todayStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 执行一次字段探查。依赖注入（fetchFn / readCacheFn / writeCacheFn / nowFn）便于自测。
 * 返回 { status, lastValidated, checkedAt, source, changes }。
 *   status: 'ok'            —— spec 正常、时间戳未变（或首次建立基线）
 *           'changed'       —— 时间戳变了，且 diff 出具体差异
 *           'changed_unknown' —— 时间戳变了，但无法解析出具体差异（非 JSON 源或结构不符）
 *           'unchecked'     —— 拉不到 spec，静默降级
 */
export async function runSchemaCheck(opts = {}) {
  const {
    cacheFile,
    fetchFn = fetchText,
    readCacheFn = readCache,
    writeCacheFn = writeCache,
    nowFn = () => new Date(),
    log = () => {},
  } = opts;

  const prev = readCacheFn(cacheFile);
  const now = nowFn();
  const today = todayStr(now);

  // 当天已经查过 → 直接返回上次结果，避免一天开三次重复拉
  if (prev && prev.lastChecked === today) {
    return {
      status: prev.status || 'ok',
      lastValidated: prev.lastValidated || null,
      checkedAt: prev.checkedAt || null,
      source: prev.source || null,
      changes: prev.changes || [],
    };
  }

  let lastValidated = null;
  let source = null;
  let specJson = null;

  for (const src of SCHEMA_SOURCES) {
    let r;
    try { r = await fetchFn(src.url); } catch { r = { ok: false, text: '' }; }
    if (!r || !r.ok || !r.text) continue;
    const lv = extractLastValidated(r.text);
    if (!lv) continue;
    lastValidated = lv;
    source = src.name;
    if (src.json) {
      try { specJson = JSON.parse(r.text); } catch { specJson = null; }
    }
    break;
  }

  if (!lastValidated) {
    const res = { status: 'unchecked', lastValidated: null, checkedAt: now.toISOString(), source: null, changes: [] };
    writeCacheFn(cacheFile, { ...res, lastChecked: today });
    log('Etsy 字段校验：本次未校验（拉不到官方 spec，不影响上架）');
    return res;
  }

  const changed = prev && prev.lastValidated && prev.lastValidated !== lastValidated;

  let result;
  if (!changed) {
    // 时间戳未变（或首次建立基线）：正常
    result = { status: 'ok', lastValidated, checkedAt: now.toISOString(), source, changes: [] };
    log(`Etsy 字段校验：正常（spec x-last-validated=${lastValidated}，来源 ${source}）`);
  } else {
    // 时间戳变了：尝试 diff
    const draft = specJson ? extractDraftSchema(specJson) : null;
    if (draft) {
      const d = diffSchema(draft);
      if (d.changed) {
        result = { status: 'changed', lastValidated, checkedAt: now.toISOString(), source, changes: d.changes };
        log('⚠️ Etsy 字段有变化：' + d.changes.map((c) => c.detail).join('；'));
      } else {
        result = { status: 'ok', lastValidated, checkedAt: now.toISOString(), source, changes: [] };
        log(`Etsy 字段校验：spec 更新到 ${lastValidated}，但关注的字段无差异`);
      }
    } else {
      result = { status: 'changed_unknown', lastValidated, checkedAt: now.toISOString(), source, changes: [] };
      log(`⚠️ Etsy spec 更新到 ${lastValidated}（旧值 ${prev.lastValidated}），但本次无法解析出具体差异（来源 ${source}）`);
    }
  }

  writeCacheFn(cacheFile, { ...result, lastChecked: today });
  return result;
}

export { fetchText };
