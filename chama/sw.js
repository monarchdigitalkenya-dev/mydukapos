// sw.js — Chama offline app-shell cache
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
const APP_ID = 'chama';
const POINTER_CACHE = `${APP_ID}-shell-pointer`; // tiny fixed-name cache that just
                                                    // remembers which hash-named shell
                                                    // cache is the current one
const POINTER_KEY = 'https://sw-internal/current-cache-name';

// How long to wait for the network on a navigation before falling back to the
// cached copy. Long enough to win on a normal connection, short enough that a
// dead Wi-Fi hotspot doesn't leave the cashier staring at a blank screen.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3500;

// zip 145 — BUMP THIS WITH EVERY RELEASE. A service worker only updates when THIS file changes; it had not changed for many releases,
// so installed apps kept the service worker (and the old cached page) they were installed with. A new version here makes every
// installed app install this worker, which re-downloads the whole shell (refreshShell) — the stuck phones catch up by themselves.
const SW_VERSION = 'zip-266';

// zip 247 - "UPDATE AVAILABLE" WHEN NOTHING WAS PUBLISHED. The notice used to be decided by the page's ETag, and (1) a changed ETag with identical bytes
// (Cloudflare re-labels a compressed copy as weak, another edge answers with another tag) announced an update that did not exist, (2) ANY page opened
// under this worker - a receipt link, the QR-order page, a help page - was stored as the app's page and its tag compared with the app's, so the next
// open of the app "found" a difference, and (3) the notice went to every open window of the site, including OTHER apps' windows. Now the decision is
// the page's own bytes (a fingerprint), only this app's page counts, and only this app's windows are told.
const APP_ROOT = (() => { try { return new URL('./', self.location.href).pathname; } catch (e) { return null; } })();   // e.g. "/" or "/hotel/"
const isAppPagePath = (pathname) => APP_ROOT === null || pathname === APP_ROOT || pathname === APP_ROOT + 'index.html';
const isAppClientUrl = (u) => { try { return !u || isAppPagePath(new URL(u).pathname); } catch (e) { return true; } };

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
    console.warn('[Chama] These shell assets could not be cached:', failed);
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

// zip 263 - the fingerprint of the page, WITHOUT the parts Cloudflare may rewrite on every request. Email obfuscation re-encodes any e-mail address in
// the page with a new random key each time, and the edge can inject beacon / rocket-loader attributes: identical app, different bytes, so every open
// announced "a newer version" that did not exist. Those pieces are removed before the hash.
async function pageHash(buf) {
  let t;
  try { t = new TextDecoder().decode(buf); } catch (e) { return sha256Hex([buf]); }
  t = t.replace(/data-cfemail="[0-9a-fA-F]+"/g, '').replace(/\/cdn-cgi\/l\/email-protection#[0-9a-fA-F]+/g, '')
    .replace(/<script[^>]*(?:cdn-cgi\/(?:scripts|challenge-platform)|beacon\.min\.js)[^>]*>[\s\S]*?<\/script>/g, '').replace(/ data-cf-[a-z-]+="[^"]*"/g, '');
  return sha256Hex([new TextEncoder().encode(t).buffer]);
}

// Stores a fresh copy of the page and tells the open app that a newer version is ready - but ONLY when the page's own bytes changed (a fingerprint of
// the content, never the ETag: a tag can change with identical bytes).
async function savePageCopy(copyPromise, ctx) {
  const got = await copyPromise;
  if (!got) return;
  try {
    const copy = got.copy;
    const hash = await pageHash(await copy.clone().arrayBuffer());
    const pointer = await caches.open(POINTER_CACHE);
    const prev = await pointer.match('https://sw-internal/page-hash-2');
    const prevHash = prev ? await prev.text() : null;
    if (prevHash && prevHash === hash) return;                      // the very page already held: nothing to store, nothing to announce
    const cache = await currentCache();
    // zip 219 - the open page may have come from the cached copy (slow line, or the first open after a release). It must ALWAYS be told when the
    // new copy differs from the one it was shown. With no fingerprint remembered yet (the first run of this release), the stored copy is compared by content.
    const old = await cache.match('./index.html');
    let differs = !!prevHash;
    if (!differs && old) { try { differs = (await pageHash(await old.clone().arrayBuffer())) !== hash; } catch (e) { differs = true; } }
    await cache.put('./index.html', copy);
    await pointer.put('https://sw-internal/page-hash-2', new Response(hash));
    if (differs) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // zip 263: the window that was just SHOWN the network copy already has the new version - only the cached-copy window and other open windows are told
      wins.forEach((c) => { if (isAppClientUrl(c.url) && (!ctx || ctx.servedCache || c.id !== ctx.clientId)) { try { c.postMessage({ type: 'app-update-ready', sw: SW_VERSION }); } catch (e) { /* closed */ } } });
    }
  } catch (e) { /* quota - not fatal */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

// A friendly page (instead of the browser's "webpage not available") for the one case nothing can be shown: the network is down or too
// slow AND nothing is cached yet (a first visit, or the device cleared its storage). It retries by itself every few seconds.
function offlinePage() {
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting…</title>'
    + '<body style="font-family:system-ui,sans-serif;text-align:center;padding:12vh 24px;color:#2c3e50">'
    + '<h2>Waiting for a connection…</h2><p>The app could not be reached right now. It will open by itself as soon as there is internet.</p>'
    + '<p><button onclick="location.reload()" style="padding:12px 22px;font-size:16px;border:0;border-radius:8px;background:#27ae60;color:#fff">Try again</button></p>'
    + '<script>setTimeout(function(){location.reload()},6000)<\/script></body>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Offline eTIMS (VSCU) background sync — registered from etims-offline.js
// (reg.sync.register('etims-queue-sync')) every time a sale is queued. The
// actual queue-processing logic lives in etims-offline.js's IndexedDB
// stores rather than here, because a Background Sync event handler can't
// itself talk to the local VSCU program's REST API with the same
// AbortController/timeout plumbing already written for the foreground
// tab — instead we wake any open/controlled tab and ask IT to flush the
// queue, which covers the common case (tab is open in the background)
// without duplicating the sync logic in two places. Browsers without the
// Background Sync API (Safari, some Android WebViews) simply never fire
// this — those rely on the 15s foreground timer + 'online' event in
// etims-offline.js instead, which is why that fallback exists at all.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'etims-queue-sync') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: 'ETIMS_FLUSH_QUEUE' }));
    })
  );
});

