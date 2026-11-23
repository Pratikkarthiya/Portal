import { getSession, jsonResponse } from '../_middleware.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const usersCount = (await env.DB.prepare('SELECT COUNT(*) as c FROM users').first()).c;
  const appsCount = (await env.DB.prepare('SELECT COUNT(*) as c FROM applications').first()).c;
  const pending = (await env.DB.prepare('SELECT COUNT(*) as c FROM applications WHERE status = "pending"').first()).c;
  const approved = (await env.DB.prepare('SELECT COUNT(*) as c FROM applications WHERE status = "approved"').first()).c;
  const rejected = (await env.DB.prepare('SELECT COUNT(*) as c FROM applications WHERE status = "rejected"').first()).c;
  const rev = await env.DB.prepare('SELECT SUM(payment_amount) as total FROM applications WHERE payment_status = "paid"').first();

  return jsonResponse({
    totalUsers: usersCount,
    totalApplications: appsCount,
    pending,
    approved,
    rejected,
    totalRevenue: rev && rev.total ? rev.total : 0
  });
}
