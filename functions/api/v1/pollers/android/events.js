import { jsonResponse } from '../../../../utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const utr = body.bankReferenceNumber ? String(body.bankReferenceNumber).trim() : null;
    const amount = Number(body.amount) || (body.amountPaise ? Number(body.amountPaise) / 100 : 0);

    if (!utr && (!body.rawNotification || !body.rawNotification.text)) {
      return jsonResponse({ error: 'Missing UTR or notification text' }, 400);
    }

    // Attempt to extract 12-digit UTR if not cleanly passed
    let finalUtr = utr;
    if (!finalUtr && body.rawNotification && body.rawNotification.text) {
      const match = body.rawNotification.text.match(/\b\d{12}\b/);
      if (match) finalUtr = match[0];
    }

    let updatedCount = 0;

    if (finalUtr) {
      // 0. Record into bank_events table
      const finalAmount = amount > 0 ? amount : 250.00;
      const rawText = body.rawNotification ? JSON.stringify(body.rawNotification) : (body.title || '') + ' ' + (body.text || '');
      const senderVpa = body.senderVpa || body.sender || '';

      await env.DB.prepare(`
        INSERT INTO bank_events (utr, amount, sender_vpa, raw_text, created_at)
        VALUES (?, ?, ?, ?, datetime("now"))
        ON CONFLICT(utr) DO UPDATE SET amount = excluded.amount
      `).bind(finalUtr, finalAmount, senderVpa, rawText).run();

      // 1. Check if application submitted this exact UTR
      const matchingApps = await env.DB.prepare(
        'SELECT id, user_id FROM applications WHERE payment_id = ? AND payment_status != "paid"'
      ).bind(finalUtr).all();

      if (matchingApps.results && matchingApps.results.length > 0) {
        for (const app of matchingApps.results) {
          await env.DB.prepare(`
            UPDATE applications 
            SET payment_status = 'paid', 
                payment_amount = ?, 
                paid_at = datetime("now") 
            WHERE id = ?
          `).bind(finalAmount, app.id).run();
          updatedCount++;
        }
        await env.DB.prepare('UPDATE bank_events SET used_by_user_id = ?, used_for = "applications" WHERE utr = ?')
          .bind(matchingApps.results[0].user_id, finalUtr).run();
      }

      // 2. Check if a pending wallet top-up submitted this exact UTR
      const pendingTopup = await env.DB.prepare(
        'SELECT id, user_id, amount FROM wallet_transactions WHERE reference_id = ? AND status = "pending"'
      ).bind(finalUtr).first();

      if (pendingTopup) {
        const topupUser = await env.DB.prepare('SELECT wallet_balance FROM users WHERE id = ?').bind(pendingTopup.user_id).first();
        const curBal = topupUser && topupUser.wallet_balance ? Number(topupUser.wallet_balance) : 0;
        const newBal = curBal + Number(pendingTopup.amount);
        await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBal, pendingTopup.user_id).run();
        await env.DB.prepare('UPDATE wallet_transactions SET status = "approved", balance_after = ? WHERE id = ?').bind(newBal, pendingTopup.id).run();
        await env.DB.prepare('UPDATE bank_events SET used_by_user_id = ?, used_for = "wallet" WHERE utr = ?')
          .bind(pendingTopup.user_id, finalUtr).run();
        updatedCount++;
      }
    }

    return jsonResponse({
      success: true,
      matched: updatedCount > 0,
      updatedCount,
      utr: finalUtr,
      amount
    });
  } catch (err) {
    return jsonResponse({ error: 'Event processing failed: ' + err.message }, 500);
  }
}
