import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const appId = params.appId;
  const existing = await env.DB.prepare(
    'SELECT id, status, admin_remarks, application_number, date_of_birth, app_password, payment_id, result_photo_url FROM applications WHERE id = ?'
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
  const newPaymentId = body.paymentId !== undefined ? String(body.paymentId).trim() : existing.payment_id;
  const newResultPhotoUrl = body.resultPhotoUrl !== undefined ? body.resultPhotoUrl : existing.result_photo_url;

  await env.DB.prepare(`
    UPDATE applications 
    SET status = ?, 
        admin_remarks = ?, 
        application_number = ?, 
        date_of_birth = ?, 
        app_password = ?, 
        payment_id = ?, 
        result_photo_url = ?, 
        reviewed_at = datetime("now") 
    WHERE id = ?
  `).bind(newStatus, newRemarks, newAppNum, newDob, newPass, newPaymentId, newResultPhotoUrl, appId).run();

  let message = `Application #${newAppNum} updated successfully`;
  if (body.status === 'correction') {
    message = `Application #${newAppNum} sent for Candidate Correction`;
  } else if (body.status === 'approved') {
    message = `Application #${newAppNum} approved successfully`;
  } else if (body.status === 'rejected') {
    message = `Application #${newAppNum} rejected`;
  }

  return jsonResponse({ success: true, message });
}
