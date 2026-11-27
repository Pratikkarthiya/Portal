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

export async function getPortalShutdownState(env) {
  const defaultMsg = 'Portal is temporarily closed by Admin. Work is paused—please check back later.';
  try {
    if (!env?.DB) return { isShutdown: false, message: defaultMsg };
    const rows = await env.DB.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('portal_shutdown', 'portal_shutdown_message')"
    ).all();
    const map = {};
    (rows?.results || []).forEach(r => { map[r.key] = r.value; });
    return {
      isShutdown: map.portal_shutdown === '1',
      message: (map.portal_shutdown_message || '').trim() || defaultMsg
    };
  } catch (e) {
    return { isShutdown: false, message: defaultMsg };
  }
}

export async function getRegistrationState(env) {
  const defaultMsg = 'New user registration is temporarily closed by Admin.';
  try {
    if (!env?.DB) return { isStopped: false, message: defaultMsg };
    const rows = await env.DB.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('registration_stopped', 'registration_stopped_message')"
    ).all();
    const map = {};
    (rows?.results || []).forEach(r => { map[r.key] = r.value; });
    return {
      isStopped: map.registration_stopped === '1',
      message: (map.registration_stopped_message || '').trim() || defaultMsg
    };
  } catch (e) {
    return { isStopped: false, message: defaultMsg };
  }
}

export async function getPortalNoticeState(env) {
  try {
    if (!env?.DB) return { enabled: false, title: '', message: '', version: '' };
    const rows = await env.DB.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('portal_notice_enabled', 'portal_notice_title', 'portal_notice_message', 'portal_notice_version')"
    ).all();
    const map = {};
    (rows?.results || []).forEach(r => { map[r.key] = r.value; });
    return {
      enabled: map.portal_notice_enabled === '1' && !!(map.portal_notice_message || '').trim(),
      title: (map.portal_notice_title || '').trim() || '📢 Important Update',
      message: (map.portal_notice_message || '').trim(),
      version: map.portal_notice_version || '1'
    };
  } catch (e) {
    return { enabled: false, title: '', message: '', version: '' };
  }
}

export async function getTelegramConfig(env) {
  let token = env?.TELEGRAM_BOT_TOKEN || '';
  let adminChatId = env?.TELEGRAM_CHAT_ID || '';
  let enabled = true;

  if (env?.DB) {
    try {
      const rows = await env.DB.prepare(
        "SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_alerts_enabled')"
      ).all();
      if (rows && rows.results) {
        const map = {};
        rows.results.forEach(r => { map[r.key] = r.value; });
        if (map.telegram_alerts_enabled === '0') enabled = false;
        token = token || map.telegram_bot_token || '';
        adminChatId = adminChatId || map.telegram_chat_id || '';
      }
    } catch (e) {}
  }

  return { token: String(token).trim(), adminChatId: String(adminChatId).trim(), enabled };
}

// Dispatches formatted HTML message (and optional base64 photo) to any Telegram chat ID
export async function sendTelegramToChat(env, targetChatId, messageHtml, photoDataUrl = '') {
  try {
    const cleanChatId = String(targetChatId || '').trim();
    if (!cleanChatId) return { ok: false, error: 'Missing Telegram Chat ID' };

    const cfg = await getTelegramConfig(env);
    if (!cfg.enabled || !cfg.token) {
      return { ok: false, error: 'Telegram bot is not configured or disabled' };
    }

    // If a base64 data URI image or PDF is provided, send via sendPhoto or sendDocument first
    if (photoDataUrl && (String(photoDataUrl).startsWith('data:image/') || String(photoDataUrl).startsWith('data:application/pdf'))) {
      try {
        const isPdf = String(photoDataUrl).startsWith('data:application/pdf');
        const parts = String(photoDataUrl).split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : (isPdf ? 'application/pdf' : 'image/jpeg');
        const binStr = atob(parts[1]);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const form = new FormData();
        form.append('chat_id', cleanChatId);
        form.append(isPdf ? 'document' : 'photo', blob, isPdf ? 'LL_Document.pdf' : 'result.jpg');
        form.append('caption', messageHtml.slice(0, 1000));
        form.append('parse_mode', 'HTML');

        const endpoint = isPdf ? 'sendDocument' : 'sendPhoto';
        const mediaResp = await fetch(`https://api.telegram.org/bot${cfg.token}/${endpoint}`, {
          method: 'POST',
          body: form
        });
        const mediaData = await mediaResp.json().catch(() => ({}));
        if (mediaResp.ok && mediaData.ok) {
          return { ok: true };
        }
      } catch (e) {
        console.warn('Telegram media send fallback to sendMessage:', e);
      }
    }

    let resp = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cleanChatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const respData = await resp.json().catch(() => ({}));
    if (!resp.ok || !respData.ok) {
      if (respData?.description && respData.description.toLowerCase().includes('entities')) {
        const plainText = messageHtml.replace(/<[^>]+>/g, '');
        const fallbackResp = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cleanChatId,
            text: plainText,
            disable_web_page_preview: true
          })
        });
        const fallbackData = await fallbackResp.json().catch(() => ({}));
        return { ok: fallbackResp.ok && fallbackData.ok, error: fallbackData.description };
      }
      return { ok: false, error: respData.description || 'Telegram sendMessage failed' };
    }

    return { ok: true };
  } catch (err) {
    console.error('Telegram notification error:', err);
    return { ok: false, error: err.message };
  }
}

// Dispatches formatted HTML alert to Admin Telegram Bot
export async function sendTelegramAlert(env, messageHtml) {
  const cfg = await getTelegramConfig(env);
  if (!cfg.enabled || !cfg.token || !cfg.adminChatId) return;
  return sendTelegramToChat(env, cfg.adminChatId, messageHtml);
}
