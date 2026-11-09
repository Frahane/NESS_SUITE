# NESS Suite

**PrivateNess Network · NESS Coin-Hours (NCH) · TempMail · Burn · Pay · Storage**

Single-process Python application that serves several related products on one payment rail, one SQLite database, and one design system:

| Product | Role |
|---------|------|
| **NESS TempMail** | Ephemeral inboxes; inbound SMTP; paid capacity by TTL / quota |
| **NESS Burn** | One-time encrypted content drops (journalism, whistleblowing, handoff) |
| **NESS Pay** (Invoice) | Payment links: invoice, coffee, fundraising — NCH to *your* address |
| **NESS Wormhole** | Client-side DPO possession + offline sealed pair (no NCH rail) |
| **NESS Storage** | **Private** encrypted vault on this device — **not** for sharing (use Burn) |
| **EmerSSH (SSH Access)** | Manage SSH **public** keys; optional Emercoin NVS publish for EmerSSH hosts |

Paid activations settle **on-chain**.

---

## Design principles

1. **Sovereign reception** — inbound SMTP is in-process (`aiosmtpd`). Unregistered recipients are dropped with `250` (no bounce, no enumeration, no backscatter).
2. **Pay for capacity, not identity** — graduated plans; settlement in NCH on PrivateNess / Fiber.
3. **Opaque tokens** — APIs use high-entropy `public_token` values, never sequential IDs.
4. **Cross-product anti-replay** — every spent `tx_hash` is claimed once in `used_transactions` via `_claim_tx` (mail, burn, invoice, storage).
5. **Payment intents** — before paying, the client obtains a short-lived secret `intent_id`. Verification requires both `tx_hash` **and** a valid pending intent (anti front-running). The intent id stays in the browser session; it is not a user-facing copy field.
6. **Fail closed on explorers** — if explorers are unreachable, verification returns an explicit offline / explorer-down error. Confirmations are never invented.
7. **Client-side vault** — drafts and Storage payloads are encrypted with **NessVault** (Web Crypto) before leaving the browser when applicable.
8. **Rate limits** — sensitive endpoints use **IP** buckets plus **global** service caps. Device ID is for **ownership**, not rate keys.

---

## Architecture

```text
  Browser ──► HTTP (Flask)
                │
                ├── app.py          TempMail + shared helpers (claim, rates, explorers)
                ├── burn.py         Burn routes (register)
                ├── invoice.py      Pay / Invoice routes (register)
                ├── storage.py      Private Storage routes (register)
                ├── wormhole.py     Wormhole access licenses (register)
                ├── ssh.py          EmerSSH / SSH Access (register)
                └── config.py       dotenv only — no business logic

  SMTP thread ──► aiosmtpd ──► messages table (registered mailboxes only)
  Cleanup thread ──► purge expired mail / burn / invoice / storage / intents
  SQLite (WAL) ──► single DB_PATH
  Explorers ──► NESS_EXPLORER_URLS (failover, cached probe)
```

### Frontend layout

```text
templates/     index.html | burn.html | invoice.html | storage.html | ssh.html | wormhole*.html
static/css/    app.css (design system) + product overrides
static/js/     ness-crypto.js → suite-nav.js → confirm-modal.js → product.js
```

Theme key is exactly **`ness_theme`** (`light` | `dark`) across all products.

---

## Products in brief

### TempMail

- Plans: Discovery (free) → Flash → Session → Day → Week → Month  
- Opaque mailbox token; message list + sandboxed reader; attachments gated by tier  
- **Renew** extends TTL: *time remaining + new plan duration*

### Burn

- Ephemeral **publish** of notes, files, voice (optional passphrase on higher tiers)  
- Limits: size, file count (`0` = unlimited), downloads, audio length  
- Public view/download; optional burn-after-download  
- **Not** a permanent archive — use Storage for private retention, Burn for handoff

### Pay (Invoice)

- Purposes: invoice, buy-me-coffee, fundraiser, other  
- Payee address is **the merchant’s** NESS address (not the suite treasury)  
- Manage token for cancel/rotate; unpaid caps per purpose on the server  
- Fiber has **no** payment memo field — do not expect on-chain memos

