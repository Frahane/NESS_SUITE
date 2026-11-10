#!/usr/bin/env python3
"""
Ness TempMail
Single-file sovereign temporary email service.

Design principles:
  1. Zero hard dependency on external services for RECEPTION (sovereign inbound SMTP).
  2. Graceful degradation: the UI always renders, even when Flask or aiosmtpd
     are not installed. A stdlib http.server shim takes over HTTP if needed.
  3. Multi-tier commercial logic paid in NESS Coin-Hours (NCH).
     Free teaser + graduated paid plans (30m → 5h → 24h → 7d → 30d)
     with increasing capacity, personalization, and features.
  4. SQLite in WAL mode so Flask (reads) and SMTP (writes) never block.
  5. Everything in English: comments, identifiers, UI strings, log messages.

Dependencies:
  - Required for HTTP:      flask        (falls back to stdlib http.server if absent)
  - Required for SMTP rx:   aiosmtpd     (SMTP disabled if absent)
  - Always available:       sqlite3, email, threading, http.server, urllib, json

Run:
  pip install flask aiosmtpd      # optional, both fall back gracefully
  python app.py
"""

import base64
import json
import os
import random
import re
import secrets
import sqlite3
import string
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ==========================================================================
# 1. OPTIONAL DEPENDENCIES - GRACEFUL RESOLUTION
# ==========================================================================

try:
    from flask import (
        Flask,
        g,
        jsonify,
        render_template,
        render_template_string,
        request,
    )
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False

try:
    from aiosmtpd.controller import Controller
    from aiosmtpd.smtp import SMTP as AioSMTPServer
    HAS_AIOSMTPD = True
except ImportError:
    HAS_AIOSMTPD = False
    AioSMTPServer = None

# ==========================================================================
# 2. CONFIGURATION
# ==========================================================================

from config import (  # noqa: E402
    BASE_DIR,
    CLEANUP_INTERVAL,
    DB_PATH,
    DOMAIN,
    EXPLORER_TIMEOUT_SEC,
    HTTP_HOST,
    HTTP_PORT,
    NCH_PAYMENT_ADDRESS,
    NESS_EXPLORER_URLS,
    PAYMENT_MIN_CONFIRMATIONS,
    PAYMENT_TX_MAX_AGE_SEC,
    SMTP_FALLBACK_PORT,
    SMTP_HOST,
    SMTP_PORT,
    TIERS,
    TRUSTED_PROXIES,
)

import burn as burn_product
import invoice as invoice_product
import storage as storage_product
import wormhole as wormhole_product
import ssh as ssh_product


# ==========================================================================
# 3. DATABASE LAYER (SQLite, WAL, concurrent-safe)
# ==========================================================================

def _open_db():
    """Open a fresh SQLite connection configured for concurrent use."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

# Thread-local storage used only in fallback (non-Flask) mode
_local = threading.local()

def get_db():
    """Return the current request's DB connection."""
    if HAS_FLASK:
        if "db" not in g:
            g.db = _open_db()
        return g.db
    else:
        if not hasattr(_local, "db") or _local.db is None:
            _local.db = _open_db()
        return _local.db

def _close_db_local():
    """Close the thread-local connection (fallback mode only)."""
    if hasattr(_local, "db") and _local.db is not None:
        try:
            _local.db.close()
        except Exception:
            pass
        _local.db = None

