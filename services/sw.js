// sw.js — Hotel/Restaurant/Bar POS offline app-shell cache
//
// Caches the page itself (plus its manifest/icons) so the app OPENS with no
// internet connection at all, not just keeps working once it's already open.
// Everything the app actually runs on (inventory, sales, receipts, reports)
// already lives in localStorage — this service worker just makes sure the
// shell that renders it doesn't have to come from the network every time.
//
// CACHE VERSIONING IS AUTOMATIC — nobody has to remember to bump a number.
// The cache that holds the shell is named after a SHA-256 hash of the shell
// assets' own bytes (computed below, in refreshShell()). Change so much as
// one character of index.html and the next install computes a different
// hash, opens a differently-named cache, and deletes every other cache this
// app owns — so there is only ever one shell cache on disk, sized to exactly
// the 5 files in SHELL_ASSETS, never a pile of old versions left behind.
const APP_ID = 'servicespos';
const POINTER_CACHE = `${APP_ID}-shell-pointer`; // tiny fixed-name cache that just
                                                    // remembers which hash-named shell
                                                    // cache is the current one
const POINTER_KEY = 'https://sw-internal/current-cache-name';

// How long to wait for the network on a navigation before falling back to the
// cached copy. Long enough to win on a normal connection, short enough that a
// dead Wi-Fi hotspot doesn't leave the cashier staring at a blank screen.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3500;

// Paths are relative to the service worker's own location, not the site root.
// Using absolute '/index.html' style paths silently breaks on any deployment
// that isn't at the domain root (a Pages preview URL, a project subfolder, a
// custom path) — the cache would fill with 404s or miss entirely, and the app
// wouldn't open offline.
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// SHA-256 over the concatenated bytes of every shell asset that fetched
// successfully. Returns a short hex string used as the cache-name suffix.
async function sha256Hex(buffers) {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    combined.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

// Fetches every shell asset fresh from the network (cache: 'reload' bypasses
// the HTTP cache so we're guaranteed the real current files, not a stale
// disk-cached copy of them), caches whichever succeed under a cache name
// derived from their combined hash, records that name in the pointer cache,
// and deletes every other cache this app owns.
//
// Each asset is fetched independently — the old cache.addAll() was ATOMIC: if
// any single asset 404s (a moved icon, a renamed manifest) the whole install
// rejected and NOTHING got cached, so the app never worked offline and gave
// no clue why. One missing icon can no longer take down offline mode.
async function refreshShell() {
  const fetched = await Promise.all(
    SHELL_ASSETS.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (!res || !res.ok) return { path, ok: false };
        const buf = await res.clone().arrayBuffer();
        return { path, ok: true, res, buf };
      } catch (e) {
        return { path, ok: false };
      }
    })
  );

  const succeeded = fetched.filter((f) => f.ok);
  const failed = fetched.filter((f) => !f.ok).map((f) => f.path);
  if (failed.length) {
    console.warn('[HRB-POS] These shell assets could not be cached:', failed);
  }
  // Offline (or every request failed) during install: leave whatever cache
  // and pointer already exist from the last successful install untouched,
  // rather than wiping a working offline copy for nothing.
  if (!succeeded.length) return;

  const hash = await sha256Hex(succeeded.map((f) => f.buf));
  const cacheName = `${APP_ID}-shell-${hash}`;

  const cache = await caches.open(cacheName);
  await Promise.all(succeeded.map((f) => cache.put(f.path, f.res)));

  const pointer = await caches.open(POINTER_CACHE);
  await pointer.put(POINTER_KEY, new Response(cacheName));

  // This is what actually frees the storage used by every previous version,
  // automatically, on every install — no manual version bump required.
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => n !== cacheName && n !== POINTER_CACHE && n.startsWith(`${APP_ID}-`))
      .map((n) => caches.delete(n))
  );
}

// Resolves to the Cache object for the currently-active shell cache. Reads
// the name from the pointer cache rather than a top-level constant, because a
// service worker can be terminated and respawned between events — a plain
// variable set during 'install' would be gone by the time a later 'fetch'
// runs in a fresh instance of this same script.
async function currentCache() {
  const pointer = await caches.open(POINTER_CACHE);
  const match = await pointer.match(POINTER_KEY);
  const name = match ? await match.text() : null;
  return caches.open(name || `${APP_ID}-shell-fallback`);
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Only the app shell (the page itself + its manifest/icons) is intercepted here.
// Everything else — every /api/* call (M-Pesa, Paystack, barcode lookups,
// cross-device sync) and any POST/PUT request — is left completely untouched
// and goes straight to the network. Those already fail gracefully on their own
// (see pullState()/pushNow() in index.html, which catch network errors and
// just show an "offline" sync badge) when there's no connection.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin requests
  if (url.pathname.includes('/api/')) return;        // never cache API calls

  // A navigation is anything that opens the app (typing the URL, tapping the
  // home-screen icon, a bookmarked ?staff= link). Those must be served from
  // cache when offline, whatever query string they carry.
  const isNavigation = req.mode === 'navigate';
  const isShellAsset = SHELL_ASSETS.some((p) => {
    const tail = p.replace(/^\.\//, '');
    return tail && url.pathname.endsWith(tail);
  });
  if (!isNavigation && !isShellAsset) return;

  event.respondWith(
    (async () => {
      const cache = await currentCache();

      // Helper: find the cached page for a navigation, ignoring the query string —
      // otherwise opening ?staff=abc offline would miss the cached page entirely
      // and show the browser's offline error page.
      const cachedPage = async () =>
        (await cache.match('./index.html')) ||
        (await cache.match('./')) ||
        (await cache.match(req, { ignoreSearch: true }));

      if (isNavigation) {
        // NETWORK-FIRST for the page itself.
        //
        // This used to be stale-while-revalidate (serve cache instantly, refresh
        // in the background). That made every redeploy invisible: the shop would
        // update the site and still be served the OLD app, because the fresh copy
        // only landed in the cache AFTER the page had already rendered from the
        // stale one. Two separate things made it worse — the background fetch
        // could itself be answered from the browser's own HTTP cache (so the new
        // file was sometimes never fetched at all), and an installed PWA rarely
        // gets reloaded twice in a row, which is what SWR needs to catch up.
        //
        // Now the network wins whenever it answers in time, with 'reload' to
        // bypass the HTTP cache so we're guaranteed the real current file. The
        // cache is still updated on every success and is still the fallback the
        // moment the network is slow or gone — so offline opening is unaffected,
        // and the cached copy never drifts far out of date even between installs.
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), NAVIGATION_NETWORK_TIMEOUT_MS);
          const res = await fetch(new Request(req.url, {
            cache: 'reload',
            signal: controller.signal,
            credentials: 'same-origin',
          }));
          clearTimeout(timer);
          if (res && res.ok) {
            cache.put('./index.html', res.clone()).catch(() => { /* quota — not fatal */ });
            return res;
          }
          // Server answered but with an error (502/404/etc) — a cached working
          // copy beats showing the shop an error page.
          return (await cachedPage()) || res;
        } catch (e) {
          // Offline, or slower than the timeout.
          const fallback = await cachedPage();
          if (fallback) return fallback;
          throw e; // nothing cached yet — let the browser show its offline page
        }
      }

      // CACHE-FIRST for the static shell assets (manifest, icons). These are
      // small, rarely change, and are exactly what should load instantly; they're
      // refreshed in the background on every hit.
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            cache.put(req, res.clone()).catch(() => { /* quota — not fatal */ });
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })()
  );
});