### Storage

- **Personal vault only** — ciphertext stored for the owning device; no share links  
- Client encrypts with NessVault before upload; server stores opaque blobs  
- Backend: `STORAGE_BACKEND=local` (default, destroy-on-expiry) or experimental `ipfs`  
- Free tier is **capped per device** (objects + cumulative bytes) even when plan `max_objects` is unlimited  
- Global disk hard cap: `STORAGE_HARD_DISK_CAP_MB`  
- **Renew** same rule as mail/burn: remaining + plan TTL  

---

## Plan tables (defaults — override via `.env`)

Amounts and limits are defined in `config.py` and are **environment-overridable**. Defaults below match the code at packaging time.


### Wormhole

- Client-side tools: **EmerDPO possession** and **Offline sealed pair**
- No server-side payload storage; optional **NCH access license** per tool + device
- Prices / TTL via dotenv: `WORMHOLE_DPO_PRICE_NCH`, `WORMHOLE_OFFLINE_PRICE_NCH`, `WORMHOLE_*_TTL_MIN` (0 NCH = free)
- Dedicated API: `GET /api/wormhole/access`, `POST /api/wormhole/intent`, `POST /api/wormhole/verify`
- Cross-product anti-replay via `_claim_tx` + `wormhole_licenses.tx_hash`


### TempMail (`TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Discovery | 0 | 5 min | 3 messages |
| Flash | 80 | 30 min | 12 messages |
| Session | 350 | 5 h | 50 messages · attach ≤ 2 MB |
| Day | 900 | 1 day | 150 messages · attach ≤ 10 MB |
| Week | 3200 | 7 days | 750 messages · attach ≤ 25 MB |
| Month | 9000 | 30 days | 3000 messages · attach ≤ 50 MB |

### Burn (`BURN_TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Spark | 0 | 15 min | 20 MB · 2 files · 1 download |
| Flash | 100 | 1 h | 100 MB · 5 files · 3 downloads |
| Session | 350 | 6 h | 500 MB · unlimited files · 15 downloads |
| Day | 1000 | 1 day | 2 GB · unlimited · 50 downloads |
| Week | 3500 | 7 days | 10 GB · unlimited · 200 downloads |
| Month | 10000 | 30 days | 50 GB · unlimited · 1000 downloads |

### Storage (`STORAGE_TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Spark | 0 | 24 h | 100 MB (free device caps still apply) |
| Flash | 80 | 7 days | 5 GB |
| Short | 450 | 30 days | 20 GB |
| Medium | 1600 | 90 days | 100 GB |
| Long | 4800 | 365 days | 500 GB |

Free Storage additionally enforces per-device limits (`STORAGE_FREE_DEVICE_OBJECTS`, `STORAGE_FREE_DEVICE_MB`) to prevent disk abuse.

---

## Configuration

Copy `.env.example` → `.env`. **Never** commit a live treasury key or production address as a secret in git; `NCH_PAYMENT_ADDRESS` is the suite receive address for **TempMail / Burn / Storage** plans. Invoice payees use the address entered by the merchant.

Important variables:

| Variable | Role |
|----------|------|
| `NCH_PAYMENT_ADDRESS` | Treasury / plan settlement address |
| `NESS_EXPLORER_URLS` | Comma-separated explorer bases (failover) |
| `MAIL_DOMAIN` | Domain shown on generated addresses |
| `SMTP_PORT` / `SMTP_FALLBACK_PORT` | 25 then fallbacks (e.g. 2525 on non-root) |
| `DB_PATH` | SQLite file |
| `MAX_CONTENT_LENGTH_MB` | Flask body limit for a single request (default 2048 MB; not the same as tier quota) |
| `STORAGE_BACKEND` | `local` (recommended) or `ipfs` |
| `STORAGE_HARD_DISK_CAP_MB` | Global Storage disk ceiling |
| `STORAGE_PRICE_*` / `BURN_PRICE_*` / `STORAGE_MAX_MB_*` / TTLs | Plan economics |

See `.env.example` for the full list of plan price and capacity keys.

---

## Payment verification flow

