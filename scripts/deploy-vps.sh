#!/usr/bin/env bash
# NESS Suite — VPS deploy (interactive, production-oriented)
# Usage: sudo bash scripts/deploy-vps.sh
#        or: bash scripts/deploy-vps.sh  (will re-exec with sudo if needed)
set -euo pipefail

# ── constants ─────────────────────────────────────────────────────────────
APP_NAME="ness-suite"
DEFAULT_APP_USER="ness"
DEFAULT_INSTALL_DIR="/opt/ness-suite"
DEFAULT_HTTP_PORT="5000"
MIN_PYTHON="3.10"

# ── colours ───────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RST='\033[0m'; C_DIM='\033[2m'; C_BOLD='\033[1m'
  C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
else
  C_RST=; C_DIM=; C_BOLD=; C_OK=; C_WARN=; C_ERR=; C_INFO=
fi
ok()   { printf "${C_OK}✓${C_RST} %s\n" "$*"; }
warn() { printf "${C_WARN}!${C_RST} %s\n" "$*"; }
err()  { printf "${C_ERR}✗${C_RST} %s\n" "$*" >&2; }
info() { printf "${C_INFO}→${C_RST} %s\n" "$*"; }
die()  { err "$*"; exit 1; }

# ── root ──────────────────────────────────────────────────────────────────
need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    info "Re-running with sudo…"
    exec sudo -E bash "$0" "$@"
  fi
}

# ── helpers ───────────────────────────────────────────────────────────────
ask() {
  # ask VAR "prompt" "default"
  local __var="$1" __prompt="$2" __def="${3-}" __ans
  if [[ -n "$__def" ]]; then
    read -r -p "$(printf '%s [%s]: ' "$__prompt" "$__def")" __ans || true
    __ans="${__ans:-$__def}"
  else
    read -r -p "$(printf '%s: ' "$__prompt")" __ans || true
  fi
  printf -v "$__var" '%s' "$__ans"
}

ask_secret() {
  local __var="$1" __prompt="$2" __ans
  read -r -s -p "$(printf '%s: ' "$__prompt")" __ans || true
  echo
  printf -v "$__var" '%s' "$__ans"
}

ask_yn() {
  # ask_yn VAR "prompt" "Y|N"
  local __var="$1" __prompt="$2" __def="${3:-Y}" __ans
  read -r -p "$(printf '%s [%s]: ' "$__prompt" "$__def")" __ans || true
  __ans="${__ans:-$__def}"
  case "${__ans,,}" in
    y|yes) printf -v "$__var" '1' ;;
    *)     printf -v "$__var" '0' ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  have "$1" || die "Missing required command: $1"
}

python_ok() {
  local py="$1" ver
  have "$py" || return 1
  ver="$("$py" -c 'import sys; print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
  [[ -n "$ver" ]] || return 1
  printf '%s\n%s\n' "$MIN_PYTHON" "$ver" | sort -V | head -1 | grep -qx "$MIN_PYTHON"
}

detect_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if python_ok "$c"; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# ── banner ────────────────────────────────────────────────────────────────
banner() {
  cat <<EOF

${C_BOLD}NESS Suite — VPS deployment${C_RST}
${C_DIM}Production layout · systemd · optional nginx · fail-closed secrets${C_RST}

EOF
}

# ── detect source tree ────────────────────────────────────────────────────
find_source() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$here/app.py" && -f "$here/config.py" ]]; then
    echo "$here"
    return 0
  fi
  if [[ -f "./app.py" && -f "./config.py" ]]; then
    pwd
    return 0
  fi
  return 1
}

