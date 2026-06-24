// Supabase Edge Function: send-alert
//
// Sends the "door open too long" email (and the "Pi offline" email). Called by
// the Pi agent and by the check-offline function.
//
// The Resend API key + sender are read from the public.app_config table using
// the service role (which bypasses RLS). That table has RLS on and no policies,
// so the key is never exposed to the browser. For production you may instead set
// a RESEND_API_KEY edge-function secret — this function prefers the env var if
// present and falls back to app_config.
//
// Payload:
//   { door_name: string, open_seconds: number, emails: string[] }   // door alert
//   { offline: true, last_seen: string, emails: string[] }          // Pi offline alert

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

interface DoorAlert {
  door_name: string;
  open_seconds: number;
  emails: string[];
}
interface OfflineAlert {
  offline: true;
  last_seen: string;
  emails: string[];
}

async function getConfig(key: string): Promise<string | null> {
  const { data } = await sb.from("app_config").select("value").eq("key", key).single();
  return data?.value ?? null;
}

function buildEmail(body: DoorAlert | OfflineAlert): { subject: string; html: string } {
  if ("offline" in body) {
    return {
      subject: "⚠️ Freezer monitor is OFFLINE",
      html:
        `<h2>Freezer monitor offline</h2>` +
        `<p>The Raspberry Pi has stopped reporting in. Door status is currently unknown.</p>` +
        `<p>Last heartbeat: <b>${body.last_seen}</b></p>` +
        `<p>Check that the Pi has power and Wi-Fi.</p>`,
    };
  }
  const minutes = Math.floor(body.open_seconds / 60);
  return {
    subject: `🚨 Freezer door open: ${body.door_name}`,
    html:
      `<h2>Freezer door left open</h2>` +
      `<p><b>${body.door_name}</b> has been open for about <b>${minutes} minute(s)</b>.</p>` +
      `<p>Please check and close it to protect the product.</p>`,
  };
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: DoorAlert | OfflineAlert;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const emails = body.emails?.filter(Boolean) ?? [];
  if (emails.length === 0) {
    return new Response(JSON.stringify({ skipped: "no recipients" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("RESEND_API_KEY") ?? (await getConfig("resend_api_key"));
  const from = Deno.env.get("ALERT_FROM") ?? (await getConfig("alert_from")) ?? "Freezer Monitor <onboarding@resend.dev>";
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "no resend api key configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { subject, html } = buildEmail(body);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: emails, subject, html }),
  });

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: text }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ sent: true, to: emails }), {
    headers: { "Content-Type": "application/json" },
  });
});