def init_db():
    """Create the schema if it doesn't exist. Migrate lightly if needed."""
    conn = _open_db()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS mailboxes (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            public_token TEXT UNIQUE,
            address      TEXT UNIQUE NOT NULL,
            plan         TEXT NOT NULL DEFAULT 'free',
            created_at   TEXT NOT NULL,
            expires_at   TEXT NOT NULL,
            max_messages INTEGER NOT NULL
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            mailbox_id       INTEGER NOT NULL,
            sender           TEXT,
            recipient        TEXT,
            subject          TEXT,
            body             TEXT,
            body_html        TEXT,
            raw_email        TEXT,
            attachments_json TEXT DEFAULT '[]',
            received_at      TEXT NOT NULL,
            FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS subscriptions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            mailbox_id       INTEGER NOT NULL,
            plan             TEXT NOT NULL,
            transaction_hash TEXT UNIQUE,
            amount_nch       REAL,
            activated_at     TEXT NOT NULL,
            expires_at       TEXT NOT NULL,
            FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS used_transactions (
            tx_hash    TEXT PRIMARY KEY,
            product    TEXT NOT NULL,
            ref_id     INTEGER,
            amount_nch INTEGER,
            used_at    TEXT NOT NULL
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS payment_intents (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            intent_id        TEXT UNIQUE NOT NULL,
            plan             TEXT NOT NULL,
            amount_nch       REAL NOT NULL,
            pay_address      TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'pending',
            tx_hash          TEXT,
            mailbox_id       INTEGER,
            created_at       TEXT NOT NULL,
            expires_at       TEXT NOT NULL,
            verified_at      TEXT
        )
    """)
    # Lightweight migrations for existing DBs
    pi_cols = {r[1] for r in c.execute("PRAGMA table_info(payment_intents)").fetchall()}
    if "product" not in pi_cols:
        c.execute("ALTER TABLE payment_intents ADD COLUMN product TEXT NOT NULL DEFAULT 'mail'")
    msg_cols = {r[1] for r in c.execute("PRAGMA table_info(messages)").fetchall()}
    if "attachments_json" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN attachments_json TEXT DEFAULT '[]'")
    if "body_html" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN body_html TEXT")

    mb_cols = {r[1] for r in c.execute("PRAGMA table_info(mailboxes)").fetchall()}
    if "public_token" not in mb_cols:
        c.execute("ALTER TABLE mailboxes ADD COLUMN public_token TEXT")
    # Backfill opaque tokens for any legacy rows (closes IDOR on old DBs)
    for row in c.execute(
        "SELECT id FROM mailboxes WHERE public_token IS NULL OR public_token = ''"
    ).fetchall():
        c.execute(
            "UPDATE mailboxes SET public_token = ? WHERE id = ?",
            (secrets.token_urlsafe(18), row[0]),
        )
    c.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_public_token "
        "ON mailboxes(public_token)"
    )
    conn.commit()
    conn.close()

# ==========================================================================
# 4. REQUEST / RESPONSE SHIMS (only used when Flask is absent)
# ==========================================================================

if not HAS_FLASK:
    class _ShimRequest:
        def __init__(self, method, path, args, form, headers):
            self.method = method
            self.path = path
            self.args = args
            self.form = form
            self.headers = headers

    _current_request = None

    class _RequestProxy:
        def __getattr__(self, name):
            return getattr(_current_request, name)

    request = _RequestProxy()

    def jsonify(data):
        return data

    def render_template_string(s):
        return s

    class MiniApp:
        """Minimal Flask-compatible HTTP app backed by the standard library."""

        def __init__(self, name):
            self.name = name
            self.routes = []

        def route(self, path, methods=None):
            methods = methods or ["GET"]
            def decorator(fn):
                self.routes.append((path, methods, fn))
                return fn
            return decorator

        def run(self, host="127.0.0.1", port=5000, **kwargs):
            app = self
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):     self._handle("GET")
                def do_POST(self):    self._handle("POST")
                def do_PUT(self):     self._handle("PUT")
                def do_DELETE(self):  self._handle("DELETE")

                def _handle(self, method):
                    parsed = urlparse(self.path)
                    path = parsed.path
                    args = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                    form = {}
                    if method in ("POST", "PUT"):
                        try:
                            length = int(self.headers.get("Content-Length", 0) or 0)
                            if length > 0:
                                body = self.rfile.read(length).decode("utf-8")
                                form = {k: v[0] for k, v in parse_qs(body).items()}
                        except Exception:
                            pass

                    for pattern, methods, handler in app.routes:
                        if method not in methods:
                            continue
                        # Convert Flask-style path converters to safe named groups
                        regex = re.sub(r"<int:([a-zA-Z_][a-zA-Z0-9_]*)>", r"(?P<\1>\\d+)", pattern)
                        regex = re.sub(r"<([a-zA-Z_][a-zA-Z0-9_]*)>", r"(?P<\1>[^/]+)", regex)
                        try:
                            m = re.match("^" + regex + "$", path)
                        except re.error:
                            continue
                        if not m:
                            continue
                        kwargs = {
                            k: (int(v) if v.isdigit() else v)
                            for k, v in m.groupdict().items()
                        }
                        global _current_request
                        _current_request = _ShimRequest(
                            method, path, args, form, dict(self.headers)
                        )
                        try:
                            result = handler(**kwargs)
                            self._send_result(result)
                        except Exception as exc:
                            self._send_json({"error": str(exc)}, 500)
                        finally:
                            _close_db_local()
                        return

                    # Static files (stdlib fallback)
                    if method == "GET" and path.startswith("/static/"):
                        rel = path[len("/static/"):]
                        static_root = BASE_DIR / "static"
                        candidate = (static_root / rel).resolve()
                        try:
                            candidate.relative_to(static_root.resolve())
                        except ValueError:
                            self._send_json({"error": "Not found"}, 404)
                            return
                        if candidate.is_file():
                            data = candidate.read_bytes()
                            ctype = "application/octet-stream"
                            if rel.endswith(".css"):
                                ctype = "text/css; charset=utf-8"
                            elif rel.endswith(".js"):
                                ctype = "application/javascript; charset=utf-8"
                            elif rel.endswith(".png"):
                                ctype = "image/png"
                            elif rel.endswith(".svg"):
                                ctype = "image/svg+xml"
                            self.send_response(200)
                            self.send_header("Content-Type", ctype)
                            self.send_header("Content-Length", str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)
                            return

                    self._send_json({"error": "Not found"}, 404)

                def _send_result(self, result):
                    status = 200
                    if isinstance(result, tuple):
                        body = result[0]
                        if len(result) > 1:
                            status = result[1]
                    else:
                        body = result

                    if isinstance(body, (dict, list)):
                        self._send_json(body, status)
                    else:
                        self.send_response(status)
                        self.send_header("Content-Type", "text/html; charset=utf-8")
                        self.end_headers()
                        self.wfile.write(str(body).encode("utf-8"))

                def _send_json(self, data, status=200):
                    payload = json.dumps(data).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

                def log_message(self, fmt, *args):
                    pass

            HTTPServer((host, port), Handler).serve_forever()

    app = MiniApp(__name__)
else:
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
        static_url_path="/static",
    )
    # Hard body cap (Burn Month up to 1 GB + margin). Reverse proxy should also limit.
        # Single-request body ceiling (not the same as marketed tier quota).
    # Large tiers above this need chunked upload (future) or raise MAX_CONTENT_LENGTH_MB on a capable host.
    _cap = int(__import__("os").environ.get("MAX_CONTENT_LENGTH_MB", "2048") or "2048")
    app.config["MAX_CONTENT_LENGTH"] = max(_cap, 64) * 1024 * 1024


if HAS_FLASK and app is not None:
    @app.context_processor
    def _ness_og_context():
        """Default Open Graph tags from path; views may override via render_template kwargs."""
        try:
            from flask import request, has_request_context
            path = request.path if has_request_context() else "/"
        except Exception:
            path = "/"
        meta = build_og_meta(og_slug_from_path(path), path=path)
        return meta


    @app.teardown_appcontext
    def _close_db(_exc=None):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    @app.after_request
    def _security_headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        # microphone=(self) required for NESS Burn voice notes (was () → Permission denied)
        resp.headers["Permissions-Policy"] = (
            "camera=(), microphone=(self), geolocation=()"
        )
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://code.jquery.com https://cdn.jsdelivr.net 'unsafe-inline'; "
            "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
            "font-src https://fonts.gstatic.com data:; "
            "img-src 'self' data: blob: https://api.qrserver.com; "
            "media-src 'self' blob:; "
            "connect-src 'self' blob:; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'"
        )
        # Avoid caching sensitive JSON
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

# ==========================================================================
# 5. SMTP RECEPTION
# ==========================================================================

# Attachment / SMTP sizing (keep coherent with each other)
# data_size_limit (SMTP) ≈ 15 MB · HARD_ATTACHMENT under that · body store 500 KB
# Align with highest TempMail tier (month = 50 MB) + SMTP envelope margin
HARD_ATTACHMENT_CAP_BYTES = 50 * 1024 * 1024
SMTP_DATA_SIZE_LIMIT = 55 * 1024 * 1024
SMTP_LINE_LENGTH_LIMIT = 100 * 1024  # above RFC 998; covers broken MUAs, not 1 MB abuse
INLINE_IMAGE_SINGLE_CAP = 512 * 1024          # per image on free (no file attachments)
INLINE_IMAGE_TOTAL_CAP_FREE = 600 * 1024      # total inline payload per message on free
BODY_TEXT_STORE_LIMIT = 500_000
BODY_HTML_STORE_LIMIT = 500_000
RAW_EMAIL_STORE_LIMIT = 600_000


def _extract_email_parts(msg, allow_attachments=True, max_attachment_bytes=0):
    """Parse body (text + html) and optional attachments from an email.message."""
    body_text = ""
    body_html = ""
    attachments = []

    def _part_filename(part):
        name = part.get_filename()
        if name:
            # Neutralize path components (../../etc/passwd style)
            base = os.path.basename(str(name).replace("\\", "/"))
            base = re.sub(r"[^\w.\- ()\[\]]+", "_", base).strip("._")
            return base[:180] or "attachment.bin"
        ctype = part.get_content_type() or "application/octet-stream"
        ext = ctype.split("/")[-1] if "/" in ctype else "bin"
        ext = re.sub(r"[^a-zA-Z0-9]", "", ext)[:12] or "bin"
        return f"attachment.{ext}"

    inline_total = 0
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            content_id = str(part.get("Content-ID") or "").strip().strip("<>")
            is_inline_image = bool(content_id and ctype.startswith("image/"))
            is_attach = (
                "attachment" in disp.lower()
                or part.get_filename()
                or is_inline_image
            )
            if is_attach:
                # Tier gate applies to real attachments only — inline cid images
                # (signatures / logos) remain available on free discovery tier.
                if not allow_attachments and not is_inline_image:
                    continue
                try:
                    payload = part.get_payload(decode=True) or b""
                except Exception:
                    payload = b""
                # Free tier: per-image + total inline caps (DoS resistance)
                if is_inline_image and not allow_attachments:
                    if len(payload) > INLINE_IMAGE_SINGLE_CAP:
                        continue
                    inline_total += len(payload)
                    if inline_total > INLINE_IMAGE_TOTAL_CAP_FREE:
                        continue
                elif max_attachment_bytes and len(payload) > max_attachment_bytes:
                    continue
                if len(payload) > HARD_ATTACHMENT_CAP_BYTES:
                    continue
                attachments.append({
                    "filename": _part_filename(part)[:180],
                    "content_type": ctype,
                    "size": len(payload),
                    "data_b64": base64.b64encode(payload).decode("ascii"),
                    "content_id": content_id,
                })
                continue
            if ctype == "text/plain" and not body_text:
                try:
                    body_text = part.get_content()
                except Exception:
                    body_text = ""
            elif ctype == "text/html" and not body_html:
                try:
                    body_html = part.get_content()
                except Exception:
                    body_html = ""
    else:
        ctype = msg.get_content_type()
        try:
            content = msg.get_content()
        except Exception:
            try:
                content = msg.get_payload(decode=True)
                if isinstance(content, bytes):
                    content = content.decode("utf-8", errors="replace")
            except Exception:
                content = ""
        if ctype == "text/html":
            body_html = content if isinstance(content, str) else str(content or "")
        else:
            body_text = content if isinstance(content, str) else str(content or "")

    if not body_text and body_html:
        # Crude strip for preview when only HTML is present
        body_text = re.sub(r"<[^>]+>", " ", body_html)
        body_text = re.sub(r"\s+", " ", body_text).strip()

    return (
        str(body_text)[:BODY_TEXT_STORE_LIMIT] if body_text else "",
        str(body_html)[:BODY_HTML_STORE_LIMIT] if body_html else "",
        attachments,
    )


class CatchAllHandler:
    """
    Inbound SMTP for registered mailboxes only.

    Design notes:
      - Despite the historical name, this is NOT an open catch-all.
        Unregistered recipients are silently ignored (no 550 bounce) to
        avoid address enumeration and backscatter.
      - When a mailbox is at max_messages capacity we also accept with 250
        and drop the message rather than bounce — same rationale for a
        temporary-mail product.
    """

    async def handle_DATA(self, server, session, envelope):
        conn = None
        try:
            mail_from = envelope.mail_from
            rcpt_tos = envelope.rcpt_tos
            data = envelope.content

            msg = BytesParser(policy=policy.default).parsebytes(data)
            subject = msg.get("Subject", "(no subject)")

            conn = _open_db()
            now = datetime.now(timezone.utc).isoformat()
            for rcpt in rcpt_tos:
                rcpt_lower = rcpt.lower().strip()
                row = conn.execute(
                    """SELECT m.id, m.max_messages, m.plan
                       FROM mailboxes m WHERE m.address = ?""",
                    (rcpt_lower,),
                ).fetchone()
                if not row:
                    # Unknown address: drop quietly (no bounce / no leak)
                    continue
                count = conn.execute(
                    "SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?",
                    (row["id"],),
                ).fetchone()["c"]
                if count >= row["max_messages"]:
                    # Full inbox: 250 OK to sender, message discarded by design
                    print(
                        f"[SMTP] Dropped message for {rcpt_lower}: "
                        f"mailbox full ({count}/{row['max_messages']})"
                    )
                    continue

                tier = TIERS.get(row["plan"], TIERS["free"])
                allow_att = bool(tier.get("attachments"))
                max_bytes = int(tier.get("max_attachment_mb") or 0) * 1024 * 1024
                body_text, body_html, attachments = _extract_email_parts(
                    msg, allow_attachments=allow_att, max_attachment_bytes=max_bytes
                )
                if not body_text and not body_html:
                    body_text = "(empty message)"

                conn.execute(
                    """INSERT INTO messages
                       (mailbox_id, sender, recipient, subject, body, body_html,
                        raw_email, attachments_json, received_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        row["id"],
                        mail_from,
                        rcpt_lower,
                        subject,
                        body_text,
                        body_html or None,
                        data[:RAW_EMAIL_STORE_LIMIT].decode("utf-8", errors="replace"),
                        json.dumps(attachments),
                        now,
                    ),
                )
            conn.commit()
            return "250 Message accepted"
        except Exception as exc:
            print(f"[SMTP] handle_DATA error: {exc}")
            return "451 Temporary failure"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass


_smtp_lock = threading.Lock()
_smtp_started = False
_smtp_bound_port = None


def start_smtp_server():
    """
    Bind SMTP once per process.
    Port 25 needs root; on Termux we fall through 2525, 2526, … 
    Failures are logged — never crash the HTTP UI.
    """
    global _smtp_started, _smtp_bound_port

    if not HAS_AIOSMTPD:
        return

    with _smtp_lock:
        if _smtp_started:
            print(f"[SMTP] Already listening on {_smtp_bound_port} — skip duplicate start")
            return

        handler = CatchAllHandler()
        # Prefer configured ports, then a small free range for dev/Termux
        ports_to_try = []
        for p in (SMTP_PORT, SMTP_FALLBACK_PORT, 2526, 2527, 2528, 8025):
            if p not in ports_to_try:
                ports_to_try.append(p)

        # Local test clients (and some MUAs) can emit base64 / large bodies that
        # trip aiosmtpd's strict RFC 5321 line limit (~998 octets).
        # 1) Patch class attributes on the SMTP implementation.
        # 2) Prefer a Controller subclass that sets server_class (supported on
        #    aiosmtpd 1.4+ without passing forbidden kwargs into SMTP.__init__).
        _controller_cls = Controller
        if AioSMTPServer is not None:
            try:
                AioSMTPServer.line_length_limit = SMTP_LINE_LENGTH_LIMIT
            except Exception:
                pass
            try:
                AioSMTPServer.data_size_limit = SMTP_DATA_SIZE_LIMIT
            except Exception:
                pass
            try:
                import aiosmtpd.smtp as _aiosmtpd_smtp
                _aiosmtpd_smtp.SMTP.line_length_limit = SMTP_LINE_LENGTH_LIMIT
                if hasattr(_aiosmtpd_smtp.SMTP, "data_size_limit"):
                    _aiosmtpd_smtp.SMTP.data_size_limit = SMTP_DATA_SIZE_LIMIT
            except Exception:
                pass

            class _NESS_SMTP(AioSMTPServer):
                line_length_limit = SMTP_LINE_LENGTH_LIMIT
                data_size_limit = SMTP_DATA_SIZE_LIMIT

            class _NESS_Controller(Controller):
                server_class = _NESS_SMTP

            _controller_cls = _NESS_Controller

        last_err = None
        for port in ports_to_try:
            try:
                controller = _controller_cls(
                    handler,
                    hostname=SMTP_HOST,
                    port=port,
                )
                controller.start()
                _smtp_started = True
                _smtp_bound_port = port
                print(f"[SMTP] Listening on {SMTP_HOST}:{port}")
                if port != 25:
                    print(
                        "[SMTP] Non-privileged port. Public MX still expects :25 "
                        "on a VPS (or a forward 25 → this port)."
                    )
                return
            except PermissionError as e:
                last_err = e
                print(
                    f"[SMTP] Permission denied on {SMTP_HOST}:{port} "
                    f"(ports < 1024 need root). Trying next…"
                )
            except OSError as e:
                last_err = e
                print(f"[SMTP] Could not bind {SMTP_HOST}:{port}: {e}. Trying next…")
            except TypeError as e:
                # Incompatible Controller kwargs on exotic builds — retry bare
                last_err = e
                print(f"[SMTP] Controller TypeError on {port}: {e}. Trying next…")
                continue
            except Exception as e:
                last_err = e
                print(f"[SMTP] Unexpected error on {port}: {e}. Trying next…")
                continue

        print(
            f"[SMTP] Disabled — no free port in {ports_to_try}. "
            f"Last error: {last_err}. HTTP UI remains available."
        )


def cleanup_expired():
    while True:
        conn = None
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.execute("PRAGMA busy_timeout=5000;")
            now = datetime.now(timezone.utc)
            now_iso = now.isoformat()
            conn.execute("DELETE FROM mailboxes WHERE expires_at < ?", (now_iso,))
            # Retain payment audit 90 days, then purge
            cutoff = (now - timedelta(days=90)).isoformat()
            conn.execute(
                "DELETE FROM payment_intents WHERE created_at < ?", (cutoff,)
            )
            conn.execute(
                "DELETE FROM payment_intents WHERE status = 'pending' AND expires_at < ?",
                ((now - timedelta(hours=1)).isoformat(),),
            )
            conn.execute(
                "DELETE FROM used_transactions WHERE used_at < ?",
                ((datetime.now(timezone.utc) - timedelta(days=365)).isoformat(),),
            )
            conn.commit()
        except Exception as exc:
            print(f"[CLEANUP] error: {exc}")
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
        try:
            burn_product.cleanup_burn_expired()
            invoice_product.cleanup_invoices_expired()
        except Exception as exc:
            print(f"[BURN] cleanup error: {exc}")
        try:
            from storage import cleanup_expired_storage
            cleanup_expired_storage()
            try:
                from ssh import cleanup_ssh_expired
                cleanup_ssh_expired()
            except Exception as exc:
                print(f"[SSH] cleanup error: {exc}")
        except Exception as _stg_exc:
            print(f"[CLEANUP] storage: {_stg_exc}")

        time.sleep(CLEANUP_INTERVAL)

# ==========================================================================
# 6. TEMPLATES & ROUTES
# ==========================================================================

# Pre-serialize tiers for the frontend (safe subset)
def _public_tiers():
    out = {}
    for k, v in TIERS.items():
        out[k] = {
            "id": v["id"],
            "label": v["label"],
            "ttl_minutes": v["ttl_minutes"],
            "max_messages": v["max_messages"],
            "custom_address": v["custom_address"],
            "custom_mode": v["custom_mode"],
            "attachments": v["attachments"],
            "max_attachment_mb": v["max_attachment_mb"],
            "priority": v["priority"],
            "api_access": v["api_access"],
            "price_nch": v["price_nch"],
            "badge_class": v["badge_class"],
            "tagline": v["tagline"],
        }
    return out



# ── Open Graph / social cards ───────────────────────────────────────────────
# Images live at static/og/og-<slug>.png (1200×630). Named by product / purpose.

_OG_CATALOG = {
    "tempmail": {
        "title": "NESS TempMail",
        "description": "Sovereign temporary email — disposable inboxes with NCH plans.",
        "image": "og-tempmail.png",
    },
    "burn": {
        "title": "NESS Burn",
        "description": "Ephemeral publish — notes, files, and voice that expire and burn.",
        "image": "og-burn.png",
    },
    "invoice": {
        "title": "NESS Pay — Invoice",
        "description": "Request payment in NESS Coin-hours (NCH).",
        "image": "og-invoice.png",
    },
    "coffee": {
        "title": "NESS Pay — Buy me a coffee",
        "description": "Tips and small support in NESS Coin-hours.",
        "image": "og-coffee.png",
    },
    "fund": {
        "title": "NESS Pay — Fundraiser",
        "description": "Collect toward a goal with NESS Coin-hours.",
        "image": "og-fund.png",
    },
    "other": {
        "title": "NESS Pay — Payment request",
        "description": "Custom NCH payment link on PrivateNess Network.",
        "image": "og-other.png",
    },
    "tips": {
        "title": "NESS Pay — Tips",
        "description": "Support with NESS Coin-hours.",
        "image": "og-tips.png",
    },
    "storage": {
        "title": "NESS Storage",
        "description": "Private encrypted vault on your device — not for sharing.",
        "image": "og-storage.png",
    },
    "wormhole": {
        "title": "NESS Wormhole",
        "description": "Physical possession and offline sealed pairs — client-side tools.",
        "image": "og-wormhole.png",
    },
    "ssh": {
        "title": "EmerSSH (SSH Access)",
        "description": "EmerSSH — manage SSH public keys on Emercoin NVS.",
        "image": "og-suite.png",
    },
}


def public_base_url() -> str:
    """Absolute origin for og:image / og:url. Prefer PUBLIC_BASE_URL, else request."""
    try:
        from config import PUBLIC_BASE_URL as _PBU
        if _PBU:
            return str(_PBU).rstrip("/")
    except Exception:
        pass
    if HAS_FLASK:
        try:
            from flask import request, has_request_context
            if has_request_context() and request:
                return request.url_root.rstrip("/")
        except Exception:
            pass
    return ""


def build_og_meta(slug: str, *, title: str | None = None, description: str | None = None,
                  path: str | None = None) -> dict:
    """Return dict for templates: og_title, og_description, og_image, og_url, og_slug."""
    base = public_base_url()
    key = (slug or "tempmail").strip().lower()
    if key not in _OG_CATALOG:
        key = "tempmail"
    cat = _OG_CATALOG[key]
    img_name = cat["image"]
    image = f"{base}/static/og/{img_name}" if base else f"/static/og/{img_name}"
    url_path = path if path is not None else "/"
    if not url_path.startswith("/"):
        url_path = "/" + url_path
    og_url = f"{base}{url_path}" if base else url_path
    return {
        "og_slug": key,
        "og_title": title or cat["title"],
        "og_description": description or cat["description"],
        "og_image": image,
        "og_url": og_url,
        "og_image_alt": title or cat["title"],
    }


def og_slug_from_path(path: str) -> str:
    p = path or "/"
    if p.startswith("/burn"):
        return "burn"
    if p.startswith("/storage"):
        return "storage"
    if p.startswith("/wormhole"):
        return "wormhole"
    if p.startswith("/invoice"):
        return "invoice"
    return "tempmail"


@app.route("/")
def index():
    """Serve the main UI from templates/index.html + static assets."""
    if HAS_FLASK:
        return render_template(
            "index.html",
            domain=DOMAIN,
            pay_address=NCH_PAYMENT_ADDRESS,
            tiers=_public_tiers(),
        )
    # Stdlib fallback: inject bootstrap constants without Jinja
    html = (Path(__file__).resolve().parent / "templates" / "index.html").read_text(
        encoding="utf-8"
    )
    html = re.sub(
        r"\{\{\s*domain\s*\|\s*tojson\s*\}\}",
        json.dumps(DOMAIN),
        html,
    )
    html = re.sub(
        r"\{\{\s*pay_address\s*\|\s*tojson\s*\}\}",
        json.dumps(NCH_PAYMENT_ADDRESS),
        html,
    )
    html = re.sub(
        r"\{\{\s*tiers\s*\|\s*tojson\s*\}\}",
        json.dumps(_public_tiers()),
        html,
    )
    return html


@app.route("/api/status", methods=["GET"])
def api_status():
    explorer_ok, explorer_detail = probe_explorer_cached()
    return jsonify({
        "smtp_enabled": HAS_AIOSMTPD,
        "flask_enabled": HAS_FLASK,
        "domain": DOMAIN,
        "payment_address": NCH_PAYMENT_ADDRESS,
        "tiers": _public_tiers(),
        "explorer_ok": explorer_ok,
        "explorer": explorer_detail,
    })


# ==========================================================================
# PAYMENT VERIFICATION — PrivateNess / NCH (on-chain, no simulation)
# ==========================================================================

class ExplorerUnavailable(Exception):
    """
    Raised when no PrivateNess explorer endpoint yields usable JSON.

    kind:
      - "offline"       — local network / DNS / unreachable (no HTTP from any host)
      - "explorer_down" — hosts responded but API unusable, or mixed/remote failure
    """

    def __init__(self, message, kind="explorer_down"):
        super().__init__(message)
        self.kind = kind if kind in ("offline", "explorer_down") else "explorer_down"


class PaymentVerificationError(Exception):
    """Raised when the transaction is reachable but fails business rules."""
    def __init__(self, message, http_status=400):
        super().__init__(message)
        self.http_status = http_status


def _is_connectivity_error(exc):
    """True when the failure looks like local network / DNS, not an HTTP API error."""
    if isinstance(exc, TimeoutError):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return False
    msg = str(exc).lower()
    # Note: ECONNREFUSED / errno 111 means a host answered with RST — that is
    # explorer_down semantics, not "no internet". Do not classify as offline.
    reasons = (
        "network is unreachable",
        "no route to host",
        "name or service not known",
        "no address associated",
        "temporary failure in name resolution",
        "nodename nor servname",
        "failed to resolve",
        "getaddrinfo",
        "dns",
        "errno 7",
        "errno -2",
        "errno -3",
        "errno 101",
        "errno 51",
        "errno 8",
        "gaierror",
        "timed out",
        "timeout",
        "offline",
        "network unreachable",
        "connectivity",
    )
    return any(r in msg for r in reasons)


def _claim_tx(db, txid: str, product: str, amount_nch=None, ref_id=None) -> bool:
    """Atomically claim a tx_hash. Returns True if claimed, False if already used."""
    txid = _normalize_txid(txid)
    if not txid:
        return False
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "INSERT INTO used_transactions (tx_hash, product, ref_id, amount_nch, used_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (txid, product, ref_id, amount_nch, now),
        )
        return True
    except sqlite3.IntegrityError:
        return False  # already claimed — expected
    except Exception as exc:
        print(f"[PAY] claim_tx unexpected error for {txid[:16]}…: {exc}")
        return False  # fail-closed, logged


