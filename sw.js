// RF Launcher service worker: keeps the launcher itself opening even when RF (or the network) is down.
// Only this site's own files are cached; requests to RF and to the wake webhook are never touched.
const CACHE = "rf-launcher-v2";
const SHELL = ["./", "index.html", "app.js", "wake.js", "app.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // Network first (so updates arrive at once), cache as the fallback after 4 s so a bad connection never hangs the page.
  const live = fetch(req, { cache: "no-store" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });
  const timed = Promise.race([live, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000))]);
  e.respondWith(timed.catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")).then((hit) => hit || live)));
});
