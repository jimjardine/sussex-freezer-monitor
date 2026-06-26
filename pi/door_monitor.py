#!/usr/bin/env python3
"""Sussex Ice Cream — Freezer Door Monitor (Raspberry Pi agent).

Reads one lever microswitch per freezer door via the Pi's GPIO, logs every
open/closed transition, and raises an email alert (through a Supabase edge
function) when a door stays open past its threshold.

Design notes
------------
* Source of truth lives here on the Pi, so alert timing is reliable even if the
  internet hiccups. Events are buffered to a local SQLite file and re-synced.
* Wiring is fail-safe: switch COM -> GND, NO -> GPIO, internal pull-up enabled.
  Door CLOSED presses the lever -> pin LOW. Door OPEN (or a cut wire) -> pin HIGH.
  So a broken wire reads as "open" and alarms rather than hiding a problem.

Run on a real Pi with `gpiozero` installed. For development on a laptop, set
`"mock_gpio": true` in config (or env MOCK_GPIO=1) to drive doors from the
keyboard instead of real pins.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import sqlite3
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import requests

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

CONFIG_PATH = Path(os.environ.get("FREEZER_CONFIG", Path(__file__).with_name("config.json")))


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}\nCopy config.example.json to config.json and fill it in.")
    with CONFIG_PATH.open() as fh:
        cfg = json.load(fh)
    if os.environ.get("MOCK_GPIO") == "1":
        cfg["mock_gpio"] = True
    return cfg


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"{iso_now()} {msg}", flush=True)


# --------------------------------------------------------------------------- #
# Supabase REST client (thin wrapper over PostgREST + edge functions)
# --------------------------------------------------------------------------- #


class Supabase:
    """Minimal Supabase client using the service-role key (bypasses RLS)."""

    def __init__(self, url: str, service_key: str, timeout: float = 10.0):
        self.base = url.rstrip("/")
        self.timeout = timeout
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def insert(self, table: str, row: dict) -> None:
        r = requests.post(
            f"{self.base}/rest/v1/{table}",
            headers=self.headers,
            json=row,
            timeout=self.timeout,
        )
        r.raise_for_status()

    def select(self, table: str, params: dict | None = None) -> list[dict]:
        r = requests.get(
            f"{self.base}/rest/v1/{table}",
            headers=self.headers,
            params=params or {},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def invoke(self, function: str, payload: dict) -> None:
        r = requests.post(
            f"{self.base}/functions/v1/{function}",
            headers=self.headers,
            json=payload,
            timeout=self.timeout,
        )
        r.raise_for_status()


# --------------------------------------------------------------------------- #
# Local SQLite outbox (offline buffer)
# --------------------------------------------------------------------------- #


class Outbox:
    """Stores events locally first; a background flusher pushes them to Supabase.

    This guarantees no event is lost while the network is down.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.execute(
            """
            create table if not exists outbox (
                id integer primary key autoincrement,
                door_id text not null,
                event_type text not null,
                duration_seconds integer,
                created_at text not null,
                synced integer not null default 0
            )
            """
        )
        self._db.commit()

    def add(self, door_id: str, event_type: str, created_at: str, duration_seconds: int | None) -> None:
        with self._lock:
            self._db.execute(
                "insert into outbox (door_id, event_type, duration_seconds, created_at) values (?,?,?,?)",
                (door_id, event_type, duration_seconds, created_at),
            )
            self._db.commit()

    def pending(self, limit: int = 50) -> list[tuple]:
        with self._lock:
            cur = self._db.execute(
                "select id, door_id, event_type, duration_seconds, created_at "
                "from outbox where synced = 0 order by id limit ?",
                (limit,),
            )
            return cur.fetchall()

    def mark_synced(self, row_id: int) -> None:
        with self._lock:
            self._db.execute("update outbox set synced = 1 where id = ?", (row_id,))
            self._db.commit()


# --------------------------------------------------------------------------- #
# Door state
# --------------------------------------------------------------------------- #


@dataclass
class Door:
    id: str
    name: str
    gpio_pin: int
    open_threshold_seconds: int = 300
    realert_seconds: int = 300
    is_open: bool = False
    opened_at: float | None = None       # monotonic time the door opened
    last_alert_at: float | None = None   # monotonic time of last alert
    _button: object = field(default=None, repr=False)


# --------------------------------------------------------------------------- #
# Monitor
# --------------------------------------------------------------------------- #


