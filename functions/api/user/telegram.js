import { getSession, jsonResponse, getTelegramConfig, sendTelegramToChat, escapeTgHtml } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const user = await env.DB.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').bind(session.user_id).first();
  const cfg = await getTelegramConfig(env);

  let botUsername = '';
  if (cfg.token) {
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`);
      const meData = await meRes.json().catch(() => ({}));
      if (meRes.ok && meData.ok && meData.result?.username) {
        botUsername = meData.result.username;
      }
    } catch (e) {}
  }

  return jsonResponse({
    success: true,
    telegramChatId: user ? (user.telegram_chat_id || '') : '',
    botUsername,
    botConfigured: !!cfg.token && cfg.enabled
  });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const chatId = String(body.telegramChatId || '').trim();

  await env.DB.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').bind(chatId, session.user_id).run();

  if (!chatId) {
    return jsonResponse({ success: true, telegramChatId: '', message: 'Telegram alerts disconnected.' });
  }

  const user = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(session.user_id).first();
  const res = await sendTelegramToChat(
    env,
    chatId,
    `🔔 <b>KP CYBER — ALERTS CONNECTED!</b>\n━━━━━━━━━━━━━━━━━━\n👋 Hello <b>${escapeTgHtml(user?.name || 'Candidate')}</b>!\n✅ You will now receive instant Telegram notifications here whenever your application is <b>Approved</b>, needs <b>Correction</b>, or your result is ready!`
  );

  if (!res.ok) {
    let errMsg = res.error || 'Could not send test message.';
    if (errMsg.toLowerCase().includes('chat not found')) {
      errMsg = 'Saved your ID, but Telegram says "chat not found": please open the bot on Telegram and tap START first, then click Save & Test again!';
    }
    return jsonResponse({ error: errMsg, telegramChatId: chatId }, 400);
  }

  return jsonResponse({
    success: true,
    telegramChatId: chatId,
    message: '🎉 Telegram connected! Check your Telegram—we just sent you a test confirmation.'
  });
}
