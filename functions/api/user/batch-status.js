import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const user = await env.DB.prepare('SELECT application_fee FROM users WHERE id = ?').bind(session.user_id).first();
  const feePerApp = user && user.application_fee ? user.application_fee : 50.00;

  const { results: unpaidApps } = await env.DB.prepare(
    'SELECT id, application_number, submitted_at FROM applications WHERE user_id = ? AND payment_status = "unpaid" ORDER BY id ASC'
  ).bind(session.user_id).all();

  const unpaidCount = unpaidApps.length;

  return jsonResponse({
    feePerApp,
    unpaidCount,
    slotInBatch: (unpaidCount % 5) + 1,
    requiresPaymentOnNext: unpaidCount === 4,
    hasDueBatch: unpaidCount >= 5,
    unpaidApps,
    batchTotal: feePerApp * 5
  });
}
