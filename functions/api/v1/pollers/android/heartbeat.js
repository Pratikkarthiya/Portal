import { jsonResponse } from '../../../../utils.js';

export async function onRequestPost() {
  return jsonResponse({
    status: 'ok',
    timestamp: Date.now()
  });
}
