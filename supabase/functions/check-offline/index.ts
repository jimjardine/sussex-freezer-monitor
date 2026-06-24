// Supabase Edge Function: check-offline
//
// Run on a schedule (e.g. every minute via pg_cron / Supabase scheduled functions).
// If the Pi hasn't written a heartbeat within `offline_grace_seconds`, email an
// "offline" alert via the send-alert function. Sends at most one alert per
// outage (tracked by an "offline" marker row in door_events with a null door).
//
// Uses the service role key (provided automatically as SUPABASE_SERVICE_ROLE_KEY
// inside the function runtime) so it can read all tables.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async () => {
  // Latest heartbeat.
  const { data: hb } = await sb
    .from("heartbeats")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  // Offline grace period from settings.
  const { data: settings } = await sb
    .from("settings")
    .select("offline_grace_seconds, alert_emails")
    .eq("id", 1)
    .single();

  const grace = settings?.offline_grace_seconds ?? 180;
  const emails: string[] = settings?.alert_emails ?? [];

  const lastSeen = hb?.[0]?.created_at ? new Date(hb[0].created_at) : null;
  const ageSeconds = lastSeen ? (Date.now() - lastSeen.getTime()) / 1000 : Infinity;
  const isOffline = ageSeconds > grace;

  if (!isOffline) {
    return json({ online: true, age_seconds: Math.round(ageSeconds) });
  }

  // De-dupe: only alert if we haven't already sent an offline alert since the
  // last heartbeat. We mark offline alerts in the offline_alerts table.
  const { data: lastAlert } = await sb
    .from("offline_alerts")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const lastAlertAt = lastAlert?.[0]?.created_at ? new Date(lastAlert[0].created_at) : null;
  // Skip if we've already alerted for this outage. When the Pi has NEVER sent a
  // heartbeat (lastSeen == null), any prior alert counts — otherwise we'd email
  // every run. A fresh heartbeat (lastSeen > lastAlertAt) re-arms the next alert.
  const alreadyAlerted = lastAlertAt && (!lastSeen || lastAlertAt > lastSeen);

  if (alreadyAlerted) {
    return json({ offline: true, already_alerted: true });
  }

  // Fire the email and record the alert.
  await fetch(`${SUPABASE_URL}/functions/v1/send-alert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      offline: true,
      last_seen: lastSeen ? lastSeen.toISOString() : "never",
      emails,
    }),
  });

  await sb.from("offline_alerts").insert({});

  return json({ offline: true, alerted: true });
});

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
  });
}
