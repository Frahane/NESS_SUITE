# Deploy NESS Suite

## A. No root (home account, e.g. `/home/debian`)

Use this when you **cannot** `sudo`:

```bash
bash scripts/deploy-user.sh
```

What it does:

- Installs under `~/ness-suite` (configurable)
- Creates a **user** Python venv and installs dependencies
- Writes `.env` with `FLASK_DEBUG=0` (never overwrites an existing `.env`)
- Starts via **systemd --user** *or* **tmux/screen/nohup**
- SMTP forced to **2525** (cannot bind privileged port 25 without root)

### Limits without root

| Need | Reality |
|------|---------|
| Public HTTP :80/:443 | Only if hoster proxies to your high port, or firewall allows e.g. 5000 |
| Public SMTP MX :25 | **Not possible** without root/CAP_NET_BIND / host SMTP relay |
| Survive logout | `loginctl enable-linger $USER` (needs admin once) **or** use `tmux` |
| system nginx | Use hoster panel / ask admin / expose app port |

### Day-to-day

```bash
~/ness-suite/start.sh
~/ness-suite/stop.sh
# or
systemctl --user status ness-suite
```

---

## B. Full VPS (root / sudo)

```bash
sudo bash scripts/deploy-vps.sh
```

System user, `/opt/ness-suite`, systemd system unit, optional nginx + UFW, optional CAP for SMTP :25.

---

## Security (both modes)

- Keep `.env` mode `600`
- Set a real `NCH_PAYMENT_ADDRESS`
- Leave `FLASK_DEBUG=0`
- Prefer bind `127.0.0.1` if a reverse proxy terminates TLS in front of you
