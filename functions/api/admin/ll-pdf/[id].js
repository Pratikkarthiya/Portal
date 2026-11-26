import { getSession, jsonResponse, arrayBufferToBase64, sendTelegramToChat, escapeTgHtml } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const reqId = params.id;
  const existing = await env.DB.prepare(
    'SELECT id, user_id, application_number, fee_amount, status, pdf_url, admin_remarks FROM ll_pdf_requests WHERE id = ?'
  ).bind(reqId).first();

  if (!existing) {
    return jsonResponse({ error: 'LL PDF request not found' }, 404);
  }

  let status = existing.status;
  let remarks = existing.admin_remarks || '';
  let pdfUrl = existing.pdf_url || '';
  let pdfDataUriForTg = '';

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('pdf');
    if (formData.get('remarks') !== null) {
      remarks = String(formData.get('remarks')).trim();
    }
    const reqStatus = formData.get('status');
    if (reqStatus) status = String(reqStatus);

    if (file && file.size > 0) {
      const buf = await file.arrayBuffer();
      const pdfKey = `llpdf-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
      if (env.UPLOADS) {
        await env.UPLOADS.put(pdfKey, buf, {
          httpMetadata: { contentType: 'application/pdf' }
        });
        pdfUrl = `/api/files/${pdfKey}`;
      } else {
        pdfUrl = `data:application/pdf;base64,${arrayBufferToBase64(buf)}`;
      }
      if (buf.byteLength <= 4 * 1024 * 1024) {
        pdfDataUriForTg = `data:application/pdf;base64,${arrayBufferToBase64(buf)}`;
      }
      status = 'completed';
    }
  } else {
    const body = await request.json().catch(() => ({}));
    if (body.status) status = body.status;
    if (body.remarks !== undefined) remarks = String(body.remarks).trim();
    if (body.pdfUrl) pdfUrl = String(body.pdfUrl);
  }

  // Refund wallet once if transitioning from pending -> rejected
  let refundedAmount = 0;
  if (status === 'rejected' && existing.status === 'pending' && Number(existing.fee_amount) > 0) {
    const userRow = await env.DB.prepare('SELECT wallet_balance FROM users WHERE id = ?').bind(existing.user_id).first();
    const curBal = userRow ? Number(userRow.wallet_balance || 0) : 0;
    refundedAmount = Number(existing.fee_amount);
    const newBal = curBal + refundedAmount;
    await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBal, existing.user_id).run();
    await env.DB.prepare(`
      INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status)
      VALUES (?, 'credit', ?, ?, ?, ?, 'approved')
    `).bind(
      existing.user_id,
      refundedAmount,
      newBal,
      existing.application_number,
      `Refund: LL PDF #${existing.application_number} Rejected`
    ).run();
  }

  await env.DB.prepare(`
    UPDATE ll_pdf_requests
    SET status = ?, pdf_url = ?, admin_remarks = ?, completed_at = datetime("now")
    WHERE id = ?
  `).bind(status, pdfUrl, remarks, reqId).run();

  // Notify customer via Telegram if connected
  try {
    const customer = await env.DB.prepare('SELECT name, telegram_chat_id FROM users WHERE id = ?').bind(existing.user_id).first();
    if (customer && customer.telegram_chat_id) {
      const custName = escapeTgHtml(customer.name || 'Candidate');
      const escApp = escapeTgHtml(existing.application_number);
      const escRem = remarks ? `\n📝 <b>Remarks:</b> ${escapeTgHtml(remarks)}` : '';
      if (status === 'completed') {
        const msg = `📄 <b>KP CYBER — YOUR LL PDF IS READY!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n🔗 <a href="https://portal-2a3.pages.dev">Download from Dashboard</a>`;
        await sendTelegramToChat(env, customer.telegram_chat_id, msg, pdfDataUriForTg);
      } else if (status === 'rejected') {
        const msg = `❌ <b>KP CYBER — LL PDF REQUEST REJECTED</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n💰 <b>Refunded to Wallet:</b> ₹${refundedAmount.toFixed(2)}`;
        await sendTelegramToChat(env, customer.telegram_chat_id, msg);
      }
    }
  } catch (e) {
    console.error('LL PDF Telegram notify error:', e);
  }

  return jsonResponse({
    success: true,
    status,
    pdfUrl,
    message: status === 'completed'
      ? `📄 LL PDF uploaded & sent for #${existing.application_number}!`
      : (status === 'rejected'
        ? `❌ Request #${existing.application_number} rejected and ₹${refundedAmount.toFixed(2)} refunded to wallet.`
        : `Request #${existing.application_number} updated.`)
  });
}

export async function onRequestDelete({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const reqId = params.id;
  const existing = await env.DB.prepare('SELECT id, application_number, pdf_url FROM ll_pdf_requests WHERE id = ?').bind(reqId).first();
  if (!existing) {
    return jsonResponse({ error: 'LL PDF request not found' }, 404);
  }

  if (env.UPLOADS && existing.pdf_url && existing.pdf_url.startsWith('/api/files/')) {
    try {
      await env.UPLOADS.delete(existing.pdf_url.replace('/api/files/', ''));
    } catch (e) {}
  }

  await env.DB.prepare('DELETE FROM ll_pdf_requests WHERE id = ?').bind(reqId).run();
  return jsonResponse({ success: true, message: `LL PDF request #${existing.application_number} deleted.` });
}
