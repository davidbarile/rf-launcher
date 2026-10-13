// RF Launcher: shows the Revenue Foundry Command Center full-screen and wakes its computer when it
// sleeps. This file contains NO secrets. The wake webhook URL/key (or a GitHub relay token) are typed
// into Settings once per device and stored only in this browser's localStorage.
"use strict";

const DEFAULT_RF = "https://grokbot-box.tail1c63a8.ts.net";
const PING_PATH = "/api/ping";          // tiny, unauthenticated, CORS-enabled for this origin
const PING_TIMEOUT_MS = 15000;
const POLL_EVERY_MS = 5000;
const POLL_FOR_MS = 3 * 60 * 1000;      // direct webhook
const RELAY_EXTRA_MS = 60 * 1000;       // GitHub Actions needs ~20-40 s to start a run
const K = { rf: "rf.launcher.rf", url: "rf.launcher.wakeUrl", key: "rf.launcher.wakeKey", gh: "rf.launcher.ghToken", repo: "rf.launcher.relayRepo" };

const $ = (s) => document.querySelector(s);
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} },
};
function defaultRepo() {
  // https://<owner>.github.io/<repo>/  ->  <owner>/<repo>
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : "";
}
const cfg = () => ({
  rf: (store.get(K.rf) || DEFAULT_RF).replace(/\/+$/, ""),
  url: store.get(K.url), key: store.get(K.key), gh: store.get(K.gh), repo: store.get(K.repo) || defaultRepo(),
});
const canWake = (c = cfg()) => !!((c.url && c.key) || (c.gh && c.repo));
const cleanKey = (k) => k.trim().replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "").trim();

