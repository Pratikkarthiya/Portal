import { getSession, jsonResponse, sendTelegramToChat, escapeTgHtml } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const appId = params.appId;
  const existing = await env.DB.prepare(
    'SELECT id, user_id, status, admin_remarks, application_number, date_of_birth, app_password, payment_status, payment_id, payment_amount, payment_method, paid_at, result_photo_url FROM applications WHERE id = ?'
  ).bind(appId).first();

  if (!existing) {
    return jsonResponse({ error: 'Application not found' }, 404);
  }

  const body = await request.json();

  const newStatus = body.status !== undefined ? body.status : existing.status;
  const newRemarks = body.remarks !== undefined ? body.remarks : (existing.admin_remarks || '');
  const newAppNum = body.applicationNumber !== undefined ? String(body.applicationNumber).trim() : existing.application_number;
  const newDob = body.dateOfBirth !== undefined ? String(body.dateOfBirth).trim() : existing.date_of_birth;
  const newPass = body.appPassword !== undefined ? String(body.appPassword).trim() : existing.app_password;
  const newResultPhotoUrl = body.resultPhotoUrl !== undefined ? body.resultPhotoUrl : existing.result_photo_url;

  const newPaymentStatus = body.paymentStatus === 'paid' || body.paymentStatus === 'unpaid'
    ? body.paymentStatus
    : existing.payment_status;

  let newPaymentId = body.paymentId !== undefined ? String(body.paymentId).trim() : (existing.payment_id || '');
  let newPaymentAmount = body.paymentAmount !== undefined ? Number(body.paymentAmount) : Number(existing.payment_amount || 0);
  let newPaymentMethod = body.paymentMethod !== undefined ? String(body.paymentMethod).trim() : (existing.payment_method || 'NONE');
  let newPaidAt = existing.paid_at || null;

  if (body.paymentStatus === 'paid') {
    if (!newPaymentId || newPaymentId === 'PENDING_BATCH_OF_5') {
      newPaymentId = 'ADMIN-PAID';
    }
    if (!newPaymentAmount || newPaymentAmount <= 0 || Number.isNaN(newPaymentAmount)) {
      const owner = await env.DB.prepare('SELECT application_fee FROM users WHERE id = ?').bind(existing.user_id).first();
      newPaymentAmount = owner && owner.application_fee ? Number(owner.application_fee) : 200.00;
    }
    if (!body.paymentMethod && (!newPaymentMethod || newPaymentMethod === 'NONE')) {
      newPaymentMethod = 'ADMIN_MARKED_PAID';
    }
    if (!newPaidAt) {
      newPaidAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
  } else if (body.paymentStatus === 'unpaid') {
    if (body.paymentId === undefined && (newPaymentId === 'ADMIN-PAID' || !newPaymentId)) {
      newPaymentId = 'PENDING_BATCH_OF_5';
    }
    if (!body.paymentMethod) {
      newPaymentMethod = 'NONE';
    }
    newPaidAt = null;
  }

  await env.DB.prepare(`
    UPDATE applications 
    SET status = ?, 
        admin_remarks = ?, 
        application_number = ?, 
        date_of_birth = ?, 
        app_password = ?, 
        payment_status = ?,
        payment_id = ?, 
        payment_amount = ?,
        payment_method = ?,
        paid_at = ?,
        result_photo_url = ?, 
        reviewed_at = datetime("now") 
    WHERE id = ?
  `).bind(
    newStatus, newRemarks, newAppNum, newDob, newPass,
    newPaymentStatus, newPaymentId, newPaymentAmount, newPaymentMethod, newPaidAt,
    newResultPhotoUrl, appId
  ).run();

  let message = `Application #${newAppNum} updated successfully`;
  if (body.paymentStatus === 'paid' && body.status === undefined) {
    message = `Application #${newAppNum} marked as PAID (₹${Number(newPaymentAmount).toFixed(2)}, Ref: ${newPaymentId})`;
  } else if (body.paymentStatus === 'unpaid' && body.status === undefined) {
    message = `Application #${newAppNum} marked as UNPAID`;
  } else if (body.status === 'correction') {
    message = `Application #${newAppNum} sent for Candidate Correction`;
  } else if (body.status === 'approved') {
    message = `Application #${newAppNum} approved successfully`;
  } else if (body.status === 'rejected') {
    message = `Application #${newAppNum} rejected`;
  }

  // Send automatic Telegram update to the customer if their Chat ID is linked
  const shouldNotifyCustomer =
    body.status !== undefined &&
    (body.status !== existing.status || (body.status === 'approved' && body.resultPhotoUrl !== undefined));

  if (shouldNotifyCustomer && ['approved', 'correction', 'rejected'].includes(newStatus)) {
    try {
      const customer = await env.DB.prepare('SELECT name, telegram_chat_id FROM users WHERE id = ?')
        .bind(existing.user_id).first();
      if (customer && customer.telegram_chat_id) {
        const custName = escapeTgHtml(customer.name || 'Candidate');
        const escApp = escapeTgHtml(newAppNum);
        const escRem = newRemarks ? `\n📝 <b>Remarks:</b> ${escapeTgHtml(newRemarks)}` : '';
        let custMsg = '';
        let photoToSend = '';

        if (newStatus === 'approved') {
          custMsg = `✅ <b>KP CYBER — APPLICATION APPROVED!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n📄 Check your dashboard to view/download your result!\n🔗 <a href="https://portal-2a3.pages.dev">Open Portal</a>`;
          photoToSend = newResultPhotoUrl || '';
        } else if (newStatus === 'correction') {
          custMsg = `⚠️ <b>KP CYBER — CORRECTION NEEDED</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n✏️ Please log in to edit and resubmit.\n🔗 <a href="https://portal-2a3.pages.dev">Open Portal</a>`;
        } else if (newStatus === 'rejected') {
          custMsg = `❌ <b>KP CYBER — APPLICATION REJECTED</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${custName}\n📝 <b>App Number:</b> <code>${escApp}</code>${escRem}\n🔗 <a href="https://portal-2a3.pages.dev">Open Portal</a>`;
        }

        if (custMsg) {
          await sendTelegramToChat(env, customer.telegram_chat_id, custMsg, photoToSend);
        }
      }
    } catch (e) {
      console.error('Customer Telegram notify error:', e);
    }
  }

  return jsonResponse({ success: true, message });
}

export async function onRequestDelete({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const appId = params.appId;
  const existing = await env.DB.prepare(
    'SELECT id, application_number, photo_url, payment_screenshot_url, result_photo_url FROM applications WHERE id = ?'
  ).bind(appId).first();

  if (!existing) {
    return jsonResponse({ error: 'Application not found' }, 404);
  }

  if (env.UPLOADS) {
    try {
      if (existing.photo_url && existing.photo_url.startsWith('/api/files/')) {
        await env.UPLOADS.delete(existing.photo_url.replace('/api/files/', ''));
      }
      if (existing.payment_screenshot_url && existing.payment_screenshot_url.startsWith('/api/files/')) {
        await env.UPLOADS.delete(existing.payment_screenshot_url.replace('/api/files/', ''));
      }
      if (existing.result_photo_url && existing.result_photo_url.startsWith('/api/files/')) {
        await env.UPLOADS.delete(existing.result_photo_url.replace('/api/files/', ''));
      }
    } catch (e) {}
  }

  await env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(appId).run();

  return jsonResponse({
    success: true,
    message: `Application #${existing.application_number || appId} deleted successfully.`
  });
}
