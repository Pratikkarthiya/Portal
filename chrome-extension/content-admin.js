// Bridge between KP Cyber Admin Console and Extension background worker

window.postMessage({ type: 'KP_CYBER_EXT_READY', version: '1.0.0' }, window.location.origin);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'KP_CYBER_REFRESH_APPS') {
    window.postMessage({ type: 'KP_CYBER_REFRESH_APPS' }, window.location.origin);
  }
});

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'KP_CYBER_EXT_PING') {
    window.postMessage({ type: 'KP_CYBER_EXT_READY', version: '1.0.0' }, window.location.origin);
    return;
  }

  if (msg.type === 'KP_CYBER_AUTOFILL_EXAM_BOT' && msg.payload) {
    window.postMessage({ type: 'KP_CYBER_EXT_ACK', requestId: msg.requestId }, window.location.origin);

    const payload = { ...msg.payload };

    // Fetch candidate photo using the active Admin session cookie
    if (payload.photoUrl && !payload.photoDataUrl) {
      try {
        const res = await fetch(payload.photoUrl, { credentials: 'include' });
        if (res.ok) {
          const blob = await res.blob();
          payload.photoMime = blob.type || 'image/jpeg';
          payload.photoDataUrl = await blobToDataUrl(blob);
        }
      } catch (err) {
        console.warn('KP Cyber Ext: photo fetch failed', err);
      }
    }

    chrome.runtime.sendMessage({ action: 'SEND_TO_EXAM_BOT', payload }, (resp) => {
      window.postMessage({
        type: 'KP_CYBER_EXT_RESULT',
        requestId: msg.requestId,
        result: resp || { success: false, error: chrome.runtime.lastError?.message }
      }, window.location.origin);
    });
  }
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
