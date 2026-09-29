/**
 * Matlock One's service worker, with one job: when a phone has no signal,
 * show a page that says so instead of the browser's own error.
 *
 * Nothing else is kept. Every page here is somebody's live business — today's
 * schedule, what an invoice still owes — and a saved copy shown as if it were
 * current is worse than no page at all. So only page loads are touched, the
 * network is always asked first, and the offline page is the one thing held.
 *
 * Not registered inside the desktop app, which has its own offline screen and
 * finds out about a failed load only if nothing here answers for it.
 */

// A new name whenever offline.html changes. A worker whose own bytes are the
// same is never reinstalled, so without it phones keep the page they have.
const CACHE = "matlock-one-offline-v2";
const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_PAGE, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_PAGE)));
});
