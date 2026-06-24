# Pi Agent — Wiring & Setup

The Raspberry Pi reads one microswitch per freezer door and reports to Supabase.

## Wiring (per door) — fail-safe

Using the CZH-LABS F-1019 screw-terminal breakout and the **V-156-1C25** SPDT
microswitches:

```
  Switch COM  ──────────────► GND      (any GND terminal)
  Switch NO   ──────────────► GPIO pin (e.g. GPIO17)
  Switch NC   ── leave unused
```

Enable the Pi's **internal pull-up** (the agent does this in code). Mount each
switch so that **closing the door presses the lever**:

| Door state        | Circuit        | GPIO reads | Meaning |
|-------------------|----------------|------------|---------|
| Closed (lever in) | COM–NO closed  | LOW        | closed  |
| Open  (lever out) | COM–NO open    | HIGH       | open    |
| Broken/cut wire   | open           | HIGH       | open → **alarms** |

Because a cut wire reads as "open", failures fail *safe* (you get an alert)
rather than silently reporting a door as closed.

Suggested pins (BCM numbering), matching `supabase/seed.sql`:

| Door            | GPIO | Physical pin |
|-----------------|------|--------------|
| Walk-in Freezer | 17   | 11           |
| Chest Freezer 1 | 27   | 13           |
| Chest Freezer 2 | 22   | 15           |

Run twisted pair (CAT5/CAT6 works great) from the breakout to each switch. Keep
the Pi at room temperature; only switches + cable go near the cold.

## Software install (on the Pi)

```bash
# Clone / copy the project to /home/pi/freezer-monitor, then:
cd /home/pi/freezer-monitor
python3 -m venv .venv
.venv/bin/pip install -r pi/requirements.txt

cp pi/config.example.json pi/config.json
# Edit pi/config.json: set supabase_url + supabase_service_key.
```

## Test before installing the service

```bash
# On the Pi with real switches:
.venv/bin/python pi/door_monitor.py
# Open/close a door — you should see OPEN/CLOSE log lines and rows in Supabase.

# On a laptop (no GPIO) — drive doors from the keyboard:
MOCK_GPIO=1 .venv/bin/python pi/door_monitor.py
# Type a door's GPIO pin number + Enter to toggle it.
```

## Run on boot (systemd)

```bash
sudo cp pi/freezer-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freezer-monitor
sudo systemctl status freezer-monitor      # check it's running
journalctl -u freezer-monitor -f           # live logs
```

## How alerting works

- The agent tracks how long each door has been open. When it exceeds the door's
  `open_threshold_seconds` (default 300 = 5 min), it calls the Supabase
  `send-alert` edge function to email the recipients, then re-alerts every
  `realert_seconds` until the door closes.
- Every event is written to a local `outbox.db` first and pushed to Supabase by
  a background flusher, so nothing is lost during a network outage.
- A heartbeat is written every ~60s; the `check-offline` function emails if the
  Pi goes quiet (power/Wi-Fi loss).
