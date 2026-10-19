// 邮件接收模块（零依赖）
//
// 职责边界：只负责「验签 → 收下 → 落盘 → 记账」，**不解析 MIME 正文**。
// 原因有三条：
//   1) Cloudflare Email Worker 免费档只有 10ms CPU，解析必须留在后端做；
//   2) 落盘优先：先写原始 .eml，再谈解析，解析失败也不能丢信；
//   3) 这是公网接口，必须 HMAC 验签，否则任何人都能往磁盘灌数据。
//
// 原始邮件按「内容哈希」命名，同一封信重复投递会被识别为 duplicate，
// 不会重复入库（Etsy 会重试投递，Cloudflare 也可能重放）。

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SKEW_MS = 5 * 60 * 1000;          // 签名时间戳允许的偏差（防重放）
const MAX_RAW_BYTES = 30 * 1024 * 1024;      // 单封上限 30MB（Cloudflare 侧限 25MB）

export function signPayload(secret, timestamp, rawB64) {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}.${rawB64}`)
    .digest('hex');
}

export function verifySignature(secret, timestamp, rawB64, signature) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (timestamp == null || !signature) return { ok: false, reason: 'missing_signature' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { ok: false, reason: 'stale_timestamp' };
  if (typeof rawB64 !== 'string' || !rawB64) return { ok: false, reason: 'missing_raw' };
  const expect = Buffer.from(signPayload(secret, timestamp, rawB64), 'utf8');
  const given = Buffer.from(String(signature), 'utf8');
  if (expect.length !== given.length) return { ok: false, reason: 'bad_signature' };
  return timingSafeEqual(expect, given)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

// RFC 2047 编码字解码：=?UTF-8?B?xxx?= / =?utf-8?Q?xxx?=
function decodeMimeWords(s) {
  if (!s) return '';
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, enc, val) => {
    try {
      if (/^b$/i.test(enc)) return Buffer.from(val, 'base64').toString('utf8');
      const bytes = val
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, 'latin1').toString('utf8');
    } catch {
      return all;
    }
  }).replace(/\s+/g, ' ').trim();
}

// 只读信头区，不碰正文（正文解析是下一步的事）
export function parseHeaders(raw) {
  const text = raw.toString('utf8');
  let cut = text.indexOf('\r\n\r\n');
  if (cut < 0) cut = text.indexOf('\n\n');
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, 8000);
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const pick = (name) => {
    const m = unfolded.match(new RegExp('^' + name + ':\\s*(.*)$', 'mi'));
    return m ? m[1].trim() : '';
  };
  return {
    subject: decodeMimeWords(pick('Subject')),
    from: pick('From'),
    to: pick('To'),
    date: pick('Date'),
    messageId: pick('Message-ID'),
  };
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function indexFile(dataDir) {
  return join(dataDir, 'index.jsonl');
}

/**
 * 收下一封邮件。
 * @param {{rawB64:string, to?:string, from?:string}} input
 * @param {{secret:string, dataDir:string}} opts
 */
export async function ingest(input, opts = {}) {
  const { secret, dataDir } = opts;
  if (!dataDir) return { ok: false, status: 500, error: 'no_datadir' };
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: 'no_secret_configured',
      note: '后端未设置 MAIL_INGEST_SECRET，拒收邮件。请在 .env 里加一行 MAIL_INGEST_SECRET=<随机串> 后重启后端。',
    };
  }

  const { rawB64, to = '', from = '' } = input || {};
  if (typeof rawB64 !== 'string' || !rawB64) {
    return { ok: false, status: 400, error: 'missing_raw' };
  }

  let raw;
  try {
    raw = Buffer.from(rawB64, 'base64');
  } catch {
    return { ok: false, status: 400, error: 'bad_base64' };
  }
  if (!raw.length) return { ok: false, status: 400, error: 'empty_raw' };
  if (raw.length > MAX_RAW_BYTES) return { ok: false, status: 413, error: 'too_large' };

  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const day = localDate();
  const dir = join(dataDir, 'inbox', day);
  const file = join(dir, `${id}.eml`);

  // 同一封信重复投递：直接认下来，不重复入库
  if (existsSync(file)) {
    return { ok: true, duplicate: true, id, day, note: '这封邮件之前已经收过了' };
  }

  const h = parseHeaders(raw);
  await mkdir(dir, { recursive: true });
  await writeFile(file, raw);

  const record = {
    id,
    at: new Date().toISOString(),
    subject: h.subject,
    from: h.from || from,
    to: h.to || to,
    size: raw.length,
    file: `inbox/${day}/${id}.eml`,
  };
  await appendFile(indexFile(dataDir), JSON.stringify(record) + '\n');

  return { ok: true, duplicate: false, ...record };
}

export async function recent(dataDir, limit = 20) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const file = indexFile(dataDir);
  if (!existsSync(file)) return { ok: true, count: 0, items: [] };
  const txt = await readFile(file, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  const items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < n; i--) {
    try { items.push(JSON.parse(lines[i])); } catch { /* 跳过坏行 */ }
  }
  return { ok: true, count: lines.length, items };
}

export async function status(dataDir) {
  const file = indexFile(dataDir);
  if (!existsSync(file)) return { ok: true, count: 0, lastAt: null };
  const txt = await readFile(file, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  let lastAt = null;
  if (lines.length) {
    try { lastAt = JSON.parse(lines[lines.length - 1]).at || null; } catch { /* ignore */ }
  }
  return { ok: true, count: lines.length, lastAt };
}
