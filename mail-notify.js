// 把一封邮件变成一条飞书通知（零依赖）
//
// ⚠️ 真实样本（2026-10-20 实测）决定了这里的写法：
//   1. 店主转发后，邮件是 multipart/alternative，两个 part **都是 base64**
//      —— 不去 base64 就会在卡片上输出乱码；
//   2. Etsy 正文里塞了大量零宽字符（U+200B~200F / U+2060 / U+FEFF / U+034F）
//      用来防邮件客户端截断 —— 不去掉就会出现一屏看不见的"空白"；
//   3. 买家消息邮件**不含对话全文**，只有 "Melody sent you a message" + 一个跳转链接。
//      所以卡片能做到的上限是「谁找你 + 点进去回」，别指望在飞书里读完消息。
//   4. 店主用的是「转发」，From 已变成店主自己，**不能靠发件人判断是不是 Etsy 的邮件**，
//      只能靠主题 + 正文。

import { sendCard } from './notify-feishu.js';

const RULES = [
  { type: 'order', label: '新订单', color: 'green',
    re: /you sold|sold an item|new order|order confirm|order receipt|made a sale|订单/i },
  { type: 'message', label: '买家咨询', color: 'blue',
    re: /new message|sent you a message|conversation|replied|message from/i },
  { type: 'case', label: '纠纷 / Case', color: 'red',
    re: /case|dispute|claim|chargeback|refund request/i },
  { type: 'review', label: '评价', color: 'orange',
    re: /review|feedback|rating/i },
  { type: 'policy', label: '平台通知', color: 'grey',
    re: /policy|announcement|important update|action required/i },
];

// 去掉 "Fw: Fwd: 转发:" 这类前缀，否则规则容易漏
export function stripPrefix(subject) {
  return String(subject || '').replace(/^(\s*(fw|fwd|re|转发|回复)\s*[:：]\s*)+/i, '').trim();
}

export function classify(subject) {
  const s = stripPrefix(subject);
  for (const r of RULES) {
    if (r.re.test(s)) return { type: r.type, label: r.label, color: r.color, subject: s };
  }
  return { type: 'other', label: '其他邮件', color: 'grey', subject: s };
}

/**
 * 从 Etsy 的主题里抠买家名和店铺名。
 * 实测格式："Etsy Conversation with Melody Deichman from FishBoneTreasures"
 */
export function parseSubject(subject) {
  const s = stripPrefix(subject);
  const m = s.match(/Etsy\s+Conversation\s+with\s+(.+?)\s+from\s+(.+)$/i);
  if (m) return { buyer: m[1].trim(), shop: m[2].trim() };
  return {};
}

/**
 * 按 boundary 切开，取出 text/plain 与 text/html 两个 part，并解掉 base64 /
 * quoted-printable。用 latin1 读原始字节，避免 utf8 解码把 base64 流弄坏。
 */
