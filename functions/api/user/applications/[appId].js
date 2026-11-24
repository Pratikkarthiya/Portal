import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const appId = params.appId;
  const app = await env.DB.prepare(
    'SELECT id, user_id, status FROM applications WHERE id = ? AND user_id = ?'
  ).bind(appId, session.user_id).first();

  if (!app) {
    return jsonResponse({ error: 'Application not found or unauthorized' }, 404);
  }

  const { applicationNumber, dateOfBirth, appPassword, photoUrl } = await request.json();

  if (!applicationNumber || !dateOfBirth || !appPassword) {
    return jsonResponse({ error: 'Application number, date of birth, and password are required' }, 400);
  }

  const cleanAppNum = String(applicationNumber).trim();
  const cleanDob = String(dateOfBirth).trim();
  const cleanPass = String(appPassword).trim();

  if (photoUrl && photoUrl.trim()) {
    await env.DB.prepare(`
      UPDATE applications 
      SET application_number = ?, 
          date_of_birth = ?, 
          app_password = ?, 
          photo_url = ?, 
          status = 'pending', 
          admin_remarks = 'Resubmitted with corrections by candidate.', 
          submitted_at = datetime("now")
      WHERE id = ? AND user_id = ?
    `).bind(cleanAppNum, cleanDob, cleanPass, photoUrl.trim(), appId, session.user_id).run();
  } else {
    await env.DB.prepare(`
      UPDATE applications 
      SET application_number = ?, 
          date_of_birth = ?, 
          app_password = ?, 
          status = 'pending', 
          admin_remarks = 'Resubmitted with corrections by candidate.', 
          submitted_at = datetime("now")
      WHERE id = ? AND user_id = ?
    `).bind(cleanAppNum, cleanDob, cleanPass, appId, session.user_id).run();
  }

  return jsonResponse({
    success: true,
    message: `Application #${cleanAppNum} corrected and resubmitted successfully! It is now pending admin review.`
  });
}
