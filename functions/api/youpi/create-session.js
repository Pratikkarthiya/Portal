import { getSession, jsonResponse } from '../../utils.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  const { applicationNumber } = await request.json();
  const user = await env.DB.prepare('SELECT application_fee FROM users WHERE id = ?').bind(session.user_id).first();
  const fee = user && user.application_fee ? user.application_fee : 200.00;
  const orderId = 'ORD-' + (applicationNumber || 'APP').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now().toString(36);

  return jsonResponse({
    success: true,
    orderId,
    vpa: 'pratikkarthiya6@oksbi',
    merchantName: 'Pratik Karthiya',
    amount: fee * 5,
    currency: 'INR',
    verificationMode: 'MANUAL_UTR'
  });
}
