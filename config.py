"""
NESS Suite — configuration (dotenv + environment).
TempMail · Burn · Pay · Storage share this module.

All secrets and deploy-specific values live in `.env` (see `.env.example`).
Python code imports from this module only — never hardcode production secrets.
"""

from __future__ import annotations

import os
from pathlib import Path

# Project root (directory containing this file)
BASE_DIR = Path(__file__).resolve().parent

# Optional python-dotenv — graceful if not installed
try:
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass


def _env(key: str, default: str | None = None) -> str | None:
    val = os.environ.get(key)
    if val is None or val == "":
        return default
    return val


def _env_int(key: str, default: int) -> int:
    raw = _env(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    raw = _env(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# ── Paths ────────────────────────────────────────────────────────────────
DB_PATH = _env("DB_PATH", str(BASE_DIR / "tempmail.db"))

# ── HTTP ─────────────────────────────────────────────────────────────────
HTTP_HOST = _env("HTTP_HOST", "0.0.0.0")
HTTP_PORT = _env_int("HTTP_PORT", 5000)

# ── SMTP ─────────────────────────────────────────────────────────────────
SMTP_HOST = _env("SMTP_HOST", "0.0.0.0")
# Port 25 needs root/CAP_NET_BIND_SERVICE. On Termux / non-root, use 2525.
SMTP_PORT = _env_int("SMTP_PORT", 25)
SMTP_FALLBACK_PORT = _env_int("SMTP_FALLBACK_PORT", 2525)
MAIL_DOMAIN = _env("MAIL_DOMAIN", "ourdomain.com")
# Alias used across the codebase
DOMAIN = MAIL_DOMAIN

CLEANUP_INTERVAL = _env_int("CLEANUP_INTERVAL", 60)

# ── Payments (PrivateNess / NCH) ─────────────────────────────────────────
NCH_PAYMENT_ADDRESS = _env(
    "NCH_PAYMENT_ADDRESS",
    "NESS1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
)

# Public site origin for absolute Open Graph URLs (optional).
# Example: https://suite.example.com — if empty, built from each request.
PUBLIC_BASE_URL = (_env("PUBLIC_BASE_URL", "") or "").strip().rstrip("/")

# Comma-separated explorer base URLs
_explorer_raw = _env(
    "NESS_EXPLORER_URLS",
    "https://ness-explorer.magnetosphere.net,https://explorer.privateness.network",
) or ""
NESS_EXPLORER_URLS = [u.strip().rstrip("/") for u in _explorer_raw.split(",") if u.strip()]
if not NESS_EXPLORER_URLS:
    NESS_EXPLORER_URLS = ["https://ness-explorer.magnetosphere.net"]

PAYMENT_TX_MAX_AGE_SEC = _env_int("PAYMENT_TX_MAX_AGE_SEC", 30 * 60)  # 30 min window; intents are primary anti-frontrun
EXPLORER_TIMEOUT_SEC = _env_int("EXPLORER_TIMEOUT_SEC", 12)
PAYMENT_MIN_CONFIRMATIONS = _env_int("PAYMENT_MIN_CONFIRMATIONS", 0)

# Comma-separated peers allowed to set X-Forwarded-For
_proxies = _env("TRUSTED_PROXIES", "127.0.0.1,::1") or ""
TRUSTED_PROXIES = {p.strip() for p in _proxies.split(",") if p.strip()}

# ── Commercial tiers (business logic stays in code; prices can be env-overridden later) ──
TIERS = {
    "free": {
        "id": "free",
        "label": "Discovery",
        "ttl_minutes": 5,
        "max_messages": 3,
        "custom_address": False,
        "custom_mode": None,
        "attachments": False,
        "max_attachment_mb": 0,
        "priority": False,
        "api_access": False,
        "ads": True,
        "price_nch": 0,
        "badge_class": "plan-free",
        "tagline": "Try it. No commitment.",
    },
    "flash": {
        "id": "flash",
        "label": "Flash",
        "ttl_minutes": 30,
        "max_messages": 12,
        "custom_address": False,
        "custom_mode": None,
        "attachments": False,
        "max_attachment_mb": 0,
        "priority": False,
        "api_access": False,
        "ads": False,
        "price_nch": _env_int("PRICE_FLASH_NCH", 80),
        "badge_class": "plan-flash",
        "tagline": "30 minutes. No ads. More capacity.",
    },
    "session": {
        "id": "session",
        "label": "Session",
        "ttl_minutes": 300,
        "max_messages": 50,
        "custom_address": True,
        "custom_mode": "prefix",
        "attachments": True,
        "max_attachment_mb": 2,
        "priority": False,
        "api_access": False,
        "ads": False,
        "price_nch": _env_int("PRICE_SESSION_NCH", 350),
        "badge_class": "plan-session",
        "tagline": "5 hours. Prefix personalization. Attachments.",
    },
    "day": {
        "id": "day",
        "label": "Day",
        "ttl_minutes": 1440,
        "max_messages": 150,
        "custom_address": True,
        "custom_mode": "full",
        "attachments": True,
        "max_attachment_mb": 10,
        "priority": False,
        "api_access": False,
        "ads": False,
        "price_nch": _env_int("PRICE_DAY_NCH", 900),
        "badge_class": "plan-day",
        "tagline": "24 hours. Full custom local-part.",
    },
    "week": {
        "id": "week",
        "label": "Week",
        "ttl_minutes": 10080,
        "max_messages": 750,
        "custom_address": True,
        "custom_mode": "full",
        "attachments": True,
        "max_attachment_mb": 25,
        "priority": True,
        "api_access": False,
        "ads": False,
        "price_nch": _env_int("PRICE_WEEK_NCH", 3200),
        "badge_class": "plan-week",
        "tagline": "7 days. Priority handling.",
    },
    "month": {
        "id": "month",
        "label": "Month",
        "ttl_minutes": 43200,
        "max_messages": 3000,
        "custom_address": True,
        "custom_mode": "full",
        "attachments": True,
        "max_attachment_mb": 50,
        "priority": True,
        "api_access": True,
        "ads": False,
        "price_nch": _env_int("PRICE_MONTH_NCH", 9000),
        "badge_class": "plan-month",
        "tagline": "30 days. API access. Full power.",
    },
}

PAID_PLAN_IDS = [k for k, v in TIERS.items() if v["price_nch"] > 0]

# ── NESS Burn (ephemeral file drops) — separate product, shared NCH rail ──
BURN_STORAGE_DIR = _env("BURN_STORAGE_DIR", str(BASE_DIR / "burn_data"))

# Burn pricing is intentionally independent from TempMail (PRICE_*_NCH).
# Override only via BURN_PRICE_* — never reuse mail prices by accident.
BURN_TIERS = {
    "free": {
        "id": "free",
        "label": "Spark",
        "ttl_minutes": _env_int("BURN_TTL_FREE_MIN", 15),
        "max_files": _env_int("BURN_MAX_FILES_FREE", 2),
        "max_size_mb": _env_int("BURN_MAX_MB_FREE", 20),
        "max_downloads": _env_int("BURN_MAX_DL_FREE", 1),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_FREE", 60),
        "max_note_chars": _env_int("BURN_MAX_NOTE_FREE", 1500),
        "burn_after_download": True,
        "password": False,
        "voice_anonymize": True,
        "price_nch": 0,
        "badge_class": "plan-free",
        "tagline": "15 min. Real PDF or photo test.",
    },
    "flash": {
        "id": "flash",
        "label": "Flash",
        "ttl_minutes": _env_int("BURN_TTL_FLASH_MIN", 60),
        "max_files": _env_int("BURN_MAX_FILES_FLASH", 5),
        "max_size_mb": _env_int("BURN_MAX_MB_FLASH", 100),
        "max_downloads": _env_int("BURN_MAX_DL_FLASH", 3),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_FLASH", 180),
        "max_note_chars": _env_int("BURN_MAX_NOTE_FLASH", 4000),
        "burn_after_download": False,
        "password": True,
        "voice_anonymize": True,
        "price_nch": _env_int("BURN_PRICE_FLASH_NCH", 100),
        "badge_class": "plan-flash",
        "tagline": "1 hour. Small confidential pack.",
    },
    "session": {
        "id": "session",
        "label": "Session",
        "ttl_minutes": _env_int("BURN_TTL_SESSION_MIN", 360),
        "max_files": _env_int("BURN_MAX_FILES_SESSION", 0),  # 0 = unlimited
        "max_size_mb": _env_int("BURN_MAX_MB_SESSION", 500),
        "max_downloads": _env_int("BURN_MAX_DL_SESSION", 15),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_SESSION", 600),
        "max_note_chars": _env_int("BURN_MAX_NOTE_SESSION", 12000),
        "burn_after_download": False,
        "password": True,
        "voice_anonymize": True,
        "price_nch": _env_int("BURN_PRICE_SESSION_NCH", 350),
        "badge_class": "plan-session",
        "tagline": "6 hours. Moderate leak session.",
    },
    "day": {
        "id": "day",
        "label": "Day",
        "ttl_minutes": _env_int("BURN_TTL_DAY_MIN", 1440),
        "max_files": _env_int("BURN_MAX_FILES_DAY", 0),
        "max_size_mb": _env_int("BURN_MAX_MB_DAY", 2048),
        "max_downloads": _env_int("BURN_MAX_DL_DAY", 50),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_DAY", 1800),
        "max_note_chars": _env_int("BURN_MAX_NOTE_DAY", 40000),
        "burn_after_download": False,
        "password": True,
        "voice_anonymize": True,
        "price_nch": _env_int("BURN_PRICE_DAY_NCH", 1000),
        "badge_class": "plan-day",
        "tagline": "24 hours. Whistleblowing volume.",
    },
    "week": {
        "id": "week",
        "label": "Week",
        "ttl_minutes": _env_int("BURN_TTL_WEEK_MIN", 10080),
        "max_files": _env_int("BURN_MAX_FILES_WEEK", 0),
        "max_size_mb": _env_int("BURN_MAX_MB_WEEK", 10240),
        "max_downloads": _env_int("BURN_MAX_DL_WEEK", 200),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_WEEK", 3600),
        "max_note_chars": _env_int("BURN_MAX_NOTE_WEEK", 80000),
        "burn_after_download": False,
        "password": True,
        "voice_anonymize": True,
        "price_nch": _env_int("BURN_PRICE_WEEK_NCH", 3500),
        "badge_class": "plan-week",
        "tagline": "7 days. Long-form investigation.",
    },
    "month": {
        "id": "month",
        "label": "Month",
        "ttl_minutes": _env_int("BURN_TTL_MONTH_MIN", 43200),
        "max_files": _env_int("BURN_MAX_FILES_MONTH", 0),
        "max_size_mb": _env_int("BURN_MAX_MB_MONTH", 51200),
        "max_downloads": _env_int("BURN_MAX_DL_MONTH", 1000),
        "max_audio_seconds": _env_int("BURN_MAX_AUDIO_MONTH", 7200),
        "max_note_chars": _env_int("BURN_MAX_NOTE_MONTH", 120000),
        "burn_after_download": False,
        "password": True,
        "voice_anonymize": True,
        "price_nch": _env_int("BURN_PRICE_MONTH_NCH", 10000),
        "badge_class": "plan-month",
        "tagline": "30 days. Collective drop box.",
    },
}

# ── NESS Storage (private objects, local encrypted blobs; IPFS backend later) ──
STORAGE_DIR = _env("STORAGE_DIR", str(BASE_DIR / "storage_data"))
STORAGE_TIERS = {
    # max_objects: 0 = unlimited (quota is max_size_mb only)
    "spark": {
        "id": "spark",
        "label": "Spark",
        "ttl_minutes": _env_int("STORAGE_TTL_SPARK_MIN", 1440),  # 24h starter
        "max_objects": _env_int("STORAGE_MAX_OBJECTS_SPARK", 0),
        "max_size_mb": _env_int("STORAGE_MAX_MB_SPARK", 100),
        "max_downloads": 0,
        "password": False,
        "price_nch": _env_int("STORAGE_PRICE_SPARK_NCH", 0),
        "badge_class": "plan-free",
        "tagline": "24 hours · 100 MB starter vault.",
    },
    "flash": {
        "id": "flash",
        "label": "Flash",
        "ttl_minutes": _env_int("STORAGE_TTL_FLASH_MIN", 10080),  # 7 days
        "max_objects": _env_int("STORAGE_MAX_OBJECTS_FLASH", 0),
        "max_size_mb": _env_int("STORAGE_MAX_MB_FLASH", 5120),  # 5 GB
        "max_downloads": 0,
        "password": False,
        "price_nch": _env_int("STORAGE_PRICE_FLASH_NCH", 80),
        "badge_class": "plan-flash",
        "tagline": "7 days · 5 GB travel vault.",
    },
    "day": {
        "id": "day",
        "label": "Short",
        "ttl_minutes": _env_int("STORAGE_TTL_DAY_MIN", 43200),  # 30 days
        "max_objects": _env_int("STORAGE_MAX_OBJECTS_DAY", 0),
        "max_size_mb": _env_int("STORAGE_MAX_MB_DAY", 20480),  # 20 GB
        "max_downloads": 0,
        "password": False,
        "price_nch": _env_int("STORAGE_PRICE_DAY_NCH", 450),
        "badge_class": "plan-day",
        "tagline": "30 days · 20 GB project backup.",
    },
    "week": {
        "id": "week",
        "label": "Medium",
        "ttl_minutes": _env_int("STORAGE_TTL_WEEK_MIN", 129600),  # 90 days
        "max_objects": _env_int("STORAGE_MAX_OBJECTS_WEEK", 0),
        "max_size_mb": _env_int("STORAGE_MAX_MB_WEEK", 102400),  # 100 GB
        "max_downloads": 0,
        "password": False,
        "price_nch": _env_int("STORAGE_PRICE_WEEK_NCH", 1600),
        "badge_class": "plan-week",
        "tagline": "90 days · 100 GB personal vault.",
    },
    "month": {
        "id": "month",
        "label": "Long",
        "ttl_minutes": _env_int("STORAGE_TTL_MONTH_MIN", 525600),  # 365 days
        "max_objects": _env_int("STORAGE_MAX_OBJECTS_MONTH", 0),
        "max_size_mb": _env_int("STORAGE_MAX_MB_MONTH", 512000),  # 500 GB
        "max_downloads": 0,
        "password": False,
        "price_nch": _env_int("STORAGE_PRICE_MONTH_NCH", 4800),
        "badge_class": "plan-month",
        "tagline": "1 year · 500 GB annual vault.",
    },
}

# Storage backend: "local" (default) or "ipfs" (HTTP API to Kubo / PrivateNess gateway)
STORAGE_BACKEND = _env("STORAGE_BACKEND", "local").strip().lower()
STORAGE_IPFS_API = _env("STORAGE_IPFS_API", "").rstrip("/")  # e.g. http://127.0.0.1:5001
STORAGE_IPFS_GATEWAY = _env("STORAGE_IPFS_GATEWAY", "").rstrip("/")  # e.g. http://127.0.0.1:8080
STORAGE_IPFS_TIMEOUT = _env_int("STORAGE_IPFS_TIMEOUT", 30)


# ── NESS Wormhole (client-side tools, paid access license) ──────────────
# Price 0 = free (no NCH). TTL is access window after successful payment.
WORMHOLE_TOOLS = {
    "dpo": {
        "id": "dpo",
        "label": "EmerDPO possession",
        "price_nch": _env_int("WORMHOLE_DPO_PRICE_NCH", 120),
        "ttl_minutes": _env_int("WORMHOLE_DPO_TTL_MIN", 10080),  # 7 days
        "tagline": "Issue QR lots · claim gates · command text only",
    },
    "offline": {
        "id": "offline",
        "label": "Offline sealed pair",
        "price_nch": _env_int("WORMHOLE_OFFLINE_PRICE_NCH", 120),
        "ttl_minutes": _env_int("WORMHOLE_OFFLINE_TTL_MIN", 10080),
        "tagline": "AES-256-GCM · two carriers · fully offline",
    },
}


# ── EmerSSH / Emercoin NVS (optional — SSH Access product) ───────────────
# When unset, activation stays local-pending and UI shows "RPC not configured".
EMERCOIN_RPC_URL = (_env("EMERCOIN_RPC_URL", "") or "").strip()
EMERCOIN_RPC_USER = (_env("EMERCOIN_RPC_USER", "") or "").strip()
EMERCOIN_RPC_PASS = (_env("EMERCOIN_RPC_PASS", "") or "").strip()
EMERCOIN_NVS_DAYS = _env_int("EMERCOIN_NVS_DAYS", 365)
SSH_MAX_KEYS_PER_DEVICE = _env_int("SSH_MAX_KEYS_PER_DEVICE", 20)

SSH_ALLOW_LOCAL_ACTIVATE = (_env("SSH_ALLOW_LOCAL_ACTIVATE", "0") or "0").strip() in ("1", "true", "yes")
