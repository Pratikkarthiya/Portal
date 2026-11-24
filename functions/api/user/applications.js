import { getSession, jsonResponse, arrayBufferToBase64 } from '../../utils.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session || session.user_type !== 'user') {
    return jsonResponse({ error: 'Please log in first' }, 401);
  }

  // Lightweight query: Excludes massive Base64 strings from the list response
  const { results: rawApps } = await env.DB.prepare(`
    SELECT id, application_number, date_of_birth, app_password,
           payment_status, payment_id, payment_amount, payment_method, paid_at,
           status, admin_remarks, submitted_at, reviewed_at,
           (photo_url IS NOT NULL AND photo_url != '') AS has_photo,
           (payment_screenshot_url IS NOT NULL AND payment_screenshot_url != '') AS has_receipt,
           (result_photo_url IS NOT NULL AND result_photo_url != '') AS has_result
    FROM applications WHERE user_id = ? ORDER BY submitted_at DESC
  `).bind(session.user_id).all();

  const applications = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  return jsonResponse({ applications });
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getSession(request, env);
    if (!session || session.user_type !== 'user') {
      return jsonResponse({ error: 'Please log in first' }, 401);
    }

    const formData = await request.formData();
    const applicationNumber = formData.get('applicationNumber');
    const dateOfBirth = formData.get('dateOfBirth');
    const appPassword = formData.get('appPassword');
    const utrNumber = formData.get('utrNumber');
    const photo = formData.get('photo');
    const screenshot = formData.get('paymentScreenshot');

    if (!applicationNumber || !dateOfBirth || !appPassword) {
      return jsonResponse({ error: 'Missing required application fields' }, 400);
    }

    if (!photo) {
      return jsonResponse({ error: 'Photo is required' }, 400);
    }

    if (photo.size > 12 * 1024 * 1024) {
      return jsonResponse({ error: 'Photo exceeds 10 MB limit. Please select a photo up to 10 MB.' }, 400);
    }

    let photoUrl = '';
    const photoKey = `photo-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
    if (env.UPLOADS) {
      await env.UPLOADS.put(photoKey, await photo.arrayBuffer(), {
        httpMetadata: { contentType: photo.type || 'image/jpeg' }
      });
      photoUrl = `/api/files/${photoKey}`;
    } else {
      const buffer = await photo.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      photoUrl = `data:${photo.type || 'image/jpeg'};base64,${base64}`;
    }

    let screenshotUrl = '';
    if (screenshot && screenshot.size > 0) {
      const receiptKey = `receipt-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
      if (env.UPLOADS) {
        await env.UPLOADS.put(receiptKey, await screenshot.arrayBuffer(), {
          httpMetadata: { contentType: screenshot.type || 'image/jpeg' }
        });
        screenshotUrl = `/api/files/${receiptKey}`;
      } else {
        const buf = await screenshot.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        screenshotUrl = `data:${screenshot.type || 'image/jpeg'};base64,${b64}`;
      }
    }

    const user = await env.DB.prepare('SELECT application_fee FROM users WHERE id = ?').bind(session.user_id).first();
    const feePerApp = user && user.application_fee ? user.application_fee : 50.00;

    const { results: unpaidApps } = await env.DB.prepare(
      'SELECT id FROM applications WHERE user_id = ? AND payment_status = "unpaid" ORDER BY id ASC'
    ).bind(session.user_id).all();

    const currentUnpaidCount = unpaidApps ? unpaidApps.length : 0;

    // 5th application or payment settlement due
    if (currentUnpaidCount >= 4) {
      if (!utrNumber || utrNumber.trim().length < 6) {
        return jsonResponse({
          error: '5th application reached! Please submit your 12-digit Bank UTR number to settle all 5 applications.',
          requiresPayment: true,
          batchTotal: feePerApp * 5
        }, 400);
      }

      const cleanUtr = utrNumber.trim();
      const batchAmount = feePerApp * 5;

      const res5 = await env.DB.prepare(
        `INSERT INTO applications 
         (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method, paid_at) 
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, 'UPI_MANUAL_UTR_BATCH5', datetime("now"))`
      ).bind(session.user_id, applicationNumber, dateOfBirth, appPassword, photoUrl, cleanUtr, screenshotUrl, feePerApp).run();

      if (unpaidApps && unpaidApps.length > 0) {
        for (const oldApp of unpaidApps) {
          await env.DB.prepare(
            `UPDATE applications 
             SET payment_status = 'paid', payment_id = ?, payment_screenshot_url = ?, payment_amount = ?, payment_method = 'UPI_MANUAL_UTR_BATCH5', paid_at = datetime("now") 
             WHERE id = ?`
          ).bind(cleanUtr, screenshotUrl, feePerApp, oldApp.id).run();
        }
      }

      return jsonResponse({
        success: true,
        message: `🎉 Batch payment verified! All 5 applications (Total ₹${batchAmount.toFixed(2)}) marked paid with UTR: ${cleanUtr}.`,
        isBatchPayment: true,
        totalPaid: batchAmount,
        utr: cleanUtr,
        applicationId: res5.meta.last_row_id
      });
    }

    const res = await env.DB.prepare(
      `INSERT INTO applications 
       (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method) 
       VALUES (?, ?, ?, ?, ?, 'unpaid', 'PENDING_BATCH_OF_5', '', ?, 'NONE')`
    ).bind(session.user_id, applicationNumber, dateOfBirth, appPassword, photoUrl, feePerApp).run();

    const slotNumber = currentUnpaidCount + 1;
    return jsonResponse({
      success: true,
      message: `Application #${slotNumber} submitted successfully! No payment needed now (payment required after every 5 applications).`,
      isBatchPayment: false,
      slotNumber,
      applicationId: res.meta.last_row_id
    });
  } catch (err) {
    console.error('Application submit error:', err);
    return jsonResponse({ error: 'Server error processing submission: ' + (err.message || 'Unknown error') }, 500);
  }
}
