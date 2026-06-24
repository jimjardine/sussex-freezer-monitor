-- Sussex Ice Cream — Freezer Door Monitor
-- Initial schema: doors, events, settings, heartbeats + RLS.
--
-- Roles:
--   * The Pi agent connects with the SERVICE ROLE key (bypasses RLS) and is the
--     only writer of door_events / heartbeats.
--   * The dashboard connects with the ANON key as an authenticated user; logged-in
--     users may READ everything and EDIT config (doors, settings) only.
--   * Anonymous (not logged in) users can do nothing.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.doors (
    id                      uuid primary key default gen_random_uuid(),
    name                    text        not null,
    gpio_pin                integer     not null unique,
    open_threshold_seconds  integer     not null default 300,   -- 5 minutes
    realert_seconds         integer     not null default 300,   -- re-alert cadence
    enabled                 boolean     not null default true,
    created_at              timestamptz not null default now()
);

comment on table  public.doors is 'One row per monitored freezer door.';
comment on column public.doors.gpio_pin is 'BCM GPIO pin the door switch is wired to.';
comment on column public.doors.open_threshold_seconds is 'Seconds a door may stay open before an alert fires.';
comment on column public.doors.realert_seconds is 'Minimum seconds between repeat alerts while a door stays open.';

create table if not exists public.door_events (
    id                uuid primary key default gen_random_uuid(),
    door_id           uuid not null references public.doors(id) on delete cascade,
    event_type        text not null check (event_type in ('open', 'closed', 'alert')),
    duration_seconds  integer,                       -- filled on 'closed' and 'alert'
    created_at        timestamptz not null default now()
);

comment on table public.door_events is 'Append-only log of every open / closed / alert transition.';

create index if not exists door_events_door_id_created_at_idx
    on public.door_events (door_id, created_at desc);
create index if not exists door_events_created_at_idx
    on public.door_events (created_at desc);

-- Single-row settings table (id is always 1).
create table if not exists public.settings (
    id                   integer primary key default 1 check (id = 1),
    alert_emails         text[]      not null default '{}',   -- recipients
    offline_grace_seconds integer    not null default 180,    -- no heartbeat => Pi offline
    updated_at           timestamptz not null default now()
);

comment on table public.settings is 'Global config: alert recipients and offline grace period.';

insert into public.settings (id) values (1)
on conflict (id) do nothing;

create table if not exists public.heartbeats (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now()
);

comment on table public.heartbeats is 'Pi writes a row every ~60s; absence => Pi offline.';

create index if not exists heartbeats_created_at_idx
    on public.heartbeats (created_at desc);

-- One row per offline alert sent; used by check-offline to avoid repeat emails.
create table if not exists public.offline_alerts (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now()
);

create index if not exists offline_alerts_created_at_idx
    on public.offline_alerts (created_at desc);

-- ---------------------------------------------------------------------------
-- Helper view: current state of each door (latest event)
-- ---------------------------------------------------------------------------

create or replace view public.door_status
with (security_invoker = true) as
select
    d.id,
    d.name,
    d.gpio_pin,
    d.open_threshold_seconds,
    d.enabled,
    e.event_type        as last_event,
    e.created_at        as last_event_at,
    (e.event_type = 'open' or e.event_type = 'alert') as is_open
from public.doors d
left join lateral (
    select event_type, created_at
    from public.door_events
    where door_id = d.id
    order by created_at desc
    limit 1
) e on true;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.doors          enable row level security;
alter table public.door_events    enable row level security;
alter table public.settings       enable row level security;
alter table public.heartbeats     enable row level security;
alter table public.offline_alerts enable row level security;

-- Authenticated users: full read on everything.
create policy "auth read doors"       on public.doors          for select to authenticated using (true);
create policy "auth read events"      on public.door_events    for select to authenticated using (true);
create policy "auth read settings"    on public.settings       for select to authenticated using (true);
create policy "auth read heartbeats"  on public.heartbeats     for select to authenticated using (true);
create policy "auth read offline"     on public.offline_alerts for select to authenticated using (true);

-- Authenticated users: edit configuration only (doors + settings).
create policy "auth manage doors"     on public.doors       for all    to authenticated using (true) with check (true);
create policy "auth update settings"  on public.settings    for update to authenticated using (true) with check (true);

-- NOTE: door_events and heartbeats have NO insert/update policy for authenticated
-- users. Only the Pi (service role) writes them, and the service role bypasses RLS.
