// 字段变更监控自测：mock 拉取 + 纯函数 diff，不碰真实网络。
// 覆盖：diff（删/加枚举、改类型、required 增删、无变化、结构缺失不误报）、
//       runSchemaCheck 全分支（拉不到/首次建基线/时间戳不变/变了diff/非JSON降级/当天跳过）、
//       错误归类关键词。
import {
  BASELINE, extractLastValidated, extractDraftSchema, diffSchema,
  classifySchemaError, runSchemaCheck,
} from '../etsy-schema-check.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓', name, extra === undefined ? '' : '  ' + extra); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : '  ' + extra); }
};

// 造一份与 BASELINE 一致的官方聚合 spec（含 createDraftListing），可 mutate 模拟平台改动
function makeSpec(lastValidated, mutate) {
  const spec = {
    openapi: '3.0.0',
    info: { version: '3.0.0', 'x-last-validated': lastValidated },
    paths: {
      '/v3/application/shops/{shop_id}/listings': {
        post: {
          operationId: 'createDraftListing',
          requestBody: { content: { 'application/x-www-form-urlencoded': { schema: {
            required: ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id'],
            properties: {
              when_made: { type: 'string', enum: BASELINE.enums.when_made.enum.slice() },
              who_made: { type: 'string', enum: ['i_did', 'collective', 'someone_else'] },
              item_type: { type: 'string', enum: ['physical', 'digital'] },
              item_weight_unit: { type: 'string', enum: ['g', 'kg', 'oz', 'lb'] },
              item_dimensions_unit: { type: 'string', enum: ['cm', 'mm', 'm', 'in'] },
            },
          } } } },
        },
      },
    },
  };
  if (mutate) mutate(spec);
  return spec;
}

console.log('\n【A】extractLastValidated（JSON / YAML 通用）');
{
  ok(extractLastValidated('"x-last-validated": "2026-05-30"') === '2026-05-30', 'JSON 引号格式');
  ok(extractLastValidated("x-last-validated: '2026-05-30'") === '2026-05-30', 'YAML 单引号格式');
  ok(extractLastValidated('x-last-validated: 2026-05-30') === '2026-05-30', 'YAML 无引号格式');
  ok(extractLastValidated('') === null, '空文本 → null');
  ok(extractLastValidated('no such key') === null, '无该字段 → null');
}

console.log('\n【B】extractDraftSchema（从聚合 spec 定位 createDraftListing）');
{
  const d = extractDraftSchema(makeSpec('2026-05-30'));
  ok(d && Array.isArray(d.required) && d.required.includes('taxonomy_id'), '能提取 required');
  ok(d && d.properties && d.properties.when_made && Array.isArray(d.properties.when_made.enum), '能提取 properties.enum');
  ok(extractDraftSchema({}) === null, '空对象 → null');
  ok(extractDraftSchema(null) === null, 'null → null');
}