def _tx_already_used(db, txid: str) -> bool:
    """True if this tx was already consumed by any suite product."""
    txid = _normalize_txid(txid)
    if not txid:
        return False
    for sql in (
        "SELECT 1 FROM used_transactions WHERE tx_hash = ?",
        "SELECT 1 FROM subscriptions WHERE transaction_hash = ?",
        "SELECT 1 FROM burn_drops WHERE transaction_hash = ?",
        "SELECT 1 FROM invoices WHERE tx_hash = ?",
        "SELECT 1 FROM wormhole_licenses WHERE tx_hash = ?",
    ):
        try:
            if db.execute(sql, (txid,)).fetchone():
                return True
        except Exception:
            # Table may not exist yet on a partial migrate / first boot.
            continue
    return False


def _normalize_txid(tx_hash):

    """Skycoin/Fiber txids are lowercase hex (64 chars typical)."""
    h = (tx_hash or "").strip().lower()
    if h.startswith("0x"):
        h = h[2:]
    return h


def _is_plausible_txid(tx_hash):
    h = _normalize_txid(tx_hash)
    if len(h) < 16 or len(h) > 128:
        return False
    return bool(re.fullmatch(r"[0-9a-f]+", h))


def _explorer_get(path, query=None):
    """
    GET JSON from the first healthy PrivateNess explorer.
    404s are accumulated across mirrors (indexing lag) and only raised
    after every base has been tried. Network failures try the next base.

    Distinguishes:
      - offline (no usable network path / DNS) → ExplorerUnavailable(kind=offline)
      - explorer_down (HTTP/JSON failure while network works) → kind=explorer_down
    """
    qs = ("?" + urllib.parse.urlencode(query)) if query else ""
    last_err = None
    saw_404 = False
    saw_http = False          # any HTTP layer response (incl. 4xx/5xx)
    network_failures = 0
    total_failures = 0
    for base in NESS_EXPLORER_URLS:
        url = f"{base}{path}{qs}"
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "NESS-Suite/1.0 (+payment-verify)",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=EXPLORER_TIMEOUT_SEC) as resp:
                saw_http = True
                if resp.status != 200:
                    total_failures += 1
                    last_err = f"HTTP {resp.status} from {base}"
                    continue
                raw = resp.read()
                try:
                    return json.loads(raw.decode("utf-8")), base
                except (UnicodeDecodeError, json.JSONDecodeError) as e:
                    total_failures += 1
                    last_err = f"Invalid JSON from {base}: {e}"
                    continue
        except urllib.error.HTTPError as e:
            saw_http = True
            total_failures += 1
            if e.code == 404:
                saw_404 = True
                last_err = f"404 from {base}"
                continue
            last_err = f"HTTP {e.code} from {base}"
            continue
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            total_failures += 1
            last_err = f"{base}: {e}"
            if _is_connectivity_error(e):
                network_failures += 1
            else:
                # Non-classified transport error — still counts as failure
                pass
            continue
    if saw_404:
        raise PaymentVerificationError(
            "Transaction not found on chain", http_status=404
        )
    # Only pure connectivity failures → offline; otherwise explorer_down
    # (ECONNREFUSED / HTTP errors are explorer_down, not "check your Wi-Fi")
    if network_failures > 0 and network_failures == total_failures:
        raise ExplorerUnavailable(
            last_err or "No network path to PrivateNess explorers",
            kind="offline",
        )
    raise ExplorerUnavailable(
        last_err or "All PrivateNess explorers are unreachable",
        kind="explorer_down",
    )


