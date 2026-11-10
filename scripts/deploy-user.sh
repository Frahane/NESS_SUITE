#!/usr/bin/env bash
# NESS Suite — user-space deploy (no root required)
# Target: restricted VPS account e.g. /home/debian
# Usage: bash scripts/deploy-user.sh
set -euo pipefail

APP_NAME="ness-suite"
DEFAULT_DIR="${HOME}/ness-suite"
DEFAULT_HTTP_PORT="5000"
MIN_PYTHON="3.10"

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

ask() {
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
  local __var="$1" __prompt="$2" __def="${3:-Y}" __ans
  read -r -p "$(printf '%s [%s]: ' "$__prompt" "$__def")" __ans || true
  __ans="${__ans:-$__def}"
  case "${__ans,,}" in y|yes) printf -v "$__var" '1' ;; *) printf -v "$__var" '0' ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

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
    python_ok "$c" && { echo "$c"; return 0; }
  done
  return 1
}

find_source() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [[ -f "$here/app.py" && -f "$here/config.py" ]] && { echo "$here"; return 0; }
  [[ -f "./app.py" && -f "./config.py" ]] && { pwd; return 0; }
  return 1
}

port_free() {
  local p="$1"
  if have ss; then
    ! ss -ltn 2>/dev/null | grep -qE ":${p}\\s"
  elif have netstat; then
    ! netstat -ltn 2>/dev/null | grep -qE ":${p}\\s"
  else
    return 0
  fi
}

