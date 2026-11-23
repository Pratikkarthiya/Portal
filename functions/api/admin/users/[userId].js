import { getSession, jsonResponse } from '../../_middleware.js';

export async function onRequestGet({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const userId = params.userId;
  const user = await env.DB.prepare('SELECT id, name, email, application_fee, created_at FROM users WHERE id = ?').bind(userId).first();
  if (!user) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const { results: applications } = await env.DB.prepare(
    'SELECT * FROM applications WHERE user_id = ? ORDER BY submitted_at DESC'
  ).bind(userId).all();

  return jsonResponse({ user, applications });
}

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const userId = params.userId;
  const { name, email, applicationFee, newPassword } = await request.json();

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;

  if (newPassword && newPassword.trim()) {
    await env.DB.prepare(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, password = ? WHERE id = ?'
    ).bind(name, email, fee, newPassword.trim(), userId).run();
  } else {
    await env.DB.prepare(
      'UPDATE users SET name = ?, email = ?, application_fee = ? WHERE id = ?'
    ).bind(name, email, fee, userId).run();
  }

  return jsonResponse({ success: true, message: `User updated successfully (Fee: ₹${fee.toFixed(2)})` });
}