_probe_cache = {"at": 0.0, "ok": False, "detail": {}, "in_flight": False}
_probe_lock = threading.Lock()
PROBE_CACHE_TTL = 20  # seconds


def probe_explorer():
    """
    Lightweight health check (uncached).
    Returns (ok: bool, detail: dict).
    detail may include connectivity: "offline" | "explorer_down".
    """
    try:
        data, base = _explorer_get("/api/health")
        fiber = data.get("fiber") or {}
        return True, {
            "url": base,
            "coin": data.get("coin") or fiber.get("name"),
            "hours_ticker": fiber.get("coin_hours_ticker") or "NCH",
            "head_seq": (data.get("blockchain") or {}).get("head", {}).get("seq"),
            "connectivity": "ok",
        }
    except ExplorerUnavailable as e:
        return False, {
            "error": str(e),
            "connectivity": getattr(e, "kind", "explorer_down"),
        }
    except (PaymentVerificationError, Exception) as e:
        return False, {"error": str(e), "connectivity": "explorer_down"}


def probe_explorer_cached():
    now = time.time()
    with _probe_lock:
        if now - _probe_cache["at"] < PROBE_CACHE_TTL:
            return _probe_cache["ok"], _probe_cache["detail"]
        if _probe_cache.get("in_flight"):
            return _probe_cache["ok"], _probe_cache["detail"]
        _probe_cache["in_flight"] = True
    try:
        ok, detail = probe_explorer()
    except Exception as exc:
        ok, detail = False, {"error": str(exc)}
    with _probe_lock:
        _probe_cache.update({
            "at": time.time(),
            "ok": ok,
            "detail": detail,
            "in_flight": False,
        })
    return ok, detail



# ── Rate limit: IP + Device-ID couple (single-node, no Redis) ─────────────
_rate_buckets = {}
_rate_lock = threading.Lock()
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{16,64}$")
def _client_ip():
    """
    Client IP for rate-limiting.
    - Works with Flask and the stdlib MiniApp shim (no remote_addr attribute).
    - X-Forwarded-For is only trusted when peer is in TRUSTED_PROXIES.
    """
    peer = getattr(request, "remote_addr", None) or "unknown"
    if peer in TRUSTED_PROXIES:
        fwd = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if fwd and re.fullmatch(r"[0-9a-fA-F\.:]{3,45}", fwd):
            return fwd
    return peer


