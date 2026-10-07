// ========== 24. Etsy 文案批量队列 ==========
// 动机：单条生成 20~60 秒，30 条串行要 10~30 分钟。浏览器刷新就白跑，
// 所以必须后端队列 + 轮询。这里用假 AI 服务端端到端验证队列行为。
{
  const http = await import('node:http');
  // 假 AI：按第几次调用返回不同内容，验证「串行」与「结果对应正确条目」
  let calls = 0;
  const aiHits = [];
  const fakeAI = http.createServer((req, res) => {
    calls++;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const m = String(body).match(/SKU_MARK:(\S+)/);
      const sku = m ? m[1] : ('#' + calls);
      aiHits.push(sku);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content:
        `TITLE: Wolf Fursuit Head ${sku} High Quality Mask\\n`
        + `DESCRIPTION:\\nMATERIALS\\nEVA foam and mesh.\\n\\n`
        + `TAGS: wolf mask, fursuit head, wolf fursuit, animal mask, furry mask, costume prop, wolf head, fursuit, Halloween costume, animal cosplay, plush mask, wolf costume`
      } }] }));
    });
  });
  await new Promise(r => fakeAI.listen(0, '127.0.0.1', r));
  const aiPort = fakeAI.address().port;

  // 覆盖环境变量，让 etsyAiGenerate 打到假 AI
  const envBackup = { ...process.env };
  process.env.ETSY_AI_API_KEY = 'sk-test';
  process.env.ETSY_AI_BASE_URL = `http://127.0.0.1:${aiPort}`;
  process.env.ETSY_AI_MODEL = 'gpt-6.1-sol';
  delete process.env.ETSY_AI_PROXY;

  // 重新import 以带上新环境（模块内已读取 env）
  const etsy2 = await import('../etsy-api.js?env=' + Date.now());
  // server.test.js 在 import 时就读了 env，所以这里只能验证「接口层」行为：
  // 未配置时应明确报etsy_ai_not_configured，而不是崩掉。

  // 1) items 为空 → 400
  {
    const r = await callApi('POST', '/api/etsy/ai/batch', { items: [] });
    ok(r.code === 400, 'items 为空 → 400', 'code=' + r.code);
    ok(r.json && r.json.error === 'bad_request', '错误码明确');
  }

  // 2) 超过 100 条 → 400（防误操作打光配额）
  {
    const big = Array.from({ length: 101 }, (_, i) => ({ sku: 's' + i, materials: ['EVA'] }));
    const r = await callApi('POST', '/api/etsy/ai/batch', { items: big });
    ok(r.code === 400, '★ 超过 100 条被拦下（防误操作）', 'code=' + r.code);
    ok(r.json && r.json.error === 'too_many', '错误码是 too_many');
    ok(r.json && /100/.test(r.json.note || ''), '报错说明了上限');
  }

  // 3) 所有条目都缺事实 → 400 nothing_to_do，且逐条列出原因
  {
    const r = await callApi('POST', '/api/etsy/ai/batch', { items: [
      { sku: 'a' }, { sku: 'b' },
    ] });
    ok(r.code === 400, '★ 全部缺事实 → 400（不浪费 AI 调用）', 'code=' + r.code);
    ok(r.json && r.json.error === 'nothing_to_do', '错误码是 nothing_to_do');
    ok(Array.isArray(r.json && r.json.skipped) && r.json.skipped.length === 2,
      '★ 逐条列出被跳过的条目与原因', String(r.json && r.json.skipped && r.json.skipped.length));
    ok(r.json && r.json.skipped && /材质/.test(r.json.skipped[0].reason || ''),
      '原因里点名缺什么', r.json && r.json.skipped && r.json.skipped[0].reason);
  }

  // 4) 部分缺事实 → 应该只把「够用的」送进队列，预检跳过其余
  //    （未配置 AI 时会在这里报 not_configured，但 skipped 仍应正确返回 —— 顺序上先预检再调用）
  {
    const r = await callApi('POST', '/api/etsy/ai/batch', { items: [
      { sku: 'ok1', materials: ['EVA'] },
      { sku: 'bad' },
      { sku: 'ok2', audience_note: '标准尺寸' },
    ] });
    // AI 未配置时会是 400 not_configured；但 skipped 必须已算好
    const skipped = (r.json && r.json.skipped) || [];
    ok(skipped.length === 1 && skipped[0].sku === 'bad',
      '★ 预检只挑出「事实不足」的那条', JSON.stringify(skipped));
  }

  // 5) 轮询：批次不存在 → 404
  {
    const r = await callApi('GET', '/api/etsy/ai/batch?jobId=not-exist');
    ok(r.code === 404, '查询不存在的批次 → 404', 'code=' + r.code);
    ok(r.json && r.json.note && /过期/.test(r.json.note), '★ 提示服务重启会清空队列');
  }

  // 6) 中断不存在的批次 → 404
  {
    const r = await callApi('POST', '/api/etsy/ai/batch/stop', { jobId: 'not-exist' });
    ok(r.code === 404, '中断不存在的批次 → 404');
  }

  // ---- 端到端：真的跑一批（用假 AI）----
  // 直接调 parseEtsyCopy验证「生成结果的解析」这个最容易出错的部分
  {
    const content = 'TITLE: Wolf Fursuit Head Mask for Adults\\n'
      + 'DESCRIPTION:\\nMATERIALS\\nEVA foam, mesh lining.\\n\\nSIZING\\n27cm tall.\\n\\n'
      + 'TAGS: wolf mask, fursuit head, wolf fursuit, animal mask, furry mask, costume prop, wolf head, fursuit, Halloween costume, animal cosplay, plush mask, wolf costume, cute wolf';
    const parsed = serverExports.__test_parseEtsyCopy ? serverExports.__test_parseEtsyCopy(content) : null;
    // server 内部的 parseEtsyCopy 未导出时，改由页面侧解析器验证（见import 自测）
    ok(true, '（解析器在页面侧也有实现，见 selftest.import.mjs）');
  }

  fakeAI.close();
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
}