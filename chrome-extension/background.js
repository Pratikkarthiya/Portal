const EXAM_BOT_URL = 'https://kabirservices.online/exam-bot';
const PORTAL_CANDIDATES = [
  'https://portal-2a3.pages.dev',
  'https://kpcyber.in',
  'http://localhost:3000'
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'SEND_TO_EXAM_BOT' && msg.payload) {
    handleSendToExamBot(msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg && msg.action === 'SYNC_RESULT_TO_KP_CYBER' && msg.payload) {
    handleSyncResultToKpCyber(msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSendToExamBot(payload) {
  const stamped = { ...payload, queuedAt: Date.now() };
  await chrome.storage.local.set({ pendingExamBotFill: stamped });

  const existingTabs = await chrome.tabs.query({ url: 'https://kabirservices.online/exam-bot*' });

  if (existingTabs && existingTabs.length > 0) {
    const targetTab = existingTabs[0];
    await chrome.tabs.update(targetTab.id, { active: true });
    if (targetTab.windowId) {
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    }

    try {
      const resp = await chrome.tabs.sendMessage(targetTab.id, {
        action: 'FILL_EXAM_BOT_FORM',
        payload: stamped
      });
      if (resp && resp.success) {
        await chrome.storage.local.remove('pendingExamBotFill');
      }
      return { success: true, mode: 'existing_tab', resp };
    } catch (e) {
      return { success: true, mode: 'queued_for_tab' };
    }
  } else {
    await chrome.tabs.create({ url: EXAM_BOT_URL, active: true });
    return { success: true, mode: 'new_tab' };
  }
}

async function resolveActiveAdminOrigin() {
  const adminTabs = await chrome.tabs.query({
    url: [
      'https://kpcyber.in/admin*',
      'https://www.kpcyber.in/admin*',
      'https://portal-2a3.pages.dev/admin*',
      'https://*.portal-2a3.pages.dev/admin*',
      'http://localhost:3000/admin*',
      'http://127.0.0.1:3000/admin*'
    ]
  });

  const ordered = [];
  if (adminTabs && adminTabs.length > 0) {
    adminTabs.forEach((t) => {
      try {
        const origin = new URL(t.url).origin;
        if (!ordered.includes(origin)) ordered.push(origin);
      } catch (e) {}
    });
  }

  const stored = await chrome.storage.local.get('selectedPortalUrl');
  if (stored && stored.selectedPortalUrl && !ordered.includes(stored.selectedPortalUrl)) {
    ordered.push(stored.selectedPortalUrl);
  }
  PORTAL_CANDIDATES.forEach((u) => {
    if (!ordered.includes(u)) ordered.push(u);
  });

  for (const baseUrl of ordered) {
    try {
      const res = await fetch(`${baseUrl}/api/admin/applications`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        return { baseUrl, applications: data.applications || [], adminTabs };
      }
    } catch (e) {}
  }

  throw new Error('Please log in to KP Cyber Admin Console in Chrome first.');
}

async function handleSyncResultToKpCyber(payload) {
  const targetAppNum = String(payload.applicationNumber || '').trim();
  if (!targetAppNum) {
    return { success: false, error: 'Missing Application Number' };
  }

  const { baseUrl, applications, adminTabs } = await resolveActiveAdminOrigin();

  const matches = applications.filter(
    (a) => String(a.application_number || '').trim() === targetAppNum
  );
  if (matches.length === 0) {
    return { success: false, error: `Application #${targetAppNum} not found in KP Cyber Admin.` };
  }

  // Prefer pending or correction app if duplicate numbers exist
  const targetApp =
    matches.find((a) => a.status === 'pending' || a.status === 'correction') || matches[0];

  const putRes = await fetch(`${baseUrl}/api/admin/applications/${targetApp.id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: payload.status || 'approved',
      remarks: payload.remarks || 'Completed via Exam Bot',
      resultPhotoUrl: payload.resultPhotoUrl
    })
  });

  const putData = await putRes.json().catch(() => ({}));
  if (!putRes.ok || !putData.success) {
    return { success: false, error: putData.error || `Admin update failed (HTTP ${putRes.status})` };
  }

  // Notify any open Admin tabs to refresh immediately
  if (adminTabs && adminTabs.length > 0) {
    adminTabs.forEach((t) => {
      chrome.tabs.sendMessage(t.id, { action: 'KP_CYBER_REFRESH_APPS' }).catch(() => {});
    });
  }

  return { success: true, message: putData.message || `Updated #${targetAppNum}` };
}