# ── main ──────────────────────────────────────────────────────────────────
main() {
  need_root "$@"
  banner

  require_cmd systemctl
  require_cmd useradd
  require_cmd install

  local SRC
  SRC="$(find_source)" || die "Run from NESS_SUITE tree (need app.py + config.py)."
  ok "Source: $SRC"

  local PY
  PY="$(detect_python)" || die "Python ${MIN_PYTHON}+ required."
  ok "Python: $PY ($("$PY" --version 2>&1))"

  # ── interactive config ──────────────────────────────────────────────────
  echo
  info "Install paths & identity"
  local APP_USER INSTALL_DIR HTTP_BIND HTTP_PORT DOMAIN
  ask APP_USER "System user for the service" "$DEFAULT_APP_USER"
  ask INSTALL_DIR "Install directory" "$DEFAULT_INSTALL_DIR"
  ask HTTP_BIND "HTTP bind address (127.0.0.1 behind nginx, 0.0.0.0 if exposed)" "127.0.0.1"
  ask HTTP_PORT "HTTP port" "$DEFAULT_HTTP_PORT"
  ask DOMAIN "Public hostname (for nginx / reminders, optional)" ""

  echo
  info "Mail / SMTP"
  local MAIL_DOMAIN SMTP_PORT SMTP_FALLBACK
  ask MAIL_DOMAIN "MAIL_DOMAIN (must match MX if public inbound)" "${DOMAIN:-example.com}"
  ask SMTP_PORT "Preferred SMTP port (25 needs root/CAP_NET_BIND_SERVICE)" "25"
  ask SMTP_FALLBACK "SMTP fallback port" "2525"

  echo
  info "Payments (NCH treasury — REQUIRED in production)"
  local NCH_ADDR EXPLORERS
  ask NCH_ADDR "NCH_PAYMENT_ADDRESS (treasury)" ""
  [[ -n "$NCH_ADDR" ]] || die "NCH_PAYMENT_ADDRESS is required for production."
  ask EXPLORERS "NESS_EXPLORER_URLS (comma-separated)" \
    "https://ness-explorer.magnetosphere.net,https://explorer.privateness.network"

  echo
  info "Optional EmerSSH / Emercoin RPC (leave empty to skip)"
  local EMC_URL EMC_USER EMC_PASS
  ask EMC_URL "EMERCOIN_RPC_URL" ""
  if [[ -n "$EMC_URL" ]]; then
    ask EMC_USER "EMERCOIN_RPC_USER" ""
    ask_secret EMC_PASS "EMERCOIN_RPC_PASS"
  else
    EMC_USER=""; EMC_PASS=""
  fi

  local WITH_NGINX WITH_UFW WITH_SMTP_CAP
  ask_yn WITH_NGINX "Install nginx reverse-proxy site config?" "Y"
  ask_yn WITH_UFW "Configure UFW allow 80/443 (and 25 if SMTP)?" "N"
  ask_yn WITH_SMTP_CAP "Grant CAP_NET_BIND_SERVICE to Python for port 25?" "N"

  echo
  info "Summary"
  cat <<EOF
  user          : $APP_USER
  install       : $INSTALL_DIR
  bind          : ${HTTP_BIND}:${HTTP_PORT}
  domain        : ${DOMAIN:-(none)}
  mail domain   : $MAIL_DOMAIN
  smtp          : $SMTP_PORT / fallback $SMTP_FALLBACK
  treasury      : ${NCH_ADDR:0:8}…
  explorers     : $EXPLORERS
  emercoin rpc  : ${EMC_URL:-(disabled)}
  nginx         : $WITH_NGINX
  ufw           : $WITH_UFW
EOF
  local CONFIRM
  ask_yn CONFIRM "Proceed?" "Y"
  [[ "$CONFIRM" == "1" ]] || die "Aborted."

  # ── packages ────────────────────────────────────────────────────────────
  info "Installing OS packages…"
  if have apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq python3-venv python3-pip curl ca-certificates \
      >/dev/null
    if [[ "$WITH_NGINX" == "1" ]]; then
      apt-get install -y -qq nginx >/dev/null || warn "nginx install failed — continue without"
    fi
  elif have dnf; then
    dnf install -y python3 python3-pip curl ca-certificates >/dev/null
    [[ "$WITH_NGINX" == "1" ]] && dnf install -y nginx >/dev/null || true
  else
    warn "Unknown package manager — ensure python3-venv is available."
  fi
  ok "Base packages"

  # ── user ────────────────────────────────────────────────────────────────
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$INSTALL_DIR" --create-home \
      --shell /usr/sbin/nologin "$APP_USER"
    ok "Created system user $APP_USER"
  else
    ok "User $APP_USER exists"
  fi

  # ── copy tree ───────────────────────────────────────────────────────────
  info "Installing application into $INSTALL_DIR…"
  mkdir -p "$INSTALL_DIR"
  # rsync-like copy without venv/db/data
  if have rsync; then
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.venv/' \
      --exclude '__pycache__/' \
      --exclude '*.db' \
      --exclude 'burn_data/' \
      --exclude 'storage_data/' \
      --exclude 'static/og/' \
      --exclude 'app_flat_backup.py' \
      --exclude '.pytest_cache/' \
      "$SRC/" "$INSTALL_DIR/"
  else
    # fallback
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name 'data' ! -name '.venv' ! -name '.env' -exec rm -rf {} +
    cp -a "$SRC/." "$INSTALL_DIR/"
    rm -rf "$INSTALL_DIR/.git" "$INSTALL_DIR/.venv" "$INSTALL_DIR/__pycache__" \
      "$INSTALL_DIR"/*.db "$INSTALL_DIR/burn_data" "$INSTALL_DIR/storage_data" \
      "$INSTALL_DIR/app_flat_backup.py" 2>/dev/null || true
  fi

  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/burn_data" "$INSTALL_DIR/storage_data"
  ok "Files installed"

  # ── venv + deps ────────────────────────────────────────────────────────
  info "Python venv + requirements…"
  if [[ ! -d "$INSTALL_DIR/.venv" ]]; then
    "$PY" -m venv "$INSTALL_DIR/.venv"
  fi
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.venv/bin/activate"
  pip install --upgrade pip wheel -q
  pip install -r "$INSTALL_DIR/requirements.txt" -q
  deactivate
  ok "Dependencies installed"

  # ── .env ────────────────────────────────────────────────────────────────
  local ENV_FILE="$INSTALL_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    warn ".env already exists — writing ${ENV_FILE}.new (not overwriting secrets)"
    ENV_FILE="${ENV_FILE}.new"
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated by scripts/deploy-vps.sh — $(date -u +%Y-%m-%dT%H:%MZ)
# Permissions should be 600, owner $APP_USER

MAIL_DOMAIN=$MAIL_DOMAIN
HTTP_HOST=$HTTP_BIND
HTTP_PORT=$HTTP_PORT
SMTP_HOST=0.0.0.0
SMTP_PORT=$SMTP_PORT
SMTP_FALLBACK_PORT=$SMTP_FALLBACK
DB_PATH=$INSTALL_DIR/data/ness_suite.db

NCH_PAYMENT_ADDRESS=$NCH_ADDR
NESS_EXPLORER_URLS=$EXPLORERS
PAYMENT_TX_MAX_AGE_SEC=604800
EXPLORER_TIMEOUT_SEC=12
PAYMENT_MIN_CONFIRMATIONS=0
TRUSTED_PROXIES=127.0.0.1,::1

# Never enable on a public host
FLASK_DEBUG=0

BURN_STORAGE_DIR=$INSTALL_DIR/burn_data
# STORAGE paths default under install dir if set in config

EMERCOIN_RPC_URL=$EMC_URL
EMERCOIN_RPC_USER=$EMC_USER
EMERCOIN_RPC_PASS=$EMC_PASS
SSH_ALLOW_LOCAL_ACTIVATE=0
EOF
  # If we wrote .env.new, remember; else .env
  if [[ "$ENV_FILE" == *.new ]]; then
    warn "Review and merge $ENV_FILE into $INSTALL_DIR/.env"
  else
    ok "Wrote $ENV_FILE"
  fi
  chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"
  chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
  chmod 600 "$INSTALL_DIR/.env.new" 2>/dev/null || true
  # data dirs writable
  chmod 750 "$INSTALL_DIR/data" "$INSTALL_DIR/burn_data" "$INSTALL_DIR/storage_data"

  # ── optional CAP_NET_BIND_SERVICE ───────────────────────────────────────
  local PY_BIN="$INSTALL_DIR/.venv/bin/python"
  if [[ "$WITH_SMTP_CAP" == "1" ]]; then
    if have setcap; then
      setcap 'cap_net_bind_service=+ep' "$PY_BIN" \
        && ok "CAP_NET_BIND_SERVICE on venv python" \
        || warn "setcap failed — SMTP may fall back to $SMTP_FALLBACK"
    else
      warn "setcap not available — install libcap2-bin"
    fi
  fi

  # ── systemd ─────────────────────────────────────────────────────────────
  info "systemd unit…"
  cat > "/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=NESS Suite (TempMail · Burn · Pay · Storage · EmerSSH)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_DIR
Environment=PATH=$INSTALL_DIR/.venv/bin:/usr/bin
EnvironmentFile=-$INSTALL_DIR/.env
ExecStart=$INSTALL_DIR/.venv/bin/python app.py
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data $INSTALL_DIR/burn_data $INSTALL_DIR/storage_data $INSTALL_DIR
# Allow bind low ports only if capability was set on the binary
AmbientCapabilities=
CapabilityBoundingSet=
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF

  # If CAP was granted, widen bounding set slightly for bind
  if [[ "$WITH_SMTP_CAP" == "1" ]]; then
    sed -i 's/^CapabilityBoundingSet=.*/CapabilityBoundingSet=CAP_NET_BIND_SERVICE/' \
      "/etc/systemd/system/${APP_NAME}.service"
    sed -i 's/^AmbientCapabilities=.*/AmbientCapabilities=CAP_NET_BIND_SERVICE/' \
      "/etc/systemd/system/${APP_NAME}.service"
  fi

  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service" >/dev/null
  systemctl restart "${APP_NAME}.service"
  sleep 1
  if systemctl is-active --quiet "${APP_NAME}.service"; then
    ok "Service ${APP_NAME} is active"
  else
    err "Service failed to start — journalctl -u ${APP_NAME} -n 50"
    systemctl status "${APP_NAME}.service" --no-pager || true
  fi

  # ── nginx ───────────────────────────────────────────────────────────────
  if [[ "$WITH_NGINX" == "1" && -n "$DOMAIN" && -d /etc/nginx ]]; then
    info "nginx site…"
    local NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}.conf"
    cat > "$NGINX_SITE" <<EOF
