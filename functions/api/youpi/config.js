import { getSession, jsonResponse } from '../../_middleware.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const user = await env.DB.prepare('SELECT application_fee FROM users WHERE id = ?').bind(session.user_id).first();
  const fee = user && user.application_fee ? user.application_fee : 50.00;

  return jsonResponse({
    vpa: 'pratikkarthiya6@oksbi',
    merchantName: 'Pratik Karthiya',
    amount: fee,
    verificationMode: 'MANUAL_UTR'
  });
}
