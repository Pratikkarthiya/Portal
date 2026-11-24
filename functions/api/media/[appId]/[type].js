// High-performance image serving endpoint with edge caching
// Avoids sending multi-megabyte Base64 payloads inside table JSON queries.

export async function onRequestGet({ request, params, env }) {
  const { appId, type } = params;
  if (!appId || !type) {
    return new Response('Not found', { status: 404 });
  }

  let colName = 'photo_url';
  if (type === 'receipt') {
    colName = 'payment_screenshot_url';
  } else if (type === 'result') {
    colName = 'result_photo_url';
  } else if (type !== 'photo') {
    return new Response('Invalid media type', { status: 400 });
  }

  const app = await env.DB.prepare(
    `SELECT ${colName} AS media_data FROM applications WHERE id = ?`
  ).bind(appId).first();

  if (!app || !app.media_data) {
    return new Response('Media not found', { status: 404 });
  }

  const dataStr = (app.media_data || '').trim();
  if (!dataStr) {
    return new Response('Empty media', { status: 404 });
  }

  // If already an R2 URL or external URL, redirect to it
  if (dataStr.startsWith('http://') || dataStr.startsWith('https://') || dataStr.startsWith('/api/files/')) {
    return Response.redirect(dataStr, 302);
  }

  // If it's a Data URL: "data:image/jpeg;base64,..."
  if (dataStr.startsWith('data:')) {
    const commaIdx = dataStr.indexOf(',');
    if (commaIdx === -1) {
      return new Response('Invalid media format', { status: 500 });
    }
    const meta = dataStr.substring(0, commaIdx);
    const base64Data = dataStr.substring(commaIdx + 1);

    let mimeType = 'image/jpeg';
    const mimeMatch = meta.match(/data:([^;]+)/);
    if (mimeMatch) {
      mimeType = mimeMatch[1];
    }

    try {
      const binaryStr = atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      return new Response(bytes.buffer, {
        headers: {
          'Content-Type': mimeType,
          // Cache image aggressively in browser & Cloudflare CDN (7 days)
          'Cache-Control': 'public, max-age=604800, immutable',
          'Content-Length': len.toString()
        }
      });
    } catch (err) {
      return new Response('Error decoding image', { status: 500 });
    }
  }

  return new Response('Not found', { status: 404 });
}
