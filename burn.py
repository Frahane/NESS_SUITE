"""
NESS Burn — ephemeral file drops (suite product, not TempMail).

Separate branding, shared NCH verification and design tokens.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from config import (
    BASE_DIR,
    BURN_STORAGE_DIR,
    BURN_TIERS,
    DB_PATH,
    NCH_PAYMENT_ADDRESS,
)

# Filled by register() from app module (avoids circular imports at load)
_app_ref = None
_deps = {}


def register(app, deps: dict):
    """
    deps must provide: get_db, jsonify, request, HAS_FLASK, render_template,
    _rate_ok, _rate_key, _new_public_token, verify_nch_payment_on_chain,
    ExplorerUnavailable, PaymentVerificationError, _normalize_txid,
    _is_plausible_txid, probe_explorer_cached, _explorer_unavailable_payload,
    _safe helpers as needed
    """
    global _app_ref, _deps
    _app_ref = app
    _deps = deps
    _ensure_storage()
    _init_burn_schema(deps["get_db"])
    _mount_routes(app, deps)


def _ensure_storage():
    Path(BURN_STORAGE_DIR).mkdir(parents=True, exist_ok=True)


def _init_burn_schema(get_db=None):
    """Create burn tables using a short-lived connection (no request context)."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS burn_drops (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            public_token    TEXT UNIQUE NOT NULL,
            plan            TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            expires_at      TEXT NOT NULL,
            max_downloads   INTEGER NOT NULL,
            download_count  INTEGER NOT NULL DEFAULT 0,
            burn_after      INTEGER NOT NULL DEFAULT 0,
            password_hash   TEXT,
            transaction_hash TEXT UNIQUE,
            amount_nch      REAL,
            status          TEXT NOT NULL DEFAULT 'active',
            total_bytes     INTEGER NOT NULL DEFAULT 0,
            files_json      TEXT NOT NULL DEFAULT '[]'
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_token ON burn_drops(public_token)"
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(burn_drops)").fetchall()}
    if "allow_view" not in cols:
        conn.execute("ALTER TABLE burn_drops ADD COLUMN allow_view INTEGER NOT NULL DEFAULT 1")
    if "allow_download" not in cols:
        conn.execute("ALTER TABLE burn_drops ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 1")
    if "creator_key" not in cols:
        conn.execute("ALTER TABLE burn_drops ADD COLUMN creator_key TEXT")
    if "enc_meta" not in cols:
        conn.execute("ALTER TABLE burn_drops ADD COLUMN enc_meta TEXT")
    try:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_burn_creator ON burn_drops(creator_key)"
        )
    except Exception:
        pass
    conn.commit()
    conn.close()


def _public_burn_tiers():
    out = {}
    for k, v in BURN_TIERS.items():
        out[k] = {
            "id": v["id"],
            "label": v["label"],
            "ttl_minutes": v["ttl_minutes"],
            "max_files": v["max_files"],
            "max_size_mb": v["max_size_mb"],
            "max_downloads": v["max_downloads"],
            "max_audio_seconds": int(v.get("max_audio_seconds") or 60),
            "max_note_chars": int(v.get("max_note_chars") or 500),
            "burn_after_download": v["burn_after_download"],
            "password": v["password"],
            "voice_anonymize": bool(v.get("voice_anonymize", True)),
            "price_nch": v["price_nch"],
            "badge_class": v["badge_class"],
            "tagline": v["tagline"],
        }
    return out


def _safe_burn_plan(pid):
    pid = (pid or "").strip().lower()
    return pid if pid in BURN_TIERS else None


# Short-lived view sessions (password → token; never put password in image URLs)
_VIEW_SESSIONS = {}
_VIEW_SESSIONS_LOCK = threading.Lock()
_VIEW_SESSION_TTL = 300  # seconds


def _purge_view_sessions():
    now = time.time()
    with _VIEW_SESSIONS_LOCK:
        dead = [k for k, v in _VIEW_SESSIONS.items() if v.get("exp", 0) < now]
        for k in dead:
            _VIEW_SESSIONS.pop(k, None)


def _issue_view_session(public_token: str) -> str:
    _purge_view_sessions()
    tok = secrets.token_urlsafe(24)
    with _VIEW_SESSIONS_LOCK:
        _VIEW_SESSIONS[tok] = {
            "drop": public_token,
            "exp": time.time() + _VIEW_SESSION_TTL,
            "dl_charged": False,
        }
    return tok


def _view_session_ok(view_token: str, public_token: str, *, finishing_pack=False) -> bool:
    if not view_token:
        return False
    _purge_view_sessions()
    with _VIEW_SESSIONS_LOCK:
        rec = _VIEW_SESSIONS.get(view_token)
        if not rec:
            return False
        if rec.get("drop") != public_token:
            return False
        if rec.get("exp", 0) <= time.time():
            return False
        if finishing_pack and not rec.get("finishes_pack"):
            return False
        # Sliding window — extend on successful use
        rec["exp"] = time.time() + _VIEW_SESSION_TTL
        return True


class _DownloadSessionRequired(Exception):
    """A multi-file pack needs a verified session to claim its final unit."""


