export async function getSession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
  if (!match) return null;

  const token = match[1];
  const session = await env.DB.prepare(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > datetime("now")'
  ).bind(token).first();

  return session || null;
}

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

// Safely convert ArrayBuffer to Base64 in chunks without call-stack overflow
export function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function escapeTgHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Dispatches formatted HTML alert to Admin Telegram Bot
export async function sendTelegramAlert(env, messageHtml) {
  try {
    let token = env?.TELEGRAM_BOT_TOKEN;
    let chatId = env?.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      if (env?.DB) {
        const rows = await env.DB.prepare(
          "SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_alerts_enabled')"
        ).all();
        if (rows && rows.results) {
          const map = {};
          rows.results.forEach(r => { map[r.key] = r.value; });
          if (map.telegram_alerts_enabled === '0') return;
          token = token || map.telegram_bot_token;
          chatId = chatId || map.telegram_chat_id;
        }
      }
    }

    if (!token || !chatId) {
      console.warn('Telegram alert skipped: token or chatId missing');
      return;
    }

    let resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      // Fallback: If Telegram couldn't parse HTML entities, send as clean plain text
      if (errJson?.description && errJson.description.toLowerCase().includes('entities')) {
        const plainText = messageHtml.replace(/<[^>]+>/g, '');
        resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainText,
            disable_web_page_preview: true
          })
        });
      }
    }
  } catch (err) {
    console.error('Telegram notification error:', err);
  }
}
