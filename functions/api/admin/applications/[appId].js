import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const appId = params.appId;
  const { status, remarks, resultPhotoUrl } = await request.json();

  if (resultPhotoUrl !== undefined) {
    await env.DB.prepare(
      'UPDATE applications SET status = ?, admin_remarks = ?, result_photo_url = ?, reviewed_at = datetime("now") WHERE id = ?'
    ).bind(status, remarks || '', resultPhotoUrl || '', appId).run();
  } else {
    await env.DB.prepare(
      'UPDATE applications SET status = ?, admin_remarks = ?, reviewed_at = datetime("now") WHERE id = ?'
    ).bind(status, remarks || '', appId).run();
  }

  return jsonResponse({ success: true, message: `Application ${status}` });
}