1. Client selects a paid plan → `POST /api/payment/intent` with `product` + `plan`  
2. Server stores a pending **intent** (`intent_id`, catalog `amount_nch`, expiry)  
3. User sends **at least** that amount of NCH to the pay address  
4. Client submits `tx_hash` + session `intent_id` to the product verify/pay endpoint  
5. Server checks intent → explorers → `_tx_already_used` → **`_claim_tx`** → business insert  

Overpayment is accepted (`>=` required amount). Explorer failures distinguish **offline** (no network) vs **explorer_down** when possible.

Detailed notes: [`docs/PAYMENTS.md`](docs/PAYMENTS.md).

---

## Security (implemented)

- Opaque tokens; no sequential IDOR on mail/burn/storage/invoice  
- `_claim_tx` + `used_transactions` cross-product  
- Payment **intent_id** anti front-running  
- IP + global rate limits; unlock lockout (Burn)  
- CSP / nosniff / frame deny / referrer policy on responses  
- HTML sanitization for Burn notes (tags, `on*`, `javascript:`, `data:text/html`)  
- Passwords never in URL query strings (Burn: view_token after unlock)  
- Device ID header for ownership; anon fails closed on create/list where required  
- Storage free-tier and disk caps; cleanup of expired objects and stale intents  

---

## Run (development)

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set NCH_PAYMENT_ADDRESS, MAIL_DOMAIN, …
python app.py
```

UI: `http://127.0.0.1:5000/` · Burn `/burn` · Pay `/invoice` · Storage `/storage`

SMTP on non-root hosts typically binds **2525** (see startup logs). Internet MX still expects port **25** on a real VPS with DNS MX records.

### Local mail inject (paid/active address only)

```python
import smtplib
from email.mime.text import MIMEText

RECIPIENT = "your-active-address@yourdomain.com"
msg = MIMEText("Body")
msg["Subject"] = "Local test"
msg["From"] = "tester@example.org"
msg["To"] = RECIPIENT

with smtplib.SMTP("127.0.0.1", 2525, timeout=10) as s:
    s.sendmail(msg["From"], [RECIPIENT], msg.as_string())
```

---

## Dependencies

```text
flask>=3.0.0
aiosmtpd>=1.4.0
python-dotenv>=1.0.0
```

No frontend framework. Optional: explorer connectivity only (HTTPS outbound).

---

## Production checklist

- [ ] Real `NCH_PAYMENT_ADDRESS` (not a placeholder)  
- [ ] `MAIL_DOMAIN` + DNS **MX** / A for SMTP on port 25 (or 25→app reverse forward)  
- [ ] `FLASK_DEBUG` unset or false  
- [ ] Reverse proxy body size aligned with `MAX_CONTENT_LENGTH_MB`  
- [ ] Disk monitoring if Storage is enabled (`STORAGE_HARD_DISK_CAP_MB`)  
- [ ] Prefer `STORAGE_BACKEND=local` unless IPFS unpin/GC is operated deliberately  
- [ ] Backup policy for `DB_PATH` (tokens, invoices, audit)  

---

## Repository layout

```text
app.py              Orchestration, TempMail, shared payment/rate/explorer helpers
burn.py             Burn product
invoice.py          Pay / Invoice product
storage.py          Private Storage product
config.py           dotenv-backed settings and tier tables
templates/          HTML shells
static/css|js/      Design system + product scripts
docs/PAYMENTS.md    Payment integration notes
.env.example        Environment template
requirements.txt
```

---

## What this is not

- Not a full Skycoin node or wallet — verification is via public explorers  
- Not a shared cloud drive — **Storage is private to the device vault**; sharing is **Burn**  
- Not KYC’d virtual numbers or identity services  

NESS Suite is built to stay small, auditable, and honest about cryptography and chain settlement.

**Powered by PrivateNess Network**


---

## EmerSSH (SSH Access)

**UI path:** `/ssh-access`  
**Menu label:** EmerSSH (SSH Access)  
**Module:** `ssh.py` · **UI:** `templates/ssh.html`, `static/js/ssh.js`, `static/css/ssh.css`

### What it is

A suite page to **register SSH public keys**, activate them for authorization, and revoke them.  
Private keys are generated **in the browser** (Web Crypto) or supplied by the user; they are **never uploaded** to NESS Suite.

