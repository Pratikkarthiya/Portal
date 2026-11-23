import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { results: applications } = await env.DB.prepare(`
    SELECT a.*, u.name as user_name, u.email as user_email, u.application_fee
    FROM applications a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.submitted_at DESC
  `).all();

  return jsonResponse({ applications: applications || [] });
}
