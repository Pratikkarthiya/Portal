import { jsonResponse } from '../../../../utils.js';

export async function onRequestPost({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const deviceName = body.deviceName ? String(body.deviceName).replace(/[^a-zA-Z0-9_-]/g, '-') : 'ANDROID-PHONE';
    const deviceId = 'OBSERVER-' + deviceName.toUpperCase();
    const signingKey = 'youpi-secret-key-2024';

    return jsonResponse({
      paired: true,
      deviceId: deviceId,
      signingKey: signingKey,
      merchantId: '00000000-0000-0000-0000-000000000001'
    });
  } catch (err) {
    return jsonResponse({ error: 'Pairing failed: ' + err.message }, 500);
  }
}
