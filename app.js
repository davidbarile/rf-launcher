// RF Launcher: shows the Revenue Foundry Command Center full-screen and wakes its computer when it
// sleeps. This file contains NO secrets. The wake webhook URL/key (or a GitHub relay token) are typed
// into Settings once per device and stored only in this browser's localStorage.
"use strict";

const DEFAULT_RF = "https://grokbot-box.tail1c63a8.ts.net";
const PING_PATH = "/api/ping";          // tiny, unauthenticated, CORS-enabled for this origin
const PING_TIMEOUT_MS = 5000;
const POLL_EVERY_MS = 10000;
const POLL_FOR_MS = 3 * 60 * 1000;      // direct webhook
const RELAY_EXTRA_MS = 60 * 1000;       // GitHub Actions needs ~20-40 s to start a run
const RELAY_WORKFLOW = "wake.yml";
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
let state = "checking", pollTimer = null, toastTimer = null;
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
    text: canWake(c) ? "The Command Center isn't answering. Its computer is probably asleep. Wake it and this page opens RF by itself when it's back."
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
  if (r.up) showRF(); else showAsleep(r.why);
}

/* ---------- wake ---------- */
async function sendDirect(c) {
  const res = await timed(c.url, {
    method: "POST", mode: "cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { "Authorization": "Bearer " + cleanKey(c.key), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "rf-launcher", action: "wake", at: new Date().toISOString(), reason: "RF did not answer the launcher" }),
  }, 20000);
  if (res.ok) return;
  let msg = ""; try { msg = (await res.json()).message || ""; } catch (e) {}
  const err = new Error(res.status === 401 ? "The webhook rejected the key (HTTP 401). Copy the current key from the Grok Bot app into Settings."
    : `The webhook answered HTTP ${res.status}${msg ? ": " + msg : ""}. Check the routine is Active and the URL is current.`);
  err.final = true; throw err;
}
async function sendRelay(c) {
  const res = await timed(`https://api.github.com/repos/${c.repo}/actions/workflows/${RELAY_WORKFLOW}/dispatches`, {
    method: "POST", mode: "cors", cache: "no-store", credentials: "omit",
    headers: { "Authorization": "Bearer " + c.gh.trim(), "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  }, 20000);
  if (res.status === 204 || res.ok) return;
  let msg = ""; try { msg = (await res.json()).message || ""; } catch (e) {}
  throw new Error(`GitHub relay refused (HTTP ${res.status}${msg ? ": " + msg : ""}). Check the token has Actions read & write on ${c.repo}.`);
}
async function wake() {
  const c = cfg();
  if (!canWake(c)) { toast("Add the wake webhook in Settings first."); return openSettings(); }
  if (state === "waking") return;
  if (state === "up" && !confirm("RF is answering right now. Waking restarts RF and Tailscale. Do it anyway?")) return;
  state = "waking"; dot("busy"); $("#b-wake").classList.add("spin");
  screen({ title: "Waking RF…", text: "Sending the wake call.", progress: 0 });
  let via = "";
  try {
    if (c.url && c.key) {
      try { await sendDirect(c); via = "direct"; }
      catch (e) {
        if (e.final || !(c.gh && c.repo)) throw (e.final ? e : new Error(
          "This browser blocked the direct call to the webhook (it doesn't allow cross-site calls). Set up the GitHub relay in Settings (see the README), or wake RF from the Grok Bot app."));
      }
    }
    if (!via) { await sendRelay(c); via = "relay"; }
  } catch (e) {
    state = "down"; $("#b-wake").classList.remove("spin"); dot("down");
    screen({ title: "Couldn't send the wake call", text: e.message, retry: true, open: true, settings: true, wake: true });
    return;
  }
  // Sent: poll until RF answers, then load it.
  const limit = POLL_FOR_MS + (via === "relay" ? RELAY_EXTRA_MS : 0), started = Date.now();
  const tick = async () => {
    const elapsed = Date.now() - started;
    screen({ title: "Waking RF…", text: via === "relay" ? "Wake sent through the GitHub relay. Waiting for RF to answer…" : "Wake sent. Waiting for RF to answer…",
      detail: `Checking every ${POLL_EVERY_MS / 1000} s · ${Math.round(elapsed / 1000)} s so far`, progress: Math.min(1, elapsed / limit) });
    const r = await ping();
    if (r.up) { clearTimeout(pollTimer); $("#b-wake").classList.remove("spin"); showRF(true); toast("RF is awake."); return; }
    if (Date.now() - started >= limit) {
      state = "down"; $("#b-wake").classList.remove("spin"); dot("down");
      screen({ title: "RF hasn't come back yet", text: `No answer after ${Math.round(limit / 60000)} min. The wake routine may still be running. Check the Grok Bot app, then try again.`,
        detail: r.why, wake: true, retry: true, open: true });
      return;
    }
    pollTimer = setTimeout(tick, POLL_EVERY_MS);
  };
  pollTimer = setTimeout(tick, 1500);
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
$("#b-wake").addEventListener("click", wake);
$("#s-wake").addEventListener("click", wake);
$("#b-settings").addEventListener("click", openSettings);
$("#s-settings").addEventListener("click", openSettings);
$("#s-retry").addEventListener("click", () => check());
$("#s-open").addEventListener("click", () => showRF(true));
// Coming back to the app (phone unlocked, tab refocused): RF may have gone to sleep meanwhile.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state !== "waking") check({ quiet: state === "up" }); });
window.addEventListener("online", () => check({ quiet: state === "up" }));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
check();
if (!canWake()) setTimeout(() => toast("Tip: add the wake webhook in Settings (gear) once on this device."), 2500);
