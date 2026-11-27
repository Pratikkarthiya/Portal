import { jsonResponse, arrayBufferToBase64, sendTelegramToChat, escapeTgHtml } from '../../../utils.js';

async function verifyWorkerKey(request, env) {
  const provided =
    request.headers.get('X-Worker-Key') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

  if (!provided) return false;

  let expected = env.LL_WORKER_SECRET || '';
  if (!expected && env.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = 'll_worker_secret'"
      ).first();
      expected = row ? String(row.value || '').trim() : '';
    } catch (e) {}
  }

  return Boolean(expected && provided === expected);
}

export async function onRequestPost({ request, env }) {
  const authorized = await verifyWorkerKey(request, env);
  if (!authorized) {
    return jsonResponse({ error: 'Unauthorized worker key' }, 401);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await request.formData();
  const requestId = formData.get('requestId');
  const applicationNumber = String(formData.get('applicationNumber') || '').trim();
  const remarks = String(formData.get('remarks') || '').trim();
  const file = formData.get('pdf');

  let existing = null;
  if (requestId) {
    existing = await env.DB.prepare(
      'SELECT id, user_id, application_number, fee_amount, status, pdf_url FROM ll_pdf_requests WHERE id = ?'
    ).bind(requestId).first();
  } else if (applicationNumber) {
    existing = await env.DB.prepare(
      "SELECT id, user_id, application_number, fee_amount, status, pdf_url FROM ll_pdf_requests WHERE application_number = ? AND status = 'pending' ORDER BY id ASC LIMIT 1"
    ).bind(applicationNumber).first();
  }

  if (!existing) {
    return jsonResponse({ error: 'LL PDF request not found' }, 404);
  }

  if (!file || !file.size) {
    return jsonResponse({ error: 'PDF file is required' }, 400);
  }

  const buf = await file.arrayBuffer();
  const pdfKey = `llpdf-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
  let pdfUrl = '';
  let pdfDataUriForTg = '';

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

  await env.DB.prepare(`
    UPDATE ll_pdf_requests
    SET status = 'completed', pdf_url = ?, admin_remarks = ?, completed_at = datetime("now")
    WHERE id = ?
  `).bind(pdfUrl, remarks || 'Auto-fetched via Telegram Bridge', existing.id).run();

  try {
    const customer = await env.DB.prepare(
      'SELECT name, telegram_chat_id FROM users WHERE id = ?'
    ).bind(existing.user_id).first();

    if (customer && customer.telegram_chat_id) {
      const custName = escapeTgHtml(customer.name || 'Candidate');
      const escApp = escapeTgHtml(existing.application_number);
      const escRem = remarks ? `\n📝 <b>Remarks:</b> ${escapeTgHtml(remarks)}` : '';
      const msg = `📄 <b>KP CYBER — YOUR LL PDF IS READY!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n🔗 <a href="https://portal-2a3.pages.dev">Download from Dashboard</a>`;
      await sendTelegramToChat(env, customer.telegram_chat_id, msg, pdfDataUriForTg);
    }
  } catch (e) {
    console.error('Worker LL PDF Telegram notify error:', e);
  }

  return jsonResponse({
    success: true,
    requestId: existing.id,
    applicationNumber: existing.application_number,
    pdfUrl
  });
}