/* ---------- UI helpers ---------- */
const frame = $("#rf");
let state = "checking", toastTimer = null;
function toast(text, bad = false, ms = 6000) {
  const t = $("#toast"); t.textContent = text; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function dot(kind) { $("#dot").className = "dot " + kind; }
function screen({ title, text, detail = "", wake = false, retry = false, open = false, settings = false, progress = null }) {
  $("#screen").hidden = false;
  $("#s-title").textContent = title; $("#s-text").textContent = text; $("#s-detail").textContent = detail;
  $("#s-wake").hidden = !wake; $("#s-retry").hidden = !retry; $("#s-open").hidden = !open; $("#s-settings").hidden = !settings;
  $("#s-progress").hidden = progress === null;
  if (progress !== null) $("#s-progress span").style.width = Math.round(progress * 100) + "%";
}
function showRF(reload = false) {
  const c = cfg();
  if (reload || !frame.src || !frame.src.startsWith(c.rf)) frame.src = c.rf + "/" + (reload ? "?r=" + Date.now() : "");
  frame.hidden = false; $("#screen").hidden = true; state = "up"; dot("up");
}
function showAsleep(why) {
  state = "down"; dot("down");
  const c = cfg();
  screen({
    title: "RF is asleep",
    text: canWake(c) ? "The Command Center isn't answering. Its computer is probably asleep. Press Wake & open and this page opens RF by itself when it's back."
      : "The Command Center isn't answering. To wake it from here, add the wake webhook in Settings (one time on this device).",
    detail: why, wake: canWake(c), retry: true, open: true, settings: !canWake(c),
  });
}

/* ---------- is RF awake? ---------- */
async function timed(url, opts, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
// -> { up: boolean, why: string }
async function ping() {
  const base = cfg().rf;
  try {
    const res = await timed(base + PING_PATH + "?t=" + Date.now(), { mode: "cors", cache: "no-store", credentials: "omit" }, PING_TIMEOUT_MS);
    if (res.ok) return { up: true, why: "" };
    return { up: false, why: `RF's address answered with HTTP ${res.status}.` };
  } catch (e) {
    if (e.name === "AbortError") return { up: false, why: `No answer within ${PING_TIMEOUT_MS / 1000} s. Is this device connected to Tailscale?` };
    // A CORS/network error. If the address is reachable at all (opaque no-cors request), the computer is
    // awake but RF itself is down (e.g. Tailscale answers 502) or RF lacks this origin in RF_LAUNCHER_ORIGINS.
    try {
      await timed(base + "/api/health?t=" + Date.now(), { mode: "no-cors", cache: "no-store", credentials: "omit" }, PING_TIMEOUT_MS);
      return { up: false, why: "The computer answered but RF didn't (RF stopped, or this page's origin isn't in RF_LAUNCHER_ORIGINS)." };
    } catch (e2) {
      return { up: false, why: "Couldn't reach RF's address. The computer is asleep, or this device isn't on the tailnet." };
    }
  }
}
async function check({ quiet = false } = {}) {
  if (state === "waking") return;
  dot("busy");
  if (!quiet) { state = "checking"; screen({ title: "Checking Revenue Foundry…", text: "Looking for the Command Center on your tailnet." }); }
  const r = await ping();
  if (state === "waking") return;
  // Down and wake set up: wake & open by itself (on launch and when the app comes back to the front).
  if (r.up) showRF(); else if (canWake()) wakeAndOpen(); else showAsleep(r.why);
}

/* ---------- wake & open: ping, wake, poll with progress, open RF (one press, or by itself on launch) ---------- */
const WOKE_AT = "rf.launcher.wokeAt";   // a wake sent a moment ago is still running: poll, don't send another
const WAKE_RUNNING_MS = 4 * 60 * 1000;
async function wakeAndOpen() {
  if (state === "waking") return;
  state = "waking"; dot("busy"); $("#b-wake").classList.add("spin");
  const stop = (opts) => { state = "down"; dot("down"); $("#b-wake").classList.remove("spin"); screen(opts); };
  screen({ title: "Checking Revenue Foundry…", text: "Looking for the Command Center on your tailnet.", progress: 0 });
  const first = await ping();
  if (first.up) { $("#b-wake").classList.remove("spin"); showRF(true); return; }
  const c = cfg();
  if (!canWake(c)) return stop({ title: "RF is asleep", text: "The Command Center isn't answering. To wake it from here, add the GitHub relay token or the wake webhook in Settings (one time on this device).",
    detail: first.why, retry: true, open: true, settings: true });
  let via = "earlier wake";
  if (Date.now() - Number(store.get(WOKE_AT) || 0) > WAKE_RUNNING_MS) {
    screen({ title: "Waking RF…", text: "Sending the wake call.", detail: first.why, progress: 0.02 });
    try {
      const r = await sendWake(c, (url, opts) => timed(url, opts, 20000));
      via = r.via; store.set(WOKE_AT, String(Date.now()));
      if (r.warning) toast(r.warning, true, 12000);
    } catch (e) {
      return stop({ title: "Couldn't send the wake call", text: e.message, detail: first.why, wake: true, retry: true, open: true, settings: !!e.settings });
    }
  }
  const limit = POLL_FOR_MS + (via === "relay" ? RELAY_EXTRA_MS : 0), started = Date.now();
  const sent = { relay: "Wake sent through the GitHub relay.", direct: "Wake sent.", "earlier wake": "A wake was sent a moment ago." }[via];
  for (;;) {
    const elapsed = Date.now() - started;
    screen({ title: "Waking RF…", text: sent + " Waiting for RF to answer; it opens by itself.",
      detail: `Checking every ${POLL_EVERY_MS / 1000} s · ${Math.round(elapsed / 1000)} s so far`, progress: Math.min(1, 0.05 + elapsed / limit) });
    const r = await ping();
    if (r.up) { store.set(WOKE_AT, ""); $("#b-wake").classList.remove("spin"); showRF(true); toast("RF is awake."); return; }
    if (Date.now() - started >= limit) {
      store.set(WOKE_AT, "");
      return stop({ title: "RF hasn't come back yet", text: `No answer after ${Math.round(limit / 60000)} min. The wake routine may still be running. Check the Grok Bot app, then try again.`,
        detail: r.why, wake: true, retry: true, open: true });
    }
    await new Promise((res) => setTimeout(res, POLL_EVERY_MS));
  }
}

/* ---------- settings ---------- */
function openSettings() {
  const c = cfg();
  $("#f-rf").value = c.rf; $("#f-url").value = c.url; $("#f-key").value = c.key; $("#f-gh").value = c.gh; $("#f-repo").value = c.repo;
  $("#f-repo-name").textContent = c.repo || "<owner>/<repo>";
  $("#settings").showModal();
}
$("#settings-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value !== "save") return;
  const rf = $("#f-rf").value.trim().replace(/\/+$/, "");
  store.set(K.rf, rf && rf !== DEFAULT_RF ? rf : "");
  store.set(K.url, $("#f-url").value.trim()); store.set(K.key, cleanKey($("#f-key").value));
  store.set(K.gh, $("#f-gh").value.trim());
  const repo = $("#f-repo").value.trim(); store.set(K.repo, repo && repo !== defaultRepo() ? repo : "");
  toast(canWake() ? "Saved on this device." : "Saved. Wake needs the webhook URL and key (or the relay token).");
  setTimeout(() => check(), 50);
});
$("#f-clear").addEventListener("click", () => {
  if (!confirm("Forget the RF address, webhook URL, key and relay token on this device?")) return;
  Object.values(K).forEach((k) => store.set(k, "")); $("#settings").close(); toast("Forgotten on this device."); check();
});

/* ---------- wiring ---------- */
$("#b-reload").addEventListener("click", async () => {
  if (state === "waking") return;
  $("#b-reload").classList.add("spin"); dot("busy");
  const r = await ping(); $("#b-reload").classList.remove("spin");
  if (r.up) showRF(true); else showAsleep(r.why);
});
$("#b-wake").addEventListener("click", wakeAndOpen);
$("#s-wake").addEventListener("click", wakeAndOpen);
$("#b-settings").addEventListener("click", openSettings);
$("#s-settings").addEventListener("click", openSettings);
$("#s-retry").addEventListener("click", () => check());
$("#s-open").addEventListener("click", () => showRF(true));
// Coming back to the app (phone unlocked, tab refocused): RF may have gone to sleep meanwhile.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state !== "waking") check({ quiet: state === "up" }); });
window.addEventListener("online", () => check({ quiet: state === "up" }));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
check();
if (!canWake()) setTimeout(() => toast("Tip: add the wake relay token or webhook in Settings (gear) once on this device."), 2500);
