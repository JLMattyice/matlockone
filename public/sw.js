/**
 * Matlock One's service worker. Two jobs: when a phone has no signal, show a
 * page that says so instead of the browser's own error; and show the push
 * notifications a person turned on, opening the right page when tapped.
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

// A push: the server sends a title, a line, where to open and a tag. A later
// push with the same tag replaces the earlier one instead of stacking.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Matlock One", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

// Tapped: bring an open Matlock One window to that page, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      // Navigating only works on a window this worker controls; failing that,
      // a new window on the page is still what the tap asked for.
      if (open) {
        return open
          .focus()
          .then((client) => client.navigate(url))
          .catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    }),
  );
});