def _client_device_id():
    """
    Opaque device identifier from the browser (localStorage → header).
    Missing / malformed → 'anon' (still rate-limited together with IP).
    """
    raw = (request.headers.get("X-Device-Id") or "").strip()
    if not raw or not _DEVICE_ID_RE.fullmatch(raw):
        return "anon"
    return raw


def _rate_key(action):
    """Rate-limit key: action + IP only (device ID is client-controlled)."""
    return f"{action}:{_client_ip()}"


def _owner_key(kind="inv"):
    """Stable resource owner id: device only (survives IP change & process restart).

    Rate-limits still use _rate_key (IP+device). Ownership of invoices/drops
    must not include IP or process memory — only the browser device id.
    """
    return f"{kind}:{_client_device_id()}"


def _rate_global(action, limit=100, window=60):
    """Shared bucket across all clients — bounds total damage under IP rotation."""
    return _rate_ok(f"global:{action}", limit=limit, window=window)


def _rate_ok(key, limit=10, window=60):

    """Thread-safe in-process token bucket."""
    now = time.time()
    with _rate_lock:
        count, reset = _rate_buckets.get(key, (0, now + window))
        if now > reset:
            count, reset = 0, now + window
        count += 1
        _rate_buckets[key] = (count, reset)
        if len(_rate_buckets) > 8000:
            dead = [k for k, (_, r) in _rate_buckets.items() if now > r]
            for k in dead[:2000]:
                _rate_buckets.pop(k, None)
        return count <= limit


def _safe_plan_id(raw):
    """Whitelist plan identifiers — never interpolate client strings into SQL."""
    pid = (raw or "").strip().lower()
    return pid if pid in TIERS else None


def _safe_int(raw, default=0, minimum=None, maximum=None):
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    if minimum is not None:
        n = max(minimum, n)
    if maximum is not None:
        n = min(maximum, n)
    return n


def _new_public_token():
    # ~144 bits URL-safe; not enumerable
    return secrets.token_urlsafe(18)


def _mailbox_by_token(db, token):
    """Resolve mailbox by opaque token. Returns row or None."""
    token = (token or "").strip()
    if not token or len(token) < 16 or len(token) > 64:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", token):
        return None
    return db.execute(
        "SELECT * FROM mailboxes WHERE public_token = ?", (token,)
    ).fetchone()


def fetch_transaction(tx_hash):
    """
    Fetch a transaction by id from the explorer.
    Returns (payload, explorer_base).
    """
    txid = _normalize_txid(tx_hash)
    data, base = _explorer_get("/api/transaction", {"txid": txid})
    return data, base


def _extract_outputs(tx_payload):
    """
    Normalize explorer transaction JSON into a list of
    {dst, coins, hours} dicts. Handles several historical shapes.
    """
    outputs = []
    # Shape A: { status, time, txn: { outputs: [...] } }
    txn = tx_payload.get("txn") or tx_payload.get("transaction") or {}
    if isinstance(txn, dict) and "txn" in txn:
        # rare double wrap
        txn = txn.get("txn") or txn
    raw_outs = (
        txn.get("outputs")
        or tx_payload.get("outputs")
        or []
    )
    for o in raw_outs:
        if not isinstance(o, dict):
            continue
        dst = o.get("dst") or o.get("address") or ""
        try:
            hours = int(float(o.get("hours") or 0))
        except (TypeError, ValueError):
            hours = 0
        try:
            coins = float(o.get("coins") or 0)
        except (TypeError, ValueError):
            coins = 0.0
        outputs.append({"dst": dst, "hours": hours, "coins": coins})
    return outputs


def _tx_confirmed(tx_payload):
    status = tx_payload.get("status") or {}
    if str(status.get("confirmed", "")).lower() in ("true", "1", "yes"):
        return True, int(status.get("height") or 0)
    # Some nodes only set unconfirmed=false
    if status.get("unconfirmed") is False and status.get("unknown") is not True:
        return True, int(status.get("height") or 0)
    return False, 0


def _tx_timestamp(tx_payload):
    if tx_payload.get("time"):
        try:
            return int(tx_payload["time"])
        except (TypeError, ValueError):
            pass
    txn = tx_payload.get("txn") or {}
    if txn.get("timestamp"):
        try:
            return int(txn["timestamp"])
        except (TypeError, ValueError):
            pass
    return None


def verify_nch_payment_on_chain(tx_hash, expected_address, min_hours, exact_amount=False):
    """
    Full on-chain verification against PrivateNess explorer.

    Returns dict:
      {
        ok, hours_received, confirmed, height, txid, explorer,
        outputs_matched
      }

    Raises:
      ExplorerUnavailable — network / all explorers down
      PaymentVerificationError — tx invalid for payment rules
    """
    if not _is_plausible_txid(tx_hash):
        raise PaymentVerificationError("Invalid transaction hash format")

    txid = _normalize_txid(tx_hash)
    payload, explorer_base = fetch_transaction(txid)

    # Normalize nested {transaction: {...}} used by some nodes
    if "transaction" in payload and "status" not in payload:
        inner = payload["transaction"]
        if isinstance(inner, dict) and "status" in inner:
            payload = inner

    confirmed, height = _tx_confirmed(payload)
    if not confirmed:
        raise PaymentVerificationError(
            "Transaction is not confirmed yet. Wait for a block, then retry.",
            http_status=402,
        )
    if PAYMENT_MIN_CONFIRMATIONS and height < PAYMENT_MIN_CONFIRMATIONS:
        raise PaymentVerificationError(
            f"Need at least {PAYMENT_MIN_CONFIRMATIONS} confirmations "
            f"(current height depth: {height}).",
            http_status=402,
        )

    ts = _tx_timestamp(payload)
    if ts is not None:
        age = int(time.time()) - ts
        if age > PAYMENT_TX_MAX_AGE_SEC:
            raise PaymentVerificationError(
                "Transaction is too old to be used for a new activation.",
                http_status=400,
            )
        if age < -300:
            # clock skew tolerance 5 min
            raise PaymentVerificationError(
                "Transaction timestamp is in the future.",
                http_status=400,
            )

    outputs = _extract_outputs(payload)
    if not outputs:
        raise PaymentVerificationError(
            "Transaction has no readable outputs.",
            http_status=400,
        )

    expected = (expected_address or "").strip()
    matched_hours = 0
    matched = []
    for o in outputs:
        if o["dst"] == expected:
            matched_hours += max(0, o["hours"])
            matched.append(o)

    if not matched:
        raise PaymentVerificationError(
            "No output pays the required PrivateNess payment address.",
            http_status=402,
        )

    if exact_amount:
        if int(matched_hours) != int(min_hours):
            raise PaymentVerificationError(
                f"Amount mismatch: got {matched_hours} NCH, need exactly {int(min_hours)}.",
                http_status=402,
            )
    elif matched_hours < int(min_hours):
        raise PaymentVerificationError(
            f"Insufficient NCH received: got {matched_hours}, need {int(min_hours)}.",
            http_status=402,
        )

    return {
        "ok": True,
        "txid": txid,
        "hours_received": matched_hours,
        "confirmed": True,
        "height": height,
        "explorer": explorer_base,
        "outputs_matched": matched,
        "timestamp": ts,
    }


def _generate_random_local(length=10):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=length))


def _validate_custom_local(local, mode):
    """Return (ok, error_message)."""
    if not local:
        return True, None
    local = local.lower().strip()
    if mode == "prefix":
        if not re.match(r"^[a-z0-9]{3,8}$", local):
            return False, "Prefix must be 3–8 alphanumeric characters"
    elif mode == "full":
        if not re.match(r"^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$", local) and not re.match(r"^[a-z0-9]{3,32}$", local):
            return False, "Local-part must be 3–32 chars (a-z, 0-9, ., _, -)"
    else:
        return False, "Custom address not allowed on this plan"
    return True, None


def _build_address(tier, custom_local=None):
    """
    Allocate a candidate address. Caller must INSERT and handle rare
    UNIQUE races (IntegrityError) by regenerating.
    """
    db = get_db()
    c = db.cursor()
    if custom_local and tier.get("custom_address"):
        ok, err = _validate_custom_local(custom_local, tier.get("custom_mode"))
        if not ok:
            return None, err
        base_local = custom_local.lower().strip()
        if tier.get("custom_mode") == "prefix":
            # prefix + random suffix — retry a few times if collision
            for _ in range(8):
                local = base_local + _generate_random_local(4)
                address = f"{local}@{DOMAIN}"
                if not c.execute(
                    "SELECT 1 FROM mailboxes WHERE address = ?", (address,)
                ).fetchone():
                    return address, None
            return None, "Address already taken"
        address = f"{base_local}@{DOMAIN}"
        if c.execute("SELECT 1 FROM mailboxes WHERE address = ?", (address,)).fetchone():
            return None, "Address already taken"
        return address, None
    # Random
    for _ in range(12):
        address = f"{_generate_random_local()}@{DOMAIN}"
        if not c.execute("SELECT 1 FROM mailboxes WHERE address = ?", (address,)).fetchone():
            return address, None
    return None, "Could not allocate address"


