// 翻译引擎自测：纯函数 + mock transport，不碰真实网络。
// 覆盖：hasCJK / 术语表直替（最长匹配+大小写不敏感）/ field 感知翻译
//       （material/dim/varval/attr/keyword/note）/ 属性名=值拆分 / 无中文直通 /
//       TMT TC3 签名结构 + 独立重算一致性 / translateTMT mock 成功与报错 /
//       translateAll 并发 + 单条错误隔离。
import * as crypto from 'crypto';
import {
  DEFAULT_GLOSSARY, loadGlossary, hasCJK, applyGlossary,
  translateDim, translateAttr, translateField, translateViaAI,
  translateTMT, tmtSignedHeaders, makeTmtEngine, makeAiEngine, translateAll,
} from '../etsy-translate.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓', name, extra === undefined ? '' : '  ' + extra); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : '  ' + extra); }
};

const GL = loadGlossary(null);

/* 记录调用的假引擎：可选择对特定输入抛错 */
function makeRecorder(failOn) {
  const calls = [];
  const fn = async (t) => {
    calls.push(t);
    if (failOn && failOn(t)) throw new Error('boom:' + t);
    return 'EN[' + t + ']';
  };
  fn.calls = calls;
  return fn;
}

console.log('== hasCJK ==');
ok(hasCJK('EVA泡棉') === true, '中文检出', '泡棉');
ok(hasCJK('EVA foam') === false, '纯英文不误判');
ok(hasCJK('') === false, '空串不误判');
ok(hasCJK(null) === false, 'null 不误判');

console.log('== 术语表直替 ==');
ok(applyGlossary('兽装 头基', GL) === 'fursuit head base', '兽装+头基', applyGlossary('兽装 头基', GL));
ok(applyGlossary('EVA泡棉', GL) === 'EVA foam', '最长匹配 EVA泡棉>泡棉', applyGlossary('EVA泡棉', GL));
ok(applyGlossary('eva泡棉', GL) === 'EVA foam', '大小写不敏感 eva→EVA', applyGlossary('eva泡棉', GL));
ok(applyGlossary('树脂眼睛', GL) === 'resin eyes', '树脂眼睛>眼睛', applyGlossary('树脂眼睛', GL));
ok(applyGlossary('羊毛毡', GL) === 'needle felt', '羊毛毡', applyGlossary('羊毛毡', GL));

console.log('== field 感知翻译（术语表命中，引擎不该被调用）==');
const noCall = makeRecorder();
noCall.calls.length = 0;
const t1 = await translateField('dim', '颜色', GL, noCall);
ok(t1 === 'Primary color', 'dim 颜色→Primary color', t1);
const t2 = await translateField('material', '羊毛毡', GL, noCall);
ok(t2 === 'needle felt', 'material 羊毛毡', t2);
const t3 = await translateField('keyword', '兽装 头基', GL, noCall);
ok(t3 === 'fursuit head base', 'keyword 兽装头基', t3);
ok(noCall.calls.length === 0, '术语表全覆盖时引擎零调用', 'calls=' + noCall.calls.length);

console.log('== field 感知翻译（残留中文才调引擎）==');
const rec = makeRecorder();
const t4 = await translateField('material', '特别软泡棉', GL, rec);
ok(t4 === 'EN[特别软foam]', '残留中文交引擎', t4);
ok(rec.calls.length === 1, '引擎恰被调一次');
ok(rec.calls[0] === '特别软foam', '引擎收到的是直替后的文本', rec.calls[0]);

console.log('== 无中文直通 ==');
const t5 = await translateField('material', 'EVA foam', GL, makeRecorder());
ok(t5 === 'EVA foam', '已英文原样返回');
const t6 = await translateField('dim', '', GL, noCall);
ok(t6 === '', '空串返回空');

console.log('== 属性名=值 拆分 ==');
const rec2 = makeRecorder();
const a1 = await translateAttr('材质=陶瓷; 风格=田园', GL, rec2);
ok(a1.includes('Material=ceramic'), '材质→Material、陶瓷→ceramic（术语表）', a1);
ok(a1.includes('Style='), '风格→Style、田园交引擎', a1);
ok(a1.split('; ').length === 2, '两条属性', a1);

