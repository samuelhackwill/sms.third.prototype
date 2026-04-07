#!/usr/bin/env python3

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar


DEFAULT_BASE_URL = "http://10.73.73.5"
DEFAULT_INTERVAL_SECONDS = 1.0
DEFAULT_PAGE_SIZE = 200


def env_str(name, default=None):
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def env_float(name, default):
    value = env_str(name)
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def log(message):
    print(f"[tenda-router-scraper] {message}", flush=True)


def obfuscate_number(number):
    clean = "".join(ch for ch in str(number or "") if ch.isdigit())
    if len(clean) < 5:
        return "xx xx xx xx xx"

    first3 = clean[:3]
    last2 = clean[-2:]
    middle = "x" * max(0, len(clean) - 5)
    grouped = " ".join(middle[index : index + 2] for index in range(0, len(middle), 2)).strip()
    pieces = [first3]
    if grouped:
      pieces.append(grouped)
    pieces.append(last2)
    return " ".join(piece for piece in pieces if piece)


def stable_router_message_id(number, content, timestamp_seconds):
    payload = json.dumps(
        {
            "number": number,
            "content": content,
            "time": timestamp_seconds,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def is_benign_router_empty_payload(raw_text):
    text = (raw_text or "").strip()
    if not text:
        return True

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return False

    return parsed.get("errCode") == 1000


class TendaRouterScraper:
    def __init__(self):
        self.base_url = env_str("TENDA_ROUTER_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        self.username = env_str("TENDA_ROUTER_USERNAME", "admin")
        self.password = env_str("TENDA_ROUTER_PASSWORD")
        self.ingest_url = env_str("TENDA_ROUTER_INGEST_URL")
        self.ingest_token = env_str("TENDA_ROUTER_INGEST_TOKEN")
        self.interval_seconds = max(0.5, env_float("TENDA_ROUTER_POLL_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS))
        self.page_size = max(1, int(env_str("TENDA_ROUTER_PAGE_SIZE", str(DEFAULT_PAGE_SIZE))))
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))
        self.running = True

    def run(self):
        if not self.password:
            log("TENDA_ROUTER_PASSWORD is missing. Exiting.")
            return 1

        if not self.ingest_url:
            log("TENDA_ROUTER_INGEST_URL is missing. Exiting.")
            return 1

        signal.signal(signal.SIGTERM, self._handle_stop)
        signal.signal(signal.SIGINT, self._handle_stop)

        log(
            f"started (base_url={self.base_url}, ingest_url={self.ingest_url}, "
            f"interval={self.interval_seconds}s, page_size={self.page_size})"
        )

        while self.running:
            heartbeat = {
                "ok": True,
                "error": None,
                "recordsSeen": 0,
                "recordsPosted": 0,
            }
            try:
                self.login()
                records = self.fetch_latest_messages()
                heartbeat["recordsSeen"] = len(records)
                if records:
                    self.post_records(records)
                    heartbeat["recordsPosted"] = len(records)
            except Exception as error:
                heartbeat["ok"] = False
                heartbeat["error"] = str(error)
                log(f"poll failed: {error}")

            self.send_heartbeat(heartbeat)
            self._sleep_interval()

        log("stopped")
        return 0

    def _handle_stop(self, signum, frame):
        self.running = False

    def _sleep_interval(self):
        deadline = time.time() + self.interval_seconds
        while self.running and time.time() < deadline:
            time.sleep(0.1)

    def login(self):
        password_hashed = hashlib.md5(self.password.encode("utf-8")).hexdigest()
        payload = json.dumps(
            {
                "username": self.username,
                "password": password_hashed,
            }
        ).encode("utf-8")

        request = urllib.request.Request(
            f"{self.base_url}/login/Auth",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Referer": f"{self.base_url}/index.html",
                "Origin": self.base_url,
                "X-Requested-With": "XMLHttpRequest",
            },
        )

        with self.opener.open(request, timeout=10) as response:
            raw = response.read().decode("utf-8", errors="replace")

        parsed = json.loads(raw)
        if parsed.get("errCode") != 0:
            raise RuntimeError(f"login failed: {parsed}")

    def fetch_latest_messages(self):
        cookie_string = "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.cookie_jar)
        query = urllib.parse.urlencode(
            {
                "rand": str(time.time()),
                "currentPage": "1",
                "pageSizes": str(self.page_size),
                "modules": "smsList",
            }
        )
        url = f"{self.base_url}/goform/getModules?{query}"

        result = subprocess.run(
            [
                "curl",
                "-s",
                url,
                "-H",
                f"Referer: {self.base_url}/index.html",
                "-H",
                "X-Requested-With: XMLHttpRequest",
                "-H",
                f"Cookie: {cookie_string}",
                "-H",
                "User-Agent: Mozilla/5.0",
                "-H",
                "Accept: application/json, text/plain, */*",
            ],
            capture_output=True,
            timeout=20,
            check=False,
        )

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"curl failed ({result.returncode}): {stderr}")

        raw_bytes = result.stdout
        decoded = self.decode_router_payload(raw_bytes)

        if is_benign_router_empty_payload(decoded):
            return []

        data = json.loads(decoded)
        phone_list = ((data.get("smsList") or {}).get("phoneList")) or []

        latest_by_sender = {}
        for entry in phone_list:
            number = entry.get("phone")
            notes = entry.get("note") or []
            note = notes[0] if notes else None
            if not number or not note:
                continue

            content = note.get("content") or ""
            timestamp_seconds = int(note.get("time") or 0)
            latest_by_sender[number] = {
                "source": "sim_router",
                "phoneNumberId": "sim_router",
                "sender": number,
                "body": content,
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp_seconds)) if timestamp_seconds > 0 else None,
                "meta": {
                    "routerMessageId": stable_router_message_id(number, content, timestamp_seconds),
                    "routerPhone": number,
                    "routerPhoneSafe": obfuscate_number(number),
                    "routerTimestampSeconds": timestamp_seconds,
                },
            }

        return list(latest_by_sender.values())

    def decode_router_payload(self, raw_bytes):
        attempts = ("utf-8", "latin1", "gbk", "cp1252")

        for encoding in attempts:
            try:
                return raw_bytes.decode(encoding)
            except UnicodeDecodeError:
                continue

        return raw_bytes.decode("utf-8", errors="replace")

    def post_records(self, records):
        payload = json.dumps({"records": records}, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
        }
        if self.ingest_token:
            headers["Authorization"] = f"Bearer {self.ingest_token}"

        request = urllib.request.Request(
            self.ingest_url,
            data=payload,
            method="POST",
            headers=headers,
        )

        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            error_body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ingest failed ({error.code}): {error_body}") from error

        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"raw": body}

        ingested_count = parsed.get("ingestedCount")
        if ingested_count:
            log(f"ingested {ingested_count} router messages")

    def send_heartbeat(self, heartbeat):
        headers = {
            "Content-Type": "application/json",
        }
        if self.ingest_token:
            headers["Authorization"] = f"Bearer {self.ingest_token}"

        request = urllib.request.Request(
            f"{self.ingest_url}/heartbeat",
            data=json.dumps(heartbeat, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )

        try:
            with urllib.request.urlopen(request, timeout=10):
                return
        except Exception as error:
            log(f"heartbeat failed: {error}")


if __name__ == "__main__":
    scraper = TendaRouterScraper()
    sys.exit(scraper.run())
