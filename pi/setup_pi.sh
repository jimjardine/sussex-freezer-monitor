#!/usr/bin/env bash
# One-shot provisioning for the freezer-monitor Pi.
# Run ON THE PI, from the repo root (e.g. /home/pi/freezer-monitor):
#     bash pi/setup_pi.sh
# Idempotent — safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
echo "Repo: $REPO_DIR"

# 1. System packages + a GPIO backend for gpiozero.
#    Bookworm has python3-lgpio; Bullseye (older) only has python3-rpi.gpio.
#    Install whichever exist; don't fail if one is missing.
echo "== apt packages =="
sudo apt-get update -y
sudo apt-get install -y python3-venv python3-pip
sudo apt-get install -y python3-rpi.gpio || true   # Bullseye backend
sudo apt-get install -y python3-lgpio    || true   # Bookworm backend

# 2. Python virtualenv + deps.
#    --system-site-packages lets the venv use the apt-installed GPIO backend
#    (RPi.GPIO / lgpio) which is hard to pip-build on the Pi.
echo "== python venv =="
if [ ! -d .venv ]; then python3 -m venv --system-site-packages .venv; fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r pi/requirements.txt

# 3. Config check.
if [ ! -f pi/config.json ]; then
  echo "!! pi/config.json missing — copy pi/config.example.json and fill it in."
  exit 1
fi
if grep -q "PASTE_SERVICE_ROLE_KEY_HERE" pi/config.json; then
  echo "!! pi/config.json still has the placeholder service-role key. Edit it before starting the service."
fi

# 4. Install the systemd service, pointing at THIS repo dir + venv.
echo "== systemd service =="
SERVICE=/etc/systemd/system/freezer-monitor.service
sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=Sussex Ice Cream Freezer Door Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$REPO_DIR/pi
ExecStart=$REPO_DIR/.venv/bin/python $REPO_DIR/pi/door_monitor.py
Restart=always
RestartSec=5
Environment=FREEZER_CONFIG=$REPO_DIR/pi/config.json

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable freezer-monitor
echo
echo "Done. Start it with:   sudo systemctl start freezer-monitor"
echo "Watch logs with:       journalctl -u freezer-monitor -f"
echo "(Set mock_gpio:false in pi/config.json once switches are wired.)"
