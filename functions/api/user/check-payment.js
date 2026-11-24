import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const url = new URL(request.url);
  const sinceMs = parseInt(url.searchParams.get('since') || '0', 10);
  // Default to checking last 2 minutes if since is not provided or invalid
  const lookbackSeconds = sinceMs > 0 ? Math.max(1, Math.floor((Date.now() - sinceMs) / 1000)) : 120;

  // 1. Check for recently paid applications
  const recentApp = await env.DB.prepare(`
    SELECT id, application_number, payment_id, payment_amount, paid_at 
    FROM applications 
    WHERE user_id = ? AND payment_status = 'paid' AND paid_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY paid_at DESC LIMIT 1
  `).bind(session.user_id, lookbackSeconds).first();

  if (recentApp) {
    return jsonResponse({
      success: true,
      verified: true,
      type: 'application',
      amount: recentApp.payment_amount || 250.00,
      utr: recentApp.payment_id || 'N/A',
      title: 'Batch Payment Verified!',
      message: `Your payment of ₹${Number(recentApp.payment_amount || 250).toFixed(2)} has been verified and settled successfully!`
    });
  }

  // 2. Check for recently credited wallet transactions
  const recentWallet = await env.DB.prepare(`
    SELECT id, amount, balance_after, reference_id, created_at 
    FROM wallet_transactions 
    WHERE user_id = ? AND type = 'credit' AND status = 'approved' AND created_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY id DESC LIMIT 1
  `).bind(session.user_id, lookbackSeconds).first();

  if (recentWallet) {
    return jsonResponse({
      success: true,
      verified: true,
      type: 'wallet',
      amount: recentWallet.amount,
      utr: recentWallet.reference_id || 'N/A',
      newBalance: recentWallet.balance_after,
      title: 'Wallet Top-Up Confirmed!',
      message: `₹${Number(recentWallet.amount).toFixed(2)} has been credited to your prepaid wallet! New balance: ₹${Number(recentWallet.balance_after).toFixed(2)}.`
    });
  }

  return jsonResponse({
    success: true,
    verified: false
  });
}
