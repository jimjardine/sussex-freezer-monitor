// Sussex Ice Cream — Freezer Monitor dashboard
/* global supabase, SUPABASE_CONFIG */

const cfg = window.SUPABASE_CONFIG;
const sb = supabase.createClient(cfg.url, cfg.anonKey);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// In-memory state.
let doors = [];                 // from `doors` table
let lastEventByDoor = {};       // door_id -> { event_type, created_at }
let tickTimer = null;

// --------------------------------------------------------------------------- //
// Auth
// --------------------------------------------------------------------------- //

async function init() {
  const { data } = await sb.auth.getSession();
  if (data.session) showApp();
  else showLogin();

  sb.auth.onAuthStateChange((_event, session) => {
    if (session) showApp();
    else showLogin();
  });
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: $("#email").value.trim(),
    password: $("#password").value,
  });
  if (error) $("#login-error").textContent = error.message;
});

$("#logout").addEventListener("click", () => sb.auth.signOut());

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if (tickTimer) clearInterval(tickTimer);
}

async function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadAll();
  subscribeRealtime();
  tickTimer = setInterval(tick, 1000);
  setInterval(refreshPiStatus, 15000);
  // Poll latest door states as a robust fallback to realtime (refreshes the
  // Live cards within a few seconds even if the realtime push doesn't arrive).
  setInterval(async () => {
    await loadLatestEvents();
    tick();
  }, 4000);
}

// --------------------------------------------------------------------------- //
// Tabs
// --------------------------------------------------------------------------- //

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $(`#tab-${tab.dataset.tab}`).classList.remove("hidden");
    if (tab.dataset.tab === "history") loadHistory();
    if (tab.dataset.tab === "settings") renderSettings();
  })
);

// --------------------------------------------------------------------------- //
// Data loading
// --------------------------------------------------------------------------- //

async function loadAll() {
  await loadDoors();
  await loadLatestEvents();
  renderDoors();
  refreshPiStatus();
  populateHistoryFilter();
}

async function loadDoors() {
  const { data } = await sb.from("doors").select("*").order("gpio_pin");
  doors = data || [];
}

async function loadLatestEvents() {
  // Pull recent events and keep the newest per door.
  const { data } = await sb
    .from("door_events")
    .select("door_id, event_type, created_at, duration_seconds")
    .order("created_at", { ascending: false })
    .limit(500);
  lastEventByDoor = {};
  for (const ev of data || []) {
    if (!lastEventByDoor[ev.door_id]) lastEventByDoor[ev.door_id] = ev;
  }
}

// --------------------------------------------------------------------------- //
// Live view
// --------------------------------------------------------------------------- //

function doorIsOpen(doorId) {
  const ev = lastEventByDoor[doorId];
  return ev && (ev.event_type === "open" || ev.event_type === "alert");
}

function renderDoors() {
  const grid = $("#doors");
  grid.innerHTML = "";
  if (doors.length === 0) {
    grid.innerHTML = `<p class="muted">No doors configured yet. Add them in Settings (or seed the database).</p>`;
    return;
  }
  for (const d of doors) {
    const card = document.createElement("div");
    card.className = "door-card";
    card.dataset.doorId = d.id;
    card.innerHTML = `
      <h3>${escapeHtml(d.name)}</h3>
      <div class="door-state"></div>
      <div class="timer"></div>
      <div class="limit">Limit: ${Math.round(d.open_threshold_seconds / 60)} min · GPIO${d.gpio_pin}</div>`;
    grid.appendChild(card);
  }
  tick();
}

// Updates timers + open/closed styling every second.
function tick() {
  for (const d of doors) {
    const card = $(`.door-card[data-door-id="${d.id}"]`);
    if (!card) continue;
    const ev = lastEventByDoor[d.id];
    const open = doorIsOpen(d.id);
    const stateEl = card.querySelector(".door-state");
    const timerEl = card.querySelector(".timer");

    card.classList.remove("open", "closed", "alert");
    if (!ev) {
      stateEl.textContent = "—";
      timerEl.textContent = "No data yet";
      continue;
    }
    const secs = Math.max(0, Math.floor((Date.now() - new Date(ev.created_at)) / 1000));
    if (open) {
      const over = secs >= d.open_threshold_seconds;
      card.classList.add(over ? "alert" : "open");
      stateEl.textContent = over ? "⚠️ OPEN" : "OPEN";
      timerEl.textContent = `Open for ${fmtDuration(secs)}`;
    } else {
      card.classList.add("closed");
      stateEl.textContent = "Closed";
      timerEl.textContent = `Closed ${fmtDuration(secs)} ago`;
    }
  }
}

// --------------------------------------------------------------------------- //
// Realtime
// --------------------------------------------------------------------------- //

