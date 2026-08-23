self.addEventListener("install", function (event) {
  self.skipWaiting();
});

// Take over the pages that are already open, so a fix does not wait for every
// tab to be closed before it can be served.
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

// Network first, cache only as a fallback.
//
// This was cache first, and nothing here ever writes to a cache - but a cache
// written by an earlier version of this worker outlives it, and a cache-first
// worker will serve that forever. The app is a patched bundle plus psx.js, both
// served from paths that never change name, so "forever" meant a deploy could
// not reach anyone who had already opened the site once. That is not a stale
// asset, it is a fix that never ships.
//
// Offline still works: an entry that is in a cache is still returned when the
// network cannot be reached.
self.addEventListener("fetch", function (event) {
  // Let analytics / CDNs fail on their own. Intercepting them turns a
  // blocked gtm.js into an uncaught TypeError in this worker.
  var url = event.request.url;
  if (url.indexOf(self.location.origin) !== 0) return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(event.request).then(function (hit) {
        if (hit) return hit;
        // Nothing cached and no network: let it fail as it would have without
        // a worker in the way, rather than resolving to undefined.
        throw new Error("offline and not cached: " + url);
      });
    })
  );
});
