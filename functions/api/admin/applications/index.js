import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  // Lightweight query: Excludes massive Base64 strings from the JSON response
  // Images are served asynchronously and cached via /api/media/:appId/:type
  const { results: rawApps } = await env.DB.prepare(`
    SELECT a.id, a.user_id, a.application_number, a.date_of_birth, a.app_password,
           a.payment_status, a.payment_id, a.payment_amount, a.payment_method, a.paid_at,
           a.status, a.admin_remarks, a.submitted_at, a.reviewed_at,
           (a.photo_url IS NOT NULL AND a.photo_url != '') AS has_photo,
           (a.payment_screenshot_url IS NOT NULL AND a.payment_screenshot_url != '') AS has_receipt,
           (a.result_photo_url IS NOT NULL AND a.result_photo_url != '') AS has_result,
           u.name as user_name, u.email as user_email, u.application_fee
    FROM applications a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.submitted_at DESC
  `).all();

  const applications = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  return jsonResponse({ applications });
}
