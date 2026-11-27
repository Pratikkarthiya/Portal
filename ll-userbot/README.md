# KP Cyber — Telegram LL PDF Userbot Bridge

Automatically polls your KP Cyber portal for `pending` LL PDF requests, sends the application number to a third-party Telegram bot from your Telegram account (MTProto), downloads the returned PDF, and uploads it back to your portal (which also auto-forwards it to the customer on Telegram).

## 1. Set the Worker Secret on Cloudflare Pages
Run once in the `e:\KP` project directory:
```powershell
npx wrangler pages secret put LL_WORKER_SECRET --project-name=portal
```
Enter a strong random secret (and put the exact same value in `ll-userbot/.env`).

## 2. Get Telegram API Credentials
1. Go to https://my.telegram.org and log in with your phone number.
2. Open **API development tools** and copy your `App api_id` (`TG_API_ID`) and `App api_hash` (`TG_API_HASH`).

## 3. Configure & Run the Bridge (PC or VPS)
```powershell
cd ll-userbot
pip install -r requirements.txt
copy .env.example .env
# Edit .env with TG_API_ID, TG_API_HASH, TARGET_BOT_USERNAME, LL_WORKER_SECRET, and BOT_COMMAND_TEMPLATE
python bot_bridge.py
```
On the first run, Telethon will ask for your phone number and Telegram OTP once, creating a `kp_userbot.session` file.

## Notes
- `BOT_COMMAND_TEMPLATE` defaults to `{app_no}`. If the third-party bot expects a slash command (for example `/ll 1234567890`), set `BOT_COMMAND_TEMPLATE=/ll {app_no}`.
- Never commit `.env` or `*.session` files to Git.
