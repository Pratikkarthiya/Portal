import asyncio
import os
import time
import requests
from dotenv import load_dotenv
from telethon import TelegramClient, events

load_dotenv()

TG_API_ID = int(os.environ["TG_API_ID"])
TG_API_HASH = os.environ["TG_API_HASH"]
TARGET_BOT = os.environ["TARGET_BOT_USERNAME"].lstrip("@")
PORTAL_URL = os.environ.get("PORTAL_URL", "https://portal-2a3.pages.dev").rstrip("/")
LL_WORKER_SECRET = os.environ["LL_WORKER_SECRET"]
BOT_COMMAND_TEMPLATE = os.environ.get("BOT_COMMAND_TEMPLATE", "{app_no}")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_SEC", "5"))
REPLY_TIMEOUT = float(os.environ.get("REPLY_TIMEOUT_SEC", "45"))

HEADERS = {"X-Worker-Key": LL_WORKER_SECRET}
in_progress = set()
cooldown_until = {}


def fetch_pending_requests():
    res = requests.get(f"{PORTAL_URL}/api/worker/ll-pdf/pending", headers=HEADERS, timeout=15)
    res.raise_for_status()
    data = res.json()
    return data.get("requests", [])


def upload_completed_pdf(request_id: int, app_no: str, pdf_bytes: bytes, filename: str):
    files = {"pdf": (filename or f"{app_no}.pdf", pdf_bytes, "application/pdf")}
    data = {"requestId": str(request_id), "applicationNumber": app_no}
    res = requests.post(
        f"{PORTAL_URL}/api/worker/ll-pdf/complete",
        headers=HEADERS,
        data=data,
        files=files,
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


async def process_request(client: TelegramClient, bot_entity, req: dict):
    req_id = req["id"]
    app_no = str(req["application_number"]).strip()
    in_progress.add(req_id)

    try:
        print(f"[#{req_id}] Requesting LL PDF for {app_no} from @{TARGET_BOT}...")
        loop = asyncio.get_running_loop()
        pdf_future = loop.create_future()

        @client.on(events.NewMessage(from_users=bot_entity))
        async def handler(event):
            if pdf_future.done():
                return
            msg = event.message
            if msg.document:
                mime = getattr(msg.document, "mime_type", "") or ""
                fname = msg.file.name if msg.file else ""
                if mime == "application/pdf" or (fname and fname.lower().endswith(".pdf")):
                    pdf_future.set_result((msg, fname or f"{app_no}.pdf"))

        try:
            prompt_text = BOT_COMMAND_TEMPLATE.format(app_no=app_no)
            await client.send_message(bot_entity, prompt_text)
            msg, fname = await asyncio.wait_for(pdf_future, timeout=REPLY_TIMEOUT)
            pdf_bytes = await client.download_media(msg, bytes)
            if not pdf_bytes:
                raise RuntimeError("Downloaded PDF was empty")
            upload_res = upload_completed_pdf(req_id, app_no, pdf_bytes, fname)
            print(f"[#{req_id}] Uploaded {fname} -> {upload_res.get('pdfUrl')}")
        except asyncio.TimeoutError:
            print(f"[#{req_id}] Timed out waiting for PDF from @{TARGET_BOT} for {app_no}")
            cooldown_until[req_id] = time.time() + 120
        finally:
            client.remove_event_handler(handler)
    except Exception as exc:
        print(f"[#{req_id}] Error processing {app_no}: {exc}")
        cooldown_until[req_id] = time.time() + 60
    finally:
        in_progress.discard(req_id)


async def main():
    client = TelegramClient("kp_userbot", TG_API_ID, TG_API_HASH)
    await client.start()
    bot_entity = await client.get_entity(TARGET_BOT)
    print(f"Connected to Telegram. Bridging pending LL PDFs to @{TARGET_BOT} -> {PORTAL_URL}")

    while True:
        try:
            now = time.time()
            pending = fetch_pending_requests()
            for req in pending:
                req_id = req["id"]
                if req_id in in_progress:
                    continue
                if cooldown_until.get(req_id, 0) > now:
                    continue
                await process_request(client, bot_entity, req)
        except Exception as exc:
            print(f"Polling error: {exc}")

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
