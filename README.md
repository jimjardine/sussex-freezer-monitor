# Sussex Ice Cream — Freezer Door Monitor

Monitors freezer doors with microswitches on a Raspberry Pi, logs every
open/close, and emails an alert when a door is left open too long (default
5 minutes). A login-protected web dashboard shows live status and history from
anywhere.

```
   Freezer doors                Raspberry Pi                    Cloud (Supabase)              Browser
  ┌────────────┐   switch on   ┌──────────────┐   events +    ┌──────────────────┐  login   ┌───────────┐
  │  ▢ ▢ ▢     │──────────────►│ door_monitor │──────────────►│ Postgres + Auth  │◄────────►│ dashboard │
  │ microswitch│   GPIO pins   │  .py (agent) │  heartbeats   │ edge functions   │ realtime │ (web/)    │
  └────────────┘               └──────┬───────┘               └────────┬─────────┘          └───────────┘
                                       │ open too long?                 │ Pi offline?
                                       └──────────► send-alert ◄────────┘  ──►  📧 email
```

## Pieces

| Folder       | What it is |
|--------------|------------|
| `pi/`        | Python agent that runs on the Raspberry Pi (reads switches → Supabase). |
| `supabase/`  | Database schema (`migrations/`), seed data, and edge functions (email + offline check). |
| `web/`       | Static dashboard (login, live status, history, settings). Host on GitHub Pages / Vercel. |

## Setup order

### 1. Supabase
```bash
# In the supabase/ folder, with the Supabase CLI linked to your project:
supabase db push                       # applies migrations/0001_init.sql
psql "$DATABASE_URL" -f seed.sql       # or paste seed.sql in the SQL editor

# Email function secrets:
supabase secrets set RESEND_API_KEY=...   ALERT_FROM="Freezer Monitor <alerts@yourdomain>"
supabase functions deploy send-alert
supabase functions deploy check-offline
# Schedule check-offline to run every minute (Dashboard → Edge Functions → Schedules,
# or pg_cron). It emails if no heartbeat arrives within the grace period.
```
Create a login user under **Authentication → Users**, and turn **off** public
sign-ups so only invited staff can log in.

### 2. Pi
See [`pi/README.md`](pi/README.md) for wiring and install. In short: wire the
switches (fail-safe: COM→GND, NO→GPIO), fill in `pi/config.json` with the
Supabase URL + **service-role** key, then run as a `systemd` service.

### 3. Dashboard
```bash
cp web/config.example.js web/config.js   # fill in url + anon key
```
Open `web/index.html` locally to test, then deploy the `web/` folder to GitHub
Pages or Vercel. Log in with the user you created.

## Security model
- The Pi uses the **service-role** key (kept only on the Pi) and is the sole
  writer of events/heartbeats.
- The browser uses the **anon** key; Row Level Security means only logged-in
  users can read, and they can only edit door config + alert recipients.
- Disable public sign-ups so the login is invite-only.

## Configurable from the dashboard (Settings tab)
- Alert recipient emails
- Per-door name, GPIO pin, open-time limit, enabled/disabled

The Pi re-reads these every ~2 minutes, so changes take effect without redeploy.
