import { getSession, jsonResponse, sendTelegramAlert } from '../../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { results } = await env.DB.prepare(
    "SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_alerts_enabled')"
  ).all();

  const settings = {
    botToken: '',
    chatId: '',
    enabled: true
  };

  (results || []).forEach(r => {
    if (r.key === 'telegram_bot_token') settings.botToken = r.value || '';
    if (r.key === 'telegram_chat_id') settings.chatId = r.value || '';
    if (r.key === 'telegram_alerts_enabled') settings.enabled = r.value !== '0';
  });

  return jsonResponse({ success: true, settings });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const { botToken, chatId, enabled, isTest } = body;

  if (botToken !== undefined) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind('telegram_bot_token', String(botToken).trim()).run();
  }

  if (chatId !== undefined) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind('telegram_chat_id', String(chatId).trim()).run();
  }

  if (enabled !== undefined) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind('telegram_alerts_enabled', enabled ? '1' : '0').run();
  }

  if (isTest) {
    const activeToken = String(botToken || '').trim();
    const activeChatId = String(chatId || '').trim();

    if (!activeToken || !activeChatId) {
      return jsonResponse({ error: 'Please enter both Bot Token and Chat ID to send test alert.' }, 400);
    }

    const testMsg = `🔔 <b>KP CYBER — TEST NOTIFICATION</b>
━━━━━━━━━━━━━━━━━━
✅ <b>Telegram Bot connection successful!</b>
⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
⚡ You will now receive instant push alerts whenever candidates submit applications or add money to their wallet!`;

    const tgRes = await fetch(`https://api.telegram.org/bot${activeToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: activeChatId,
        text: testMsg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const tgData = await tgRes.json().catch(() => ({}));
    if (!tgRes.ok || !tgData.ok) {
      return jsonResponse({
        error: 'Telegram error: ' + (tgData.description || 'Invalid Bot Token or Chat ID')
      }, 400);
    }

    return jsonResponse({
      success: true,
      message: '🎉 Test message sent to your Telegram successfully! Check your phone.'
    });
  }

  return jsonResponse({
    success: true,
    message: 'Telegram alert settings saved successfully.'
  });
}
