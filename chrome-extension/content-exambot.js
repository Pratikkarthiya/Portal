// Auto-fill script for https://kabirservices.online/exam-bot

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

function convertDobToDdMmYyyy(dobStr) {
  if (!dobStr) return '';
  const clean = String(dobStr).trim();
  // Convert YYYY-MM-DD -> DD-MM-YYYY
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  }
  // Convert YYYY/MM/DD -> DD-MM-YYYY
  const slashIso = clean.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIso) {
    return `${slashIso[3]}-${slashIso[2]}-${slashIso[1]}`;
  }
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

  // 1. Switch taskType to "exam" so DOB, Password, and Photo fields appear
  if (taskSelect) {
    taskSelect.value = 'exam';
    taskSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 2. Fill Application Number (digits only)
  const cleanAppNum = String(payload.applicationNumber || '').replace(/[^0-9]/g, '');
  setFieldValue(appInput, cleanAppNum);

  // 3. Fill DOB in DD-MM-YYYY format
  const formattedDob = convertDobToDdMmYyyy(payload.dateOfBirth);
  setFieldValue(dobInput, formattedDob);

  // 4. Fill Password
  const rawPass = String(payload.appPassword || '').trim();
  setFieldValue(passInput, rawPass);

  // 5. Attach Photo into #customPhotoInput so crop modal opens automatically
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
    maxWidth: '360px',
    lineHeight: '1.4'
  });
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}