When Emercoin JSON-RPC is configured on the **server**, activation publishes the public key into **Emercoin NVS** under a name of the form:

```text
ssh:ness:<username>:<token>
```

SSH hosts that run **EmerSSH** (`emcssh` as `AuthorizedKeysCommand`) can authorize logins from those NVS records. Configuring the coin daemon and `emcssh` is an **operator** task (dotenv + server packages), not an end-user chore in the UI.

### User flow (no ops jargon)

1. Open **EmerSSH (SSH Access)**.
2. **Generate keypair** (Ed25519, ECDSA P-256/P-384, RSA 2048/4096) *or* paste / upload a `.pub` file.
3. Download and safeguard the **private** key (shown once).
4. **Register** the public key (status `pending`), then **Activate**.
5. Optionally set **Server host** (domain or IP) and **Use in command** to copy `ssh user@host`.
6. **Revoke** when access must end.

Device identity (`X-Device-Id` / NessVault) owns the key rows. Anonymous browsers cannot create keys.

### Operator configuration (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `EMERCOIN_RPC_URL` | For on-chain activate | JSON-RPC endpoint, e.g. `http://127.0.0.1:6662` |
| `EMERCOIN_RPC_USER` | With URL | RPC username |
| `EMERCOIN_RPC_PASS` | With URL | RPC password |
| `EMERCOIN_NVS_DAYS` | No (default `365`) | NVS lease days for `name_new` / `name_update` |
| `SSH_MAX_KEYS_PER_DEVICE` | No (default `20`) | Cap of non-revoked keys per device owner |
| `SSH_ALLOW_LOCAL_ACTIVATE` | No (default off) | `1` / `true` — lab only: mark keys `active` **without** NVS publish |

RPC credentials are read from the process environment on **each** RPC call (supports updating env without editing code). Prefer reloading the app process after changing secrets.

**Without** `EMERCOIN_RPC_URL`:

- Users can still **save** public keys (`pending`).
- **Activate** returns a temporary failure (user-facing, no `.env` leakage), unless `SSH_ALLOW_LOCAL_ACTIVATE=1`.

### API (summary)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/ssh-access` | Page |
| `GET` | `/api/ssh/status` | `{ rpc_configured, max_keys, … }` |
| `GET` | `/api/ssh/keys` | List current device keys |
| `POST` | `/api/ssh/keys` | Body JSON `{ username, public_key }` |
| `POST` | `/api/ssh/keys/<id>/activate` | NVS publish or gated local |
| `DELETE` | `/api/ssh/keys/<id>` | Revoke (best-effort `name_delete`) |

Rate limits: per-IP via `_rate_key` + `_rate_global` on list/add/activate/revoke.

### SSH server (operator only)

On hosts that should honor NVS-backed keys:

```text
AuthorizedKeysCommand /usr/local/bin/emcssh
AuthorizedKeysCommandUser root
```

Install and configure **emcssh** according to EmerSSH / Emercoin documentation. Leave classic `authorized_keys` management empty if NVS is the sole source of truth.

### Security properties

- Public keys only in SQLite (`ssh_keys`); fingerprints SHA256 (OpenSSH-style).
- Username: `^[a-z][a-z0-9_-]{0,31}$`.
- Public key max length 8 KiB; format `ssh-ed25519` / `ssh-rsa` / `ecdsa-sha2-nistp*`.
- Ownership: `creator_key` from device id; `anon` cannot mutate.
- Revoke is idempotent; NVS delete failures still mark local `revoked`.
- Generated private PEM is wiped from the DOM after register/close.

### Database

Table `ssh_keys` (created on register):  
`id`, `creator_key`, `username`, `public_key`, `fingerprint`, `key_type`, `status` (`pending`|`active`|`revoked`), `nvs_name`, `created_at`, `activated_at`, `revoked_at`.

### Typography (suite)

- **Inter** — UI chrome and body (clean, modern, high legibility on mobile).
- **JetBrains Mono** — fingerprints, keys, commands, SSH snippets.
- **Newsreader** — reserved for long-form reading surfaces (e.g. Burn notes), not the EmerSSH control panel.

