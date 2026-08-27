// Cache name. Bumping it drops every entry the previous worker wrote.
var CACHE = "psx-v1";

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

// Take over the pages that are already open, so a fix does not wait for every
// tab to be closed before it can be served. Older caches go at the same time:
// this worker is the only thing that writes one, so anything under another name
// is a previous version's and nothing will ever read it again.
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (n) {
            return n === CACHE ? null : caches.delete(n);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// Network first, falling back to the cache, and every successful response is
// written back.
//
// This was cache first, and a cache written by an earlier version of this
// worker outlives it - so a cache-first worker served that forever. The app is
// a patched bundle plus psx.js, both at paths that never change name, so
// "forever" meant a deploy could not reach anyone who had already opened the
// site once. That is not a stale asset, it is a fix that never ships. Network
// first has no such failure: the network wins whenever it answers.
//
// It also used to write nothing at all, which left the fallback permanently
// empty - the worker claimed to work offline and did not. It matters here
// because docs/vendor/ now holds ~55 MB of Mediapipe wasm and tflite that used
// to come from a CDN: on the second load that is served from disk instead of
// fetched, which on a Raspberry Pi is the difference between a slow start and
// a start that does not need the network at all.
self.addEventListener("fetch", function (event) {
  var req = event.request;

  // Only our own GETs. A cross-origin request intercepted here turns a blocked
  // third-party into an uncaught TypeError in this worker, and a POST has no
  // business in a cache.
  if (req.method !== "GET") return;
  if (req.url.indexOf(self.location.origin) !== 0) return;

  event.respondWith(
    fetch(req)
      .then(function (res) {
        // Only complete, ordinary responses. A 404 or a range response (the
        // browser asks for those on media) is not a copy of the file.
        if (res && res.ok && res.type === "basic") {
          var copy = res.clone();
          // Not awaited: the page should not wait on the disk write, and a
          // quota failure is not a reason to fail the request.
          caches
            .open(CACHE)
            .then(function (c) {
              return c.put(req, copy);
            })
            .catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          // Nothing cached and no network: let it fail as it would have without
          // a worker in the way, rather than resolving to undefined.
          throw new Error("offline and not cached: " + req.url);
        });
      })
  );
});
