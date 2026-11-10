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
    NCH_PAYMENT_ADDRESS,
    SSH_MAX_KEYS_PER_DEVICE,
    SSH_TIERS,
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ssh_licenses (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_key   TEXT NOT NULL,
            plan          TEXT NOT NULL,
            tx_hash       TEXT,
            amount_nch    INTEGER NOT NULL DEFAULT 0,
            max_keys      INTEGER NOT NULL,
            created_at    TEXT NOT NULL,
            expires_at    TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'active'
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssh_lic_owner "
        "ON ssh_licenses(creator_key, status, expires_at)"
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


def _tier_meta(plan_id: str) -> dict | None:
    pid = (plan_id or "").strip().lower()
    if pid in SSH_TIERS:
        return dict(SSH_TIERS[pid])
    return None


def _active_license(db, creator_key: str):
    now = _utc_now()
    return db.execute(
        """
        SELECT * FROM ssh_licenses
         WHERE creator_key = ? AND status = 'active' AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 1
        """,
        (creator_key, now),
    ).fetchone()


def _entitlement(db, creator_key: str) -> dict:
    """Resolve free vs paid entitlement for key caps."""
    free = _tier_meta("free") or {
        "id": "free", "max_keys": 1, "price_nch": 0, "ttl_minutes": 0, "label": "Spark",
    }
    abs_cap = int(SSH_MAX_KEYS_PER_DEVICE or 50)
    lic = _active_license(db, creator_key) if creator_key and creator_key != "anon" else None
    if lic:
        max_keys = min(int(lic["max_keys"] or 0) or int(free["max_keys"]), abs_cap)
        return {
            "plan": lic["plan"],
            "max_keys": max_keys,
            "expires_at": lic["expires_at"],
            "paid": True,
            "label": (SSH_TIERS.get(lic["plan"]) or {}).get("label") or lic["plan"],
        }
    max_keys = min(int(free.get("max_keys") or 1), abs_cap)
    return {
        "plan": "free",
        "max_keys": max_keys,
        "expires_at": None,
        "paid": False,
        "label": free.get("label") or "Spark",
    }


def _new_intent_id() -> str:
    return secrets.token_urlsafe(24)



def cleanup_ssh_expired(db_path: str | None = None) -> int:
    """Mark expired paid licenses inactive. Does not revoke keys (slots only)."""
    path = db_path or str(DB_PATH)
    conn = None
    n = 0
    try:
        conn = sqlite3.connect(path, timeout=5)
        conn.row_factory = sqlite3.Row
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        cur = conn.execute(
            """
            UPDATE ssh_licenses
               SET status = 'expired'
             WHERE status = 'active' AND expires_at <= ?
            """,
            (now,),
        )
        n = cur.rowcount or 0
        conn.commit()
    except Exception as exc:
        print(f"[SSH] cleanup error: {exc}")
        try:
            if conn is not None:
                conn.rollback()
        except Exception:
            pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return n


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
    claim_tx = deps.get("_claim_tx")
    tx_already = deps.get("_tx_already_used")
    verify_nch = deps.get("verify_nch_payment_on_chain")
    ExplorerUnavailable = deps.get("ExplorerUnavailable")
    PaymentVerificationError = deps.get("PaymentVerificationError")
    normalize_txid = deps.get("_normalize_txid") or (lambda x: (x or "").strip().lower())
    is_plausible_txid = deps.get("_is_plausible_txid")
    explorer_payload = deps.get("_explorer_unavailable_payload")

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
        owner = _owner()
        ent = {"plan": "free", "max_keys": 1, "paid": False, "expires_at": None, "label": "Spark"}
        if owner != "anon":
            try:
                db = get_db()
                ent = _entitlement(db, owner)
            except Exception:
                pass
        tiers = []
        for k, v in SSH_TIERS.items():
            tiers.append({
                "id": v["id"],
                "label": v["label"],
                "price_nch": int(v["price_nch"]),
                "max_keys": int(v["max_keys"]),
                "ttl_minutes": int(v.get("ttl_minutes") or 0),
                "hint": v.get("hint") or "",
                "free": int(v["price_nch"]) <= 0,
            })
        return jsonify({
            "success": True,
            "product": "ssh",
            "rpc_configured": rpc_configured(),
            "nvs_days": int(EMERCOIN_NVS_DAYS or 365),
            "pay_address": NCH_PAYMENT_ADDRESS,
            "entitlement": ent,
            "tiers": tiers,
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
        ent = _entitlement(db, owner)
        n = db.execute(
            "SELECT COUNT(*) AS c FROM ssh_keys WHERE creator_key = ? AND status != 'revoked'",
            (owner,),
        ).fetchone()["c"]
        if int(n) >= int(ent["max_keys"]):
            return jsonify({
                "success": False,
                "error": f"Key limit reached for your plan ({ent['label']}: {ent['max_keys']} keys). Upgrade to add more.",
                "need_upgrade": True,
                "entitlement": ent,
            }), 402

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
        # Align NVS lease with paid license remaining time when shorter than default
        try:
            ent = _entitlement(db, owner)
            if ent.get("paid") and ent.get("expires_at"):
                exp = datetime.fromisoformat(ent["expires_at"])
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                remaining_days = (exp - datetime.now(timezone.utc)).total_seconds() / 86400.0
                if remaining_days > 0:
                    days = max(1, int(remaining_days + 0.999))  # ceil
        except Exception:
            pass
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


    @app.route("/api/ssh/intent", methods=["POST"])
    def api_ssh_intent():
        if rate_global and not rate_global("ssh_intent", limit=40, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_intent"), limit=12, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({"success": False, "error": "Device identity required"}), 403
        if HAS_FLASK:
            from flask import request as fr
            body = fr.get_json(silent=True) or {}
            plan = (body.get("plan") or fr.form.get("plan") or "").strip().lower()
        else:
            plan = (request.form.get("plan") or "").strip().lower()
        meta = _tier_meta(plan)
        if not meta or int(meta["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Choose a paid plan"}), 400
        intent_id = _new_intent_id()
        now = datetime.now(timezone.utc)
        exp = now.timestamp() + 3600
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).replace(microsecond=0).isoformat()
        created = now.replace(microsecond=0).isoformat()
        price = int(meta["price_nch"])
        db = get_db()
        db.execute(
            """
            INSERT INTO payment_intents
              (intent_id, plan, amount_nch, pay_address, status, created_at, expires_at, product)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, 'ssh')
            """,
            (
                intent_id,
                f"ssh:{plan}",
                price,
                NCH_PAYMENT_ADDRESS,
                created,
                expires_at,
            ),
        )
        db.commit()
        return jsonify({
            "success": True,
            "intent_id": intent_id,
            "plan": plan,
            "amount_nch": price,
            "pay_address": NCH_PAYMENT_ADDRESS,
            "expires_at": expires_at,
            "max_keys": int(meta["max_keys"]),
            "ttl_minutes": int(meta.get("ttl_minutes") or 0),
        })

    @app.route("/api/ssh/verify", methods=["POST"])
    def api_ssh_verify():
        if rate_global and not rate_global("ssh_verify", limit=40, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("ssh_verify"), limit=12, window=60):
            return jsonify({"success": False, "error": "Too many verification attempts"}), 429
        owner = _owner()
        if owner == "anon":
            return jsonify({"success": False, "error": "Device identity required"}), 403
        if HAS_FLASK:
            from flask import request as fr
            body = fr.get_json(silent=True) or {}
            tx_hash = (body.get("tx_hash") or fr.form.get("tx_hash") or "").strip()
            intent_id = (body.get("intent_id") or fr.form.get("intent_id") or "").strip()
            plan = (body.get("plan") or fr.form.get("plan") or "").strip().lower()
        else:
            tx_hash = (request.form.get("tx_hash") or "").strip()
            intent_id = (request.form.get("intent_id") or "").strip()
            plan = (request.form.get("plan") or "").strip().lower()

        if not intent_id:
            return jsonify({"success": False, "error": "Missing payment intent"}), 400
        if is_plausible_txid and not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid transaction hash"}), 400
        meta = _tier_meta(plan)
        if not meta or int(meta["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Invalid plan"}), 400

        db = get_db()
        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'ssh'",
            (intent_id,),
        ).fetchone()
        if not intent:
            return jsonify({"success": False, "error": "Payment intent not found or already used"}), 404
        if (intent["plan"] or "") != f"ssh:{plan}":
            return jsonify({"success": False, "error": "Plan mismatch"}), 400
        required_nch = int(intent["amount_nch"])
        try:
            intent_exp = datetime.fromisoformat(intent["expires_at"])
            if intent_exp.tzinfo is None:
                intent_exp = intent_exp.replace(tzinfo=timezone.utc)
            if intent_exp <= datetime.now(timezone.utc):
                return jsonify({"success": False, "error": "Payment intent expired"}), 410
        except Exception:
            pass

        txid = normalize_txid(tx_hash)
        if tx_already and tx_already(db, txid):
            return jsonify({"success": False, "error": "This transaction was already used."}), 409

        if not verify_nch:
            return jsonify({"success": False, "error": "Payment verification unavailable"}), 503
        try:
            chain = verify_nch(
                tx_hash,
                expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch,
                exact_amount=False,
            )
        except Exception as exc:
            if ExplorerUnavailable and isinstance(exc, ExplorerUnavailable):
                payload = explorer_payload(exc) if explorer_payload else {"success": False, "error": str(exc)}
                return jsonify(payload), 503
            if PaymentVerificationError and isinstance(exc, PaymentVerificationError):
                return jsonify({"success": False, "error": str(exc)}), getattr(exc, "http_status", 400) or 400
            print(f"[SSH] verify error: {exc}")
            return jsonify({"success": False, "error": "Verification failed"}), 500

        if not claim_tx:
            return jsonify({"success": False, "error": "Payment claim unavailable"}), 503
        if not claim_tx(db, txid, "ssh", amount_nch=required_nch, ref_id=plan):
            return jsonify({"success": False, "error": "Transaction already used."}), 409

        ttl = int(meta.get("ttl_minutes") or 10080)
        now = datetime.now(timezone.utc)
        # Stack remaining time if upgrading while active
        ent = _entitlement(db, owner)
        base = now
        if ent.get("paid") and ent.get("expires_at"):
            try:
                prev = datetime.fromisoformat(ent["expires_at"])
                if prev.tzinfo is None:
                    prev = prev.replace(tzinfo=timezone.utc)
                if prev > now:
                    base = prev
            except Exception:
                pass
        expires = (base.timestamp() + ttl * 60)
        expires_at = datetime.fromtimestamp(expires, tz=timezone.utc).replace(microsecond=0).isoformat()
        created = now.replace(microsecond=0).isoformat()
        max_keys = int(meta["max_keys"])

        # Atomic intent consume — only one concurrent winner
        cur = db.execute(
            """
            UPDATE payment_intents
               SET status='paid', tx_hash=?, verified_at=?
             WHERE intent_id=? AND status='pending' AND product='ssh'
            """,
            (txid, created, intent_id),
        )
        if cur.rowcount != 1:
            db.rollback()
            return jsonify({
                "success": False,
                "error": "Payment intent already consumed",
            }), 409

        try:
            db.execute(
                """
                INSERT INTO ssh_licenses
                  (creator_key, plan, tx_hash, amount_nch, max_keys, created_at, expires_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
                """,
                (owner, plan, txid, required_nch, max_keys, created, expires_at),
            )
            db.commit()
        except Exception as exc:
            print(f"[SSH] CRITICAL license insert after claim: {exc} tx={txid[:16]}…")
            try:
                db.rollback()
            except Exception:
                pass
            return jsonify({
                "success": False,
                "error": "License grant failed after payment — contact support with your tx hash",
                "txid": txid,
            }), 500
        return jsonify({
            "success": True,
            "plan": plan,
            "max_keys": max_keys,
            "expires_at": expires_at,
            "amount_nch": required_nch,
            "entitlement": _entitlement(db, owner),
        })

    print("[SSH] EmerSSH Access routes registered")
