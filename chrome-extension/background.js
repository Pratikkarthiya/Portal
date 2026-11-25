const EXAM_BOT_URL = 'https://kabirservices.online/exam-bot';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'SEND_TO_EXAM_BOT' && msg.payload) {
    handleSendToExamBot(msg.payload)
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

    // Deliver immediately to content-exambot.js
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
      // Content script will also pick up pendingExamBotFill on reload/focus
      return { success: true, mode: 'queued_for_tab' };
    }
  } else {
    // Open exam-bot tab; content-exambot.js reads pendingExamBotFill on load
    await chrome.tabs.create({ url: EXAM_BOT_URL, active: true });
    return { success: true, mode: 'new_tab' };
  }
}