def _charge_download_once(db, row, view_token: str, public_token: str, *, multi_file=False):
    """Return (charged count, destroy now), or (None, False) if unavailable.

    Publish a session's claim after SQLite commits. Only the valid unlock
    session that exhausts a multi-file pack can continue after quota closes.
    Tokenless requests retain the two-minute client window while quota is open.
    """
    session_key = view_token
    if not view_token:
        try:
            from flask import request as fr
            ip = getattr(fr, "remote_addr", None) or "unknown"
        except Exception:
            ip = "unknown"
        session_key = f"anon-dl:{public_token}:{ip}"

    with _VIEW_SESSIONS_LOCK:
        now = time.time()
        rec = _VIEW_SESSIONS.get(session_key)
        if rec and (rec.get("drop") != public_token or rec.get("exp", 0) <= now):
            rec = None
        if view_token and rec is None:
            return None, False

        if rec and rec.get("dl_charged"):
            current = db.execute(
                """SELECT download_count FROM burn_drops WHERE id = ?
                     AND julianday(expires_at) > julianday('now')
                     AND ((status = 'active' AND download_count < max_downloads)
                          OR (status = 'burned' AND ? AND files_json <> '[]'))""",
                (row["id"], bool(view_token and rec.get("finishes_pack"))),
            ).fetchone()
            return (int(current["download_count"]), False) if current else (None, False)

        allow_final_claim = bool(view_token) or not multi_file
        try:
            claim = db.execute(
                """UPDATE burn_drops SET download_count = download_count + 1
                   WHERE id = ? AND status = 'active'
                     AND download_count < max_downloads
                     AND (? OR burn_after <> 0 OR download_count < max_downloads - 1)
                     AND julianday(expires_at) > julianday('now')""",
                (row["id"], allow_final_claim),
            )
            if claim.rowcount != 1:
                if not allow_final_claim and db.execute(
                    """SELECT 1 FROM burn_drops
                       WHERE id = ? AND status = 'active' AND burn_after = 0
                         AND download_count = max_downloads - 1
                         AND julianday(expires_at) > julianday('now')""",
                    (row["id"],),
                ).fetchone():
                    raise _DownloadSessionRequired
                db.rollback()
                return None, False
            current = db.execute(
                "SELECT download_count, max_downloads, burn_after FROM burn_drops WHERE id = ?",
                (row["id"],),
            ).fetchone()
            new_count = int(current["download_count"])
            closed = bool(current["burn_after"]) or new_count >= int(current["max_downloads"])
            if closed:
                # Close the drop for *new* sessions; do not delete files here.
                db.execute(
                    "UPDATE burn_drops SET status = 'burned' WHERE id = ?",
                    (row["id"],),
                )
            db.commit()
        except Exception:
            db.rollback()
            raise

        finishes_pack = bool(view_token and multi_file and closed and not current["burn_after"])
        if view_token:
            rec["dl_charged"] = True
            rec["finishes_pack"] = finishes_pack
        else:
            _VIEW_SESSIONS[session_key] = {
                "drop": public_token,
                "exp": now + 120,
                "dl_charged": True,
            }

        return new_count, closed and not finishes_pack



# ── Unlock brute-force protection (per drop token, disk-persisted) ───────────
# After 3 failed attempts: exponential lockout. During lockout even the correct
# passphrase is refused (closes race / spray). State survives process restart.
_UNLOCK_LOCK_PATH = Path(BASE_DIR) / "burn_unlock_locks.json"
_UNLOCK_STATE_LOCK = threading.Lock()
_UNLOCK_FAIL_THRESHOLD = 3
_UNLOCK_BASE_LOCK_SEC = 30
_UNLOCK_MAX_LOCK_SEC = 3600
_UNLOCK_STALE_SEC = 3600  # drop idle records after 1h without activity


def _unlock_load_state():
    try:
        if not _UNLOCK_LOCK_PATH.is_file():
            return {}
        with open(_UNLOCK_LOCK_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _unlock_save_state(state: dict):
    try:
        tmp = _UNLOCK_LOCK_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        tmp.replace(_UNLOCK_LOCK_PATH)
    except Exception as exc:
        print(f"[BURN] unlock lock persist error: {exc}")


def _unlock_cleanup(state: dict, now: float) -> dict:
    out = {}
    for tok, rec in state.items():
        if not isinstance(rec, dict):
            continue
        locked_until = float(rec.get("locked_until") or 0)
        last = float(rec.get("last_fail") or 0)
        # Keep only active lockouts or recent failure history
        if locked_until > now:
            out[tok] = rec
        elif last and (now - last) < _UNLOCK_STALE_SEC:
            out[tok] = rec
    return out


def _unlock_lockout_remaining(lock_key: str):
    """Return seconds remaining in lockout for this key, or 0 if free."""
    now = time.time()
    with _UNLOCK_STATE_LOCK:
        raw = _unlock_load_state()
        state = _unlock_cleanup(raw, now)
        if state != raw:
            _unlock_save_state(state)
        rec = state.get(lock_key) or {}
        locked_until = float(rec.get("locked_until") or 0)
        if locked_until > now:
            return int(locked_until - now) + 1
        return 0


def _unlock_register_failure(lock_key: str) -> int:
    """Record a failed unlock for this key. Returns lockout seconds (0 if not yet locked)."""
    now = time.time()
    with _UNLOCK_STATE_LOCK:
        state = _unlock_cleanup(_unlock_load_state(), now)
        rec = state.get(lock_key) or {"fails": 0, "lock_level": 0, "locked_until": 0, "last_fail": 0}
        locked_until = float(rec.get("locked_until") or 0)
        if locked_until > now:
            state[lock_key] = rec
            _unlock_save_state(state)
            return int(locked_until - now) + 1

        fails = int(rec.get("fails") or 0) + 1
        rec["fails"] = fails
        rec["last_fail"] = now
        lock_sec = 0
        if fails >= _UNLOCK_FAIL_THRESHOLD:
            level = int(rec.get("lock_level") or 0) + 1
            rec["lock_level"] = level
            lock_sec = min(
                _UNLOCK_BASE_LOCK_SEC * (2 ** max(0, level - 1)),
                _UNLOCK_MAX_LOCK_SEC,
            )
            rec["locked_until"] = now + lock_sec
            rec["fails"] = 0
        state[lock_key] = rec
        _unlock_save_state(state)
        return lock_sec


def _unlock_register_success(lock_key: str):
    """Clear lockout history for this key after a successful unlock."""
    with _UNLOCK_STATE_LOCK:
        state = _unlock_load_state()
        if lock_key in state:
            state.pop(lock_key, None)
            _unlock_save_state(_unlock_cleanup(state, time.time()))



def _reject_oversized_request(jsonify, HAS_FLASK, max_plan_bytes=None):
    """Return (response, status) if request body is too large, else None.

    Defensive only — real DoS protection belongs in the reverse proxy
    (client_max_body_size). Threshold: highest tier max_size_mb + 256 KB.
    """
    if not HAS_FLASK:
        return None
    from flask import request as fr
    if max_plan_bytes is None:
        try:
            max_plan_bytes = max(
                int(v.get("max_size_mb") or 0) for v in BURN_TIERS.values()
            ) * 1024 * 1024
        except Exception:
            max_plan_bytes = 1024 * 1024 * 1024
    if max_plan_bytes <= 0:
        max_plan_bytes = 1024 * 1024 * 1024
    if fr.content_length and fr.content_length > max_plan_bytes + 256 * 1024:
        return jsonify({"success": False, "error": "Request too large"}), 413
    return None


PBKDF2_ITERATIONS = 100_000
PBKDF2_LEGACY_ITERATIONS = 600_000  # hashes created before versioned format


def _parse_enc_meta(raw):
    """Validate client E2E envelope. Server never receives DEK in plaintext."""
    if not raw or not str(raw).strip():
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict) or int(obj.get("v") or 0) != 1:
        return None
    if obj.get("alg") != "AES-GCM-256":
        return None
    wrap = obj.get("wrap")
    if not isinstance(wrap, dict):
        return None
    mode = wrap.get("mode")
    if mode not in ("passphrase", "link"):
        return None
    if not wrap.get("iv") or not wrap.get("ct"):
        return None
    if mode == "passphrase" and (not wrap.get("salt") or not wrap.get("iters")):
        return None
    dumped = json.dumps(obj, separators=(",", ":"))
    if len(dumped) > 4096:
        return None
    return dumped


