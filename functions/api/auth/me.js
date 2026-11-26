import { getSession, jsonResponse, getPortalShutdownState } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const [session, shutdown] = await Promise.all([
    getSession(request, env),
    getPortalShutdownState(env)
  ]);

  if (!session) {
    return jsonResponse({
      loggedIn: false,
      portalShutdown: shutdown.isShutdown,
      shutdownMessage: shutdown.message
    });
  }

  if (session.user_type === 'admin') {
    return jsonResponse({
      loggedIn: true,
      userType: 'admin',
      portalShutdown: shutdown.isShutdown,
      shutdownMessage: shutdown.message
    });
  }

  const user = await env.DB.prepare('SELECT id, name, email, application_fee, ll_pdf_fee, wallet_balance, telegram_chat_id, created_at FROM users WHERE id = ?').bind(session.user_id).first();
  return jsonResponse({
    loggedIn: true,
    userType: 'user',
    user,
    portalShutdown: shutdown.isShutdown,
    shutdownMessage: shutdown.message
  });
}
