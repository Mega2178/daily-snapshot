// Daily Snapshot service worker.
// ---------------------------------------------------------------
// Goal: make repeat visits feel instant, without showing stale data
// for so long that the user wonders why nothing has changed.
//
// Strategy:
//   - HTML / CSS / JS / fonts:  cache-first.   Fastest possible paint.
//   - data/items.json:          stale-while-revalidate.
//                               Serve cached copy immediately AND fetch a
//                               fresh one in the background; next reload
//                               picks up the new data.
//   - Everything else (CDN images): just hit the network normally.
//
// Bump CACHE_VERSION whenever you change app.js, index.html, or style.css
// so old clients pick up the new code on next reload.

const CACHE_VERSION = "v1";
const STATIC_CACHE  = `static-${CACHE_VERSION}`;
const DATA_CACHE    = `data-${CACHE_VERSION}`;

// Files we want available offline / instantly on repeat load.
// Keep this list to OUR static assets — not third-party CDN images.
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
];

// ---- install: pre-cache the static shell ----------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Activate this SW immediately on first install.
  self.skipWaiting();
});

// ---- activate: drop old caches when CACHE_VERSION bumps -------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ---- fetch: route by URL ---------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GETs from our own origin. Everything else goes to network.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The data file: stale-while-revalidate.
  if (url.pathname.endsWith("/data/items.json")) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Static shell: cache-first.
  if (
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/style.css")
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Anything else same-origin: just network.
});

// Cache-first: try cache, fall back to network, store on the way back.
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    // Offline and not cached — let it fail like a normal fetch would.
    throw err;
  }
}

// Stale-while-revalidate: hand back the cached copy immediately, kick off
// a background refresh that updates the cache for next time.
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null); // background failure is non-fatal

  // If we have a cached copy, return it now and let the network update happen
  // in the background. Otherwise wait on the network.
  return cached || (await networkPromise) || new Response(
    JSON.stringify({ generated_at: null, items: [] }),
    { headers: { "Content-Type": "application/json" } }
  );
}
