# KP Cyber — Telegram LL PDF Userbot Bridge

Automatically polls your KP Cyber portal for `pending` LL PDF requests, sends the application number to a third-party Telegram bot from your Telegram account (MTProto), downloads the returned PDF, and uploads it back to your portal (which also auto-forwards it to the customer on Telegram).

## 1. Set the Worker Secret on Cloudflare Pages
Run once in `e:\KP` (or add `LL_WORKER_SECRET` in Cloudflare Dashboard → Workers & Pages → `portal` → Settings → Variables and Secrets):
```powershell
npx wrangler pages secret put LL_WORKER_SECRET --project-name=portal
```

## 2. Get Telegram API Credentials
1. Go to https://my.telegram.org and log in with your phone number.
2. Open **API development tools** and copy your `App api_id` (`TG_API_ID`) and `App api_hash` (`TG_API_HASH`).

## 3. Configure & Run (Node.js — Recommended on Windows)
```powershell
cd e:\KP\ll-userbot
npm install
copy .env.example .env
# Edit .env with TG_API_ID, TG_API_HASH, TARGET_BOT_USERNAME, LL_WORKER_SECRET, and BOT_COMMAND_TEMPLATE
node bot_bridge.js
```

On the first run, it will ask for your phone number and the Telegram OTP once, saving `kp_userbot.session`.

*(A Python version `bot_bridge.py` is also included if you prefer running it on a Python VPS.)*
