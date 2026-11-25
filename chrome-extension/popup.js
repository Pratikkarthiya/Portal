const portalSelect = document.getElementById('portalUrl');
const refreshBtn = document.getElementById('refreshBtn');
const statusBox = document.getElementById('statusBox');
const appsList = document.getElementById('appsList');

function setStatus(text, type = 'info') {
  statusBox.textContent = text;
  statusBox.className = `status ${type}`;
}

async function init() {
  const stored = await chrome.storage.local.get('selectedPortalUrl');
  if (stored && stored.selectedPortalUrl) {
    portalSelect.value = stored.selectedPortalUrl;
  }
  loadPendingApps();
}

portalSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ selectedPortalUrl: portalSelect.value });
  loadPendingApps();
});

refreshBtn.addEventListener('click', loadPendingApps);

async function loadPendingApps() {
  const baseUrl = portalSelect.value;
  appsList.innerHTML = '';
  setStatus('Loading applications from Admin session...', 'info');

  try {
    const res = await fetch(`${baseUrl}/api/admin/applications`, { credentials: 'include' });
    if (res.status === 401) {
      setStatus(`Please log in to ${baseUrl}/admin in Chrome first.`, 'error');
      return;
    }
    const data = await res.json();
    const apps = (data.applications || []).filter(a => a.status === 'pending' || a.status === 'correction');

    if (apps.length === 0) {
      setStatus('No pending applications found.', 'ok');
      return;
    }

    statusBox.className = 'status';
    apps.forEach(app => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-info">
          <div class="app-num">${app.application_number}</div>
          <div class="meta">${app.user_name || 'Candidate'} • DOB: ${app.date_of_birth}</div>
        </div>
        <button class="btn-fill">⚡ Auto-Fill</button>
      `;

      const btn = card.querySelector('.btn-fill');
      btn.addEventListener('click', () => fillCandidate(baseUrl, app, btn));
      appsList.appendChild(card);
    });
  } catch (err) {
    setStatus('Failed to connect to ' + baseUrl + ': ' + err.message, 'error');
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function fillCandidate(baseUrl, app, btn) {
  btn.disabled = true;
  btn.textContent = 'Filling...';
  setStatus(`Preparing App #${app.application_number}...`, 'info');

  try {
    let photoDataUrl = '';
    if (app.photo_url) {
      const photoRes = await fetch(`${baseUrl}${app.photo_url}`, { credentials: 'include' });
      if (photoRes.ok) {
        const blob = await photoRes.blob();
        photoDataUrl = await blobToDataUrl(blob);
      }
    }

    const resp = await chrome.runtime.sendMessage({
      action: 'SEND_TO_EXAM_BOT',
      payload: {
        id: app.id,
        applicationNumber: app.application_number,
        dateOfBirth: app.date_of_birth,
        appPassword: app.app_password,
        candidateName: app.user_name || 'Candidate',
        photoDataUrl
      }
    });

    if (resp && resp.success) {
      setStatus(`Sent App #${app.application_number} to Exam Bot tab!`, 'ok');
    } else {
      setStatus((resp && resp.error) || 'Could not fill Exam Bot tab.', 'error');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Auto-Fill';
  }
}

init();
