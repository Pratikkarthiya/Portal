import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { results: transactions } = await env.DB.prepare(`
    SELECT wt.id, wt.user_id, wt.type, wt.amount, wt.balance_after, wt.reference_id, wt.description, wt.receipt_url, wt.status, wt.created_at,
           u.name as user_name, u.email as user_email
    FROM wallet_transactions wt
    JOIN users u ON wt.user_id = u.id
    ORDER BY wt.id DESC
  `).all();

  return jsonResponse({
    success: true,
    transactions: transactions || []
  });
}
