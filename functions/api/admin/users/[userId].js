import { getSession, jsonResponse } from '../../../utils.js';

export async function onRequestGet({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const userId = params.userId;
  const user = await env.DB.prepare('SELECT id, name, email, application_fee, wallet_balance, payment_mode, telegram_chat_id, created_at FROM users WHERE id = ?').bind(userId).first();
  if (!user) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const { results: rawApps } = await env.DB.prepare(`
    SELECT id, user_id, application_number, date_of_birth, app_password,
           payment_status, payment_id, payment_amount, payment_method, paid_at,
           status, admin_remarks, submitted_at, reviewed_at,
           (photo_url IS NOT NULL AND photo_url != '') AS has_photo,
           (payment_screenshot_url IS NOT NULL AND payment_screenshot_url != '') AS has_receipt,
           (result_photo_url IS NOT NULL AND result_photo_url != '') AS has_result
    FROM applications WHERE user_id = ? ORDER BY submitted_at DESC
  `).bind(userId).all();

  const applications = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  return jsonResponse({ user, applications });
}

export async function onRequestPut({ request, params, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'admin') {
    return jsonResponse({ error: 'Admin access required' }, 401);
  }

  const userId = params.userId;
  const { name, email, applicationFee, paymentMode, telegramChatId, newPassword } = await request.json();

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';
  const tgChatId = telegramChatId !== undefined ? String(telegramChatId).trim() : '';

  if (newPassword && newPassword.trim()) {
    await env.DB.prepare(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, payment_mode = ?, telegram_chat_id = ?, password = ? WHERE id = ?'
    ).bind(name, email, fee, mode, tgChatId, newPassword.trim(), userId).run();
  } else {
    await env.DB.prepare(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, payment_mode = ?, telegram_chat_id = ? WHERE id = ?'
    ).bind(name, email, fee, mode, tgChatId, userId).run();
  }

  return jsonResponse({ success: true, message: `User updated successfully (Plan: ${mode === 'one_time' ? 'One-Time' : '5-Batch'}, Fee: ₹${fee.toFixed(2)})` });
}
