import { getSession, jsonResponse, getPortalNoticeState } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const notice = await getPortalNoticeState(env);
  return jsonResponse({ success: true, notice });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const title = String(body.title || '📢 Important Update').trim();
  const message = String(body.message || '').trim();
  const version = String(Date.now());

  if (enabled && !message) {
    return jsonResponse({ error: 'Please enter a notice message before publishing.' }, 400);
  }

  const entries = [
    ['portal_notice_enabled', enabled ? '1' : '0'],
    ['portal_notice_title', title],
    ['portal_notice_message', message],
    ['portal_notice_version', version]
  ];

  for (const [k, v] of entries) {
    await env.DB.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(k, v).run();
  }

  return jsonResponse({
    success: true,
    notice: { enabled, title, message, version },
    statusText: enabled
      ? '📢 Notice published! All users will see this popup on their dashboard.'
      : '🔕 Notice popup turned off.'
  });
}
