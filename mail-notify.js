// 把一封邮件变成一条飞书通知（零依赖）
//
// 这一版刻意做得很粗：只按主题判断类型，正文抓一段摘要。
// 原因是没有真实样本之前，任何细粒度解析都是猜的。
// 等真实 Etsy 邮件进来，看清结构再逐项补（订单号、金额、买家名）。
//
// ⚠️ 店主转发的邮件是被重新打包过的新邮件（From 已变成店主自己），
// 所以这里**不能靠发件人判断**，只能靠主题 + 正文。

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
function stripPrefix(subject) {
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
 * 从原始邮件里抓一段可读摘要。
 * 不是完整 MIME 解析——只做「去编码、去标签、压空白」，够通知里看个大概。
 */
export function extractSnippet(raw, max = 260) {
  let s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');

  const crlf = s.indexOf('\r\n\r\n');
  const lf = s.indexOf('\n\n');
  const cut = crlf >= 0 ? crlf : lf;
  if (cut > 0) s = s.slice(cut);

  s = s.replace(/=\r?\n/g, '');                                  // quoted-printable 软换行
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');                                // HTML 标签
  s = s.replace(/^--[-\w]+.*$/gm, ' ');                           // MIME 边界行
  s = s.replace(/^(content-[\w-]+|mime-version|charset|boundary|transfer-encoding|content-transfer-encoding)\s*:.*$/gim, ' ');
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"');
  s = s.replace(/\s+/g, ' ').trim();

  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function buildCard(record, snippet, baseUrl = '') {
  const c = classify(record.subject);
  const when = record.at ? new Date(record.at) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;

  const lines = [
    `**${c.subject || '(无主题)'}**`,
    snippet ? snippet : '（正文为空或无法读取）',
    `收到时间：${time}`,
  ];

  return {
    title: c.label,
    color: c.color,
    lines,
    footer: record.from ? `原邮件来自：${record.from}` : '',
    url: baseUrl,
  };
}

export async function notifyMail(record, raw, opts = {}) {
  const { webhook, secret = '', baseUrl = '' } = opts;
  if (!webhook) return { ok: false, error: 'no_webhook' };
  const snippet = extractSnippet(raw);
  return sendCard(webhook, buildCard(record, snippet, baseUrl), { secret });
}