class Monitor:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.mock = bool(cfg.get("mock_gpio"))
        self.poll_seconds = float(cfg.get("poll_seconds", 1.0))
        self.heartbeat_seconds = float(cfg.get("heartbeat_seconds", 60.0))
        self.settings_refresh_seconds = float(cfg.get("settings_refresh_seconds", 120.0))

        self.sb = Supabase(cfg["supabase_url"], cfg["supabase_service_key"])
        self.outbox = Outbox(Path(cfg.get("outbox_path", Path(__file__).with_name("outbox.db"))))
        self.alert_emails: list[str] = []

        self.doors: dict[str, Door] = {}
        self._events: "queue.Queue[tuple]" = queue.Queue()
        self._stop = threading.Event()
        self._wake_flusher = threading.Event()  # set when a new event needs uploading

    # -- setup ------------------------------------------------------------- #

    def load_doors(self) -> None:
        """Fetch enabled doors + settings from Supabase."""
        rows = self.sb.select("doors", {"enabled": "eq.true", "select": "*"})
        seen = set()
        for r in rows:
            seen.add(r["id"])
            d = self.doors.get(r["id"])
            if d:
                d.name = r["name"]
                d.open_threshold_seconds = r["open_threshold_seconds"]
                d.realert_seconds = r["realert_seconds"]
                if d.gpio_pin != r["gpio_pin"]:        # pin changed in dashboard
                    self._unbind_door(d)               # release the old pin first
                    d.gpio_pin = r["gpio_pin"]
                    self._bind_door(d)
            else:                                       # new door added in dashboard
                d = Door(
                    id=r["id"],
                    name=r["name"],
                    gpio_pin=r["gpio_pin"],
                    open_threshold_seconds=r["open_threshold_seconds"],
                    realert_seconds=r["realert_seconds"],
                )
                self.doors[d.id] = d
                self._bind_door(d)
        # Drop doors that were deleted or disabled in the dashboard.
        for door_id in list(self.doors):
            if door_id not in seen:
                self._unbind_door(self.doors[door_id])
                del self.doors[door_id]
        settings = self.sb.select("settings", {"id": "eq.1", "select": "alert_emails"})
        if settings:
            self.alert_emails = settings[0].get("alert_emails") or []
        log(f"Loaded {len(self.doors)} door(s); alert emails: {self.alert_emails or '(none set)'}")

    def setup_gpio(self) -> None:
        if self.mock:
            log("MOCK GPIO mode — type a door's GPIO pin number + Enter to toggle it. Ctrl-C to quit.")

    def _bind_door(self, door: Door) -> None:
        """Start watching a door's GPIO pin (no-op in mock mode or if already bound)."""
        if self.mock or door._button is not None:
            return
        from gpiozero import Button  # imported here so dev machines don't need it
        # pull_up=True: pin idles HIGH; pressed (LOW) == door closed. We poll
        # is_pressed in the main loop (edge callbacks occasionally miss changes).
        door._button = Button(door.gpio_pin, pull_up=True, bounce_time=0.05)
        door.is_open = not door._button.is_pressed
        if door.is_open:
            door.opened_at = time.monotonic()
            door.last_alert_at = None
            self._log_event(door, "open")
        log(f"Monitoring '{door.name}' on GPIO{door.gpio_pin}: {'OPEN' if door.is_open else 'closed'}")

    def _unbind_door(self, door: Door) -> None:
        """Stop watching a door's pin (when it's deleted or disabled in the dashboard)."""
        if door._button is not None:
            try:
                door._button.close()
            except Exception:  # noqa: BLE001
                pass
            door._button = None
        log(f"Stopped monitoring '{door.name}' (GPIO{door.gpio_pin})")

    def _make_handler(self, door_id: str, opened: bool):
        def handler():
            self._events.put((door_id, opened, time.monotonic()))
        return handler

    # -- main loops -------------------------------------------------------- #

    def run(self) -> None:
        self.setup_gpio()
        self.load_doors()   # fetches doors and binds their GPIO pins (logs initial state)

        threading.Thread(target=self._flusher_loop, daemon=True).start()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        threading.Thread(target=self._settings_loop, daemon=True).start()
        if self.mock:
            threading.Thread(target=self._mock_input_loop, daemon=True).start()

        log("Monitor running.")
        while not self._stop.is_set():
            # Poll real GPIO levels and act on any change (robust vs edge callbacks).
            if not self.mock:
                for door in self.doors.values():
                    if door._button is None:
                        continue
                    current_open = not door._button.is_pressed  # pressed == closed
                    if current_open != door.is_open:
                        self._on_transition(door.id, current_open)
            # Drain mock transition events (keyboard-driven in mock mode).
            try:
                while True:
                    door_id, opened, _ts = self._events.get_nowait()
                    self._on_transition(door_id, opened)
            except queue.Empty:
                pass
            # Check open-too-long for every open door.
            self._check_thresholds()
            # Poll GPIO frequently for snappy response (cap config value at 0.2s).
            self._stop.wait(min(self.poll_seconds, 0.2))

    def _on_transition(self, door_id: str, opened: bool) -> None:
        door = self.doors.get(door_id)
        if not door or door.is_open == opened:
            return
        door.is_open = opened
        if opened:
            door.opened_at = time.monotonic()
            door.last_alert_at = None
            self._log_event(door, "open")
            log(f"OPEN  '{door.name}'")
        else:
            duration = int(time.monotonic() - door.opened_at) if door.opened_at else None
            door.opened_at = None
            door.last_alert_at = None
            self._log_event(door, "closed", duration)
            log(f"CLOSE '{door.name}' after {duration}s")

    def _check_thresholds(self) -> None:
        now = time.monotonic()
        for door in self.doors.values():
            if not door.is_open or door.opened_at is None:
                continue
            open_for = now - door.opened_at
            if open_for < door.open_threshold_seconds:
                continue
            # Past threshold. Alert now, then respect re-alert cadence.
            if door.last_alert_at is not None and (now - door.last_alert_at) < door.realert_seconds:
                continue
            door.last_alert_at = now
            self._log_event(door, "alert", int(open_for))
            self._send_alert(door, int(open_for))

    # -- emitting events --------------------------------------------------- #

    def _log_event(self, door: Door, event_type: str, duration: int | None = None) -> None:
        self.outbox.add(door.id, event_type, iso_now(), duration)
        self._wake_flusher.set()  # push to Supabase immediately, don't wait for the timer

    def _send_alert(self, door: Door, open_for: int) -> None:
        minutes = open_for // 60
        log(f"ALERT '{door.name}' open for ~{minutes} min — emailing {self.alert_emails}")
        if not self.alert_emails:
            log("  (no recipients configured; skipping email)")
            return
        try:
            self.sb.invoke(
                "send-alert",
                {
                    "door_name": door.name,
                    "open_seconds": open_for,
                    "emails": self.alert_emails,
                },
            )
        except Exception as exc:  # noqa: BLE001 — never let a failed email kill the loop
            log(f"  email send failed: {exc}")

    # -- background loops -------------------------------------------------- #

    def _flusher_loop(self) -> None:
        while not self._stop.is_set():
            for row in self.outbox.pending():
                row_id, door_id, event_type, duration, created_at = row
                try:
                    self.sb.insert(
                        "door_events",
                        {
                            "door_id": door_id,
                            "event_type": event_type,
                            "duration_seconds": duration,
                            "created_at": created_at,
                        },
                    )
                    self.outbox.mark_synced(row_id)
                except Exception:
                    break  # network down — try again next tick
            # Wake immediately when a new event is logged; otherwise re-check every 2s.
            self._wake_flusher.wait(2.0)
            self._wake_flusher.clear()

    def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.sb.insert("heartbeats", {"created_at": iso_now()})
            except Exception as exc:  # noqa: BLE001
                log(f"heartbeat failed: {exc}")
            self._stop.wait(self.heartbeat_seconds)

    def _settings_loop(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self.settings_refresh_seconds)
            if self._stop.is_set():
                break
            try:
                self.load_doors()
            except Exception as exc:  # noqa: BLE001
                log(f"settings refresh failed: {exc}")

    def _mock_input_loop(self) -> None:
        """Dev helper: read GPIO pin numbers from stdin to toggle doors."""
        pin_to_id = {d.gpio_pin: d.id for d in self.doors.values()}
        for line in sys.stdin:
            line = line.strip()
            if not line.isdigit():
                continue
            door_id = pin_to_id.get(int(line))
            if not door_id:
                log(f"No door on GPIO{line}")
                continue
            door = self.doors[door_id]
            self._events.put((door_id, not door.is_open, time.monotonic()))

    def stop(self, *_args) -> None:
        log("Shutting down…")
        self._stop.set()


def main() -> None:
    cfg = load_config()
    mon = Monitor(cfg)
    signal.signal(signal.SIGINT, mon.stop)
    signal.signal(signal.SIGTERM, mon.stop)
    mon.run()


if __name__ == "__main__":
    main()
