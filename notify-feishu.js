// 飞书群机器人通知（零依赖）
//
// 为什么用群机器人而不是飞书应用：群机器人只要一个 webhook，不需要建应用、
// 不需要审核、不需要管理员权限。对「把提醒发到几个人手机上」这个需求，
// 它是成本最低的路。
//
// 安全设置说明（飞书后台建机器人时会让选）：
//   - 选「签名校验」最省事：本模块已实现 sign
//   - 选「关键词」需要消息里包含指定词，容易被文案改动踩坑
//   - 选「IP 白名单」在家庭宽带上不可用（IP 会变）

import { createHmac } from 'node:crypto';

/**
 * 飞书签名：把 `${timestamp}\n${secret}` 当作 HMAC 的 **key**，data 为空串，再 base64。
 * 注意它和常见 HMAC(secret, data) 的用法反过来，写错会一直报 sign 错误。
 */
export function buildSign(secret, timestamp) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

function withSign(webhook, payload, secret) {
  if (!secret) return payload;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { timestamp, sign: buildSign(secret, timestamp), ...payload };
}

function normalize(json, httpOk) {
  // 飞书新旧两版返回体字段不同，这里都认
  const code = json && (json.code !== undefined ? json.code : json.StatusCode);
  const msg = (json && (json.msg || json.StatusMessage)) || '';
  const okay = httpOk && (code === 0 || code === undefined);
  return { ok: okay, code, msg };
}

async function post(webhook, payload) {
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const r = normalize(json, res.ok);
    if (!r.ok) {
      return { ok: false, status: res.status, code: r.code, error: r.msg || text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function sendText(webhook, text, opts = {}) {
  if (!webhook) return { ok: false, error: 'no_webhook' };
  return post(webhook, withSign(webhook, {
    msg_type: 'text',
    content: { text: String(text || '') },
  }, opts.secret));
}

/**
 * 发一张卡片。lines 是 markdown 行数组；url 可选，给一个「查看」按钮。
 */
export async function sendCard(webhook, { title, lines = [], color = 'blue', url = '', footer = '' }, opts = {}) {
  if (!webhook) return { ok: false, error: 'no_webhook' };

  const elements = lines
    .filter(Boolean)
    .map((line) => ({ tag: 'div', text: { tag: 'lark_md', content: String(line) } }));

  if (url) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '打开工作台' },
        url,
        type: 'primary',
      }],
    });
  }
  if (footer) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] });
  }

  return post(webhook, withSign(webhook, {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: String(title || '通知') }, template: color },
      elements,
    },
  }, opts.secret));
}
