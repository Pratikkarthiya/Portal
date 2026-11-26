import { getSession, jsonResponse, getPortalShutdownState, sendTelegramAlert, escapeTgHtml } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const user = await env.DB.prepare(
    'SELECT ll_pdf_fee, wallet_balance FROM users WHERE id = ?'
  ).bind(session.user_id).first();

  const { results: requests } = await env.DB.prepare(
    'SELECT id, application_number, fee_amount, status, pdf_url, admin_remarks, created_at, completed_at FROM ll_pdf_requests WHERE user_id = ? ORDER BY id DESC'
  ).bind(session.user_id).all();

  return jsonResponse({
    success: true,
    llPdfFee: user && user.ll_pdf_fee !== null && user.ll_pdf_fee !== undefined ? Number(user.ll_pdf_fee) : 20.00,
    walletBalance: user ? Number(user.wallet_balance || 0) : 0.00,
    requests: requests || []
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getSession(request, env);
    if (!session || session.user_type !== 'user') {
      return jsonResponse({ error: 'Please log in first' }, 401);
    }

    const shutdown = await getPortalShutdownState(env);
    if (shutdown.isShutdown) {
      return jsonResponse({ error: shutdown.message, portalShutdown: true }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const applicationNumber = String(body.applicationNumber || '').trim();
    if (!applicationNumber || applicationNumber.length < 3) {
      return jsonResponse({ error: 'Please enter a valid Application Number' }, 400);
    }

    const user = await env.DB.prepare(
      'SELECT id, name, email, ll_pdf_fee, wallet_balance FROM users WHERE id = ?'
    ).bind(session.user_id).first();

    if (!user) {
      return jsonResponse({ error: 'User account not found' }, 404);
    }

    const llPdfFee = user.ll_pdf_fee !== null && user.ll_pdf_fee !== undefined ? Number(user.ll_pdf_fee) : 20.00;
    const currentBalance = Number(user.wallet_balance || 0);

    if (currentBalance < llPdfFee) {
      return jsonResponse({
        error: `Insufficient wallet balance (₹${currentBalance.toFixed(2)}). LL PDF rate is ₹${llPdfFee.toFixed(2)}—please add money to your wallet first.`,
        insufficientWallet: true,
        requiredFee: llPdfFee,
        walletBalance: currentBalance
      }, 400);
    }

    const newBalance = currentBalance - llPdfFee;
    await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?')
      .bind(newBalance, session.user_id).run();

    await env.DB.prepare(`
      INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status)
      VALUES (?, 'debit', ?, ?, ?, ?, 'approved')
    `).bind(
      session.user_id,
      llPdfFee,
      newBalance,
      applicationNumber,
      `LL PDF Request #${applicationNumber}`
    ).run();

    const insertRes = await env.DB.prepare(`
      INSERT INTO ll_pdf_requests (user_id, application_number, fee_amount, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime("now"))
    `).bind(session.user_id, applicationNumber, llPdfFee).run();

    try {
      const candidateLabel = `${escapeTgHtml(user.name)} (${escapeTgHtml(user.email)})`;
      const timeNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      await sendTelegramAlert(
        env,
        `📄 <b>KP CYBER — NEW LL PDF REQUEST!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n📝 <b>App Number:</b> <code>${escapeTgHtml(applicationNumber)}</code>\n💳 <b>Fee Deducted:</b> ₹${llPdfFee.toFixed(2)} (Wallet)\n🏦 <b>New Wallet Balance:</b> ₹${newBalance.toFixed(2)}\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://portal-2a3.pages.dev/admin">Upload PDF in Admin</a>`
      );
    } catch (e) {}

    return jsonResponse({
      success: true,
      requestId: insertRes.meta ? insertRes.meta.last_row_id : null,
      walletBalance: newBalance,
      feeDeducted: llPdfFee,
      message: `📄 LL PDF requested for #${applicationNumber}! ₹${llPdfFee.toFixed(2)} deducted from wallet.`
    });
  } catch (err) {
    console.error('LL PDF request error:', err);
    return jsonResponse({ error: 'Failed to submit LL PDF request: ' + err.message }, 500);
  }
}
