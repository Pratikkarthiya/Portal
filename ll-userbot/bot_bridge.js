const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const TG_API_ID = parseInt(process.env.TG_API_ID || '', 10);
const TG_API_HASH = (process.env.TG_API_HASH || '').trim();
const TARGET_BOT = (process.env.TARGET_BOT_USERNAME || '').replace(/^@/, '').trim();
const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal-2a3.pages.dev').replace(/\/+$/, '');
const LL_WORKER_SECRET = (process.env.LL_WORKER_SECRET || '').trim();
const BOT_COMMAND_TEMPLATE = process.env.BOT_COMMAND_TEMPLATE || '{app_no}';
const POLL_INTERVAL_MS = parseFloat(process.env.POLL_INTERVAL_SEC || '5') * 1000;
const REPLY_TIMEOUT_MS = parseFloat(process.env.REPLY_TIMEOUT_SEC || '45') * 1000;

if (!TG_API_ID || !TG_API_HASH || !TARGET_BOT || !LL_WORKER_SECRET) {
  console.error('Missing required env vars in ll-userbot/.env: TG_API_ID, TG_API_HASH, TARGET_BOT_USERNAME, LL_WORKER_SECRET');
  process.exit(1);
}

const SESSION_FILE = path.join(__dirname, 'kp_userbot.session');
const HEADERS = { 'X-Worker-Key': LL_WORKER_SECRET };
const inProgress = new Set();
const cooldownUntil = new Map();

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

async function fetchPendingRequests() {
  const res = await fetch(`${PORTAL_URL}/api/worker/ll-pdf/pending`, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Pending API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.requests || [];
}

async function uploadCompletedPdf(requestId, appNo, pdfBuffer, filename) {
  const form = new FormData();
  form.append('requestId', String(requestId));
  form.append('applicationNumber', appNo);
  form.append('pdf', new Blob([pdfBuffer], { type: 'application/pdf' }), filename || `${appNo}.pdf`);

  const res = await fetch(`${PORTAL_URL}/api/worker/ll-pdf/complete`, {
    method: 'POST',
    headers: HEADERS,
    body: form
  });
  if (!res.ok) {
    throw new Error(`Complete API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function getDocumentFilename(msg) {
  const doc = msg?.media?.document;
  if (!doc) return '';
  const attr = (doc.attributes || []).find((a) => a.fileName);
  return attr ? attr.fileName : '';
}

function isPdfMessage(msg) {
  const doc = msg?.media?.document;
  if (!doc) return false;
  const mime = (doc.mimeType || '').toLowerCase();
  const fname = getDocumentFilename(msg).toLowerCase();
  return mime === 'application/pdf' || fname.endsWith('.pdf');
}

async function processRequest(client, botEntity, req) {
  const reqId = req.id;
  const appNo = String(req.application_number || '').trim();
  inProgress.add(reqId);

  let handler = null;
  try {
    console.log(`[#${reqId}] Requesting LL PDF for ${appNo} from @${TARGET_BOT}...`);

    const pdfPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${REPLY_TIMEOUT_MS / 1000}s waiting for PDF`));
      }, REPLY_TIMEOUT_MS);

      handler = async (event) => {
        const msg = event.message;
        if (isPdfMessage(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      };

      client.addEventHandler(handler, new NewMessage({ fromUsers: [botEntity] }));
    });

    const promptText = BOT_COMMAND_TEMPLATE.replace('{app_no}', appNo);
    await client.sendMessage(botEntity, { message: promptText });

    const pdfMsg = await pdfPromise;
    const fname = getDocumentFilename(pdfMsg) || `${appNo}.pdf`;
    const pdfBuffer = await client.downloadMedia(pdfMsg, {});
    if (!pdfBuffer || !pdfBuffer.length) {
      throw new Error('Downloaded PDF buffer was empty');
    }

    const uploadRes = await uploadCompletedPdf(reqId, appNo, pdfBuffer, fname);
    console.log(`[#${reqId}] Uploaded ${fname} -> ${uploadRes.pdfUrl}`);
  } catch (err) {
    console.error(`[#${reqId}] Error processing ${appNo}:`, err.message || err);
    cooldownUntil.set(reqId, Date.now() + 60_000);
  } finally {
    if (handler) {
      client.removeEventHandler(handler, new NewMessage({ fromUsers: [botEntity] }));
    }
    inProgress.delete(reqId);
  }
}

async function main() {
  if (process.env.PORT) {
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('KP LL Userbot Bridge Running');
    }).listen(Number(process.env.PORT), () => {
      console.log(`Healthcheck server listening on port ${process.env.PORT}`);
    });
  }

  const envSession = (process.env.TG_SESSION_STRING || '').trim();
  const savedSession = envSession || (fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '');
  const client = new TelegramClient(new StringSession(savedSession), TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
    useWSS: true
  });

  await client.start({
    phoneNumber: () => ask('Enter your Telegram phone number (with country code, e.g. +91...): '),
    password: () => ask('Enter your Telegram 2FA password (if enabled): '),
    phoneCode: () => ask('Enter the OTP code sent to your Telegram app: '),
    onError: (err) => console.error('Telegram login error:', err)
  });

  fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf8');
  const botEntity = await client.getEntity(TARGET_BOT);
  console.log(`Connected to Telegram. Bridging pending LL PDFs to @${TARGET_BOT} -> ${PORTAL_URL}`);

  while (true) {
    try {
      const now = Date.now();
      const pending = await fetchPendingRequests();
      for (const req of pending) {
        if (inProgress.has(req.id)) continue;
        if ((cooldownUntil.get(req.id) || 0) > now) continue;
        await processRequest(client, botEntity, req);
      }
    } catch (err) {
      console.error('Polling error:', err.message || err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
