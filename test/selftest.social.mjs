/* 社媒内容生成 + 发布页深链自测（etsy-social.js）
 *
 * 为什么这些断言必须存在：
 *  1. X 的字符计数不是 length()：链接固定 23、中文与表情各 2。算错的表现是
 *     「页面显示没超，发出去被截」——用户不会怀疑是计数错，只会觉得内容掉了。
 *  2. 深链参数必须 encodeURIComponent：文案里带 & # ? 是常态（价格、标签、标题），
 *     不编码的后果是链接被从中间截断，点开到了错误的页面。
 *  3. socEsc 是 XSS 的唯一防线：标题/详情来自 AI 生成与 CSV 导入，属于外部输入。
 *  4. 草稿必须被拦住：draft 没有公开链接，发出去别人点开是 404。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${extra ? '｜' + extra : ''}`); }
};

const src = readFileSync(resolve(ROOT, 'etsy-social.js'), 'utf8');
const M = new Function(src + '\n; return { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_BY_KEY, socEsc, socStripHtml, socClip, socCount, socTruncate, socHashtags, socValidateListing, socBuildContent, socDeepLink, socWithUtm, SOCIAL_FALLBACK_NOTE };')();

/* 一个正常的在售商品（后面各个用例基于它改） */
const LISTING = {
  listing_id: 123456789,
  title: 'Handmade Ceramic Horse Figurine & Blue Glaze Decor',
  description: '<p>A small kiln-fired ceramic horse.</p><p>Each piece is unique &amp; glazed by hand.</p>',
  tags: ['ceramic horse', 'horse decor', 'blue horse decor', 'handmade gift'],
  price: 29.99,
  currency_code: 'USD',
  state: 'active',
  url: 'https://www.etsy.com/listing/123456789/handmade-ceramic-horse-figurine',
  images: ['https://i.etsystatic.com/aaa/il_fullxfull.111.jpg', 'https://i.etsystatic.com/aaa/il_fullxfull.222.jpg'],
};

console.log('\n【A】X 加权字符计数（不是 length）');
{
  ok(M.socCount('x', 'hello') === 5, '纯 ASCII 按 1 个算', M.socCount('x', 'hello'));
  ok(M.socCount('x', '你好') === 4, '中文各算 2', M.socCount('x', '你好'));
  ok(M.socCount('x', '🐎') === 2, 'emoji 算 2', M.socCount('x', '🐎'));
  const withUrl = M.socCount('x', 'see https://www.etsy.com/listing/123456789/a-very-long-slug-name-here');
  ok(withUrl === 4 + 23, '链接固定算 23（不管实际长度）', withUrl);
  ok(M.socCount('x', '中文 https://a.co/1 尾巴') === 33, '中英混杂 + 链接（空格各算 1）', M.socCount('x', '中文 https://a.co/1 尾巴'));
  ok(M.socCount('pinterest', '中文中文') === 4, '非加权平台用 length', M.socCount('pinterest', '中文中文'));
}

console.log('\n【B】按平台规则截断');
{
  const long = '这是一段很长的中文文案，'.repeat(40);
  const t = M.socTruncate('x', long);
  ok(M.socCount('x', t) <= 280, 'X 截断后不超 280', String(M.socCount('x', t)));
  ok(t.endsWith('…'), '截断有省略号提示');
  const p = M.socTruncate('pinterest', long);
  ok(p.length <= 801, 'Pinterest 截断后不超 800（含省略号一点余量）', p.length);
  ok(M.socCount('x', 'short') === 5 && M.socTruncate('x', 'short') === 'short', '没超就不动它');
}

console.log('\n【C】hashtag 生成');
{
  const h = M.socHashtags(['ceramic horse', 'horse decor'], ['#Etsy']);
  ok(h.indexOf('#ceramichorse') >= 0, '标签里的空格被去掉');
  ok(h.indexOf('#Etsy') >= 0, '附加标签带上');
  ok(M.socHashtags(['a', 'ab', 'abc']).length === 1, '太短的标签被丢弃（<3 字符）');
  const many = M.socHashtags(Array.from({ length: 20 }, (_, i) => 'tag' + i));
  ok(many.length === 13, '最多取 13 个（Etsy 标签上限）', many.length);
  const dup = M.socHashtags(['etsy'], ['#etsy', '#Etsy']);
  ok(dup.length === 1, '大小写不同的重复标签去重', JSON.stringify(dup));
}

console.log('\n【D】listing 状态校验（草稿必须拦住）');
{
  ok(M.socValidateListing(LISTING).ok === true, 'active → 放行');
  const d = M.socValidateListing({ ...LISTING, state: 'draft' });
  ok(d.ok === false, 'draft → 拦住');
  ok(d.reason.indexOf('草稿') >= 0, '原因里点名是草稿', d.reason.slice(0, 40));
  ok(M.socValidateListing({ ...LISTING, state: 'inactive' }).ok === false, 'inactive → 拦住');
  ok(M.socValidateListing({ ...LISTING, state: 'expired' }).ok === false, 'expired → 拦住');
  const so = M.socValidateListing({ ...LISTING, state: 'sold_out' });
  ok(so.ok === true && !!so.warn, 'sold_out → 放行但给警告');
  ok(M.socValidateListing(null).ok === false, '空对象 → 拦住');
}

