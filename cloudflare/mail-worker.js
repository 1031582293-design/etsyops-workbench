// Cloudflare Email Worker：把 Etsy 通知邮件推送到工作台后端
//
// 设计约束（重要）：
//   免费版 Worker 每次只有 10ms CPU。所以这里**只做搬运，不解析邮件**——
//   读原始报文 → base64 → HMAC 签名 → POST。拆信的事留给后端 Node 做。
//
// 需要的环境变量（在 Cloudflare 面板 Worker → Settings → Variables and Secrets 里配）：
//   MAIL_INGEST_SECRET  必填，与后端 .env 里的同名变量**完全一致**
//   INGEST_URL          可选，默认 https://api.mailili-agency.com/api/mail/ingest
//   FALLBACK_TO         可选，推送失败时把原邮件转投到这个地址（防 Tunnel 抖动丢信）
//
// 部署后还要在 Email Routing → Routing rules 里，把目标地址的动作设为
// 「Send to a Worker」，选中这个 Worker。

const DEFAULT_INGEST_URL = 'https://api.mailili-agency.com/api/mail/ingest';

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

export default {
  async email(message, env) {
    const started = Date.now();

    if (!env.MAIL_INGEST_SECRET) {
      // 密钥没配：直接转投兜底地址，别把信吞了
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

    const ts = String(Date.now());
    const url = env.INGEST_URL || DEFAULT_INGEST_URL;

    try {
      const signature = await hmacHex(env.MAIL_INGEST_SECRET, `${ts}.${rawB64}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mail-timestamp': ts,
          'x-mail-signature': signature,
        },
        body: JSON.stringify({ rawB64, to: message.to || '', from: message.from || '' }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        console.error('[mail-worker] 后端拒收', res.status, text);
        if (env.FALLBACK_TO) await message.forward(env.FALLBACK_TO);
        return;
      }
      console.log('[mail-worker] 已投递', message.from, '→', message.to, `${Date.now() - started}ms`);
    } catch (e) {
      // 网络失败（Tunnel 抖动最常见）：转投兜底地址，宁可贵一点也别丢信
      console.error('[mail-worker] 投递异常', e && e.message);
      if (env.FALLBACK_TO) await message.forward(env.FALLBACK_TO);
    }
  },
};