export function decodeParts(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const b = (s.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];

  const decodeBody = (part) => {
    const enc = ((part.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || '').toLowerCase();
    const i = part.indexOf('\r\n\r\n');
    let body = i >= 0 ? part.slice(i + 4) : '';
    if (enc === 'base64') {
      try {
        return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
      } catch { return body; }
    }
    if (enc === 'quoted-printable') {
      return body.replace(/=\r\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return Buffer.from(body, 'latin1').toString('utf8');
  };

  if (!b) {
    // 不是 multipart：整封当正文
    const i = s.indexOf('\r\n\r\n');
    return { plain: Buffer.from(i >= 0 ? s.slice(i + 4) : s, 'latin1').toString('utf8'), html: '' };
  }

  let plain = '';
  let html = '';
  for (const part of s.split('--' + b)) {
    const ct = (part.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1] || '';
    if (/text\/plain/i.test(ct)) plain += decodeBody(part) + '\n';
    else if (/text\/html/i.test(ct)) html += decodeBody(part) + '\n';
  }
  return { plain, html };
}

const ZERO_WIDTH = /[\u034f\u200b-\u200f\u2060\ufeff]/g;
// Etsy 通知的核心句：优先抓这一句，而不是把整段正文截断（正文里混着转发头和导航菜单）
const CORE = /(sent you a message|you sold|has been shipped|is on its way|left a (?:review|rating)|opened a case|sent you an offer|new order|order cancel)/i;

/** 压成一行可读文本：去零宽字符、去转发头、去标签、去导航词、压空白 */
export function cleanText(input, max = 260) {
  if (!input) return '';
  let s = String(input);
  s = s.replace(ZERO_WIDTH, '');
  s = s.replace(/=\r?\n/g, '');                 // quoted-printable 软换行
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '\n');              // 标签换成换行，尽量保留分行
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');

  const kept = [];
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^_+$/.test(line)) continue;                                        // 分隔线
    if (/^(from|sent|to|cc|bcc|subject|date)\s*:/i.test(line)) continue;     // 转发头
    if (/^(on sale|gift guide|home & living|sign in|help|your account|etsy)$/i.test(line)) continue;
    kept.push(line);
  }

  s = kept.join(' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\[https?:\/\/[^\]]*\]/g, ' ')   // [https://...] 形式的图片/链接
       .replace(/\[[^\]\n]{1,24}\]/g, ' ')       // [Etsy] [Instagram] 这类 alt 文本
       .replace(/https?:\/\/\S+/g, ' ')
       .replace(/\b(On Sale|Gift Guide|Home & Living|Sign in|Your Account|View message|Let's be friends)\b/gi, ' ')
       // 页脚开始的地方直接截断，后面全是 App 推广与免责声明
       .replace(/\b(Download the Etsy app|If you live in|Unsubscribe|This email was sent|You are receiving)\b[\s\S]*$/i, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 从清理后的正文里挑出核心那一句，找不到就返回开头一段 */
function pickCore(text) {
  const i = text.search(CORE);
  if (i < 0) return '';
  let seg = text.slice(Math.max(0, i - 40), i + 90).trim();
  seg = seg.replace(/(.{12,60}?)\s+\1/g, '$1');        // 正文里 plain/html 两份拼接出的重复句
  const dot = seg.indexOf('. ');
  if (dot > 24) seg = seg.slice(0, dot);               // 第一句就够了
  return seg.trim().slice(0, 170);
}

export function extractSnippet(raw, max = 260) {
  const { plain, html } = decodeParts(raw);
  const text = cleanText(plain || html, 6000);
  const out = pickCore(text) || text;
  return out.length > max ? out.slice(0, max) + '…' : out;
}

/** 取第一个能点的链接：优先 Etsy 域，其次 ablink 这类跟踪域 */
export function extractLink(raw) {
  const { plain, html } = decodeParts(raw);
  const all = `${html}\n${plain}`;
  const href = all.match(/href="(https?:\/\/[^"]+etsy\.com[^"]*)"/i);
  if (href) return href[1];
  const angle = plain.match(/<(https?:\/\/[^>\s]*etsy[^>\s]*)>/i);
  if (angle) return angle[1];
  const ab = all.match(/href="(https?:\/\/ablink[^"]+)"/i) || plain.match(/<(https?:\/\/ablink[^>\s]+)>/i);
  return ab ? ab[1] : '';
}

export function buildCard(record, snippet, baseUrl = '', extra = {}) {
  const c = classify(record.subject);
  const { buyer, shop } = parseSubject(record.subject);
  const when = record.at ? new Date(record.at) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;

  const lines = [];
  if (buyer) {
    lines.push(`**${buyer}**${shop ? ` · ${shop}` : ''}`);
  } else {
    lines.push(`**${c.subject || '(无主题)'}**`);
  }
  if (snippet) lines.push(snippet);
  lines.push(`收到时间：${time}`);

  return {
    title: c.label,
    color: c.color,
    lines,
    footer: record.from ? `经 ${record.from} 转发` : '',
    url: extra.link || baseUrl,
  };
}

export async function notifyMail(record, raw, opts = {}) {
  const { webhook, secret = '', baseUrl = '' } = opts;
  if (!webhook) return { ok: false, error: 'no_webhook' };
  const snippet = extractSnippet(raw);
  const link = extractLink(raw);
  return sendCard(webhook, buildCard(record, snippet, baseUrl, { link }), { secret });
}
