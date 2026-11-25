// Auto-fill & 2-Way Result Sync script for https://kabirservices.online/exam-bot

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'FILL_EXAM_BOT_FORM' && msg.payload) {
    fillExamBotForm(msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// If user opened this tab via "Send to Exam Bot", check queued data on load
(async function checkQueuedFill() {
  try {
    const store = await chrome.storage.local.get('pendingExamBotFill');
    const pending = store && store.pendingExamBotFill;
    if (pending && Date.now() - (pending.queuedAt || 0) < 5 * 60 * 1000) {
      await chrome.storage.local.remove('pendingExamBotFill');
      setTimeout(() => fillExamBotForm(pending), 600);
    }
  } catch (e) {}
})();

// =========================================================
// 1. AUTO-FILL INTO EXAM BOT FORM
// =========================================================
function convertDobToDdMmYyyy(dobStr) {
  if (!dobStr) return '';
  const clean = String(dobStr).trim();
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  const slashIso = clean.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIso) return `${slashIso[3]}-${slashIso[2]}-${slashIso[1]}`;
  return clean.replace(/\//g, '-');
}

function setFieldValue(el, value) {
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function dataUrlToFile(dataUrl, filename = 'candidate_photo.jpg') {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(parts[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  const ext = mime.includes('png') ? 'png' : 'jpg';
  return new File([u8arr], filename.replace(/\.\w+$/, `.${ext}`), { type: mime });
}

async function fillExamBotForm(payload) {
  const taskSelect = document.getElementById('taskType');
  const appInput = document.getElementById('appNumber');
  const dobInput = document.getElementById('dob');
  const passInput = document.getElementById('password');
  const photoInput = document.getElementById('customPhotoInput');

  if (!appInput) {
    showToast('⚠️ Please log in to LL Exam Bot first, then click Auto-Fill again.', true);
    return { success: false, error: 'Exam Bot form not found (login may be required)' };
  }

  if (taskSelect) {
    taskSelect.value = 'exam';
    taskSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const cleanAppNum = String(payload.applicationNumber || '').replace(/[^0-9]/g, '');
  setFieldValue(appInput, cleanAppNum);
  setFieldValue(dobInput, convertDobToDdMmYyyy(payload.dateOfBirth));
  setFieldValue(passInput, String(payload.appPassword || '').trim());

  let photoAttached = false;
  if (photoInput && payload.photoDataUrl) {
    try {
      const file = dataUrlToFile(payload.photoDataUrl, `photo_${cleanAppNum || 'candidate'}.jpg`);
      const dt = new DataTransfer();
      dt.items.add(file);
      photoInput.files = dt.files;
      photoInput.dispatchEvent(new Event('change', { bubbles: true }));
      photoAttached = true;
    } catch (e) {
      console.warn('Photo attach failed:', e);
    }
  }

  const noticeModal = document.getElementById('noticeModal');
  const noticeVisible = noticeModal && getComputedStyle(noticeModal).display !== 'none';

  let msg = `✅ Auto-filled App #${cleanAppNum} (${payload.candidateName || 'Candidate'})`;
  if (photoAttached) msg += ' + Photo loaded';
  if (noticeVisible) msg += ' • Accept Notice first to crop & submit';
  showToast(msg, false);

  return { success: true, photoAttached };
}

// =========================================================
// 2. TWO-WAY SYNC: SEND RESULT SCREENSHOT BACK TO KP CYBER
// =========================================================
function compressBlobToDataUrl(blob, maxDim = 950, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result);
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(blob);
  });
}

function injectSendResultButtons() {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;

  const shotBtns = historyList.querySelectorAll('button[onclick*="downloadScreenshot("]');
  shotBtns.forEach((shotBtn) => {
    const parent = shotBtn.parentElement;
    if (!parent || parent.querySelector('.kp-send-result-btn')) return;

    const onclickAttr = shotBtn.getAttribute('onclick') || '';
    const idMatch = onclickAttr.match(/downloadScreenshot\(\s*(\d+)\s*\)/);
    if (!idMatch) return;
    const taskId = idMatch[1];

    // Find enclosing task card to extract App Number & Result Message
    const card = shotBtn.closest('.history-item, .h-card, div[class*="card"], div[class*="item"]') || parent.parentElement;
    const panEl = card ? card.querySelector('.h-pan') : null;
    const msgEl = card ? card.querySelector('.h-msg') : null;

    let appNum = '';
    if (panEl) {
      const m = panEl.textContent.match(/\d{6,15}/);
      if (m) appNum = m[0];
    }
    if (!appNum && card) {
      const m = card.textContent.match(/\b\d{8,15}\b/);
      if (m) appNum = m[0];
    }

    const resultMsg = msgEl ? msgEl.textContent.trim() : '';

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'kp-send-result-btn';
    syncBtn.textContent = '📤 Send to KP Cyber';
    Object.assign(syncBtn.style, {
      marginLeft: '6px',
      padding: '5px 10px',
      fontSize: '0.78rem',
      fontWeight: '700',
      borderRadius: '6px',
      border: 'none',
      background: '#0071e3',
      color: '#ffffff',
      cursor: 'pointer'
    });

    syncBtn.addEventListener('click', async () => {
      const targetApp = appNum || prompt('Enter Candidate Application Number for this result:');
      if (!targetApp) return;

      const origText = syncBtn.textContent;
      syncBtn.disabled = true;
      syncBtn.textContent = '⏳ Uploading...';

      try {
        const shotRes = await fetch(`/exam-bot/screenshot/${taskId}`, { credentials: 'include' });
        if (!shotRes.ok) {
          throw new Error(`Could not fetch screenshot (HTTP ${shotRes.status})`);
        }
        const blob = await shotRes.blob();
        const resultPhotoUrl = await compressBlobToDataUrl(blob, 950, 0.78);

        const resp = await chrome.runtime.sendMessage({
          action: 'SYNC_RESULT_TO_KP_CYBER',
          payload: {
            applicationNumber: targetApp.trim(),
            resultPhotoUrl,
            remarks: resultMsg || 'Completed via Exam Bot',
            status: 'approved'
          }
        });

        if (resp && resp.success) {
          syncBtn.textContent = '✅ Sent to KP Cyber!';
          syncBtn.style.background = '#15803d';
          showToast(`🎉 Result uploaded & App #${targetApp} marked Approved on KP Cyber!`, false);
        } else {
          syncBtn.disabled = false;
          syncBtn.textContent = origText;
          showToast('❌ ' + ((resp && resp.error) || 'Sync failed. Make sure KP Cyber Admin is logged in.'), true);
        }
      } catch (err) {
        syncBtn.disabled = false;
        syncBtn.textContent = origText;
        showToast('❌ ' + err.message, true);
      }
    });

    parent.appendChild(syncBtn);
  });
}

(function observeHistoryTab() {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;
  injectSendResultButtons();
  const observer = new MutationObserver(() => injectSendResultButtons());
  observer.observe(historyList, { childList: true, subtree: true });
})();

function showToast(text, isError) {
  const existing = document.getElementById('kpCyberAutoFillToast');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'kpCyberAutoFillToast';
  div.textContent = text;
  Object.assign(div.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999999',
    background: isError ? '#b91c1c' : '#15803d',
    color: '#ffffff',
    padding: '12px 18px',
    borderRadius: '10px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '13px',
    fontWeight: '600',
    boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
    maxWidth: '380px',
    lineHeight: '1.4'
  });
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 6500);
}
