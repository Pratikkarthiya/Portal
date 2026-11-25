import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  try {
    const { results: events } = await env.DB.prepare(`
      SELECT be.id, be.utr, be.amount, be.sender_vpa, be.raw_text,
             be.used_by_user_id, be.used_for, be.created_at,
             u.name as claimed_user_name, u.email as claimed_user_email
      FROM bank_events be
      LEFT JOIN users u ON be.used_by_user_id = u.id
      ORDER BY be.id DESC
      LIMIT 300
    `).all();

    return jsonResponse({
      success: true,
      events: events || []
    });
  } catch (err) {
    return jsonResponse({ error: 'Failed to load bank events: ' + err.message }, 500);
  }
}