console.log('\n【E】深链构造与编码');
{
  const c = M.socBuildContent(LISTING, {});
  const pin = M.socDeepLink('pinterest', c.items.pinterest, { link: c.link, image: c.image });
  ok(pin.indexOf('https://www.pinterest.com/pin/create/button/') === 0, 'Pinterest 用官方 create 按钮地址');
  ok(pin.indexOf('media=' + encodeURIComponent(LISTING.images[0])) > 0, 'media 直接带 Etsy 图片地址');
  ok(pin.indexOf('&description=') > 0, 'description 预填');

  // 标题/文案里带 & # ? 时不得截断参数
  const tricky = M.socBuildContent(
    { ...LISTING, title: 'A&B #1 ?deal', description: '<p>cost & size #2? yes</p>' },
    {}
  );
  const pin2 = M.socDeepLink('pinterest', tricky.items.pinterest, { link: tricky.link, image: tricky.image });
  ok(pin2.indexOf('%26') > 0, '& 被编码成 %26');
  ok(pin2.indexOf('%23') > 0, '# 被编码成 %23');
  ok(pin2.split('&').length === 3, '链接里的 & 已编码成 %26，只剩 media/description 两个分隔符',
    pin2.split('&').length + ' 段');

  ok(M.socDeepLink('x', c.items.x, { link: c.link, image: c.image }).indexOf('https://x.com/intent/tweet?text=') === 0, 'X 用 intent/tweet');
  ok(M.socDeepLink('facebook', c.items.facebook, { link: c.link }).indexOf('https://www.facebook.com/sharer/sharer.php?u=') === 0, 'FB 用 sharer');
  ok(M.socDeepLink('weibo', c.items.weibo, { link: c.link, image: c.image }).indexOf('pic=') > 0, '微博带 pic 参数');
  ok(M.socDeepLink('instagram', c.items.instagram, { link: c.link }) === null, 'Instagram 没有发布深链（返回 null）');
}

console.log('\n【F】内容生成');
{
  const c = M.socBuildContent(LISTING, {});
  ok(c.ok === true, '生成成功');
  ok(c.items.pinterest.title.length <= 100, 'Pinterest 标题 ≤100');
  ok(c.items.pinterest.count <= 800, 'Pinterest 描述 ≤800', c.items.pinterest.count);
  ok(c.items.x.count <= 280, 'X 文案 ≤280', c.items.x.count);
  ok(c.link.indexOf('utm_source=etsy') > 0, '链接默认带 utm');
  ok(M.socBuildContent(LISTING, { utm: false }).link === LISTING.url, '关掉 utm 时用原始链接');
  ok(M.socBuildContent(LISTING, { variant: 1 }).items.x.text.indexOf(M.socCount ? '' : '') === 0, '款式参数不报错');
  ok(c.items.x.blurb.indexOf('http') < 0, 'X 的 blurb 里不放链接（链接走 url 参数，省 23 字符额度）');
  ok(c.items.x.copy.indexOf('http') > 0, 'X 的复制版带链接（手动粘贴时要用）');
  ok(c.items.instagram.text.indexOf('http') < 0, 'IG 文案不放链接（IG 不吃链接）');
  ok(c.image === LISTING.images[0], '默认取第一张图');
  ok(M.socBuildContent(LISTING, { image: LISTING.images[1] }).image === LISTING.images[1], '可指定用哪张图');
  const draft = M.socBuildContent({ ...LISTING, state: 'draft' }, {});
  ok(draft.ok === false, '草稿不给生成内容');
}

console.log('\n【G】HTML 剥离与转义（外部输入的唯一防线）');
{
  ok(M.socEsc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', 'socEsc 转义尖括号');
  ok(M.socEsc('a&b"c\'d') === 'a&amp;b&quot;c&#39;d', '引号与 & 一并转义');
  ok(M.socStripHtml('<p>hello</p><script>bad()</script>').indexOf('bad') < 0, 'script 内容被剔除');
  ok(M.socStripHtml('<p>a</p><p>b</p>').indexOf('<') < 0, '标签被去掉');
  ok(M.socStripHtml('x &amp; y') === 'x & y', '实体被还原');
  const evil = M.socBuildContent({ ...LISTING, title: '<img src=x onerror=alert(1)>', description: '<p>ok</p>' }, {});
  ok(evil.items.pinterest.title.indexOf('<') < 0, '危险标题进不了文案（已剥标签）', evil.items.pinterest.title);
}

console.log('\n【H】文案轮换与兜底');
{
  const a = M.socBuildContent(LISTING, { variant: 0 }).items.x.text;
  const b = M.socBuildContent(LISTING, { variant: 1 }).items.x.text;
  ok(a !== b, '不同款式给出不同开场');
  const r = M.socBuildContent(LISTING, { variant: 99 }).items.x.text;
  ok(typeof r === 'string' && r.length > 0, '款式号越界不崩（取模）');
  ok(typeof M.SOCIAL_FALLBACK_NOTE === 'string' && M.SOCIAL_FALLBACK_NOTE.length > 0, '深链失效有兜底文案');
  ok(M.SOCIAL_PLATFORMS.filter(p => p.deep).length === 4, '四个平台有发布深链（含微博），IG 没有');
}

console.log('\n' + '='.repeat(60));
console.log(`社媒模块自测：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