write_user_unit() {
  local unit_dir="$1" install_dir="$2" http_port="$3"
  mkdir -p "$unit_dir"
  cat > "${unit_dir}/${APP_NAME}.service" <<EOF
[Unit]
Description=NESS Suite (user service)
After=default.target

[Service]
Type=simple
WorkingDirectory=${install_dir}
Environment=PATH=${install_dir}/.venv/bin:/usr/bin
EnvironmentFile=-${install_dir}/.env
ExecStart=${install_dir}/.venv/bin/python app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

main() {
  if [[ "${EUID}" -eq 0 ]]; then
    warn "You are root. Prefer scripts/deploy-vps.sh for system install."
    warn "Continuing in user-style under /root is possible but not recommended."
  fi

  cat <<EOF

${C_BOLD}NESS Suite — user deploy (no root)${C_RST}
${C_DIM}Installs under your home · no systemd system unit · SMTP :25 unavailable${C_RST}

EOF

  local SRC PY
  SRC="$(find_source)" || die "Run from NESS_SUITE tree (need app.py + config.py)."
  ok "Source: $SRC"
  PY="$(detect_python)" || die "Python ${MIN_PYTHON}+ required (no root to install it)."
  ok "Python: $PY ($("$PY" --version 2>&1))"

  local INSTALL_DIR HTTP_BIND HTTP_PORT MAIL_DOMAIN
  ask INSTALL_DIR "Install directory" "$DEFAULT_DIR"
  ask HTTP_BIND "HTTP bind (0.0.0.0 if you need external access)" "0.0.0.0"
  ask HTTP_PORT "HTTP port (>1024 without root)" "$DEFAULT_HTTP_PORT"
  [[ "$HTTP_PORT" -gt 1024 ]] 2>/dev/null || warn "Port $HTTP_PORT may require privileges — prefer 5000/8080."
  ask MAIL_DOMAIN "MAIL_DOMAIN" "example.com"

  local NCH_ADDR EXPLORERS
  ask NCH_ADDR "NCH_PAYMENT_ADDRESS (treasury)" ""
  [[ -n "$NCH_ADDR" ]] || die "NCH_PAYMENT_ADDRESS is required."
  ask EXPLORERS "NESS_EXPLORER_URLS" \
    "https://ness-explorer.magnetosphere.net,https://explorer.privateness.network"

  local EMC_URL EMC_USER EMC_PASS
  ask EMC_URL "EMERCOIN_RPC_URL (optional)" ""
  if [[ -n "$EMC_URL" ]]; then
    ask EMC_USER "EMERCOIN_RPC_USER" ""
    ask_secret EMC_PASS "EMERCOIN_RPC_PASS"
  else
    EMC_USER=""; EMC_PASS=""
  fi

  local USE_SYSTEMD_USER START_NOW
  ask_yn USE_SYSTEMD_USER "Enable systemd --user service (survives logout if lingering on)?" "Y"
  ask_yn START_NOW "Start the app now?" "Y"

  if ! port_free "$HTTP_PORT"; then
    warn "Port $HTTP_PORT looks busy — choose another if start fails."
  fi

  local CONFIRM
  ask_yn CONFIRM "Proceed installing into $INSTALL_DIR?" "Y"
  [[ "$CONFIRM" == "1" ]] || die "Aborted."

  # ── copy ────────────────────────────────────────────────────────────────
  info "Installing into $INSTALL_DIR…"
  mkdir -p "$INSTALL_DIR"
  if have rsync; then
    rsync -a \
      --exclude '.git/' \
      --exclude '.venv/' \
      --exclude '__pycache__/' \
      --exclude '*.db' \
      --exclude 'burn_data/' \
      --exclude 'storage_data/' \
      --exclude 'static/og/' \
      --exclude 'app_flat_backup.py' \
      --exclude '.pytest_cache/' \
      --exclude '.env' \
      "$SRC/" "$INSTALL_DIR/"
  else
    # careful not to wipe existing data
    for item in app.py burn.py invoice.py storage.py ssh.py wormhole.py config.py \
                requirements.txt templates static scripts docs tests; do
      if [[ -e "$SRC/$item" ]]; then
        rm -rf "$INSTALL_DIR/$item"
        cp -a "$SRC/$item" "$INSTALL_DIR/$item"
      fi
    done
    [[ -f "$SRC/README.md" ]] && cp -a "$SRC/README.md" "$INSTALL_DIR/"
  fi
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/burn_data" "$INSTALL_DIR/storage_data"
  ok "Files in place"

  # ── venv ────────────────────────────────────────────────────────────────
  info "venv + pip…"
  if [[ ! -d "$INSTALL_DIR/.venv" ]]; then
    "$PY" -m venv "$INSTALL_DIR/.venv"
  fi
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.venv/bin/activate"
  pip install --upgrade pip wheel -q
  pip install -r "$INSTALL_DIR/requirements.txt" -q
  deactivate
  ok "Dependencies ready"

  # ── .env ────────────────────────────────────────────────────────────────
  local ENV_FILE="$INSTALL_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    warn ".env exists — writing ${ENV_FILE}.new only"
    ENV_FILE="${ENV_FILE}.new"
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
# User deploy — $(date -u +%Y-%m-%dT%H:%MZ)
# No root: SMTP binds fallback port only (not public MX on :25)

MAIL_DOMAIN=$MAIL_DOMAIN
HTTP_HOST=$HTTP_BIND
HTTP_PORT=$HTTP_PORT
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_FALLBACK_PORT=2525
DB_PATH=$INSTALL_DIR/data/ness_suite.db

NCH_PAYMENT_ADDRESS=$NCH_ADDR
NESS_EXPLORER_URLS=$EXPLORERS
PAYMENT_TX_MAX_AGE_SEC=604800
EXPLORER_TIMEOUT_SEC=12
PAYMENT_MIN_CONFIRMATIONS=0
TRUSTED_PROXIES=127.0.0.1,::1

FLASK_DEBUG=0

BURN_STORAGE_DIR=$INSTALL_DIR/burn_data

EMERCOIN_RPC_URL=$EMC_URL
EMERCOIN_RPC_USER=$EMC_USER
EMERCOIN_RPC_PASS=$EMC_PASS
SSH_ALLOW_LOCAL_ACTIVATE=0
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  if [[ "$ENV_FILE" == *.new ]]; then
    warn "Merge $ENV_FILE into $INSTALL_DIR/.env then restart"
  else
    ok "Wrote $ENV_FILE (mode 600)"
  fi

  # ── helper scripts ──────────────────────────────────────────────────────
  cat > "$INSTALL_DIR/start.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$INSTALL_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
set -a
# shellcheck disable=SC1091
source .env
set +a
exec python app.py
EOF
  chmod +x "$INSTALL_DIR/start.sh"

  cat > "$INSTALL_DIR/stop.sh" <<EOF
#!/usr/bin/env bash
# Stop process listening on configured HTTP port or matching app.py
PORT=\$(grep -E '^HTTP_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
PORT=\${PORT:-5000}
if command -v fuser >/dev/null 2>&1; then
  fuser -k "\${PORT}/tcp" 2>/dev/null || true
fi
pkill -f "$INSTALL_DIR/.venv/bin/python app.py" 2>/dev/null || true
echo "Stop signal sent."
EOF
  chmod +x "$INSTALL_DIR/stop.sh"
  ok "start.sh / stop.sh"

  # ── systemd --user ───────────────────────────────────────────────────────
  if [[ "$USE_SYSTEMD_USER" == "1" ]] && have systemctl; then
    local UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    write_user_unit "$UNIT_DIR" "$INSTALL_DIR" "$HTTP_PORT"
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user enable "${APP_NAME}.service" 2>/dev/null; then
      ok "systemd --user unit enabled"
      info "If the service dies after logout: sudo loginctl enable-linger \$USER"
      info "(requires an admin once — without it, use screen/tmux + start.sh)"
    else
      warn "systemctl --user enable failed — use ./start.sh in tmux/screen instead"
      USE_SYSTEMD_USER=0
    fi
  else
    USE_SYSTEMD_USER=0
  fi

  # ── start ───────────────────────────────────────────────────────────────
  if [[ "$START_NOW" == "1" ]]; then
    if [[ "$USE_SYSTEMD_USER" == "1" ]]; then
      systemctl --user restart "${APP_NAME}.service" 2>/dev/null || true
      sleep 1
      if systemctl --user is-active --quiet "${APP_NAME}.service" 2>/dev/null; then
        ok "Service running (systemd --user)"
      else
        warn "systemd --user start failed — try: $INSTALL_DIR/start.sh"
        systemctl --user status "${APP_NAME}.service" --no-pager 2>/dev/null || true
      fi
    else
      if have tmux; then
        tmux has-session -t "$APP_NAME" 2>/dev/null && tmux kill-session -t "$APP_NAME" || true
        tmux new-session -d -s "$APP_NAME" "$INSTALL_DIR/start.sh"
        ok "Started in tmux session '$APP_NAME' (tmux attach -t $APP_NAME)"
      elif have screen; then
        screen -S "$APP_NAME" -dm bash "$INSTALL_DIR/start.sh"
        ok "Started in screen '$APP_NAME'"
      else
        nohup "$INSTALL_DIR/start.sh" >"$INSTALL_DIR/data/ness.log" 2>&1 &
        ok "Started with nohup (log: $INSTALL_DIR/data/ness.log)"
      fi
    fi
  fi

  echo
  ok "User deploy complete"
  cat <<EOF

${C_BOLD}Paths${C_RST}
  App:     $INSTALL_DIR
  Env:     $INSTALL_DIR/.env
  DB:      $INSTALL_DIR/data/ness_suite.db
  Start:   $INSTALL_DIR/start.sh
  Stop:    $INSTALL_DIR/stop.sh

${C_BOLD}Limits without root${C_RST}
  • No bind on port 25 → SMTP uses 2525 (local tests only, not public MX)
  • No system nginx/certbot → put a reverse proxy in front if your host provides one,
    or expose ${HTTP_BIND}:${HTTP_PORT} if the firewall allows your user ports
  • systemd --user may stop on logout unless admin runs: loginctl enable-linger $USER
  • Fallback: keep the process in tmux/screen

${C_BOLD}Useful commands${C_RST}
  curl -s http://127.0.0.1:${HTTP_PORT}/ | head
  systemctl --user status ${APP_NAME}     # if unit enabled
  journalctl --user -u ${APP_NAME} -f
  tmux attach -t ${APP_NAME}

EOF
}

main "$@"
