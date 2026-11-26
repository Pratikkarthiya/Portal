import { jsonResponse, getPortalShutdownState, sendTelegramAlert, escapeTgHtml } from '../../utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const shutdown = await getPortalShutdownState(env);
    if (shutdown.isShutdown) {
      return jsonResponse({ error: shutdown.message, portalShutdown: true }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const telegramChatId = String(body.telegramChatId || '').trim();

    if (!name || name.length < 2) {
      return jsonResponse({ error: 'Please enter your full name.' }, 400);
    }
    if (!email || !/^[^\s@]+@gmail\.com$/i.test(email)) {
      return jsonResponse({ error: 'Please register using a valid @gmail.com email address.' }, 400);
    }
    if (!password || password.length < 6) {
      return jsonResponse({ error: 'Password must be at least 6 characters.' }, 400);
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
      .bind(email).first();
    if (existing) {
      return jsonResponse({ error: 'An account with this Gmail already exists. Please sign in.' }, 409);
    }

    const insertRes = await env.DB.prepare(
      `INSERT INTO users (name, email, password, application_fee, ll_pdf_fee, payment_mode, telegram_chat_id)
       VALUES (?, ?, ?, 50.00, 20.00, 'batch', ?)`
    ).bind(name, email, password, telegramChatId).run();

    const userId = insertRes.meta ? insertRes.meta.last_row_id : null;
    if (!userId) {
      return jsonResponse({ error: 'Failed to create account.' }, 500);
    }

    // Auto-login newly registered user
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'INSERT INTO sessions (token, user_id, user_type, expires_at) VALUES (?, ?, "user", ?)'
    ).bind(token, userId, expiresAt).run();

    // Notify Admin on Telegram
    try {
      const timeNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      await sendTelegramAlert(
        env,
        `🆕 <b>KP CYBER — NEW GMAIL REGISTRATION!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${escapeTgHtml(name)}\n📧 <b>Gmail:</b> <code>${escapeTgHtml(email)}</code>\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://portal-2a3.pages.dev/admin">View in Admin Users</a>`
      );
    } catch (e) {}

    return jsonResponse({
      success: true,
      message: '🎉 Account created successfully! Redirecting to dashboard...'
    }, 200, {
      'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    });
  } catch (err) {
    console.error('Register error:', err);
    return jsonResponse({ error: 'Registration failed: ' + (err.message || 'Server error') }, 500);
  }
}
