// Sends the wake call. Used by app.js in the browser and by wake.test.js under `node --test`.
// The GitHub relay goes first when a token is set, because browsers block the direct webhook call
// (its host doesn't allow this origin). If the relay fails, the webhook is tried when it is set up.
// Resolves { via, warning }; throws an Error with .settings = true when the fix is in Settings.
// Never puts a token or key into a message.
"use strict";

const RELAY_WORKFLOW = "wake.yml";

async function sendWake(c, fetchFn) {
  let warning = "";
  if (c.gh && c.repo) {
    try {
      await sendRelay(c, fetchFn);
      return { via: "relay", warning };
    } catch (e) {
      warning = e.message;
      if (!(c.url && c.key)) { e.settings = true; throw e; }
    }
  }
  if (!(c.url && c.key)) {
    const e = new Error("Wake isn't set up on this device. Add the GitHub relay token or the wake webhook in Settings.");
    e.settings = true; throw e;
  }
  try {
    await sendDirect(c, fetchFn);
    return { via: "direct", warning };
  } catch (e) {
    const err = new Error(warning ? warning + " The webhook didn't work either: " + e.message : e.message);
    err.settings = true; throw err;
  }
}

async function sendRelay(c, fetchFn) {
  const res = await fetchFn(`https://api.github.com/repos/${c.repo}/actions/workflows/${RELAY_WORKFLOW}/dispatches`, {
    method: "POST", mode: "cors", cache: "no-store", credentials: "omit",
    headers: { "Authorization": "Bearer " + c.gh.trim(), "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status === 204 || res.ok) return;
  if (res.status === 401) throw new Error("GitHub rejected the relay token (HTTP 401): it has expired or was revoked. Paste a new one in Settings → GitHub token.");
  let msg = ""; try { msg = (await res.json()).message || ""; } catch (e) {}
  throw new Error(`GitHub relay refused (HTTP ${res.status}${msg ? ": " + msg : ""}). Check the token has Actions read & write on ${c.repo}.`);
}

async function sendDirect(c, fetchFn) {
  let res;
  try {
    res = await fetchFn(c.url, {
      method: "POST", mode: "cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "Authorization": "Bearer " + c.key, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "rf-launcher", action: "wake", at: new Date().toISOString(), reason: "RF did not answer the launcher" }),
    });
  } catch (e) {
    throw new Error("This browser blocked the direct call to the webhook (it doesn't allow cross-site calls). Set up the GitHub relay in Settings (see the README), or wake RF from the Grok Bot app.");
  }
  if (res.ok) return;
  if (res.status === 401) throw new Error("The webhook rejected the key (HTTP 401). Copy the current key from the Grok Bot app into Settings.");
  let msg = ""; try { msg = (await res.json()).message || ""; } catch (e) {}
  throw new Error(`The webhook answered HTTP ${res.status}${msg ? ": " + msg : ""}. Check the routine is Active and the URL is current.`);
}

if (typeof module !== "undefined") module.exports = { sendWake };