def _row_enc_meta(row):
    try:
        raw = row["enc_meta"]
    except (KeyError, IndexError, TypeError):
        return None
    if not raw:
        return None
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def _hash_password(pw: str) -> str:
    """PBKDF2-HMAC-SHA256. Format: pbkdf2$<iters>$<salt>$<dig>.

    Legacy formats still verified:
      • pbkdf2$<salt>$<dig>  (iters implicit — try 600k then 100k)
      • sha256$<salt>$<dig>
    """
    salt = secrets.token_bytes(16)
    dig = hashlib.pbkdf2_hmac(
        "sha256", pw.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt.hex()}${dig.hex()}"


def _row_has_password(row) -> bool:
    try:
        h = row["password_hash"]
    except (KeyError, IndexError, TypeError):
        return False
    if h is None:
        return False
    s = str(h).strip()
    return bool(s) and s.lower() not in ("none", "null", "")


def _check_password(pw: str, stored: str | None) -> bool:
    if not stored:
        return True
    if not pw:
        return False
    try:
        parts = str(stored).split("$")
        if len(parts) == 4 and parts[0] == "pbkdf2":
            _, iters_s, salt_hex, dig = parts
            iters = int(iters_s)
            calc = hashlib.pbkdf2_hmac(
                "sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), iters
            ).hex()
            return secrets.compare_digest(calc, dig)
        if len(parts) == 3 and parts[0] == "pbkdf2":
            # Legacy: iteration count not stored — try known historical values
            salt_hex, dig = parts[1], parts[2]
            for iters in (PBKDF2_LEGACY_ITERATIONS, PBKDF2_ITERATIONS):
                calc = hashlib.pbkdf2_hmac(
                    "sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), iters
                ).hex()
                if secrets.compare_digest(calc, dig):
                    return True
            return False
        if len(parts) == 3 and parts[0] == "sha256":
            salt, dig = parts[1], parts[2]
            calc = hashlib.sha256((salt + pw).encode("utf-8")).hexdigest()
            return secrets.compare_digest(calc, dig)
        return False
    except Exception:
        return False



def _sanitize_filename(name: str) -> str:
    base = os.path.basename(str(name or "file").replace("\\", "/"))
    base = re.sub(r"[^\w.\- ()\[\]]+", "_", base).strip("._")
    return (base[:180] or "file.bin")


def _drop_dir(token: str) -> Path:
    # token is url-safe; still prevent path escape
    safe = re.sub(r"[^A-Za-z0-9_\-]", "", token)[:64]
    return Path(BURN_STORAGE_DIR) / safe


def _destroy_drop(db, row):
    """Mark burned and remove files. If rmtree fails, keep files_json for retry."""
    token = row["public_token"]
    d = _drop_dir(token)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    db.execute(
        """UPDATE burn_drops SET status = 'burned',
           files_json = CASE WHEN ? THEN files_json ELSE '[]' END WHERE id = ?""",
        (d.exists(), row["id"]),
    )
    db.commit()


# renew route registered inside _mount_routes via late bind

