/* Minimal service worker for installability + light offline shell.
 * - Cache-first for content-hashed static assets (chunks, icons, CSS, Leaflet images)
 * - Stale-while-revalidate for the nightly data payloads (see isDataPayload)
 * - Network-first for HTML navigations
 * - Never cache admin / review / suggest write paths
 */
// v2: the data payloads below became cacheable, so old v1 entries (which never
// held them) are dropped rather than merged into the new strategy.
const CACHE_VERSION = "train-map-v2";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

// How long a cached data payload may be served before the network takes over.
// The scrape commits once a night, so a copy from this cycle is as good as a
// fresh fetch — and it bounds how long a returning visitor can be left on an
// older *shape* of a file after a deploy that changes one.
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function isNeverCache(url) {
  const p = url.pathname;
  return (
    p.startsWith("/api/admin") ||
    p.startsWith("/api/suggest") ||
    // The loopback-only admin dashboard — the page itself, not everything
    // underneath it. This used to be a `startsWith("/data")`, which also
    // excluded /data/gtfs/*.json: the largest asset the map downloads was the
    // one thing the cache never held.
    p === "/data" ||
    p.includes("proposals")
  );
}

/**
 * The map's own data: rebuilt by the nightly scrape, unchanged in between, and
 * by far the heaviest thing a visitor downloads. Worth serving from cache the
 * moment it is asked for.
 */
function isDataPayload(url) {
  const p = url.pathname;
  return (
    p === "/api/initial-data" ||
    p === "/api/route-geometry" ||
    p === "/api/osm-relation" ||
    p === "/api/trains" ||
    p.startsWith("/data/")
  );
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/leaflet/") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".woff2") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/favicon.ico"
  );
}

/** Whether a cached response is recent enough to hand over without waiting. */
function isFresh(response) {
  const date = response?.headers?.get("date");
  if (!date) return false;
  const age = Date.now() - new Date(date).getTime();
  return Number.isFinite(age) && age < MAX_STALE_MS;
}

/** Fetch, storing a copy for next time. The write is kept alive by the caller. */
function fetchAndStore(event, cache, req) {
  return fetch(req).then((res) => {
    if (res.ok) event.waitUntil(cache.put(req, res.clone()));
    return res;
  });
}

/**
 * Stale-while-revalidate: hand over tonight's copy immediately and refresh in
 * the background. On a slow connection this is the difference between a map
 * that is there and one that arrives ten seconds later.
 */
async function serveDataPayload(event, req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);

  if (cached && isFresh(cached)) {
    event.waitUntil(fetchAndStore(event, cache, req).catch(() => {}));
    return cached;
  }

  try {
    return await fetchAndStore(event, cache, req);
  } catch (err) {
    // Offline, or the network gave up, and the only copy we have is older than
    // the ceiling above. A stale map still beats no map.
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;

  if (isDataPayload(url)) {
    event.respondWith(serveDataPayload(event, req));
    return;
  }

  // Network-first for HTML navigations (the app shell). Cache-first would freeze
  // returning visitors on a stale build whose hashed JS chunks may 404 after a
  // deploy — a white screen. Fall back to the cached shell only when offline.
  if (req.mode === "navigate" || url.pathname === "/") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // Cache-first for immutable/static assets (content-hashed chunks, icons, CSS).
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
