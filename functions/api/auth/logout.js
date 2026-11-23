import { jsonResponse } from '../../utils.js';

export async function onRequestPost() {
  return jsonResponse({ success: true }, 200, {
    'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0'
  });
}
