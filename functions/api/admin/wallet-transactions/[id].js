import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestDelete({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const id = params.id;
  const tx = await env.DB.prepare(
    'SELECT id, user_id, type, amount, reference_id FROM wallet_transactions WHERE id = ?'
  ).bind(id).first();

  if (!tx) {
    return jsonResponse({ error: 'Wallet transaction not found' }, 404);
  }

  // Reverse wallet credit if deleting a credit transaction
  if (tx.type === 'credit' && Number(tx.amount) > 0) {
    const user = await env.DB.prepare('SELECT wallet_balance FROM users WHERE id = ?').bind(tx.user_id).first();
    const curBal = user ? Number(user.wallet_balance || 0) : 0;
    const newBal = Math.max(0, curBal - Number(tx.amount));
    await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBal, tx.user_id).run();
  }

  // Release matching bank_events claim if any
  if (tx.reference_id && tx.reference_id !== 'ADMIN-ADJUST') {
    await env.DB.prepare(
      'UPDATE bank_events SET used_by_user_id = NULL, used_for = NULL WHERE utr = ? AND used_by_user_id = ?'
    ).bind(tx.reference_id, tx.user_id).run();
  }

  await env.DB.prepare('DELETE FROM wallet_transactions WHERE id = ?').bind(id).run();

  return jsonResponse({
    success: true,
    message: `Transaction (Ref: ${tx.reference_id || id}) deleted.`
  });
}
