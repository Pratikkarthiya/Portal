import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { results: requests } = await env.DB.prepare(`
    SELECT r.id, r.user_id, r.application_number, r.fee_amount, r.status, r.pdf_url, r.admin_remarks,
           r.created_at, r.completed_at,
           u.name as user_name, u.email as user_email, u.telegram_chat_id
    FROM ll_pdf_requests r
    JOIN users u ON r.user_id = u.id
    ORDER BY r.id DESC
  `).all();

  return jsonResponse({
    success: true,
    requests: requests || []
  });
}
