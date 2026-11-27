import { jsonResponse } from '../../../utils.js';

async function verifyWorkerKey(request, env) {
  const provided =
    request.headers.get('X-Worker-Key') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

  if (!provided) return false;

  let expected = env.LL_WORKER_SECRET || '';
  if (!expected && env.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = 'll_worker_secret'"
      ).first();
      expected = row ? String(row.value || '').trim() : '';
    } catch (e) {}
  }

  return Boolean(expected && provided === expected);
}

export async function onRequestGet({ request, env }) {
  const authorized = await verifyWorkerKey(request, env);
  if (!authorized) {
    return jsonResponse({ error: 'Unauthorized worker key' }, 401);
  }

  const { results } = await env.DB.prepare(`
    SELECT r.id, r.user_id, r.application_number, r.fee_amount, r.created_at,
           u.name as user_name, u.email as user_email
    FROM ll_pdf_requests r
    JOIN users u ON r.user_id = u.id
    WHERE r.status = 'pending'
    ORDER BY r.id ASC
    LIMIT 20
  `).all();

  return jsonResponse({
    success: true,
    requests: results || []
  });
}