// Only the app shell (the page itself + its manifest/icons) is intercepted here.
// Everything else — every /api/* call (M-Pesa, Paystack, barcode lookups,
// cross-device sync) and any POST/PUT request — is left completely untouched
// and goes straight to the network. Those already fail gracefully on their own
// (see pullState()/pushNow() in index.html, which catch network errors and
// just show an "offline" sync badge) when there's no connection.
const MEDIA_CACHE = 'mydukapos-media-v1';            // shared by every app on this site; not an app-shell cache, so never cleared by an update
async function mediaCacheFirst(req) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) { try { await cache.put(req, res.clone()); } catch (e) { /* storage full: shown, not kept */ } }
    return res;
  } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin requests
  // Product / menu photos kept in R2 (zip 133): they never change once stored (a new photo gets a new id), so each is kept on the
  // device after its first load and shown from there — also offline. Only product photos (k=p): clinical images are never cached here.
  if (url.pathname.endsWith('/api/media') && url.searchParams.get('k') === 'p') { event.respondWith(mediaCacheFirst(req)); return; }
  if (url.pathname.includes('/api/')) return;        // never cache API calls

  // A navigation is anything that opens the app (typing the URL, tapping the
  // home-screen icon, a bookmarked ?staff= link). Those must be served from
  // cache when offline, whatever query string they carry.
  const isNavigation = req.mode === 'navigate';
  const isShellAsset = SHELL_ASSETS.some((p) => {
    const tail = p.replace(/^\.\//, '');
    if (!tail) return false;
    return APP_ROOT === null ? url.pathname.endsWith(tail) : url.pathname === APP_ROOT + tail;       // zip 247: THIS app's files only (not another app's index.html / manifest)
  });
  if (!isNavigation && !isShellAsset) return;
  if (isNavigation) {
    event.__pageNetwork = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
    // the copy for the cache is cloned FIRST (before the browser starts reading the page), in the very first handler attached
    // zip 247: only THIS app's own page is kept as the app's page (a receipt, QR-order or help page opened under this worker is not)
    event.__pageCtx = { servedCache: false, clientId: event.resultingClientId || null };
    if (isAppPagePath(url.pathname)) {
      const pageCopy = event.__pageNetwork.then((r) => (r && r.ok ? { copy: r.clone(), headers: r.headers } : null), () => null);
      event.waitUntil(savePageCopy(pageCopy, event.__pageCtx));                // keeps the worker alive until the new copy is stored
    }
  }

  event.respondWith(
    (async () => {
     try {
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
        // zip 145 — the download is NEVER aborted. After NAVIGATION_NETWORK_TIMEOUT_MS the cached copy is shown (the app opens fast
        // on a slow line), but the download carries on and REPLACES the cached copy when it arrives (savePageCopy). It used to be
        // aborted at 3.5 s: on a phone whose connection takes longer than that to answer, an installed app showed its old copy on every
        // open and the copy was never refreshed — stuck for good on an old release (old offline detection: "Offline" with internet).
        const network = event.__pageNetwork;
        const timedOut = new Promise((r) => setTimeout(() => r('timeout'), NAVIGATION_NETWORK_TIMEOUT_MS));
        let res = null, failed = false;
        try { res = await Promise.race([network, timedOut]); } catch (e) { failed = true; }
        if (res && res !== 'timeout' && res.ok) return res;
        // zip 147 — Cloudflare's security check answered instead of the app. It must be SHOWN so the browser can complete it (it sets the
        // clearance cookie and returns to the app); serving the cached app instead meant an installed app could never pass it, and every
        // request to the POS server stayed blocked ("offline" / "server refused") with working internet.
        if (res && res !== 'timeout' && String(res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge') return res;
        if (event.__pageCtx) event.__pageCtx.servedCache = true;      // from here the window is shown the cached copy, so a different network copy IS news to it
        const fallback = await cachedPage();
        if (fallback) return fallback;                                 // offline, slow, or an error answer: the cached app
        if (res && res !== 'timeout') return res;                      // an error answer and nothing cached
        // Nothing cached yet (a first visit, or cleared storage): wait for the download with no time limit; only if it fails, a
        // friendly page.
        if (!failed) { try { const r2 = await network; if (r2) return r2; } catch (e2) { /* below */ } }
        try { return await fetch(req); } catch (e3) { return offlinePage(); }
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
        .catch(() => cached || Response.error());

      return cached || networkFetch;
     } catch (err) {
      // The cache itself failed (storage full, blocked, corrupted): never turn that into an error page — just use the network.
      try { return await fetch(req); } catch (e3) { return isNavigation ? offlinePage() : Response.error(); }
     }
    })()
  );
});
