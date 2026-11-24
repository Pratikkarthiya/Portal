import { jsonResponse } from '../../../utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const smsBody = body.body || '';

    // Extract 12-digit UTR from SMS body
    const utrMatch = smsBody.match(/\b\d{12}\b/);
    const utr = utrMatch ? utrMatch[0] : null;

    // Extract amount from SMS body (e.g. Rs. 250 or INR 250)
    let amount = 250.00;
    const amountMatch = smsBody.match(/(?:rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (amountMatch) {
      amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    }

    let updatedCount = 0;
    if (utr) {
      // 0. Record into bank_events
      await env.DB.prepare(`
        INSERT INTO bank_events (utr, amount, sender_vpa, raw_text, created_at)
        VALUES (?, ?, '', ?, datetime("now"))
        ON CONFLICT(utr) DO UPDATE SET amount = excluded.amount
      `).bind(utr, amount, smsBody).run();

      const matchingApps = await env.DB.prepare(
        'SELECT id, user_id FROM applications WHERE payment_id = ? AND payment_status != "paid"'
      ).bind(utr).all();

      if (matchingApps.results && matchingApps.results.length > 0) {
        for (const app of matchingApps.results) {
          await env.DB.prepare(`
            UPDATE applications 
            SET payment_status = 'paid', 
                payment_amount = ?, 
                paid_at = datetime("now") 
            WHERE id = ?
          `).bind(amount, app.id).run();
          updatedCount++;
        }
        await env.DB.prepare('UPDATE bank_events SET used_by_user_id = ?, used_for = "applications" WHERE utr = ?')
          .bind(matchingApps.results[0].user_id, utr).run();
      }

      // Check pending wallet top-up
      const pendingTopup = await env.DB.prepare(
        'SELECT id, user_id, amount FROM wallet_transactions WHERE reference_id = ? AND status = "pending"'
      ).bind(utr).first();

      if (pendingTopup) {
        const topupUser = await env.DB.prepare('SELECT wallet_balance FROM users WHERE id = ?').bind(pendingTopup.user_id).first();
        const curBal = topupUser && topupUser.wallet_balance ? Number(topupUser.wallet_balance) : 0;
        const newBal = curBal + Number(pendingTopup.amount);
        await env.DB.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').bind(newBal, pendingTopup.user_id).run();
        await env.DB.prepare('UPDATE wallet_transactions SET status = "approved", balance_after = ? WHERE id = ?').bind(newBal, pendingTopup.id).run();
        await env.DB.prepare('UPDATE bank_events SET used_by_user_id = ?, used_for = "wallet" WHERE utr = ?')
          .bind(pendingTopup.user_id, utr).run();
        updatedCount++;
      }
    }

    return jsonResponse({
      success: true,
      matched: updatedCount > 0,
      updatedCount,
      utr,
      amount
    });
  } catch (err) {
    return jsonResponse({ error: 'SMS processing failed: ' + err.message }, 500);
  }
}