@app.route("/api/mailbox", methods=["POST"])
def create_mailbox():
    """Create a free mailbox (paid plans go through /api/payment/verify)."""
    if not _rate_ok(_rate_key("mb_create"), limit=8, window=60):
        return jsonify({
            "success": False,
            "error": "Too many mailbox requests. Slow down.",
        }), 429

    db = get_db()
    plan_id = _safe_plan_id(request.form.get("plan") or "free") or "free"
    if plan_id not in TIERS:
        return jsonify({"success": False, "error": "Unknown plan"}), 400

    tier = TIERS[plan_id]
    # Only free tier can be created without payment
    if tier["price_nch"] > 0:
        return jsonify({
            "success": False,
            "error": "This plan requires NCH payment. Use the payment flow.",
        }), 402

    custom_local = (request.form.get("custom_local") or "").strip() or None
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=tier["ttl_minutes"])

    address = None
    public_token = None
    last_err = "Could not allocate address"
    for _attempt in range(5):
        address, err = _build_address(tier, custom_local)
        if err:
            last_err = err
            # Full/custom taken is terminal; random/prefix may retry
            if "taken" in (err or "") and tier.get("custom_mode") == "full":
                return jsonify({"success": False, "error": err}), 400
            continue
        public_token = _new_public_token()
        try:
            db.execute(
                """INSERT INTO mailboxes
                   (public_token, address, plan, created_at, expires_at, max_messages)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    public_token,
                    address,
                    tier["id"],
                    now.isoformat(),
                    expires_at.isoformat(),
                    tier["max_messages"],
                ),
            )
            db.commit()
            break
        except sqlite3.IntegrityError:
            db.rollback()
            address = None
            public_token = None
            continue
    else:
        return jsonify({"success": False, "error": last_err}), 400

    return jsonify({
        "success": True,
        "token": public_token,
        "address": address,
        "plan": tier["id"],
        "plan_label": tier["label"],
        "badge_class": tier["badge_class"],
        "max_messages": tier["max_messages"],
        "expires_at": expires_at.isoformat(),
    })


@app.route("/api/mailbox/<token>", methods=["GET"])
def get_mailbox(token):
    """Return mailbox state for session restore after page reload (opaque token)."""
    db = get_db()
    mb = _mailbox_by_token(db, token)
    if not mb:
        return jsonify({"success": False, "error": "Mailbox not found"}), 404
    if mb["expires_at"] < datetime.now(timezone.utc).isoformat():
        return jsonify({"success": False, "error": "Mailbox expired"}), 410

    plan_id = mb["plan"]
    tier = TIERS.get(plan_id, TIERS["free"])
    return jsonify({
        "success": True,
        "token": mb["public_token"],
        "address": mb["address"],
        "plan": plan_id,
        "plan_label": tier["label"],
        "badge_class": tier["badge_class"],
        "max_messages": mb["max_messages"],
        "expires_at": mb["expires_at"],
        "created_at": mb["created_at"],
    })


def _attachment_meta(attachments_json):
    """Return attachment list without base64 payloads (for list views)."""
    try:
        items = json.loads(attachments_json or "[]")
    except Exception:
        items = []
    out = []
    for a in items:
        out.append({
            "filename": a.get("filename") or "file",
            "content_type": a.get("content_type") or "application/octet-stream",
            "size": int(a.get("size") or 0),
        })
    return out


@app.route("/api/messages/<token>", methods=["GET"])
def get_messages(token):
    """Paginated inbox list. Query: page (1-based), per_page (default 8, max 25)."""
    db = get_db()
    mb = _mailbox_by_token(db, token)
    if not mb:
        return jsonify({"success": False, "error": "Mailbox not found"}), 404
    if mb["expires_at"] < datetime.now(timezone.utc).isoformat():
        return jsonify({"success": False, "error": "Mailbox expired"}), 410

    mailbox_id = mb["id"]
    page = _safe_int(request.args.get("page"), default=1, minimum=1, maximum=10_000)
    per_page = _safe_int(request.args.get("per_page"), default=8, minimum=1, maximum=25)

    total = db.execute(
        "SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?",
        (mailbox_id,),
    ).fetchone()["c"]
    offset = (page - 1) * per_page

    rows = db.execute(
        """SELECT id, sender, recipient, subject, body, attachments_json, received_at
           FROM messages WHERE mailbox_id = ?
           ORDER BY received_at DESC
           LIMIT ? OFFSET ?""",
        (mailbox_id, per_page, offset),
    ).fetchall()

    messages = []
    for r in rows:
        atts = _attachment_meta(r["attachments_json"])
        preview = (r["body"] or "").strip().replace("\n", " ")
        if len(preview) > 160:
            preview = preview[:160] + "…"
        messages.append({
            "id": r["id"],
            "sender": r["sender"],
            "recipient": r["recipient"],
            "subject": r["subject"] or "(no subject)",
            "preview": preview,
            "received_at": r["received_at"],
            "attachment_count": len(atts),
            "attachments": atts,
        })

    total_pages = max(1, (total + per_page - 1) // per_page)
    return jsonify({
        "success": True,
        "messages": messages,
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "total_pages": total_pages,
            "has_prev": page > 1,
            "has_next": page < total_pages,
        },
    })


@app.route("/api/messages/<token>/<int:message_id>", methods=["GET"])
def get_message_detail(token, message_id):
    """Full message body + attachments (with downloadable base64)."""
    db = get_db()
    mb = _mailbox_by_token(db, token)
    if not mb:
        return jsonify({"success": False, "error": "Mailbox not found"}), 404
    if mb["expires_at"] < datetime.now(timezone.utc).isoformat():
        return jsonify({"success": False, "error": "Mailbox expired"}), 410

    row = db.execute(
        """SELECT id, sender, recipient, subject, body, body_html,
                  attachments_json, received_at
           FROM messages
           WHERE id = ? AND mailbox_id = ?""",
        (message_id, mb["id"]),
    ).fetchone()
    if not row:
        return jsonify({"success": False, "error": "Message not found"}), 404

    try:
        attachments = json.loads(row["attachments_json"] or "[]")
    except Exception:
        attachments = []

    return jsonify({
        "success": True,
        "message": {
            "id": row["id"],
            "sender": row["sender"],
            "recipient": row["recipient"],
            "subject": row["subject"] or "(no subject)",
            "body": row["body"] or "",
            "body_html": row["body_html"] or "",
            "received_at": row["received_at"],
            "attachments": attachments,
        },
    })


def _explorer_unavailable_payload(exc_or_detail):
    """Build a consistent API body for explorer/connectivity failures."""
    if isinstance(exc_or_detail, ExplorerUnavailable):
        kind = getattr(exc_or_detail, "kind", "explorer_down")
        detail = str(exc_or_detail)
    elif isinstance(exc_or_detail, dict):
        kind = exc_or_detail.get("connectivity") or "explorer_down"
        detail = exc_or_detail.get("error")
    else:
        kind = "explorer_down"
        detail = str(exc_or_detail) if exc_or_detail else None
    if kind == "offline":
        error = "No internet connection — verify your network and try again"
    else:
        error = "PrivateNess explorer is down"
    return {
        "success": False,
        "explorer_ok": False,
        "connectivity": kind,
        "error": error,
        "detail": detail,
    }


@app.route("/api/payment/explorer", methods=["GET"])
def payment_explorer_status():
    """Public probe so the UI can warn on offline vs explorer-down."""
    ok, detail = probe_explorer_cached()
    if ok:
        return jsonify({"success": True, "explorer_ok": True, **detail})
    body = _explorer_unavailable_payload(detail)
    return jsonify(body), 503



@app.route("/api/payment/intent", methods=["POST"])
def create_payment_intent():
    """Create a short-lived payment intent (anti front-running via secret intent_id)."""
    if not _rate_global("pay_intent", limit=120, window=60):
        return jsonify({"success": False, "error": "Service busy, try again later"}), 503
    if not _rate_ok(_rate_key("pay_intent"), limit=20, window=60):
        return jsonify({"success": False, "error": "Too many attempts"}), 429

    body = {}
    try:
        if getattr(request, "is_json", False):
            body = request.get_json(silent=True) or {}
    except Exception:
        body = {}
    product = (request.form.get("product") or body.get("product") or "mail").strip().lower()
    if product not in ("mail", "burn", "storage", "wormhole", "ssh"):
        return jsonify({"success": False, "error": "Invalid product"}), 400
    plan_id = (request.form.get("plan") or body.get("plan") or "").strip().lower()

    if product == "mail":
        from config import TIERS as _T
        if plan_id not in _T or int(_T[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Invalid paid plan"}), 400
        base = int(_T[plan_id]["price_nch"])
    elif product == "burn":
        from config import BURN_TIERS as _T
        if plan_id not in _T or int(_T[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Invalid paid plan"}), 400
        base = int(_T[plan_id]["price_nch"])
    elif product == "storage":
        from config import STORAGE_TIERS as _T
        if plan_id not in _T or int(_T[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Invalid paid plan"}), 400
        base = int(_T[plan_id]["price_nch"])
    elif product == "wormhole":
        # Prefer dedicated /api/wormhole/intent. Shared endpoint accepts tool as plan.
        from config import WORMHOLE_TOOLS as _W
        tool = (plan_id or "").strip().lower()
        if tool not in _W or int(_W[tool]["price_nch"]) <= 0:
            return jsonify({
                "success": False,
                "error": "Invalid wormhole tool — use plan=dpo or plan=offline",
            }), 400
        base = int(_W[tool]["price_nch"])
        plan_id = f"wormhole:{tool}"
    else:
        return jsonify({"success": False, "error": "Invalid product"}), 400

    # Catalog amount. Anti front-running is the secret intent_id (not shown in UI).
    # Overpayment is accepted at verify (hours_received >= amount_nch).
    amount = base
    intent_id = secrets.token_urlsafe(18)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=15)
    db = get_db()
    db.execute(
        """INSERT INTO payment_intents
           (intent_id, plan, amount_nch, pay_address, status, created_at, expires_at, product)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)""",
        (intent_id, plan_id, amount, NCH_PAYMENT_ADDRESS, now.isoformat(), expires.isoformat(), product),
    )
    try:
        db.commit()
    except Exception:
        pass
    return jsonify({
        "success": True,
        "intent_id": intent_id,
        "amount_nch": amount,
        "pay_address": NCH_PAYMENT_ADDRESS,
        "expires_at": expires.isoformat(),
        "plan": plan_id,
        "product": product,
    })



@app.route("/api/mailbox/renew", methods=["POST"])
def api_mailbox_renew():
    """Extend mailbox TTL: remaining time + full plan TTL (requires payment intent + tx)."""
    if not _rate_ok(_rate_key("mail_renew"), limit=10, window=60):
        return jsonify({"success": False, "error": "Too many attempts"}), 429
    token = (request.form.get("token") or "").strip()
    plan_id = _safe_plan_id(request.form.get("plan"))
    intent_id = (request.form.get("intent_id") or "").strip()
    tx_hash = _normalize_txid(request.form.get("tx_hash") or "")
    if not token or not plan_id or not intent_id or not _is_plausible_txid(tx_hash):
        return jsonify({"success": False, "error": "Invalid renew request"}), 400
    if TIERS[plan_id]["price_nch"] <= 0:
        return jsonify({"success": False, "error": "Renew requires a paid plan"}), 400
    db = get_db()
    mb = _mailbox_by_token(db, token)
    if not mb:
        return jsonify({"success": False, "error": "Mailbox not found"}), 404
    intent = db.execute(
        "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'mail'",
        (intent_id,),
    ).fetchone()
    if not intent or (intent["plan"] or "") != plan_id:
        return jsonify({"success": False, "error": "Invalid payment intent"}), 404
    required_nch = int(intent["amount_nch"])
    if _tx_already_used(db, tx_hash):
        return jsonify({"success": False, "error": "Transaction already used"}), 409
    try:
        chain = verify_nch_payment_on_chain(
            tx_hash, expected_address=NCH_PAYMENT_ADDRESS,
            min_hours=required_nch, exact_amount=False,
        )
    except ExplorerUnavailable as e:
        return jsonify(_explorer_unavailable_payload(e)), 503
    except PaymentVerificationError as e:
        return jsonify({"success": False, "error": str(e), "explorer_ok": True}), getattr(e, "http_status", 400)
    if not _claim_tx(db, tx_hash, "mail", amount_nch=required_nch):
        return jsonify({"success": False, "error": "Transaction already used"}), 409
    now = datetime.now(timezone.utc)
    try:
        exp = datetime.fromisoformat(str(mb["expires_at"]).replace("Z", "+00:00"))
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
    except Exception:
        exp = now
    remaining = max(0, (exp - now).total_seconds())
    new_exp = now + timedelta(seconds=remaining) + timedelta(minutes=int(TIERS[plan_id]["ttl_minutes"]))
    db.execute(
        "UPDATE mailboxes SET expires_at = ?, plan = ? WHERE public_token = ?",
        (new_exp.isoformat(), plan_id, token),
    )
    try:
        db.execute(
            "UPDATE payment_intents SET status='paid', tx_hash=?, verified_at=? WHERE intent_id=?",
            (tx_hash, now.isoformat(), intent_id),
        )
        db.commit()
    except Exception:
        pass
    return jsonify({
        "success": True,
        "expires_at": new_exp.isoformat(),
        "plan": plan_id,
        "hours_received": chain.get("hours_received"),
    })


@app.route("/api/payment/verify", methods=["POST"])
def verify_payment():
    """
    On-chain NCH payment verification + plan activation.

    Security model:
      • Never trust the client amount — price comes from TIERS[plan].
      • Resolve tx via PrivateNess explorer (no simulation on failure).
      • Require confirmed tx, correct destination address, sufficient hours (NCH).
      • Enforce unique transaction_hash (anti-replay).
      • Reject oversized / malformed txids early.
    """
    plan_id = _safe_plan_id(request.form.get("plan"))
    if not plan_id or TIERS[plan_id]["price_nch"] <= 0:
        return jsonify({"success": False, "error": "Invalid paid plan"}), 400

    tier = TIERS[plan_id]
    required_nch = int(tier["price_nch"])
    tx_hash = _normalize_txid(request.form.get("tx_hash") or "")
    intent_id = (request.form.get("intent_id") or "").strip()

    # Opaque token only — never accept sequential numeric mailbox ids from clients
    client_token = (request.form.get("token") or "").strip() or None
    custom_local = (request.form.get("custom_local") or "").strip() or None

    if not _is_plausible_txid(tx_hash):
        return jsonify({"success": False, "error": "Invalid transaction hash"}), 400

    if not intent_id:
        return jsonify({
            "success": False,
            "error": "Missing payment intent. Re-open the payment dialog and try again.",
        }), 400

    if not _rate_global("pay_verify", limit=120, window=60):
        return jsonify({"success": False, "error": "Service busy, try again later"}), 503
    if not _rate_ok(_rate_key("pay_verify"), limit=12, window=60):
        return jsonify({"success": False, "error": "Too many verification attempts"}), 429

    db = get_db()

    intent = db.execute(
        "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'mail'",
        (intent_id,),
    ).fetchone()
    if not intent:
        return jsonify({"success": False, "error": "Payment intent not found or already used"}), 404
    try:
        if intent["expires_at"] < datetime.now(timezone.utc).isoformat():
            return jsonify({"success": False, "error": "Payment intent expired — open payment again"}), 410
    except Exception:
        pass
    if (intent["plan"] or "") != plan_id:
        return jsonify({"success": False, "error": "Plan mismatch with payment intent"}), 400
    required_nch = int(intent["amount_nch"])


    # Anti-replay cross-product (mail + burn + invoice)
    if _tx_already_used(db, tx_hash):
        return jsonify({"success": False, "error": "Transaction already used"}), 409

    # Pre-validate address allocation BEFORE on-chain verification so a doomed
    # request never leaves the user charged with no mailbox.
    if not client_token and custom_local:
        ok, err = _validate_custom_local(custom_local, tier.get("custom_mode"))
        if not ok:
            return jsonify({"success": False, "error": err}), 400
        if tier.get("custom_mode") == "full":
            candidate = f"{custom_local.lower().strip()}@{DOMAIN}"
            if db.execute(
                "SELECT 1 FROM mailboxes WHERE address = ?", (candidate,)
            ).fetchone():
                return jsonify({"success": False, "error": "Address already taken"}), 409

    # ── On-chain verification (no simulation) ─────────────────────────────
    try:
        chain = verify_nch_payment_on_chain(
            tx_hash,
            expected_address=NCH_PAYMENT_ADDRESS,
            min_hours=required_nch,
            exact_amount=False,
        )
    except ExplorerUnavailable as e:
        return jsonify(_explorer_unavailable_payload(e)), 503
    except PaymentVerificationError as e:
        return jsonify({
            "success": False,
            "error": str(e),
            "explorer_ok": True,
        }), e.http_status

    hours_received = int(chain["hours_received"])
    now = datetime.now(timezone.utc)
    if not _claim_tx(db, tx_hash, "mail", amount_nch=hours_received):
        return jsonify({"success": False, "error": "Transaction already used"}), 409
    try:
        db.execute(
            "UPDATE payment_intents SET status = 'paid', tx_hash = ?, verified_at = ? WHERE intent_id = ?",
            (tx_hash, datetime.now(timezone.utc).isoformat(), intent_id),
        )
    except Exception:
        pass

    new_expires = now + timedelta(minutes=tier["ttl_minutes"])
    address = None
    public_token = None
    mailbox_id = None

    if client_token:
        mb = _mailbox_by_token(db, client_token)
        if not mb:
            # Paid on-chain but upgrade target missing — critical ops state
            print(
                f"[PAY] CRITICAL: tx {chain['txid']} verified but mailbox "
                f"token not found for upgrade"
            )
            return jsonify({
                "success": False,
                "error": "Payment verified on-chain but mailbox was not found. "
                         "Contact support with your tx hash.",
                "txid": chain["txid"],
                "explorer": chain["explorer"],
            }), 500
        mailbox_id = mb["id"]
        address = mb["address"]
        public_token = mb["public_token"]
        current_tier = TIERS.get(mb["plan"], TIERS["free"])
        if tier["price_nch"] < current_tier["price_nch"]:
            return jsonify({
                "success": False,
                "error": "Cannot downgrade an active mailbox. "
                         "Let it expire or contact support.",
            }), 400
        db.execute(
            """UPDATE mailboxes
               SET plan = ?, expires_at = ?, max_messages = ?
               WHERE id = ?""",
            (tier["id"], new_expires.isoformat(), tier["max_messages"], mailbox_id),
        )
    else:
        # Race window between pre-check and INSERT — retry like create_mailbox
        for _attempt in range(5):
            address, err = _build_address(tier, custom_local)
            if err:
                print(
                    f"[PAY] CRITICAL: tx {chain['txid']} verified but "
                    f"no mailbox: {err}"
                )
                return jsonify({
                    "success": False,
                    "error": "Payment verified on-chain but address allocation "
                             "failed. Contact support with your tx hash.",
                    "txid": chain["txid"],
                    "explorer": chain["explorer"],
                }), 500

            public_token = _new_public_token()
            try:
                db.execute(
                    """INSERT INTO mailboxes
                       (public_token, address, plan, created_at, expires_at, max_messages)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        public_token,
                        address,
                        tier["id"],
                        now.isoformat(),
                        new_expires.isoformat(),
                        tier["max_messages"],
                    ),
                )
                mailbox_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
                break
            except sqlite3.IntegrityError:
                db.rollback()
                address = None
                public_token = None
                continue
        else:
            print(
                f"[PAY] CRITICAL: tx {chain['txid']} verified but "
                f"address allocation retries exhausted"
            )
            return jsonify({
                "success": False,
                "error": "Payment verified on-chain but address allocation failed. "
                         "Contact support with your tx hash.",
                "txid": chain["txid"],
                "explorer": chain["explorer"],
            }), 500

    try:
        db.execute(
            """INSERT INTO subscriptions
               (mailbox_id, plan, transaction_hash, amount_nch, activated_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                mailbox_id,
                tier["id"],
                chain["txid"],
                hours_received,
                now.isoformat(),
                new_expires.isoformat(),
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        return jsonify({"success": False, "error": "Transaction already used"}), 409

    return jsonify({
        "success": True,
        "message": "Payment verified on-chain. Plan activated.",
        "token": public_token,
        "address": address,
        "plan": tier["id"],
        "plan_label": tier["label"],
        "badge_class": tier["badge_class"],
        "max_messages": tier["max_messages"],
        "expires_at": new_expires.isoformat(),
        "hours_received": hours_received,
        "txid": chain["txid"],
        "explorer": chain["explorer"],
        "confirmations_height": chain["height"],
    })


# ==========================================================================
# 7. SUITE PRODUCTS
# ==========================================================================

burn_product.register(app, {
    "get_db": get_db,
    "jsonify": jsonify,
    "request": request,
    "HAS_FLASK": HAS_FLASK,
    "render_template": render_template if HAS_FLASK else None,
    "_rate_ok": _rate_ok,
    "_rate_key": _rate_key,
    "_client_ip": _client_ip,
    "_tx_already_used": _tx_already_used,
    "_claim_tx": _claim_tx,
    "_rate_global": _rate_global,
    "verify_nch_payment_on_chain": verify_nch_payment_on_chain,
    "ExplorerUnavailable": ExplorerUnavailable,
    "PaymentVerificationError": PaymentVerificationError,
    "_normalize_txid": _normalize_txid,
    "_is_plausible_txid": _is_plausible_txid,
    "probe_explorer_cached": probe_explorer_cached,
    "_explorer_unavailable_payload": _explorer_unavailable_payload,
    "Path": Path,
    "json": json,
})

invoice_product.register(app, {
    "get_db": get_db,
    "jsonify": jsonify,
    "request": request,
    "HAS_FLASK": HAS_FLASK,
    "render_template": render_template if HAS_FLASK else None,
    "_rate_ok": _rate_ok,
    "_rate_key": _rate_key,
    "_tx_already_used": _tx_already_used,
    "_claim_tx": _claim_tx,
    "_rate_global": _rate_global,
    "_owner_key": _owner_key,
    "verify_nch_payment_on_chain": verify_nch_payment_on_chain,
    "ExplorerUnavailable": ExplorerUnavailable,
    "PaymentVerificationError": PaymentVerificationError,
    "_normalize_txid": _normalize_txid,
    "_is_plausible_txid": _is_plausible_txid,
    "probe_explorer_cached": probe_explorer_cached,
    "_explorer_unavailable_payload": _explorer_unavailable_payload,
    "Path": Path,
    "json": json,
})

storage_product.register(app, {
    "get_db": get_db,
    "jsonify": jsonify,
    "request": request,
    "HAS_FLASK": HAS_FLASK,
    "render_template": render_template if HAS_FLASK else None,
    "_rate_ok": _rate_ok,
    "_rate_key": _rate_key,
    "_rate_global": _rate_global,
    "_client_ip": _client_ip,
    "_client_device_id": _client_device_id,
    "_claim_tx": _claim_tx,
    "_tx_already_used": _tx_already_used,
    "verify_nch_payment_on_chain": verify_nch_payment_on_chain,
    "ExplorerUnavailable": ExplorerUnavailable,
    "PaymentVerificationError": PaymentVerificationError,
    "_normalize_txid": _normalize_txid,
    "_is_plausible_txid": _is_plausible_txid,
    "probe_explorer_cached": probe_explorer_cached,
    "_explorer_unavailable_payload": _explorer_unavailable_payload,
})

wormhole_product.register(app, {
    "get_db": get_db,
    "jsonify": jsonify,
    "request": request,
    "HAS_FLASK": HAS_FLASK,
    "render_template": render_template if HAS_FLASK else None,
    "_rate_ok": _rate_ok,
    "_rate_key": _rate_key,
    "_rate_global": _rate_global,
    "_client_device_id": _client_device_id,
    "_claim_tx": _claim_tx,
    "_tx_already_used": _tx_already_used,
    "verify_nch_payment_on_chain": verify_nch_payment_on_chain,
    "ExplorerUnavailable": ExplorerUnavailable,
    "PaymentVerificationError": PaymentVerificationError,
    "_normalize_txid": _normalize_txid,
    "_is_plausible_txid": _is_plausible_txid,
    "_explorer_unavailable_payload": _explorer_unavailable_payload,
})

ssh_product.register(app, {
    "get_db": get_db,
    "jsonify": jsonify,
    "request": request,
    "HAS_FLASK": HAS_FLASK,
    "render_template": render_template if HAS_FLASK else None,
    "_rate_ok": _rate_ok,
    "_rate_key": _rate_key,
    "_rate_global": _rate_global,
    "_client_device_id": _client_device_id,
    "_owner_key": _owner_key,
    "_claim_tx": _claim_tx,
    "_tx_already_used": _tx_already_used,
    "verify_nch_payment_on_chain": verify_nch_payment_on_chain,
    "ExplorerUnavailable": ExplorerUnavailable,
    "PaymentVerificationError": PaymentVerificationError,
    "_normalize_txid": _normalize_txid,
    "_is_plausible_txid": _is_plausible_txid,
    "_explorer_unavailable_payload": _explorer_unavailable_payload,
})







# ==========================================================================
# 8. ENTRY POINT
# ==========================================================================

if __name__ == "__main__":
    init_db()
    try:
        burn_product._init_burn_schema()
    except Exception as exc:
        print(f"[BURN] schema init: {exc}")
    try:
        invoice_product._init_invoice_schema()
    except Exception as exc:
        print(f"[INVOICE] schema init: {exc}")
    if HAS_AIOSMTPD:
        threading.Thread(target=start_smtp_server, daemon=True).start()
    else:
        print("[SMTP] aiosmtpd missing -> reception disabled, UI still fully operational.")
    threading.Thread(target=cleanup_expired, daemon=True).start()

    print("=" * 60)
    print("  NESS Suite")
    print("=" * 60)
    print(f"  Domain           : {DOMAIN}")
    print(f"  Database         : {DB_PATH}")
    try:
        _c = _open_db()
        inv_u = _c.execute("SELECT COUNT(*) FROM invoices WHERE status='unpaid'").fetchone()[0]
        br_a = _c.execute("SELECT COUNT(*) FROM burn_drops WHERE status='active'").fetchone()[0]
        mb = _c.execute("SELECT COUNT(*) FROM mailboxes").fetchone()[0]
        _c.close()
        print(f"  Persisted        : mailboxes={mb}  unpaid_invoices={inv_u}  active_burns={br_a}")
    except Exception as _exc:
        print(f"  Persisted        : (counts unavailable: {_exc})")
    print(f"  Payment address  : {NCH_PAYMENT_ADDRESS}")
    print(f"  Explorer         : {NESS_EXPLORER_URLS[0]}")
    print(f"  HTTP             : http://{HTTP_HOST}:{HTTP_PORT}")
    print(f"  SMTP             : {'enabled' if HAS_AIOSMTPD else 'disabled'}")
    print(f"  Flask            : {'yes' if HAS_FLASK else 'stdlib fallback'}")
    print("  Plans:")
    for pid, t in TIERS.items():
        print(f"    · {t['label']:10s}  {t['ttl_minutes']:>6d} min  "
              f"{t['max_messages']:>4d} msg  {t['price_nch']:>6.0f} NCH")
    print("=" * 60)

    # Non-blocking explorer probe — fills cache without delaying HTTP bind
    def _bg_probe():
        ok, detail = probe_explorer()
        with _probe_lock:
            _probe_cache["at"] = time.time()
            _probe_cache["ok"] = ok
            _probe_cache["detail"] = detail
        print(f"  Explorer status  : {'OK' if ok else 'DOWN'} {detail}")

    threading.Thread(target=_bg_probe, daemon=True).start()

    # Production default: debug off. Dev: FLASK_DEBUG=1 python app.py
    # No payment bypass — verify against real PrivateNess chain (NCH).
    _debug = os.environ.get("FLASK_DEBUG") == "1"
    app.run(
        host=HTTP_HOST,
        port=HTTP_PORT,
        debug=_debug,
        use_reloader=False,
    )
