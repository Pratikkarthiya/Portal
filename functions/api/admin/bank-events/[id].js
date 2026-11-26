import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestDelete({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const id = params.id;
  const existing = await env.DB.prepare('SELECT id, utr FROM bank_events WHERE id = ?').bind(id).first();
  if (!existing) {
    return jsonResponse({ error: 'Bank UTR event not found' }, 404);
  }

  await env.DB.prepare('DELETE FROM bank_events WHERE id = ?').bind(id).run();

  return jsonResponse({
    success: true,
    message: `Bank UTR "${existing.utr}" deleted.`
  });
}
