// Top Conspiracies service worker: offline shell + last data.json
const CACHE = "tc-20261009182118";
const SHELL = ["./", "index.html", "core.js", "config.js", "manifest.json", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "data.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // live feeds go straight to network
  if (u.pathname.endsWith("/data.json")) {                                  // network-first, fall back to cached copy
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put("data.json", cp)); } return r; })
      .catch(() => caches.match("data.json")));
    return;
  }
  // app shell: network-first (so updates land quickly), cache fallback for offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
