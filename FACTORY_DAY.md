# Factory Day — Runbook

Goal: minimum time on-site. Everything below the line marked **ON-SITE** should
already be done before you leave.

## Before you leave (bench, at home)

- [ ] Pi provisioned: `bash pi/setup_pi.sh` run, service **enabled**.
- [ ] `pi/config.json` has the real **service-role key** and `mock_gpio: false`.
- [ ] Bench-tested with a real switch on GPIO17 — saw OPEN/CLOSE in the dashboard
      and got a threshold email. (See "Bench test" below.)
- [ ] Phone hotspot pre-loaded as a known Wi-Fi:
      `bash pi/add-wifi.sh "YourHotspot" "password"`  ← lets you SSH in on-site.
- [ ] 3 switch harnesses built + labelled **Blast 1 / 2 / 3**, enough cable length.
- [ ] Breakout terminals noted: Blast 1 → GPIO17, Blast 2 → GPIO22, Blast 3 → GPIO27;
      each switch COM → a GND terminal, NO → its GPIO terminal.

### Things to bring
- Pi + power supply (and a spare phone charger / battery for power)
- The 3 labelled switch harnesses + mounting screws/tape/brackets
- Laptop (for SSH) + your phone (for the hotspot)
- Small screwdriver for the F-1019 terminals
- This runbook

---

## ON-SITE

1. **Power the Pi.** Turn on your phone hotspot first so the Pi joins a known
   network. Connect your laptop to the same hotspot.

2. **Find + SSH to the Pi:**
   ```bash
   ssh pi@raspberrypi.local      # or use the IP from your hotspot's client list
   ```

3. **Add the factory Wi-Fi** (so it works after you leave / hotspot off):
   ```bash
   cd ~/freezer-monitor
   bash pi/add-wifi.sh "FactorySSID" "factory-password"
   ```
   Confirm it connected, then you can turn the hotspot off.

4. **Mount the switches.** For each door, position the switch so the **closed
   door presses the lever** (lever in = closed). Wire into the breakout:
   COM → GND, NO → the door's GPIO terminal. (Pre-built harnesses = just screw in.)

5. **Confirm the service is running:**
   ```bash
   sudo systemctl restart freezer-monitor
   journalctl -u freezer-monitor -f
   ```
   You should see each door's state logged at startup.

6. **Test each door:** open it, watch the dashboard card flip to OPEN with a
   running timer; close it, watch it go green. Do all three. If a door reads
   backwards (shows open when closed), the switch lever position needs adjusting
   so the closed door depresses it.

7. **(Optional) Confirm the alert** on one door: prop it open past 5 minutes and
   check the email arrives — or temporarily lower its limit in the dashboard
   Settings to ~1 min to test faster, then set it back to 5.

Done. The Pi auto-starts on power and re-syncs after any Wi-Fi/power blip.

---

## Bench test (do this at home, with real hardware)

1. Wire **one** switch to GPIO17 + GND on the breakout.
2. In `pi/config.json` set `"mock_gpio": false` and the real service-role key.
3. Run it directly (not the service) to watch output:
   ```bash
   cd ~/freezer-monitor
   .venv/bin/python pi/door_monitor.py
   ```
4. Press/release the switch — you should see `OPEN`/`CLOSE` lines and the card
   move in the dashboard. To test email fast, set Blast Freezer 1's limit to
   1 minute in Settings, hold the switch "open", and wait for the email.
5. Ctrl-C, set the limit back to 5 min. Ready to pack.