function subscribeRealtime() {
  sb.channel("door_events")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "door_events" }, (payload) => {
      const ev = payload.new;
      lastEventByDoor[ev.door_id] = ev;
      tick();
      if (!$("#tab-history").classList.contains("hidden")) loadHistory();
    })
    .subscribe();

  sb.channel("heartbeats")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "heartbeats" }, refreshPiStatus)
    .subscribe();
}

// --------------------------------------------------------------------------- //
// Pi online/offline badge
// --------------------------------------------------------------------------- //

async function refreshPiStatus() {
  const { data } = await sb
    .from("heartbeats")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  const badge = $("#pi-status");
  if (!data || data.length === 0) {
    badge.className = "badge badge-unknown";
    badge.textContent = "Pi: no data";
    return;
  }
  const age = (Date.now() - new Date(data[0].created_at)) / 1000;
  if (age < 180) {
    badge.className = "badge badge-ok";
    badge.textContent = "Pi: online";
  } else {
    badge.className = "badge badge-bad";
    badge.textContent = `Pi: OFFLINE (${fmtDuration(age)})`;
  }
}

// --------------------------------------------------------------------------- //
// History
// --------------------------------------------------------------------------- //

function populateHistoryFilter() {
  const sel = $("#history-door");
  sel.innerHTML = `<option value="">All doors</option>`;
  for (const d of doors) sel.innerHTML += `<option value="${d.id}">${escapeHtml(d.name)}</option>`;
}

$("#history-refresh").addEventListener("click", loadHistory);
$("#history-door").addEventListener("change", loadHistory);

async function loadHistory() {
  const doorId = $("#history-door").value;
  let q = sb
    .from("door_events")
    .select("door_id, event_type, created_at, duration_seconds")
    .order("created_at", { ascending: false })
    .limit(200);
  if (doorId) q = q.eq("door_id", doorId);
  const { data } = await q;
  const nameById = Object.fromEntries(doors.map((d) => [d.id, d.name]));
  const body = $("#history-body");
  body.innerHTML = "";
  for (const ev of data || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(ev.created_at).toLocaleString()}</td>
      <td>${escapeHtml(nameById[ev.door_id] || "?")}</td>
      <td><span class="pill ${ev.event_type}">${ev.event_type}</span></td>
      <td>${ev.duration_seconds != null ? fmtDuration(ev.duration_seconds) : "—"}</td>`;
    body.appendChild(tr);
  }
}

// --------------------------------------------------------------------------- //
// Settings
// --------------------------------------------------------------------------- //

async function renderSettings() {
  const { data: s } = await sb.from("settings").select("alert_emails").eq("id", 1).single();
  $("#emails").value = (s?.alert_emails || []).join(", ");

  const body = $("#doors-settings-body");
  body.innerHTML = "";
  for (const d of doors) {
    const tr = document.createElement("tr");
    tr.dataset.doorId = d.id;
    tr.innerHTML = `
      <td><input class="s-name" value="${escapeAttr(d.name)}" /></td>
      <td><input class="s-pin" type="number" value="${d.gpio_pin}" style="width:80px" /></td>
      <td><input class="s-limit" type="number" min="1" value="${Math.round(d.open_threshold_seconds / 60)}" style="width:80px" /></td>
      <td><input class="s-enabled" type="checkbox" ${d.enabled ? "checked" : ""} /></td>`;
    body.appendChild(tr);
  }
}

$("#save-emails").addEventListener("click", async () => {
  const emails = $("#emails").value.split(",").map((e) => e.trim()).filter(Boolean);
  const { error } = await sb.from("settings").update({ alert_emails: emails, updated_at: new Date().toISOString() }).eq("id", 1);
  $("#settings-saved").textContent = error ? `Error: ${error.message}` : "Saved ✓";
  setTimeout(() => ($("#settings-saved").textContent = ""), 2500);
});

$("#save-doors").addEventListener("click", async () => {
  for (const tr of $$("#doors-settings-body tr")) {
    const id = tr.dataset.doorId;
    const update = {
      name: tr.querySelector(".s-name").value.trim(),
      gpio_pin: Number(tr.querySelector(".s-pin").value),
      open_threshold_seconds: Math.max(1, Number(tr.querySelector(".s-limit").value)) * 60,
      enabled: tr.querySelector(".s-enabled").checked,
    };
    await sb.from("doors").update(update).eq("id", id);
  }
  $("#doors-saved").textContent = "Saved ✓ (Pi picks up changes within ~2 min)";
  await loadAll();
  setTimeout(() => ($("#doors-saved").textContent = ""), 3500);
});

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function fmtDuration(secs) {
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}

init();
