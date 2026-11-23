import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const appId = params.appId;
  const { status, remarks } = await request.json();

  await env.DB.prepare(
    'UPDATE applications SET status = ?, admin_remarks = ?, reviewed_at = datetime("now") WHERE id = ?'
  ).bind(status, remarks || '', appId).run();

  return jsonResponse({ success: true, message: `Application ${status}` });
}
