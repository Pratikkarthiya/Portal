import { onRequestPost as handlePost, onRequestGet as handleGet } from './index.js';

export async function onRequestPost(context) {
  return handlePost(context);
}

export async function onRequestGet(context) {
  return handleGet(context);
}

export async function onRequest(context) {
  if (context.request.method === 'POST') {
    return handlePost(context);
  }
  if (context.request.method === 'GET') {
    return handleGet(context);
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}
