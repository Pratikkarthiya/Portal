import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ loggedIn: false });
  }

  if (session.user_type === 'admin') {
    return jsonResponse({ loggedIn: true, userType: 'admin' });
  }

  const user = await env.DB.prepare('SELECT id, name, email, application_fee, created_at FROM users WHERE id = ?').bind(session.user_id).first();
  return jsonResponse({ loggedIn: true, userType: 'user', user });
}
