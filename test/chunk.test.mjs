/* 分片传输自测：验证 7448 字长稿能被完整分片取回、拼回后与原文一字不差 */
import http from 'node:http';
import path from 'node:path';
let pass=0,fail=0;
const ok=(c,m,x='')=>{ if(c){pass++;console.log('  ✓ '+m+(x?'  '+x:''));} else {fail++;console.log('  ✗ '+m+'  '+x);} };

function mkReq(method,url,headers={},bodyObj=null){
  const bodyStr=bodyObj?JSON.stringify(bodyObj):'';
  const req=new http.IncomingMessage();
  req.method=method; req.url=url; req.headers={origin:'http://t',...headers};
  if(bodyStr){req.__b=Buffer.from(bodyStr);req.headers['content-length']=String(req.__b.length);}
  return req;
}
function mkRes(){ const r={_c:0,_h:null,_b:null};
  r.writeHead=(c,h)=>{r._c=c;r._h=h;return r;};
  r.setHeader=(k,v)=>{r._h=r._h||{};r._h[k]=v;};
  r.end=(b)=>{r._b=b?Buffer.from(b):Buffer.alloc(0);return r;}; return r; }
async function call(method,url,bodyObj){
  const req=mkReq(method,url,{},bodyObj);
  if(req.__b) req[Symbol.asyncIterator]=async function*(){yield req.__b;};
  const res=mkRes();
  const mod=await import(path.resolve('server.test.js'));
  await mod.__test_handleApi(req,res);
  let j=null; try{ j=JSON.parse(res._b.toString('utf8')); }catch{}
  return {code:res._c,headers:res._h,json:j};
}

// mock AI 返回 7448 字（复刻用户那次的真实量级）
let expected='';
globalThis.fetch = async ()=>{
  expected = '标题：Etsy卖家圣诞季选品避坑指南\n\n' + Array.from({length:150},(_,k)=>
    '第'+(k+1)+'段：'+'垂涎做纯标品是一个误区，觉得做传统市场太多已经有一点点卷了，那里可能来的标品就一改。').join('\n\n');
  return new Response(JSON.stringify({choices:[{message:{content:expected}}]}),{status:200,headers:{'Content-Type':'application/json'}});
};

console.log('='.repeat(72));
console.log('分片传输自测（长稿完整性）');
console.log('='.repeat(72));

const sub=await call('POST','/api/ai/generate',{manuscript:'素材内容测试',prompt:'写长文',async:true});
ok(sub.code===200,'提交任务 200','code='+sub.code);
const jobId=sub.json.jobId;

// 模拟前端：循环取片直到 done
let from=0, buf='', total=0, rounds=0, done=false, maxChunkBytes=0;
while(rounds<60){
  rounds++;
  const r=await call('GET','/api/ai/job?id='+jobId+'&from='+from);
  ok(r.code===200||r.code===404, '第'+rounds+'次请求有明确状态码','code='+r.code);
  if(r.code===404) break;
  const d=r.json;
  total=d.total; from=d.end; buf+=d.content||'';
  maxChunkBytes=Math.max(maxChunkBytes,(r.headers&&r.headers['Content-Length'])||0);
  if(d.status==='done'){ done=true; break; }
  if(d.status==='error'){ ok(false,'任务失败',d.note); break; }
}
ok(done, rounds+' 次请求后取完全文');
ok(buf.length===total, '取回长度与总长度一致', buf.length+'/'+total);
ok(buf===expected, '拼回内容与AI 原文**一字不差**', '差异字符数='+(buf===expected?0:'>0'));
ok(maxChunkBytes>0 && maxChunkBytes<6000, '单个分片响应足够小（<6KB）', '最大片='+maxChunkBytes+'字节');
ok(rounds>1, '确实分了多片（说明长稿会走分片）','rounds='+rounds);

console.log('='.repeat(72));
console.log('结果：通过 '+pass+' 项，失败 '+fail+' 项');
console.log('='.repeat(72));
process.exit(fail>0?1:0);
