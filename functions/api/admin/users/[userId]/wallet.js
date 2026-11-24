import { getSession, jsonResponse } from '../../../../utils.js';

export async function onRequestPost({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const userId = params.userId;
  const user = await env.DB.prepare('SELECT id, name, wallet_balance FROM users WHERE id = ?').bind(userId).first();
  if (!user) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const body = await request.json().catch(() => ({}));
  const numAmount = parseFloat(body.amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    return jsonResponse({ error: 'Valid amount is required' }, 400);
  }

  const currentBalance = Number(user.wallet_balance) || 0.00;
  const isCredit = body.type !== 'debit';
  const newBalance = isCredit ? currentBalance + numAmount : Math.max(0, currentBalance - numAmount);
  const actualDiff = isCredit ? numAmount : (currentBalance - newBalance);

  await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBalance, userId).run();

  await env.DB.prepare(`
    INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status, created_at)
    VALUES (?, ?, ?, ?, 'ADMIN-ADJUST', ?, 'approved', datetime("now"))
  `).bind(userId, isCredit ? 'credit' : 'debit', actualDiff, newBalance, body.note || (isCredit ? 'Admin Wallet Credit' : 'Admin Wallet Debit')).run();

  return jsonResponse({
    success: true,
    message: `Wallet updated for ${user.name}: ${isCredit ? '+' : '-'}₹${numAmount.toFixed(2)}. New balance: ₹${newBalance.toFixed(2)}`,
    newBalance
  });
}
