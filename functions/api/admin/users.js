import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { results: users } = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.application_fee, u.wallet_balance, u.payment_mode, u.created_at,
           COUNT(a.id) as total_applications,
           SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
           SUM(CASE WHEN a.payment_status = 'paid' THEN a.payment_amount ELSE 0 END) as total_paid
    FROM users u
    LEFT JOIN applications a ON u.id = a.user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  return jsonResponse({ users });
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const { name, email, password, applicationFee, paymentMode } = await request.json();
  if (!name || !email || !password) {
    return jsonResponse({ error: 'Name, email, and password required' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return jsonResponse({ error: 'User with this email already exists' }, 409);
  }

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';

  const result = await env.DB.prepare(
    'INSERT INTO users (name, email, password, application_fee, payment_mode) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, email, password, fee, mode).run();

  return jsonResponse({
    success: true,
    message: `User created (${mode === 'one_time' ? 'One-Time Payment' : '5-Batch Payment'}, fee ₹${fee.toFixed(2)})`,
    userId: result.meta.last_row_id
  });
}
