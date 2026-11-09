"""
NESS SSH Access (EmerSSH bridge) — manage public keys + Emercoin NVS.

Never stores private keys. Publishes/revokes public keys via Emercoin JSON-RPC
when EMERCOIN_RPC_URL is configured. Otherwise keys stay local (pending) with
an explicit UI status.

Routes:
  GET    /ssh-access
  GET    /api/ssh/status
  GET    /api/ssh/keys
  POST   /api/ssh/keys
  POST   /api/ssh/keys/<id>/activate
  DELETE /api/ssh/keys/<id>
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from config import (
    BASE_DIR,
    DB_PATH,
    EMERCOIN_NVS_DAYS,
    EMERCOIN_RPC_PASS,
    EMERCOIN_RPC_URL,
    EMERCOIN_RPC_USER,
    SSH_MAX_KEYS_PER_DEVICE,
)

try:
    from config import SSH_ALLOW_LOCAL_ACTIVATE
except ImportError:
    SSH_ALLOW_LOCAL_ACTIVATE = False


# ssh-ed25519|rsa|ecdsa + base64 payload + optional comment
_PUBKEY_RE = re.compile(
    r"^(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521))\s+"
    r"([A-Za-z0-9+/=]+)(?:\s+(\S.*))?$"
)
_USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

_deps: dict = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _rpc_settings():
    """Read RPC settings from process env each call (dotenv / ops hot update)."""
    import os
    url = (os.environ.get("EMERCOIN_RPC_URL") or EMERCOIN_RPC_URL or "").strip()
    user = (os.environ.get("EMERCOIN_RPC_USER") if os.environ.get("EMERCOIN_RPC_USER") is not None else EMERCOIN_RPC_USER) or ""
    password = (os.environ.get("EMERCOIN_RPC_PASS") if os.environ.get("EMERCOIN_RPC_PASS") is not None else EMERCOIN_RPC_PASS) or ""
    return url.strip(), str(user), str(password)


def rpc_configured() -> bool:
    url, user, _password = _rpc_settings()
    return bool(url)


def emercoin_rpc(method: str, params=None):
    """JSON-RPC 1.0 call to Emercoin node. Raises RuntimeError on failure."""
    url, user, password = _rpc_settings()
    if not url:
        raise RuntimeError("Authorization service unavailable")
    payload = json.dumps({
        "jsonrpc": "1.0",
        "id": "ness-ssh",
        "method": method,
        "params": params or [],
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            err_body = str(exc)
        raise RuntimeError(f"RPC HTTP {exc.code}: {err_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"RPC unreachable: {exc.reason}") from exc
    except Exception as exc:
        raise RuntimeError(f"RPC failure: {exc}") from exc
    if body.get("error"):
        raise RuntimeError(f"RPC error: {body['error']}")
    return body.get("result")


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ssh_keys (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_key     TEXT NOT NULL,
            username        TEXT NOT NULL,
            public_key      TEXT NOT NULL,
            fingerprint     TEXT NOT NULL,
            key_type        TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL DEFAULT 'pending',
            nvs_name        TEXT,
            created_at      TEXT NOT NULL,
            activated_at    TEXT,
            revoked_at      TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssh_fp ON ssh_keys(fingerprint)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssh_creator ON ssh_keys(creator_key)"
    )
    conn.commit()


def _fingerprint(pubkey_b64: str) -> str:
    """OpenSSH-style SHA256 fingerprint (unpadded base64)."""
    raw = base64.b64decode(pubkey_b64.encode("ascii"))
    dig = hashlib.sha256(raw).digest()
    return "SHA256:" + base64.b64encode(dig).decode("ascii").rstrip("=")


def _parse_pubkey(raw: str):
    line = (raw or "").strip()
    # Allow single-line only; reject multi-line blobs
    if "\n" in line or "\r" in line:
        line = line.splitlines()[0].strip()
    m = _PUBKEY_RE.match(line)
    if not m:
        return None
    ktype, b64, comment = m.group(1), m.group(2), (m.group(3) or "").strip()
    try:
        base64.b64decode(b64.encode("ascii"), validate=False)
    except Exception:
        return None
    # Normalize stored form
    normalized = f"{ktype} {b64}" + (f" {comment}" if comment else "")
    return {
        "type": ktype,
        "b64": b64,
        "comment": comment,
        "normalized": normalized,
        "fingerprint": _fingerprint(b64),
    }


def _row_public(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "public_key": row["public_key"],
        "fingerprint": row["fingerprint"],
        "key_type": row["key_type"],
        "status": row["status"],
        "nvs_name": row["nvs_name"],
        "created_at": row["created_at"],
        "activated_at": row["activated_at"],
        "revoked_at": row["revoked_at"],
    }


def _nvs_name_for(username: str) -> str:
    tok = secrets.token_hex(6)
    return f"ssh:ness:{username}:{tok}"


def register(app, deps: dict):
    global _deps
    _deps = deps
    get_db = deps["get_db"]
    jsonify = deps["jsonify"]
    request = deps["request"]
    HAS_FLASK = deps["HAS_FLASK"]
    render_template = deps.get("render_template")
    rate_ok = deps["_rate_ok"]
    rate_key = deps["_rate_key"]
    rate_global = deps.get("_rate_global")
    client_device_id = deps.get("_client_device_id")
    owner_key = deps.get("_owner_key")

    def _device():
        if client_device_id:
            return client_device_id()
        return "anon"

    def _owner():
        """Return stable owner id, or 'anon' if device is missing/invalid.

        _owner_key('ssh') yields 'ssh:<device>'. Treat any '*anon' as anonymous
        so we never share a single creator_key across strangers.
        """
        d = _device()
        if not d or d == "anon":
            return "anon"
        if owner_key:
            try:
                return owner_key("ssh")
            except Exception:
                return f"ssh:{d}"
        return f"ssh:{d}"

    # Schema on register
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        ensure_schema(conn)
        conn.close()
    except Exception as exc:
        print(f"[SSH] schema init: {exc}")

    def _page():
        if HAS_FLASK and render_template:
            try:
                from app import build_og_meta
                meta = build_og_meta("ssh", path="/ssh-access")
            except Exception:
                meta = {}
            return render_template(
                "ssh.html",
                rpc_configured=rpc_configured(),
                **meta,
            )
        html = (BASE_DIR / "templates" / "ssh.html").read_text(encoding="utf-8")
        return html

    @app.route("/ssh-access")
    def ssh_index():
        return _page()

    @app.route("/api/ssh/status", methods=["GET"])
    def api_ssh_status():
        return jsonify({
            "success": True,
            "product": "ssh",
            "rpc_configured": rpc_configured(),
            "nvs_days": int(EMERCOIN_NVS_DAYS or 365),
            "max_keys": int(SSH_MAX_KEYS_PER_DEVICE or 20),
        })

    @app.route("/api/ssh/keys", methods=["GET"])
    def api_ssh_list():
        if rate_global and not rate_global("ssh_list", limit=120, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_list"), limit=30, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({"success": True, "items": [], "anon": True})
        db = get_db()
        rows = db.execute(
            """SELECT * FROM ssh_keys
               WHERE creator_key = ? AND status != 'revoked'
               ORDER BY id DESC LIMIT 50""",
            (owner,),
        ).fetchall()
        return jsonify({
            "success": True,
            "items": [_row_public(r) for r in rows],
            "rpc_configured": rpc_configured(),
        })

    @app.route("/api/ssh/keys", methods=["POST"])
    def api_ssh_add():
        if rate_global and not rate_global("ssh_add", limit=60, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_add"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({
                "success": False,
                "error": "Device identity required. Enable storage in this browser.",
            }), 403

        if HAS_FLASK:
            from flask import request as fr
            body = fr.get_json(silent=True) or {}
            username = (body.get("username") or fr.form.get("username") or "").strip().lower()
            public_key = (body.get("public_key") or fr.form.get("public_key") or "").strip()
        else:
            username = (request.form.get("username") or "").strip().lower()
            public_key = (request.form.get("public_key") or "").strip()

        if len(public_key) > 8192:
            return jsonify({"success": False, "error": "Public key too large"}), 400

        if not _USERNAME_RE.match(username):
            return jsonify({
                "success": False,
                "error": "Username must be 1–32 chars: start with a-z, then a-z0-9_-",
            }), 400
        parsed = _parse_pubkey(public_key)
        if not parsed:
            return jsonify({
                "success": False,
                "error": "Invalid public key. Use a single-line ssh-ed25519 or ssh-rsa key.",
            }), 400

        db = get_db()
        n = db.execute(
            "SELECT COUNT(*) AS c FROM ssh_keys WHERE creator_key = ? AND status != 'revoked'",
            (owner,),
        ).fetchone()["c"]
        if int(n) >= int(SSH_MAX_KEYS_PER_DEVICE or 20):
            return jsonify({"success": False, "error": "Key limit reached for this device"}), 400

        # Unique fingerprint among non-revoked
        taken = db.execute(
            "SELECT id FROM ssh_keys WHERE fingerprint = ? AND status != 'revoked'",
            (parsed["fingerprint"],),
        ).fetchone()
        if taken:
            return jsonify({"success": False, "error": "This public key is already registered"}), 409

        now = _utc_now()
        cur = db.execute(
            """INSERT INTO ssh_keys
               (creator_key, username, public_key, fingerprint, key_type, status, created_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
            (
                owner,
                username,
                parsed["normalized"],
                parsed["fingerprint"],
                parsed["type"],
                now,
            ),
        )
        db.commit()
        row = db.execute("SELECT * FROM ssh_keys WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify({"success": True, "key": _row_public(row)}), 201

    @app.route("/api/ssh/keys/<int:kid>/activate", methods=["POST"])
    def api_ssh_activate(kid):
        if rate_global and not rate_global("ssh_act", limit=40, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_act"), limit=8, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({"success": False, "error": "Device identity required"}), 403

        db = get_db()
        row = db.execute(
            "SELECT * FROM ssh_keys WHERE id = ? AND creator_key = ?",
            (kid, owner),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Key not found"}), 404
        if row["status"] == "active":
            return jsonify({"success": True, "key": _row_public(row), "already": True})
        if row["status"] == "revoked":
            return jsonify({"success": False, "error": "Key is revoked"}), 410

        if not rpc_configured():
            # Default: refuse fake "active" without chain. Opt-in for lab only.
            if not SSH_ALLOW_LOCAL_ACTIVATE:
                return jsonify({
                    "success": False,
                    "error": "Activation is temporarily unavailable. Your key is saved — try Activate again later.",
                }), 503
            now = _utc_now()
            nvs = row["nvs_name"] or _nvs_name_for(row["username"])
            db.execute(
                """UPDATE ssh_keys
                   SET status = 'active', nvs_name = ?, activated_at = ?
                   WHERE id = ?""",
                (nvs, now, kid),
            )
            db.commit()
            row = db.execute("SELECT * FROM ssh_keys WHERE id = ?", (kid,)).fetchone()
            return jsonify({
                "success": True,
                "key": _row_public(row),
                "local_only": True,
                "warning": "Lab mode: active in NESS only — not published to Emercoin NVS.",
            })

        nvs = row["nvs_name"] or _nvs_name_for(row["username"])
        value = row["public_key"]
        days = int(EMERCOIN_NVS_DAYS or 365)
        try:
            # Emercoin: name_new <name> <value> <days>
            emercoin_rpc("name_new", [nvs, value, days])
        except RuntimeError as exc:
            msg = str(exc)
            # Idempotent-ish: if name exists, try update
            if "exists" in msg.lower() or "already" in msg.lower():
                try:
                    emercoin_rpc("name_update", [nvs, value, days])
                except RuntimeError as exc2:
                    return jsonify({"success": False, "error": str(exc2)}), 502
            else:
                return jsonify({"success": False, "error": msg}), 502

        now = _utc_now()
        db.execute(
            """UPDATE ssh_keys
               SET status = 'active', nvs_name = ?, activated_at = ?
               WHERE id = ?""",
            (nvs, now, kid),
        )
        db.commit()
        row = db.execute("SELECT * FROM ssh_keys WHERE id = ?", (kid,)).fetchone()
        return jsonify({"success": True, "key": _row_public(row)})

    @app.route("/api/ssh/keys/<int:kid>", methods=["DELETE"])
    def api_ssh_revoke(kid):
        if rate_global and not rate_global("ssh_rev", limit=40, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_rev"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({"success": False, "error": "Device identity required"}), 403

        db = get_db()
        row = db.execute(
            "SELECT * FROM ssh_keys WHERE id = ? AND creator_key = ?",
            (kid, owner),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Key not found"}), 404
        if row["status"] == "revoked":
            return jsonify({"success": True, "key": _row_public(row), "already": True})

        # Best-effort NVS delete; always revoke locally (idempotent)
        if rpc_configured() and row["nvs_name"]:
            try:
                emercoin_rpc("name_delete", [row["nvs_name"]])
            except RuntimeError as exc:
                print(f"[SSH] name_delete: {exc}")

        now = _utc_now()
        db.execute(
            "UPDATE ssh_keys SET status = 'revoked', revoked_at = ? WHERE id = ?",
            (now, kid),
        )
        db.commit()
        row = db.execute("SELECT * FROM ssh_keys WHERE id = ?", (kid,)).fetchone()
        return jsonify({"success": True, "key": _row_public(row)})

    print("[SSH] EmerSSH Access routes registered")
