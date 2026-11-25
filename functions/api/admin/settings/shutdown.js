import { getSession, jsonResponse, getPortalShutdownState } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const state = await getPortalShutdownState(env);
  return jsonResponse({
    success: true,
    isShutdown: state.isShutdown,
    message: state.message
  });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const isShutdown = !!body.isShutdown;
  const customMessage = body.message !== undefined ? String(body.message).trim() : undefined;

  await env.DB.prepare(
    'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind('portal_shutdown', isShutdown ? '1' : '0').run();

  if (customMessage !== undefined) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind('portal_shutdown_message', customMessage).run();
  }

  const state = await getPortalShutdownState(env);
  return jsonResponse({
    success: true,
    isShutdown: state.isShutdown,
    message: state.message,
    statusText: state.isShutdown
      ? '🔴 Portal is now SHUT DOWN. All user logins, submissions, and top-ups are stopped.'
      : '🟢 Portal is now ONLINE. Users can work normally.'
  });
}
