#!/usr/bin/env bash
# Add (or update) a Wi-Fi network on the Pi without a monitor/keyboard.
# Raspberry Pi OS Bookworm uses NetworkManager, so this just wraps nmcli.
#
# Usage (run on the Pi, e.g. over SSH):
#     bash pi/add-wifi.sh "NetworkName" "password"
#
# The Pi remembers every network you add and auto-joins whichever is in range,
# so you can pre-load your phone hotspot now and add the factory Wi-Fi on-site.

set -euo pipefail

SSID="${1:-}"
PASS="${2:-}"
if [ -z "$SSID" ] || [ -z "$PASS" ]; then
  echo "Usage: bash pi/add-wifi.sh \"SSID\" \"password\""
  exit 1
fi

echo "Adding Wi-Fi network: $SSID"
sudo nmcli connection add type wifi con-name "$SSID" ssid "$SSID" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" connection.autoconnect yes \
  >/dev/null 2>&1 || sudo nmcli device wifi connect "$SSID" password "$PASS"

echo "Saved. Known networks:"
nmcli -f NAME connection show | grep -vi loopback
echo
echo "Connecting now (if in range)…"
sudo nmcli connection up "$SSID" || true
nmcli -t -f STATE,CONNECTION device status | head -1
