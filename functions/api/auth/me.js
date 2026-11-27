import { getSession, jsonResponse, getPortalShutdownState, getPortalNoticeState, getRegistrationState } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const [session, shutdown, notice, regState] = await Promise.all([
    getSession(request, env),
    getPortalShutdownState(env),
    getPortalNoticeState(env),
    getRegistrationState(env)
  ]);

  if (!session) {
    return jsonResponse({
      loggedIn: false,
      portalShutdown: shutdown.isShutdown,
      shutdownMessage: shutdown.message,
      registrationStopped: regState.isStopped,
      registrationMessage: regState.message,
      portalNotice: notice
    });
  }

  if (session.user_type === 'admin') {
    return jsonResponse({
      loggedIn: true,
      userType: 'admin',
      portalShutdown: shutdown.isShutdown,
      shutdownMessage: shutdown.message,
      registrationStopped: regState.isStopped,
      registrationMessage: regState.message,
      portalNotice: notice
    });
  }

  const user = await env.DB.prepare('SELECT id, name, email, application_fee, ll_pdf_fee, wallet_balance, telegram_chat_id, created_at FROM users WHERE id = ?').bind(session.user_id).first();
  return jsonResponse({
    loggedIn: true,
    userType: 'user',
    user,
    portalShutdown: shutdown.isShutdown,
    shutdownMessage: shutdown.message,
    registrationStopped: regState.isStopped,
    registrationMessage: regState.message,
    portalNotice: notice
  });
}
