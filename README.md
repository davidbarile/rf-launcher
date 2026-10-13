# RF Launcher

An always-up page for the Revenue Foundry Command Center. It shows RF full-screen in a frame and
checks whether RF answers (`/api/ping`, 15 s timeout). When RF is down it runs **Wake & open** on its
own as soon as the page opens. One press does the same from the status screen or the bar's power
button. Wake & open pings RF first and opens it right away if it is up. Otherwise it sends the wake
call through the GitHub relay first when a token is set, falling back to the webhook. It then polls
every 5 s with a progress bar for up to 3 min (4 with the relay) and opens RF the moment it answers.
A wake sent in the last 4 minutes is not sent again; the page just keeps polling. If GitHub rejects
the relay token (HTTP 401), the page says so, points to Settings and falls back to the webhook when
one is set.

Tests: `node --test` (the wake-sending logic in `wake.js`).

**This repo has no secrets.** The webhook URL and key are typed into the page's Settings once per
device and kept only in that browser's `localStorage`. The page reaches RF only over Tailscale, so
it works only on devices signed in to the tailnet.

## Setup on each device

1. Open the launcher URL (`https://<owner>.github.io/rf-launcher/`).
   - iPhone/iPad (Safari): Share → **Add to Home Screen**.
   - Android (Chrome): ⋮ → **Add to Home screen / Install app**.
   - Mac (Chrome/Edge): install icon in the address bar → **Install**. Safari: File → **Add to Dock**.
2. Open it from the new icon, tap the gear (Settings) and paste, from the Grok Bot desktop app
   (routine "Wake RF on demand" → Webhook): **POST to** → *webhook URL*, **key** → *Key*. Save.
3. Chrome may ask to let the page "access devices on your local network": allow it (RF lives on
   your tailnet's private 100.x address).

## Why there is a relay

The Grok Bot webhook endpoint (`api2.cursor.sh/automations/webhook/…`) answers CORS preflights but
only allows its own origins, so a browser on this page cannot send it a POST with an
`Authorization` header. The page still tries the direct call first. If that is blocked and a relay
token is set, it starts `.github/workflows/wake.yml` through the GitHub API (which does allow
browser calls), and that workflow calls the webhook with the URL and key stored as encrypted repo
secrets.

To turn the relay on (one time):

1. Repo → Settings → Secrets and variables → Actions → New repository secret:
   `RF_WAKE_URL` (the POST-to URL) and `RF_WAKE_KEY` (the key).
2. GitHub → Settings → Developer settings → Fine-grained tokens → Generate: repository access
   **only this repo**, permission **Actions: Read and write** (nothing else).
3. Paste that token into the launcher's Settings → *GitHub token* on each device.

The token can only start/read workflow runs in this one repo.

## RF side

RF must list this page's origin in `RF_LAUNCHER_ORIGINS` (in `$RF_HOME/.env`), which makes RF send
`Content-Security-Policy: frame-ancestors 'self' <origin>` and answer CORS on `/api/ping` and
`/api/health` for that origin only. See RF's `docs/DECISIONS.md` (D39).
