import { getSession, jsonResponse, arrayBufferToBase64 } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const user = await env.DB.prepare(
    'SELECT id, name, email, application_fee, wallet_balance FROM users WHERE id = ?'
  ).bind(session.user_id).first();

  const { results: transactions } = await env.DB.prepare(
    'SELECT id, type, amount, balance_after, reference_id, description, receipt_url, status, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC'
  ).bind(session.user_id).all();

  return jsonResponse({
    success: true,
    walletBalance: user ? (user.wallet_balance || 0.00) : 0.00,
    applicationFee: user ? (user.application_fee || 50.00) : 50.00,
    transactions: transactions || []
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getSession(request, env);
    if (!session || session.user_type !== 'user') {
      return jsonResponse({ error: 'Please log in first' }, 401);
    }

    let amount = 0;
    let utrNumber = '';
    let receiptUrl = '';

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      amount = parseFloat(formData.get('amount') || '0');
      utrNumber = (formData.get('utrNumber') || '').trim();
      const receipt = formData.get('receipt');

      if (receipt && receipt.size > 0) {
        const receiptKey = `wallet-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
        if (env.UPLOADS) {
          await env.UPLOADS.put(receiptKey, await receipt.arrayBuffer(), {
            httpMetadata: { contentType: receipt.type || 'image/jpeg' }
          });
          receiptUrl = `/api/files/${receiptKey}`;
        } else {
          const buf = await receipt.arrayBuffer();
          receiptUrl = `data:${receipt.type || 'image/jpeg'};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } else {
      const body = await request.json().catch(() => ({}));
      amount = parseFloat(body.amount || '0');
      utrNumber = (body.utrNumber || '').trim();
      receiptUrl = body.receiptUrl || '';
    }

    if (!amount || amount < 10) {
      return jsonResponse({ error: 'Minimum wallet top-up amount is ₹10.00' }, 400);
    }

    if (!utrNumber || utrNumber.length < 6) {
      return jsonResponse({ error: 'Please provide your 12-digit Bank UTR / Transaction ID' }, 400);
    }

    const user = await env.DB.prepare('SELECT wallet_balance FROM users WHERE id = ?').bind(session.user_id).first();
    const currentBalance = user && user.wallet_balance ? Number(user.wallet_balance) : 0.00;

    // Check if this UTR was already submitted in wallet transactions
    const duplicate = await env.DB.prepare(
      'SELECT id FROM wallet_transactions WHERE reference_id = ? AND status != "rejected"'
    ).bind(utrNumber).first();

    if (duplicate) {
      return jsonResponse({ error: `❌ UTR / Transaction Ref "${utrNumber}" has already been submitted and processed.` }, 400);
    }

    // Strict Real-Time Bank Verification Check
    // Verify against incoming bank events from Android observer
    const bankEvent = await env.DB.prepare(
      'SELECT id, amount, used_by_user_id FROM bank_events WHERE utr = ?'
    ).bind(utrNumber).first();

    if (!bankEvent) {
      return jsonResponse({
        error: `❌ Payment Failed: UTR "${utrNumber}" is invalid or not received by bank. Please ensure you transferred ₹${amount.toFixed(2)} to UPI ID pratikkarthiya6@oksbi and entered the genuine 12-digit UTR.`
      }, 400);
    }

    if (bankEvent.used_by_user_id) {
      return jsonResponse({
        error: `❌ Payment Rejected: UTR "${utrNumber}" was already claimed and credited to an account.`
      }, 400);
    }

    if (Number(bankEvent.amount) < amount) {
      return jsonResponse({
        error: `❌ Amount Mismatch: Bank received ₹${Number(bankEvent.amount).toFixed(2)}, which is less than the requested top-up of ₹${amount.toFixed(2)}.`
      }, 400);
    }

    // Mark bank event as used
    await env.DB.prepare(
      'UPDATE bank_events SET used_by_user_id = ?, used_for = "wallet" WHERE id = ?'
    ).bind(session.user_id, bankEvent.id).run();

    // Legitimate bank payment verified -> Credit wallet balance
    const newBalance = currentBalance + amount;
    await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBalance, session.user_id).run();

    const res = await env.DB.prepare(`
      INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, receipt_url, status, created_at)
      VALUES (?, 'credit', ?, ?, ?, 'Prepaid Wallet Top-up (Verified UPI)', ?, 'approved', datetime("now"))
    `).bind(session.user_id, amount, newBalance, utrNumber, receiptUrl).run();

    return jsonResponse({
      success: true,
      message: `🎉 ₹${amount.toFixed(2)} added to your wallet successfully! New Balance: ₹${newBalance.toFixed(2)}.`,
      newBalance,
      transactionId: res.meta ? res.meta.last_row_id : null
    });
  } catch (err) {
    console.error('Wallet topup error:', err);
    return jsonResponse({ error: 'Wallet top-up failed: ' + err.message }, 500);
  }
}
