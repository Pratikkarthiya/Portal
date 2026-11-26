import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const userId = Number(body.userId);
  const utr = String(body.utr || '').trim();

  if (!userId || !utr) {
    return jsonResponse({ error: 'userId and utr are required' }, 400);
  }

  await env.DB.prepare(`
    UPDATE applications
    SET payment_status = 'unpaid',
        payment_id = 'PENDING_BATCH_OF_5',
        payment_method = 'NONE',
        paid_at = NULL
    WHERE user_id = ? AND payment_id = ?
  `).bind(userId, utr).run();

  await env.DB.prepare(
    'UPDATE bank_events SET used_by_user_id = NULL, used_for = NULL WHERE utr = ? AND used_by_user_id = ?'
  ).bind(utr, userId).run();

  return jsonResponse({
    success: true,
    message: `UTR "${utr}" cleared and application(s) marked unpaid.`
  });
}
