import { jsonResponse, getPortalShutdownState } from '../../utils.js';

export async function onRequestPost({ request, env }) {
  const shutdown = await getPortalShutdownState(env);
  if (shutdown.isShutdown) {
    return jsonResponse({ error: shutdown.message, portalShutdown: true }, 503);
  }

  const { email, password } = await request.json();
  if (!email || !password) {
    return jsonResponse({ error: 'Email and password required' }, 400);
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, user_type, expires_at) VALUES (?, ?, "user", ?)'
  ).bind(token, user.id, expiresAt).run();

  return jsonResponse({ success: true, message: 'Login successful' }, 200, {
    'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  });
}
