/**
 * 文件删除 + 风格删除 自测
 */
import fs from 'node:fs';

const html = fs.readFileSync('wechat-publisher.html', 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m + (x ? '  ' + x : '')); } else { fail++; console.log('  ✗ ' + m + '  ' + x); } };

console.log('='.repeat(72));
console.log('文件删除 + 风格删除 自测');
console.log('='.repeat(72));

console.log('\n【1】文件登记表与逐个删除');
{
  ok(html.includes('let __files = []'), '有文件登记表 __files');
  ok(html.includes('function rebuildSrcFromFiles()'), '有从登记表重建正文的函数');
  ok(html.includes('function renderFileTags()'), '有文件标签渲染函数');
  ok(html.includes('data-delfile'), '删除按钮带 data-delfile 标识');
  ok(html.includes('__files = __files.filter(x=>x.id!==id)'), '按 id 精确移除单个文件');
  ok(html.includes("rebuildSrcFromFiles();\n      toast('已移除"), '删除后重建正文并提示');
  // 不再是单个 fileTag 覆盖
  ok(!/\$\('#fileTag'\)\.innerHTML='<span class="filetag">/.test(html), '不再用单标签覆盖（支持多文件并存）');
}

console.log('\n【2】四类文件都登记 sizes（便于标签显示大小）');
{
  for (const [k, pat] of [
    ['docx', 'fillText(htmlToText(r.value), f.name, f.size)'],
    ['pdf', 'fillText(await pdfToText(reader.result), f.name, f.size)'],
    ['html', "fillText(doc.body.innerText||doc.body.textContent||'', f.name, f.size)"],
    ['txt/md', 'fillText(reader.result, f.name, f.size)'],
  ]) ok(html.includes(pat), k + ' 分支已传 f.size');
}

console.log('\n【3】文件标签 XSS 防护（文件名来自用户）');
{
  ok(html.includes("f.name.replace(/[<>]/g,'')"), '文件名过滤尖括号，防注入');
}

console.log('\n【4】封面风格删除');
{
  const i = html.indexOf('const COVER_STYLES_DEFAULT');
  const open = html.indexOf('[', i);
  let d = 0, close = open;
  for (let k = open; k < html.length; k++) { if (html[k] === '[') d++; else if (html[k] === ']') { d--; if (d === 0) { close = k; break; } } }
  const arr = eval('(' + html.slice(open, close + 1) + ')');
  ok(arr.every(x => x.builtIn === true), '内置风格全部标记 builtIn');
  ok(html.includes('if(!st.builtIn){'), '只有非内置风格才渲染删除按钮');
  ok(html.includes("删除封面风格「"), '删除有二次确认');
  ok(html.includes('COVER_STYLES = COVER_STYLES.filter(y=>y.id!==st.id)'), '按 id 移除风格');
  ok(html.includes('if(_coverStyleId === st.id) _coverStyleId = COVER_STYLES[0].id'), '删掉当前选中项时自动切回第一套');
}

console.log('\n【5】持久化只存用户自建风格（关键）');
{
  ok(html.includes("localStorage.setItem('etsyops.coverStyles', JSON.stringify(COVER_STYLES.filter(x=>!x.builtIn)))"),
     'saveCoverStyles 只存非内置风格');
  ok(html.includes('return arr.concat(COVER_STYLES_DEFAULT).slice(0, 12)'), '读取时把内置风格合并回来');
  ok(html.includes('let COVER_STYLES = loadCoverStyles();'), '初始化走 loadCoverStyles');
}

console.log('\n【6】生稿风格（原有 delStyle）仍在');
{
  ok(html.includes("$('#delStyle')"), '生稿风格保留删除按钮');
  ok(html.includes("localStorage.setItem(STYLE_KEY"), '生稿风格持久化未受影响');
}

console.log('\n' + '='.repeat(72));
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(72));
process.exit(fail > 0 ? 1 : 0);