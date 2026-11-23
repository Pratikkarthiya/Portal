// Cloudflare R2 file serving endpoint
export async function onRequestGet({ params, env }) {
  const key = params.key;
  if (!env.UPLOADS || !key) {
    return new Response('Not found', { status: 404 });
  }

  const object = await env.UPLOADS.get(key);
  if (!object) {
    return new Response('Object Not Found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');

  return new Response(object.body, { headers });
}