console.log('\n【C】diffSchema（工作台基准 vs 官方 spec 当前值）');
{
  // 无变化：spec 与 BASELINE 完全一致
  const same = diffSchema(extractDraftSchema(makeSpec('2026-05-30')));
  ok(same.changed === false && same.changes.length === 0, '完全一致 → 无差异（不误报）', JSON.stringify(same.changes));

  // 删枚举：when_made 移除 2007_2009
  const rmSpec = makeSpec('2026-06-01', s => {
    const e = s.paths['/v3/application/shops/{shop_id}/listings'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.when_made.enum;
    const i = e.indexOf('2007_2009'); if (i >= 0) e.splice(i, 1);
  });
  const rm = diffSchema(extractDraftSchema(rmSpec));
  ok(rm.changed && rm.changes.some(c => c.kind === 'enum_removed' && c.field === 'when_made'), '删枚举 → enum_removed', JSON.stringify(rm.changes));

  // 加枚举：when_made 新增 2026_2029
  const addSpec = makeSpec('2026-06-01', s => {
    s.paths['/v3/application/shops/{shop_id}/listings'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.when_made.enum.push('2026_2029');
  });
  const ad = diffSchema(extractDraftSchema(addSpec));
  ok(ad.changed && ad.changes.some(c => c.kind === 'enum_added' && c.field === 'when_made' && /2026_2029/.test(c.detail)), '加枚举 → enum_added', JSON.stringify(ad.changes));

  // 改类型：who_made string → integer
  const tySpec = makeSpec('2026-06-01', s => {
    s.paths['/v3/application/shops/{shop_id}/listings'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.who_made.type = 'integer';
  });
  const ty = diffSchema(extractDraftSchema(tySpec));
  ok(ty.changed && ty.changes.some(c => c.kind === 'type_changed' && c.field === 'who_made'), '改类型 → type_changed', JSON.stringify(ty.changes));

  // required 增删
  const reqSpec = makeSpec('2026-06-01', s => {
    const sc = s.paths['/v3/application/shops/{shop_id}/listings'].post.requestBody.content['application/x-www-form-urlencoded'].schema;
    sc.required.push('production_partner_ids');
    sc.required = sc.required.filter(x => x !== 'taxonomy_id');
  });
  const rq = diffSchema(extractDraftSchema(reqSpec));
  ok(rq.changed && rq.changes.some(c => c.kind === 'required_added' && /production_partner_ids/.test(c.detail)), 'required 新增', JSON.stringify(rq.changes));
  ok(rq.changed && rq.changes.some(c => c.kind === 'required_removed' && /taxonomy_id/.test(c.detail)), 'required 移除', JSON.stringify(rq.changes));

  // 结构缺失 → 不误报
  ok(diffSchema(null).changed === false, 'no_schema → 不误报');
  ok(diffSchema({ required: [], properties: {} }).changed === false, 'empty_properties → 不误报');
}

console.log('\n【D】classifySchemaError（错误归类）');
{
  ok(classifySchemaError('Etsy POST /v3 → HTTP 400：unknown field "foo"').suspected === true, 'unknown field → 疑似');
  ok(classifySchemaError('HTTP 400：invalid enum value').suspected === true, 'invalid enum → 疑似');
  ok(classifySchemaError('HTTP 400：the field "when_made" is not recognized').suspected === true, 'field not recognized → 疑似');
  ok(classifySchemaError('HTTP 400：unexpected value').suspected === true, 'unexpected value → 疑似');
  ok(classifySchemaError('HTTP 429：rate limited').suspected === false, '429 限流 → 非疑似');
  ok(classifySchemaError('网络请求失败：timeout').suspected === false, '网络失败 → 非疑似');
  ok(classifySchemaError('').suspected === false, '空 → 非疑似');
}

console.log('\n【E】runSchemaCheck（mock 拉取，全分支）');
{
  const okSpecText = JSON.stringify(makeSpec('2026-05-30'));

  // 1) 拉不到 → unchecked
  {
    const writes = [];
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => ({ ok: false, text: '' }),
      readCacheFn: () => null,
      writeCacheFn: (f, d) => writes.push(d),
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'unchecked', '拉不到 → unchecked', r.status);
  }

  // 2) 首次拉到（无缓存）→ ok 建基线
  {
    const writes = [];
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => ({ ok: true, text: okSpecText }),
      readCacheFn: () => null,
      writeCacheFn: (f, d) => writes.push(d),
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'ok' && r.lastValidated === '2026-05-30', '首次拉到 → ok 建基线', JSON.stringify(r));
    ok(writes[0] && writes[0].lastValidated === '2026-05-30' && writes[0].lastChecked === '2026-10-23', '写入缓存含时间戳+当日', JSON.stringify(writes[0]));
  }

  // 3) 时间戳一致 → ok
  {
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => ({ ok: true, text: okSpecText }),
      readCacheFn: () => ({ lastValidated: '2026-05-30', lastChecked: '2026-10-22', status: 'ok', changes: [] }),
      writeCacheFn: () => {},
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'ok', '时间戳一致 → ok', r.status);
  }

  // 4) 时间戳变了 + diff 出差异 → changed
  {
    const changedText = JSON.stringify(makeSpec('2026-06-01', s => {
      const e = s.paths['/v3/application/shops/{shop_id}/listings'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.when_made.enum;
      e.push('2026_2029');
    }));
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => ({ ok: true, text: changedText }),
      readCacheFn: () => ({ lastValidated: '2026-05-30', lastChecked: '2026-10-22', status: 'ok', changes: [] }),
      writeCacheFn: () => {},
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'changed' && r.changes.some(c => c.kind === 'enum_added'), '时间戳变 + diff → changed', JSON.stringify(r.changes));
  }

  // 5) 时间戳变了但非 JSON（YAML 文本，parse 失败）→ changed_unknown
  {
    const yamlText = "openapi: 3.0.0\ninfo:\n  x-last-validated: '2026-06-01'\npaths: {}\n";
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => ({ ok: true, text: yamlText }),
      readCacheFn: () => ({ lastValidated: '2026-05-30', lastChecked: '2026-10-22', status: 'ok', changes: [] }),
      writeCacheFn: () => {},
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'changed_unknown', '时间戳变但非 JSON → changed_unknown', r.status);
  }

  // 6) 当天已查过 → 直接返回缓存，不再拉取
  {
    let fetched = 0;
    const r = await runSchemaCheck({
      cacheFile: '/x/c.json',
      fetchFn: async () => { fetched++; return { ok: true, text: okSpecText }; },
      readCacheFn: () => ({ lastValidated: '2026-05-30', lastChecked: '2026-10-23', status: 'ok', changes: [] }),
      writeCacheFn: () => {},
      nowFn: () => new Date('2026-10-23T10:00:00'),
      log: () => {},
    });
    ok(r.status === 'ok' && fetched === 0, '当天已查过 → 跳过拉取', 'fetched=' + fetched);
  }
}

console.log('\n' + '='.repeat(60));
console.log(`字段监控：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