# NESS Suite — reverse proxy
# TLS: certbot --nginx -d $DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 700m;

    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location / {
        proxy_pass http://${HTTP_BIND}:${HTTP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
    if [[ -d /etc/nginx/sites-enabled ]]; then
      ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
    fi
    if nginx -t 2>/dev/null; then
      systemctl reload nginx
      ok "nginx configured for $DOMAIN → ${HTTP_BIND}:${HTTP_PORT}"
      info "Add TLS: certbot --nginx -d $DOMAIN"
    else
      warn "nginx -t failed — fix $NGINX_SITE manually"
    fi
  elif [[ "$WITH_NGINX" == "1" ]]; then
    warn "nginx skipped (need DOMAIN and /etc/nginx)"
  fi

  # ── UFW ─────────────────────────────────────────────────────────────────
  if [[ "$WITH_UFW" == "1" ]] && have ufw; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    if [[ "$SMTP_PORT" == "25" ]]; then
      ufw allow 25/tcp >/dev/null 2>&1 || true
    fi
    warn "UFW rules added — enable with: ufw enable  (only if you understand the impact)"
  fi

  # ── final ───────────────────────────────────────────────────────────────
  echo
  ok "Deployment complete"
  cat <<EOF

${C_BOLD}Next steps${C_RST}
  • Logs:     journalctl -u ${APP_NAME} -f
  • Status:   systemctl status ${APP_NAME}
  • Config:   ${INSTALL_DIR}/.env   (chmod 600)
  • DB:       ${INSTALL_DIR}/data/ness_suite.db

${C_BOLD}Mail (public MX)${C_RST}
  • A/AAAA → this host
  • MX ${MAIL_DOMAIN} → host (priority 10)
  • Inbound TCP ${SMTP_PORT} open; process must bind it
  • Until MX is live, test with: swaks --to you@${MAIL_DOMAIN} --server 127.0.0.1:${SMTP_FALLBACK}

${C_BOLD}Security checklist${C_RST}
  • FLASK_DEBUG must stay off
  • TRUSTED_PROXIES only includes your real reverse proxy
  • Keep NCH_PAYMENT_ADDRESS under your control
  • SSH Access NVS needs Emercoin RPC only if you use Activate on-chain
  • Back up ${INSTALL_DIR}/data and ${INSTALL_DIR}/.env

EOF
}

main "$@"