def cleanup_burn_expired():
    """Purge expired / burned drops (filesystem + rows).

    Uses a dedicated SQLite connection — never Flask get_db() — so background
    threads do not require an application context.
    """
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000;")
        now = datetime.now(timezone.utc).isoformat()
        rows = conn.execute(
            """SELECT * FROM burn_drops WHERE (status = 'active' AND expires_at < ?)
               OR (status IN ('burned', 'expired') AND files_json <> '[]')""",
            (now,),
        ).fetchall()
        # Do not wipe a closed pack while its quota-consuming session
        # is still allowed to finish downloading the remaining files.
        # This registry is process-local; multi-worker cleanup requires
        # coordinating the finishing-session lease across workers.
        with _VIEW_SESSIONS_LOCK:
            session_now = time.time()
            finishing = {
                rec["drop"] for rec in _VIEW_SESSIONS.values()
                if rec.get("finishes_pack") and rec.get("exp", 0) > session_now
            }
        for row in rows:
            if (row["status"] == "burned" and row["expires_at"] > now
                    and row["public_token"] in finishing):
                continue
            _destroy_drop(conn, row)
            if row["status"] != "burned":
                conn.execute(
                    "UPDATE burn_drops SET status = 'expired' WHERE id = ?",
                    (row["id"],),
                )
        conn.execute(
            "DELETE FROM burn_drops WHERE status IN ('burned','expired') "
            "AND files_json = '[]' AND expires_at < ?",
            ((datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),),
        )
        conn.commit()
    except Exception as exc:
        print(f"[BURN] cleanup error: {exc}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _mount_routes(app, deps):
    get_db = deps["get_db"]
    jsonify = deps["jsonify"]
    request = deps["request"]
    render_template = deps.get("render_template")
    HAS_FLASK = deps["HAS_FLASK"]
    rate_ok = deps["_rate_ok"]
    rate_key = deps["_rate_key"]
    verify_nch = deps["verify_nch_payment_on_chain"]
    ExplorerUnavailable = deps["ExplorerUnavailable"]
    PaymentVerificationError = deps["PaymentVerificationError"]
    normalize_txid = deps["_normalize_txid"]
    is_plausible_txid = deps["_is_plausible_txid"]
    probe_cached = deps["probe_explorer_cached"]
    explorer_payload = deps["_explorer_unavailable_payload"]
    Path_ = deps.get("Path", Path)
    json_mod = deps.get("json", json)


    @app.route("/api/burn/<token>/renew", methods=["POST"])
    def api_burn_renew(token):
        """Extend drop TTL: remaining + plan duration after paid intent."""
        token = (token or "").strip()
        if not token or len(token) < 16:
            return jsonify({"success": False, "error": "Not found"}), 404
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_renew", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("burn_renew"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        plan_id = _safe_burn_plan(request.form.get("plan"))
        intent_id = (request.form.get("intent_id") or "").strip()
        tx_hash = normalize_txid(request.form.get("tx_hash") or "")
        if not plan_id or not intent_id or not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid renew request"}), 400
        if int(BURN_TIERS[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Renew requires a paid plan"}), 400
        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ? AND status = 'active'",
            (token,),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found or expired"}), 404
        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'burn'",
            (intent_id,),
        ).fetchone()
        if not intent or (intent["plan"] or "") != plan_id:
            return jsonify({"success": False, "error": "Invalid payment intent"}), 404
        required_nch = int(intent["amount_nch"])
        tx_used = deps.get("_tx_already_used")
        if tx_used and tx_used(db, tx_hash):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        try:
            chain = verify_nch(
                tx_hash,
                expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch,
                exact_amount=False,
            )
        except ExplorerUnavailable as e:
            return jsonify(explorer_payload(e)), 503
        except PaymentVerificationError as e:
            return jsonify({"success": False, "error": str(e), "explorer_ok": True}), getattr(e, "http_status", 400)
        claim = deps.get("_claim_tx")
        if claim and not claim(db, tx_hash, "burn", amount_nch=required_nch):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        now = datetime.now(timezone.utc)
        try:
            exp = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
        except Exception:
            exp = now
        remaining = max(0.0, (exp - now).total_seconds())
        new_exp = now + timedelta(seconds=remaining) + timedelta(
            minutes=int(BURN_TIERS[plan_id]["ttl_minutes"])
        )
        db.execute(
            "UPDATE burn_drops SET expires_at = ?, plan = ? WHERE public_token = ?",
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
            "hours_received": chain.get("hours_received") if isinstance(chain, dict) else required_nch,
        })


    @app.route("/burn")
    def burn_index():
        tiers = _public_burn_tiers()
        if HAS_FLASK and render_template:
            try:
                from app import build_og_meta
                meta = build_og_meta("burn", path="/burn")
            except Exception:
                meta = {}
            return render_template(
                "burn.html",
                pay_address=NCH_PAYMENT_ADDRESS,
                tiers=tiers,
                **meta,
            )
        html = (BASE_DIR / "templates" / "burn.html").read_text(encoding="utf-8")
        html = re.sub(
            r"\{\{\s*pay_address\s*\|\s*tojson\s*\}\}",
            json_mod.dumps(NCH_PAYMENT_ADDRESS),
            html,
        )
        html = re.sub(
            r"\{\{\s*tiers\s*\|\s*tojson\s*\}\}",
            json_mod.dumps(tiers),
            html,
        )
        return html

    @app.route("/burn/d/<token>")
    def burn_download_page(token):
        # Same SPA shell; JS reads token from path. OG always Burn (shared content card).
        tiers = _public_burn_tiers()
        if HAS_FLASK and render_template:
            try:
                from app import build_og_meta
                meta = build_og_meta("burn", path=f"/burn/d/{token}")
            except Exception:
                meta = {}
            return render_template(
                "burn.html",
                pay_address=NCH_PAYMENT_ADDRESS,
                tiers=tiers,
                **meta,
            )
        return burn_index()

    @app.route("/api/burn/tiers", methods=["GET"])
    def api_burn_tiers():
        return jsonify({"success": True, "tiers": _public_burn_tiers()})

    @app.route("/api/burn/mine", methods=["GET"])
    def api_burn_mine():
        """List active (non-expired) drops owned by this device — publisher only."""
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_mine", limit=120, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("burn_mine"), limit=30, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        owner = "anon"
        try:
            owner = (client_device_id() or "anon").strip()
        except Exception:
            owner = "anon"
        if owner == "anon":
            return jsonify({"success": True, "items": []})
        db = get_db()
        now = datetime.now(timezone.utc).isoformat()
        rows = db.execute(
            """
            SELECT public_token, plan, created_at, expires_at, max_downloads,
                   download_count, burn_after, status, files_json, allow_view, allow_download
              FROM burn_drops
             WHERE creator_key = ?
               AND status = 'active'
               AND expires_at > ?
             ORDER BY created_at DESC
             LIMIT 50
            """,
            (owner, now),
        ).fetchall()
        items = []
        for r in rows:
            plan_id = r["plan"]
            tier = BURN_TIERS.get(plan_id) or {}
            try:
                files = json.loads(r["files_json"] or "[]")
            except Exception:
                files = []
            items.append({
                "token": r["public_token"],
                "plan": plan_id,
                "plan_label": tier.get("label") or plan_id,
                "badge_class": tier.get("badge_class") or "",
                "created_at": r["created_at"],
                "expires_at": r["expires_at"],
                "max_downloads": r["max_downloads"],
                "download_count": r["download_count"],
                "burn_after": bool(r["burn_after"]),
                "files": files,
                "path": f"/burn/d/{r['public_token']}",
                "allow_view": bool(r["allow_view"]) if r["allow_view"] is not None else True,
                "allow_download": bool(r["allow_download"]) if r["allow_download"] is not None else True,
            })
        return jsonify({"success": True, "items": items})

    @app.route("/api/burn/create", methods=["POST"])
    def api_burn_create():
        oversized = _reject_oversized_request(jsonify, HAS_FLASK)
        if oversized is not None:
            return oversized
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_create", limit=60, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("burn_create"), limit=6, window=60):
            return jsonify({"success": False, "error": "Too many uploads. Slow down."}), 429

        plan_id = _safe_burn_plan(request.form.get("plan") or "free") or "free"
        tier = BURN_TIERS[plan_id]
        try:
            owner = (client_device_id() or "anon").strip()
        except Exception:
            owner = "anon"
        if tier["price_nch"] > 0:
            return jsonify({
                "success": False,
                "error": "This plan requires NCH payment. Use the payment flow.",
            }), 402

        files = []
        # Flask: request.files; stdlib shim may not support multipart well
        if HAS_FLASK:
            from flask import request as flask_request
            uploaded = flask_request.files.getlist("files") or []
            if not uploaded and flask_request.files.get("file"):
                uploaded = [flask_request.files.get("file")]
        else:
            return jsonify({
                "success": False,
                "error": "File upload requires Flask. Install flask and retry.",
            }), 503

        if not uploaded:
            return jsonify({"success": False, "error": "No file provided"}), 400
        if int(tier.get("max_files") or 0) > 0 and len(uploaded) > int(tier["max_files"]):
            return jsonify({
                "success": False,
                "error": f"This plan allows at most {tier['max_files']} file(s).",
            }), 400

        max_bytes = int(tier["max_size_mb"]) * 1024 * 1024
        if HAS_FLASK:
            from flask import request as flask_request
            if (
                flask_request.content_length
                and flask_request.content_length > max_bytes + 512 * 1024
            ):
                return jsonify({
                    "success": False,
                    "error": f"Request too large for this plan (max {tier['max_size_mb']} MB).",
                }), 413
        total = 0
        blobs = []
        for f in uploaded:
            data = f.read()
            total += len(data)
            if total > max_bytes:
                return jsonify({
                    "success": False,
                    "error": f"Total size exceeds {tier['max_size_mb']} MB for this plan.",
                }), 400
            fname = _sanitize_filename(getattr(f, "filename", None) or "file.bin")
            blobs.append((fname, data, getattr(f, "mimetype", None) or "application/octet-stream"))

        token = secrets.token_urlsafe(18)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(minutes=tier["ttl_minutes"])
        ddir = _drop_dir(token)
        ddir.mkdir(parents=True, exist_ok=True)

        meta_files = []
        for fname, data, mime in blobs:
            # avoid collisions
            dest_name = fname
            dest = ddir / dest_name
            n = 1
            while dest.exists():
                stem, ext = os.path.splitext(fname)
                dest_name = f"{stem}_{n}{ext}"
                dest = ddir / dest_name
                n += 1
            dest.write_bytes(data)
            meta_files.append({
                "filename": dest_name,
                "size": len(data),
                "content_type": mime,
            })

        password = (request.form.get("password") or "").strip()
        pw_hash = None
        if password:
            if not tier.get("password"):
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({
                    "success": False,
                    "error": "This plan does not support a passphrase.",
                }), 400
            if len(password) < 4 or len(password) > 128:
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({"success": False, "error": "Passphrase must be 4–128 characters."}), 400
            pw_hash = _hash_password(password)

        if HAS_FLASK:
            from flask import request as fr
            enc_raw = fr.form.get("enc_meta")
        else:
            enc_raw = request.form.get("enc_meta")
        enc_meta = _parse_enc_meta(enc_raw)
        if meta_files and not enc_meta:
            shutil.rmtree(ddir, ignore_errors=True)
            return jsonify({
                "success": False,
                "error": "Client encryption required — update your app and retry.",
            }), 400
        if enc_meta:
            try:
                mode = json.loads(enc_meta).get("wrap", {}).get("mode")
            except Exception:
                mode = None
            if password and mode != "passphrase":
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({"success": False, "error": "Encryption envelope mismatch"}), 400
            if (not password) and mode != "link":
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({"success": False, "error": "Encryption envelope mismatch"}), 400

        burn_after = 1 if tier["burn_after_download"] else (
            1 if (request.form.get("burn_after") or "") == "1" else 0
        )

        db = get_db()
        allow_view = 1 if (request.form.get("allow_view") or "1") != "0" else 0
        allow_download = 1 if (request.form.get("allow_download") or "1") != "0" else 0
        if not allow_view and not allow_download:
            allow_view = 1  # always permit at least one channel

        db.execute(
            """INSERT INTO burn_drops
               (public_token, plan, created_at, expires_at, max_downloads,
                burn_after, password_hash, total_bytes, files_json, status,
                allow_view, allow_download, creator_key, enc_meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)""",
            (
                token,
                plan_id,
                now.isoformat(),
                expires.isoformat(),
                int(tier["max_downloads"]),
                burn_after,
                pw_hash,
                total,
                json.dumps(meta_files),
                allow_view,
                allow_download,
                owner if owner != "anon" else None,
                enc_meta,
            ),
        )
        db.commit()

        return jsonify({
            "success": True,
            "token": token,
            "plan": plan_id,
            "plan_label": tier["label"],
            "badge_class": tier["badge_class"],
            "expires_at": expires.isoformat(),
            "max_downloads": tier["max_downloads"],
            "burn_after": bool(burn_after),
            "files": meta_files,
            "path": f"/burn/d/{token}",
        })

    @app.route("/api/burn/pay", methods=["POST"])
    def api_burn_pay():
        """Pay for a burn plan; multipart files + tx_hash + intent_id in one request."""
        try:
            owner = (client_device_id() or "anon").strip()
        except Exception:
            owner = "anon"
        oversized = _reject_oversized_request(jsonify, HAS_FLASK)
        if oversized is not None:
            return oversized
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_pay", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("burn_pay"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429

        plan_id = _safe_burn_plan(request.form.get("plan"))
        if not plan_id or BURN_TIERS[plan_id]["price_nch"] <= 0:
            return jsonify({"success": False, "error": "Invalid paid plan"}), 400
        tier = BURN_TIERS[plan_id]
        tx_hash = normalize_txid(request.form.get("tx_hash") or "")
        if not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid transaction hash"}), 400

        db = get_db()
        tx_used = deps.get("_tx_already_used")
        if tx_used and tx_used(db, tx_hash):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        # Also block against mail subscriptions table if present
        try:
            if db.execute(
                "SELECT 1 FROM subscriptions WHERE transaction_hash = ?", (tx_hash,)
            ).fetchone():
                return jsonify({"success": False, "error": "Transaction already used"}), 409
        except Exception:
            pass

        
        intent_id = (request.form.get("intent_id") or "").strip()
        if not intent_id:
            return jsonify({"success": False, "error": "Missing payment intent. Re-open payment and try again."}), 400
        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'burn'",
            (intent_id,),
        ).fetchone()
        if not intent:
            return jsonify({"success": False, "error": "Payment intent not found or already used"}), 404
        if (intent["plan"] or "") != plan_id:
            return jsonify({"success": False, "error": "Plan mismatch with payment intent"}), 400
        try:
            if intent["expires_at"] < datetime.now(timezone.utc).isoformat():
                return jsonify({"success": False, "error": "Payment intent expired"}), 410
        except Exception:
            pass
        required_nch = int(intent["amount_nch"])

        try:
            chain = verify_nch(
                tx_hash,
                expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch,
                exact_amount=False,
            )
        except ExplorerUnavailable as e:
            return jsonify(explorer_payload(e)), 503
        except PaymentVerificationError as e:
            return jsonify({
                "success": False,
                "error": str(e),
                "explorer_ok": True,
            }), e.http_status

        # Validate files BEFORE claim (avoid burning intent/tx on empty upload)
        if not HAS_FLASK:
            return jsonify({"success": False, "error": "Flask required for uploads"}), 503
        from flask import request as flask_request
        uploaded = flask_request.files.getlist("files") or []
        if not uploaded and flask_request.files.get("file"):
            uploaded = [flask_request.files.get("file")]
        if not uploaded:
            return jsonify({
                "success": False,
                "error": "Attach files before verifying payment.",
            }), 400

        if int(tier.get("max_files") or 0) > 0 and len(uploaded) > int(tier["max_files"]):
            return jsonify({"success": False, "error": "Too many files for plan"}), 400

        max_bytes = int(tier["max_size_mb"]) * 1024 * 1024
        total = 0
        blobs = []
        for f in uploaded:
            data = f.read()
            total += len(data)
            if total > max_bytes:
                return jsonify({"success": False, "error": "Files exceed plan size limit"}), 400
            blobs.append((
                _sanitize_filename(f.filename or "file.bin"),
                data,
                f.mimetype or "application/octet-stream",
            ))

        claim = deps.get("_claim_tx")
        if claim and not claim(db, tx_hash, "burn", amount_nch=required_nch):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        try:
            db.execute(
                "UPDATE payment_intents SET status='paid', tx_hash=?, verified_at=? WHERE intent_id=?",
                (tx_hash, datetime.now(timezone.utc).isoformat(), intent_id),
            )
        except Exception:
            pass

        token = secrets.token_urlsafe(18)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(minutes=tier["ttl_minutes"])
        ddir = _drop_dir(token)
        ddir.mkdir(parents=True, exist_ok=True)
        meta_files = []
        for fname, data, mime in blobs:
            dest = ddir / fname
            n = 1
            while dest.exists():
                stem, ext = os.path.splitext(fname)
                dest = ddir / f"{stem}_{n}{ext}"
                n += 1
            dest.write_bytes(data)
            meta_files.append({
                "filename": dest.name,
                "size": len(data),
                "content_type": mime,
            })

        password = (request.form.get("password") or "").strip()
        pw_hash = None
        if password:
            if not tier.get("password"):
                return jsonify({
                    "success": False,
                    "error": "This plan does not support a passphrase.",
                }), 400
            if len(password) < 4 or len(password) > 128:
                return jsonify({"success": False, "error": "Passphrase must be 4–128 characters."}), 400
            pw_hash = _hash_password(password)
        burn_after = 1 if (request.form.get("burn_after") or "") == "1" else 0

        allow_view = 1 if (request.form.get("allow_view") or "1") != "0" else 0
        allow_download = 1 if (request.form.get("allow_download") or "1") != "0" else 0
        if not allow_view and not allow_download:
            allow_view = 1

        if HAS_FLASK:
            from flask import request as fr
            enc_raw = fr.form.get("enc_meta")
        else:
            enc_raw = request.form.get("enc_meta")
        enc_meta = _parse_enc_meta(enc_raw)
        if meta_files and not enc_meta:
            shutil.rmtree(ddir, ignore_errors=True)
            return jsonify({
                "success": False,
                "error": "Client encryption required — update your app and retry.",
            }), 400
        if enc_meta:
            try:
                mode = json.loads(enc_meta).get("wrap", {}).get("mode")
            except Exception:
                mode = None
            if password and mode != "passphrase":
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({"success": False, "error": "Encryption envelope mismatch"}), 400
            if (not password) and mode != "link":
                shutil.rmtree(ddir, ignore_errors=True)
                return jsonify({"success": False, "error": "Encryption envelope mismatch"}), 400

        try:
            db.execute(
                """INSERT INTO burn_drops
                   (public_token, plan, created_at, expires_at, max_downloads,
                    burn_after, password_hash, transaction_hash, amount_nch,
                    total_bytes, files_json, status, allow_view, allow_download, creator_key, enc_meta)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)""",
                (
                    token, plan_id, now.isoformat(), expires.isoformat(),
                    int(tier["max_downloads"]), burn_after, pw_hash,
                    chain["txid"], int(chain["hours_received"]),
                    total, json.dumps(meta_files),
                    allow_view, allow_download, owner, enc_meta,
                ),
            )
            db.commit()
        except sqlite3.IntegrityError:
            db.rollback()
            shutil.rmtree(ddir, ignore_errors=True)
            return jsonify({"success": False, "error": "Transaction already used"}), 409

        return jsonify({
            "success": True,
            "token": token,
            "plan": plan_id,
            "plan_label": tier["label"],
            "badge_class": tier["badge_class"],
            "expires_at": expires.isoformat(),
            "max_downloads": tier["max_downloads"],
            "burn_after": bool(burn_after),
            "files": meta_files,
            "path": f"/burn/d/{token}",
            "hours_received": int(chain["hours_received"]),
            "txid": chain["txid"],
        })

    @app.route("/api/burn/<token>/claim-device", methods=["POST"])
    def api_burn_claim_device(token):
        """Bind a drop to this device for /mine when unowned (creator_key NULL).

        Requires passphrase when the drop is password-protected. Does NOT steal
        ownership from another device — only fills a blank creator_key.
        """
        token = (token or "").strip()
        if not token or len(token) < 16:
            return jsonify({"success": False, "error": "Invalid token"}), 404
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_claim", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("burn_claim"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        try:
            owner = (client_device_id() or "anon").strip()
        except Exception:
            owner = "anon"
        if owner == "anon":
            return jsonify({"success": False, "error": "Device id required"}), 400
        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ?", (token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Drop not found"}), 404
        now = datetime.now(timezone.utc)
        try:
            exp = datetime.fromisoformat(row["expires_at"])
        except Exception:
            exp = now
        if row["status"] != "active" or exp <= now:
            return jsonify({"success": False, "error": "Expired"}), 410
        if _row_has_password(row):
            pw = (request.form.get("password") or "").strip()
            if not _check_password(pw, row["password_hash"]):
                return jsonify({"success": False, "error": "Invalid passphrase"}), 403
        try:
            ck = row["creator_key"]
        except (KeyError, IndexError):
            ck = None
        if ck and str(ck).strip() and str(ck).strip() != owner:
            # Already owned by another device — do not steal
            return jsonify({
                "success": True,
                "claimed": False,
                "reason": "owned_elsewhere",
            })
        if not ck or not str(ck).strip():
            db.execute(
                "UPDATE burn_drops SET creator_key = ? WHERE public_token = ? AND (creator_key IS NULL OR creator_key = '')",
                (owner, token),
            )
            db.commit()
            return jsonify({"success": True, "claimed": True})
        return jsonify({"success": True, "claimed": True, "reason": "already_yours"})

    @app.route("/api/burn/<token>/publisher-open", methods=["POST"])
    def api_burn_publisher_open(token):
        """Publisher-only: open own drop without passphrase (device ownership)."""
        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_pub_open", limit=60, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        if not rate_ok(rate_key("burn_pub_open"), limit=20, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        try:
            owner = (client_device_id() or "anon").strip()
        except Exception:
            owner = "anon"
        if owner == "anon":
            return jsonify({"success": False, "error": "Device identity required"}), 403
        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ?",
            (token,),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Drop not found"}), 404
        ck = None
        try:
            ck = row["creator_key"]
        except (KeyError, IndexError):
            ck = None
        if ck and ck != owner:
            return jsonify({"success": False, "error": "Not your drop"}), 403
        # Legacy drops (no creator_key): bind to this device on first publisher open.
        # public_token is high-entropy — knowledge of the link is the capability.
        if not ck and owner and owner != "anon":
            try:
                db.execute(
                    "UPDATE burn_drops SET creator_key = ? WHERE public_token = ? AND (creator_key IS NULL OR creator_key = '')",
                    (owner, token),
                )
                db.commit()
            except Exception:
                pass
        now = datetime.now(timezone.utc)
        exp = datetime.fromisoformat(row["expires_at"])
        if row["status"] != "active" or exp <= now:
            return jsonify({
                "success": False,
                "error": "This drop has expired and burned",
                "status": row["status"],
            }), 410
        files = json.loads(row["files_json"] or "[]")
        try:
            allow_view = bool(row["allow_view"])
        except (KeyError, IndexError):
            allow_view = True
        try:
            allow_download = bool(row["allow_download"])
        except (KeyError, IndexError):
            allow_download = True
        # Issue view session so inline/file fetches work without passphrase
        vt = _issue_view_session(token)
        tier = BURN_TIERS.get(row["plan"]) or {}
        return jsonify({
            "success": True,
            "view_token": vt,
            "token": token,
            "plan": row["plan"],
            "plan_label": tier.get("label") or row["plan"],
            "badge_class": tier.get("badge_class") or "",
            "expires_at": row["expires_at"],
            "max_downloads": row["max_downloads"],
            "download_count": row["download_count"],
            "downloads_remaining": max(0, int(row["max_downloads"]) - int(row["download_count"])),
            "burn_after": bool(row["burn_after"]),
            "password_required": False,  # publisher path — already authorized
            "allow_view": allow_view,
            "allow_download": allow_download,
            "files": [
                {
                    "filename": f["filename"],
                    "size": f["size"],
                    "content_type": f.get("content_type"),
                    "kind": (
                        "note" if (f.get("filename") or "").endswith(".html")
                        else "audio" if str(f.get("content_type") or "").startswith("audio/")
                        else "image" if str(f.get("content_type") or "").startswith("image/")
                        else "file"
                    ),
                }
                for f in files
            ],
            "total_bytes": row["total_bytes"],
            "path": f"/burn/d/{token}",
            "publisher": True,
            "encrypted": bool(_row_enc_meta(row)),
            "enc_meta": _row_enc_meta(row),
        })

    @app.route("/api/burn/<token>", methods=["GET"])
    def api_burn_meta(token):
        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ?", (token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Drop not found"}), 404
        now = datetime.now(timezone.utc)
        exp = datetime.fromisoformat(row["expires_at"])
        if row["status"] != "active" or exp <= now:
            return jsonify({"success": False, "error": "This drop has expired and burned", "status": row["status"]}), 410
        files = json.loads(row["files_json"] or "[]")
        # Row may predate migration
        try:
            allow_view = bool(row["allow_view"])
        except (KeyError, IndexError):
            allow_view = True
        try:
            allow_download = bool(row["allow_download"])
        except (KeyError, IndexError):
            allow_download = True

        return jsonify({
            "success": True,
            "token": token,
            "plan": row["plan"],
            "expires_at": row["expires_at"],
            "max_downloads": row["max_downloads"],
            "download_count": row["download_count"],
            "downloads_remaining": max(0, row["max_downloads"] - row["download_count"]),
            "burn_after": bool(row["burn_after"]),
            # Source of truth is the stored hash (not current tier flag)
            "password_required": bool(_row_has_password(row)),
            "encrypted": bool(_row_enc_meta(row)),
            "enc_meta": _row_enc_meta(row),
            "allow_view": allow_view,
            "allow_download": allow_download,
            "files": [
                {
                    "filename": f["filename"],
                    "size": f["size"],
                    "content_type": f.get("content_type"),
                    "kind": (
                        "note" if (f.get("filename") or "").endswith(".html")
                        else "audio" if str(f.get("content_type") or "").startswith("audio/")
                        else "image" if str(f.get("content_type") or "").startswith("image/")
                        else "file"
                    ),
                }
                for f in files
            ],
            "total_bytes": row["total_bytes"],
        })

    @app.route("/api/burn/<token>/unlock", methods=["POST"])
    def api_burn_unlock(token):
        """Exchange passphrase for a short-lived view token (no password in image URLs).

        Brute-force: after 3 failures, exponential lockout (30s → 60s → … → 1h).
        During lockout, even a correct passphrase is refused. State is disk-persisted.
        """
        token = (token or "").strip()
        if not token or len(token) < 16:
            return jsonify({"success": False, "error": "Invalid token"}), 404

        rate_global = deps.get("_rate_global")
        if rate_global and not rate_global("burn_unlock", limit=60, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("burn_unlock"), limit=15, window=60):
            return jsonify({"success": False, "error": "Too many unlock attempts"}), 429

        # Per (drop, client IP) — device ID is client-controlled and must not
        # be part of the lockout identity (rotation would bypass the limit).
        try:
            ip = deps.get("_client_ip", lambda: "unknown")()
        except Exception:
            ip = "unknown"
        if not ip:
            ip = "unknown"
        lock_key = f"{token}:{ip}"

        wait = _unlock_lockout_remaining(lock_key)
        if wait > 0:
            return jsonify({
                "success": False,
                "error": f"Too many passphrase attempts. Try again in {wait}s.",
                "retry_after": wait,
            }), 429

        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ? AND status = 'active'",
            (token,),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found or expired"}), 404

        if HAS_FLASK:
            from flask import request as fr
            password = (fr.form.get("password") or "").strip()
            if not password and fr.is_json:
                body = fr.get_json(silent=True) or {}
                password = str(body.get("password") or "").strip()
        else:
            password = (request.form.get("password") or "").strip()

        if _row_has_password(row):
            if not password or not _check_password(password, row["password_hash"]):
                lock_sec = _unlock_register_failure(lock_key)
                if lock_sec > 0:
                    return jsonify({
                        "success": False,
                        "error": f"Invalid passphrase. Locked for {lock_sec}s after repeated failures.",
                        "retry_after": lock_sec,
                    }), 429
                return jsonify({"success": False, "error": "Invalid passphrase"}), 403
            _unlock_register_success(lock_key)
        # Passwordless or verified — issue view session
        vt = _issue_view_session(token)
        return jsonify({"success": True, "view_token": vt, "ttl": _VIEW_SESSION_TTL})

    @app.route("/api/burn/<token>/file/<int:idx>", methods=["GET", "POST"])
    def api_burn_download(token, idx):
        db = get_db()
        row = db.execute(
            "SELECT * FROM burn_drops WHERE public_token = ?", (token,)
        ).fetchone()
        if not row or row["status"] not in ("active", "burned"):
            return jsonify({"success": False, "error": "Drop not found"}), 404

        # Passwords only via POST /unlock → view_token. Never accept ?password=.
        view_token = ""
        inline = False
        if HAS_FLASK:
            from flask import request as fr
            view_token = (fr.form.get("view_token") or fr.args.get("view_token") or "").strip()
            inline = (fr.args.get("inline") or fr.form.get("inline") or "") in ("1", "true", "yes")
        else:
            view_token = (request.form.get("view_token") or request.args.get("view_token") or "").strip()
            inline = (request.args.get("inline") or request.form.get("inline") or "") in ("1", "true", "yes")
        closed = row["status"] == "burned"
        valid_session = _view_session_ok(view_token, token, finishing_pack=closed)
        # Passphrase-protected drops: every file byte requires a live view session
        # from POST /unlock. No anonymous inline/download path.
        if _row_has_password(row) and not valid_session:
            return jsonify({
                "success": False,
                "error": "Passphrase required",
                "password_required": True,
            }), 403
        if closed and not valid_session:
            return jsonify({"success": False, "error": "Drop not found"}), 404
        exp = datetime.fromisoformat(row["expires_at"])
        if exp <= datetime.now(timezone.utc):
            _destroy_drop(db, row)
            return jsonify({"success": False, "error": "Expired"}), 410
        if not closed and row["download_count"] >= row["max_downloads"]:
            return jsonify({"success": False, "error": "Access limit reached"}), 410
        if not valid_session:
            view_token = ""

        try:
            allow_view = bool(row["allow_view"])
        except (KeyError, IndexError):
            allow_view = True
        try:
            allow_download = bool(row["allow_download"])
        except (KeyError, IndexError):
            allow_download = True
        if inline and not allow_view:
            return jsonify({"success": False, "error": "Viewing is disabled for this drop"}), 403
        if not inline and not allow_download:
            return jsonify({"success": False, "error": "Download is disabled for this drop"}), 403

        files = json.loads(row["files_json"] or "[]")
        if idx < 0 or idx >= len(files):
            return jsonify({"success": False, "error": "File not found"}), 404
        meta = files[idx]
        path = _drop_dir(token) / meta["filename"]
        if not path.is_file():
            return jsonify({"success": False, "error": "File missing"}), 404
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return jsonify({"success": False, "error": "File missing"}), 404

        # Quota claim after a successful read. Inline view does not consume quota.
        should_burn = False
        if not inline:
            try:
                charged_count, should_burn = _charge_download_once(
                    db, row, view_token, token, multi_file=len(files) > 1
                )
            except _DownloadSessionRequired:
                return jsonify({
                    "success": False,
                    "error": "Reopen this link to start a download session, then try again.",
                }), 403
            if charged_count is None:
                return jsonify({"success": False, "error": "Drop is no longer available"}), 410

        if should_burn:
            try:
                _destroy_drop(db, row)
            except Exception as e:
                print(f"[BURN] destroy after download: {e}")

        if HAS_FLASK:
            from flask import Response
            disp = "inline" if inline else "attachment"
            fname = meta["filename"].replace('"', "")
            return Response(
                data,
                mimetype=meta.get("content_type") or "application/octet-stream",
                headers={
                    "Content-Disposition": f'{disp}; filename="{fname}"',
                    "Content-Length": str(len(data)),
                    "X-Content-Type-Options": "nosniff",
                },
            )
        return data
