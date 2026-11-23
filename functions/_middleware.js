// Cloudflare Pages Function: Session & Auth helper using Cloudflare D1
export async function getSession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
  if (!match) return null;

  const token = match[1];
  const session = await env.DB.prepare(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > datetime("now")'
  ).bind(token).first();

  return session || null;
}

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}
