import { getSession, jsonResponse, getRegistrationState } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const state = await getRegistrationState(env);
  return jsonResponse({
    success: true,
    isStopped: state.isStopped,
    message: state.message
  });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const isStopped = !!body.isStopped;
  const customMessage = body.message !== undefined ? String(body.message).trim() : undefined;

  await env.DB.prepare(
    'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind('registration_stopped', isStopped ? '1' : '0').run();

  if (customMessage !== undefined) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind('registration_stopped_message', customMessage).run();
  }

  const state = await getRegistrationState(env);
  return jsonResponse({
    success: true,
    isStopped: state.isStopped,
    message: state.message,
    statusText: state.isStopped
      ? '🔒 User registration is now STOPPED. New users cannot self-register.'
      : '🟢 User registration is now OPEN. New users can register with Gmail.'
  });
}
