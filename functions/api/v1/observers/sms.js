import { jsonResponse } from '../../../../utils.js';

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
