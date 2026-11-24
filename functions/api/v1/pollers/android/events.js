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
          `).bind(amount > 0 ? amount : 250.00, app.id).run();
          updatedCount++;
        }
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