console.log('== TMT TC3 签名结构 ==');
const sig = tmtSignedHeaders(JSON.stringify({ SourceText: '你好', Source: 'auto', Target: 'en', ProjectId: 0 }),
  { secretId: 'AKIDtest', secretKey: 'SKEYtest', region: 'ap-guangzhou', timestamp: 1750000000 });
ok(sig.headers['X-TC-Action'] === 'TextTranslate', 'action');
ok(sig.headers['X-TC-Version'] === '2018-03-21', 'version');
ok(sig.headers['X-TC-Region'] === 'ap-guangzhou', 'region');
const m = sig.headers.Authorization.match(/^TC3-HMAC-SHA256 Credential=AKIDtest\/(\d{4}-\d{2}-\d{2})\/tmt\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=([0-9a-f]{64})$/);
ok(!!m, 'Authorization 结构', sig.headers.Authorization);
ok(/^[0-9a-f]{64}$/.test(m ? m[2] : ''), '签名是 64 位 hex');

console.log('== TMT 签名独立重算一致性 ==');
const sha256hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmacSha = (k, msg) => crypto.createHmac('sha256', k).update(msg, 'utf8').digest();
function recomputeSig(payload, secretKey, ts, date, service = 'tmt') {
  const host = 'tmt.tencentcloudapi.com', action = 'TextTranslate';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256hex(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${ts}\n${credentialScope}\n${sha256hex(canonicalRequest)}`;
  const secretDate = hmacSha('TC3' + secretKey, date);
  const secretService = hmacSha(secretDate, service);
  const secretSigning = hmacSha(secretService, 'tc3_request');
  return crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
}
const expectSig = recomputeSig(sig.payload, 'SKEYtest', 1750000000, sig.date);
const gotSig = (m ? m[2] : '');
ok(gotSig === expectSig, '模块签名 == 独立重算', gotSig);
const sig2 = tmtSignedHeaders(sig.payload, { secretId: 'AKIDtest', secretKey: 'SKEYtest', region: 'ap-guangzhou', timestamp: 1750000000 });
ok(sig2.headers.Authorization === sig.headers.Authorization, '同输入签名确定');

console.log('== translateTMT mock transport ==');
const captured = [];
const fakeOk = async (opts, payload) => { captured.push({ opts, payload }); return JSON.stringify({ Response: { TargetText: 'hello' } }); };
const r1 = await translateTMT('你好', { secretId: 'AKID', secretKey: 'SK', transport: fakeOk });
ok(r1 === 'hello', '成功解析 TargetText');
ok(JSON.parse(captured[0].payload).SourceText === '你好', 'payload SourceText');
ok(JSON.parse(captured[0].payload).Target === 'en', 'payload Target=en');
const fakeErr = async () => JSON.stringify({ Response: { Error: { Code: 'FailedOperation', Message: '额度不足' } } });
let threw = '';
try { await translateTMT('你好', { secretId: 'AKID', secretKey: 'SK', transport: fakeErr }); }
catch (e) { threw = String(e.message); }
ok(/FailedOperation/.test(threw) && /额度不足/.test(threw), 'TMT 报错透传', threw);

console.log('== 引擎工厂（术语表先直替，残留中文才调引擎）==');
const tmtEng = makeTmtEngine(GL, { secretId: 'AKID', secretKey: 'SK', transport: async () => JSON.stringify({ Response: { TargetText: 'x' } }) });
const e1 = await tmtEng('羊毛毡');   // 术语表命中，不该调 TMT
ok(e1 === 'needle felt', 'TMT 引擎：术语表命中不调网', e1);

console.log('== translateAll 并发 + 错误隔离 ==');
const items = [
  { field: 'material', text: '羊毛毡' },
  { field: 'material', text: '未知词X' },   // 引擎会 failOn 这个
  { field: 'dim', text: '颜色' },
  { field: 'attr', text: '材质=陶瓷' },
  { field: 'keyword', text: '兽装' },
];
const engFail = makeRecorder((t) => t.includes('未知词X'));
const all = await translateAll(items, GL, engFail, { concurrency: 2 });
ok(all.length === 5, '结果与输入等长');
ok(all.filter(x => x.ok).length === 4, '4 条成功');
ok(all.filter(x => !x.ok).length === 1, '1 条失败被隔离');
ok(all.find(x => x.zh === '未知词X').note.includes('boom'), '失败条带原因');
ok(all.find(x => x.zh === '羊毛毡').en === 'needle felt', '成功条回填正确');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
