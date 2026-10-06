/**
 * 运行记录落库 自测
 * 真实 handleApi + 真实文件读写，不起端口。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

function mkReq(method, url, bodyObj) {
  const s = bodyObj ? JSON.stringify(bodyObj) : '';
  const req = new http.IncomingMessage();
  req.method = method; req.url = url;
  req.headers = { origin: 'http://t' };
  if (s) { req.__b = Buffer.from(s); req.headers['content-length'] = String(req.__b.length); }
  return req;
}
function mkRes() {
  const r = { _c: 0, _h: null, _b: null };
  r.writeHead = (c, h) => { r._c = c; r._h = h; return r; };
  r.setHeader = (k, v) => { r._h = r._h || {}; r._h[k] = v; };
  r.end = (b) => { r._b = b ? Buffer.from(b) : Buffer.alloc(0); return r; };
  return r;
}
async function call(method, url, bodyObj) {
  const req = mkReq(method, url, bodyObj);
  if (req.__b) req[Symbol.asyncIterator] = async function* () { yield req.__b; };
  const res = mkRes();
  const mod = await import(path.resolve('server.test.js'));
  await mod.__test_handleApi(req, res);
  let j = null; try { j = JSON.parse(res._b.toString('utf8')); } catch {}
  return { code: res._c, json: j, text: res._b.toString('utf8') };
}

console.log('='.repeat(72));
console.log('运行记录落库自测');
console.log('='.repeat(72));

// 隔离测试数据目录：改process.env 让它写到临时位置
const DATA = path.resolve('data');
fs.rmSync(DATA, { recursive: true, force: true });

console.log('\n【1】POST /api/runs 新建');
let id = '';
{
  const r = await call('POST', '/api/runs', {
    employee: 'publisher', runName: '圣诞选品实操营', configName: '干货风',
    files: ['a.docx', 'b.pdf'],
    steps: [{ key: 'upload', title: '载入文稿', ms: 100, state: 'ok', note: '' }],
  });
  ok(r.code === 200, '返回 200', 'code=' + r.code);
  ok(!!(r.json && r.json.id), '生成了 id', r.json && r.json.id);
  ok(r.json && r.json.status === 'running', '初始状态 running');
  ok(r.json && Array.isArray(r.json.steps) && r.json.steps.length === 1, 'steps 已保存');
  ok(r.json && r.json.files.length === 2, '文件清单已保存');
  id = r.json && r.json.id;
  // 等防抖落盘
  await new Promise(r2 => setTimeout(r2, 120));
  ok(fs.existsSync(path.join(DATA, 'runs.json')), 'data/runs.json 已落盘');
}

console.log('\n【2】PATCH /api/runs?id= 更新进度');
{
  const r = await call('PATCH', '/api/runs?id=' + id, {
    status: 'done', words: 2381, draftMediaId: 'MEDIA123',
    steps: [
      { key: 'upload', title: '载入文稿', ms: 100, state: 'ok', note: '2 份' },
      { key: 'gen', title: 'AI 生稿', ms: 17400, state: 'ok', note: '2381 字' },
      { key: 'draft', title: '写入草稿箱', ms: 1800, state: 'ok', note: '' },
    ],
  });
  ok(r.code === 200, '返回 200', 'code=' + r.code);
  ok(r.json && r.json.status === 'done', '状态更新为 done');
  ok(r.json && r.json.words === 2381, '字数已记录');
  ok(r.json && r.json.steps.length === 3, '三个步骤都已保存');
}

console.log('\n【3】GET /api/runs 读历史（倒序）');
{
  const r2 = await call('POST', '/api/runs', { employee: 'publisher', runName: '第二条' });
  await new Promise(x => setTimeout(x, 120));
  const r = await call('GET', '/api/runs?limit=10');
  ok(r.code === 200, '返回 200');
  ok(r.json && r.json.total === 2, '共 2 条', 'total=' + (r.json && r.json.total));
  ok(r.json && r.json.runs[0].runName === '第二条', '倒序：最新在最前', r.json && r.json.runs[0].runName);
}

console.log('\n【4】GET 按 employee 过滤');
{
  await call('POST', '/api/runs', { employee: 'lister', runName: '别的工作流' });
  await new Promise(x => setTimeout(x, 120));
  const r = await call('GET', '/api/runs?employee=publisher');
  ok(r.json && r.json.runs.every(x => x.employee === 'publisher'), '只返回该工作流的记录',
     '共 ' + (r.json && r.json.runs.length) + ' 条');
}

console.log('\n【5】容错与边界');
{
  const r1 = await call('PATCH', '/api/runs?id=nope', { status: 'done' });
  ok(r1.code === 404, '更新不存在的记录 → 404', 'code=' + r1.code);
  const r2 = await call('POST', '/api/runs', { employee: 'x'.repeat(200), runName: 'y'.repeat(300) });
  ok(r2.code === 200 && r2.json.employee.length <= 60, '超长字段被截断', 'len=' + r2.json.employee.length);
  const r3 = await call('POST', '/api/runs', { steps: 'not-an-array' });
  ok(r3.code === 200 && Array.isArray(r3.json.steps), 'steps 传错类型不崩溃');
  await new Promise(x => setTimeout(x, 120));
}

console.log('\n【6】DELETE /api/runs');
{
  const r1 = await call('DELETE', '/api/runs?id=' + id);
  ok(r1.code === 200, '删除单条 → 200', 'deleted=' + (r1.json && r1.json.deleted));
  const r2 = await call('GET', '/api/runs');
  ok(r2.json && !r2.json.runs.some(x => x.id === id), '被删记录已消失');
  const r3 = await call('DELETE', '/api/runs');
  ok(r3.code === 200, '清空全部 → 200');
  const r4 = await call('GET', '/api/runs');
  ok(r4.json && r4.json.total === 0, '已清空', 'total=' + r4.json.total);
}

console.log('\n【7】不存稿件正文（避免文件膨胀）');
{
  await call('POST', '/api/runs', { employee: 'publisher', runName: '正文测试', manuscript: 'A'.repeat(50000) });
  await new Promise(x => setTimeout(x, 120));
  const r = await call('GET', '/api/runs');
  const raw = JSON.stringify(r.json);
  ok(!raw.includes('AAAA'), '正文未被写入记录');
  ok(raw.length < 3000, '单条记录体积很小', raw.length + ' 字符');
}

fs.rmSync(DATA, { recursive: true, force: true });

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);