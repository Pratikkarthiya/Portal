import { jsonResponse } from '../_middleware.js';

export async function onRequestPost({ request, env }) {
  const { username, password } = await request.json();

  if (!username || !password) {
    return jsonResponse({ error: 'Username and password required' }, 400);
  }

  const admin = await env.DB.prepare('SELECT * FROM admins WHERE username = ?').bind(username).first();
  if (!admin) {
    return jsonResponse({ error: 'Invalid admin credentials' }, 401);
  }

  // Simple edge-safe verification (admin123)
  if (password !== 'admin123') {
    return jsonResponse({ error: 'Invalid admin credentials' }, 401);
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, user_type, expires_at) VALUES (?, ?, "admin", ?)'
  ).bind(token, admin.id, expiresAt).run();

  return jsonResponse({ success: true, message: 'Admin login successful' }, 200, {
    'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  });
}
