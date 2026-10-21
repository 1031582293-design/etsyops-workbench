// Cloudflare Email Worker：把 Etsy 通知邮件推送到工作台后端
//
// 设计约束（重要）：
//   免费版 Worker 每次只有 10ms CPU。所以这里**只做搬运，不解析邮件**——
//   读原始报文 → base64 → HMAC 签名 → POST。拆信的事留给后端 Node 做。
//
// ★ 为什么还要写 KV（2026-10-21 加）：
//   之前是「收到就推，推不到就丢」。本地后端跑在自家电脑上，隧道一断，
//   那封信就没了。现在改成「先落地，再推送」：
//     邮件 → KV（key: pending:*）→ 尝试推 → 推成功才删 KV
//   推失败也没关系，定时任务（cron）每 5 分钟扫一遍未推的，重试到成功为止。
//   隧道断三天，开机后也会一封不少地补进来。
//
// 需要的环境变量（Cloudflare 面板 Worker → Settings → Variables and Secrets）：
//   MAIL_INGEST_SECRET  必填，与后端 .env 里的同名变量**完全一致**
//   INGEST_URL          可选，默认 https://api.mailili-agency.com/api/mail/ingest
//   FALLBACK_TO         可选，KV 也没配时的最后兜底：转投这个邮箱
//
// 需要的绑定（Settings → Bindings）：
//   KV namespace，变量名必须是 MAIL_PENDING
// 需要的触发器（Settings → Triggers）：
//   Cron：*/5 * * * *

const DEFAULT_INGEST_URL = 'https://api.mailili-agency.com/api/mail/ingest';
const KEY_PREFIX = 'pending:';
const MAX_KV_BYTES = 20 * 1024 * 1024;   // KV 单值上限 25MiB，base64 会膨胀，留点余量
const CRON_BATCH = 10;                   // 每次 cron 最多补推 10 封，避免 CPU 超时

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pushToBackend(env, payload) {
  const ts = String(Date.now());
  const url = env.INGEST_URL || DEFAULT_INGEST_URL;
  const signature = await hmacHex(env.MAIL_INGEST_SECRET, `${ts}.${payload.rawB64}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mail-timestamp': ts,
        'x-mail-signature': signature,
      },
      body: JSON.stringify({ rawB64: payload.rawB64, to: payload.to || '', from: payload.from || '' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, status: res.status, error: text };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export default {
  async email(message, env) {
    const started = Date.now();

    if (!env.MAIL_INGEST_SECRET) {
      if (env.FALLBACK_TO) await message.forward(env.FALLBACK_TO);
      return;
    }

    let rawB64;
    try {
      const buf = await new Response(message.raw).arrayBuffer();
      rawB64 = toBase64(new Uint8Array(buf));
    } catch (e) {
      console.error('[mail-worker] 读取原始报文失败', e && e.message);
      if (env.FALLBACK_TO) await message.forward(env.FALLBACK_TO);
      return;
    }

    const payload = { rawB64, to: message.to || '', from: message.from || '', at: new Date().toISOString() };
    let kvKey = '';

    // ① 先落地：推不推得出去，都先存一份
    if (env.MAIL_PENDING && rawB64.length < MAX_KV_BYTES) {
      kvKey = `${KEY_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
      try {
        await env.MAIL_PENDING.put(kvKey, JSON.stringify(payload));
      } catch (e) {
        console.error('[mail-worker] 写 KV 失败，降级为直接推送', e && e.message);
        kvKey = '';
      }
    }

    // ② 再推送
    const r = await pushToBackend(env, payload);
    if (r.ok) {
      if (kvKey) await env.MAIL_PENDING.delete(kvKey).catch(() => {});
      console.log('[mail-worker] 已投递', message.from, '→', message.to, `${Date.now() - started}ms`);
      return;
    }

    console.error('[mail-worker] 投递失败，已留在 KV 等 cron 重试', r.status || '', r.error || '');
    // ③ 连 KV 都没配上时才走转发兜底
    if (!kvKey && env.FALLBACK_TO) await message.forward(env.FALLBACK_TO);
  },

  // 定时补推：隧道恢复后，把积压的信一封封送进后端
  async scheduled(event, env) {
    if (!env.MAIL_PENDING || !env.MAIL_INGEST_SECRET) return;

    let list;
    try {
      list = await env.MAIL_PENDING.list({ prefix: KEY_PREFIX, limit: CRON_BATCH });
    } catch (e) {
      console.error('[mail-worker] 列 KV 失败', e && e.message);
      return;
    }
    if (!list.keys.length) return;

    let sent = 0;
    for (const k of list.keys) {
      let payload = null;
      try {
        payload = await env.MAIL_PENDING.get(k.name, 'json');
      } catch (e) {
        console.error('[mail-worker] 读 KV 失败', k.name, e && e.message);
        continue;
      }
      if (!payload) {
        await env.MAIL_PENDING.delete(k.name).catch(() => {});
        continue;
      }
      const r = await pushToBackend(env, payload);
      if (r.ok) {
        await env.MAIL_PENDING.delete(k.name).catch(() => {});
        sent++;
      } else {
        // 后端还没活过来，下一轮再试，别把积压删掉
        break;
      }
    }
    if (sent) console.log(`[mail-worker] cron 补推 ${sent} 封`);
  },
};
