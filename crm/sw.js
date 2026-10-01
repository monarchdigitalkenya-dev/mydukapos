/* MyDuka CRM service worker (zip 161) - makes the app shell open instantly on a repeat visit, without ever serving a mismatched or stale-forever app.
 *
 * How it stays safe:
 *  - It handles ONLY GET requests for the CRM's own shell files (the page, crm.css, the crm-*.js files, the icon and the manifest). It never touches /api (or anything else),
 *    so data is always live; the shop's own service worker (/sw.js) ignores /crm/ and this one ignores everything outside /crm/.
 *  - The shell is stored as ONE consistent SET (a cache named after a hash of the files' bytes). A page is always served files from a single set, so
 *    crm-core.js from one release can never meet crm-leads.js from another.
 *  - Stale-while-revalidate: the cached set answers at once; in the background (at most once a minute) every shell file is re-fetched with cache:'no-cache' (a conditional
 *    request: a 304 when nothing changed). Only if ALL of them arrive and their combined hash differs is a NEW set built, then switched to atomically. A failed or partial
 *    download changes nothing.
 *  - When a new set is ready the page is told ('crm-update') and shows "A new version is ready - Reload". The running page is never swapped under the user's hands.
 *  - This file itself is served with Cache-Control: no-cache (see _headers), and it uses skipWaiting + clients.claim so a new worker takes over at once.
 *  - Kill switch: opening /crm/?nosw=1 unregisters it and clears its caches.
 */
'use strict';
const SW_VERSION = 'crm-sw-2';     // zip 162: crm-admin-more.js joins the shell; every answer from the set carries X-Crm-Set
const META = 'crm-sw-meta', SET_PREFIX = 'crm-set-', POINTER = '/__crm_sw_current';
const SHELL = ['/crm/index.html', '/crm/crm.css', '/crm/crm-core.js', '/crm/crm-leads.js', '/crm/crm-inbox.js', '/crm/crm-admin.js', '/crm/crm-admin-more.js', '/crm/crm-start.js', '/crm/manifest.webmanifest', '/crm/icon.svg'];
const MIN_GAP_MS = 60000;
let lastCheck = 0, checking = null;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function currentSet() { try { const c = await caches.open(META); const r = await c.match(POINTER); return r ? (await r.text()) : null; } catch (e) { return null; } }
async function setPointer(name) { const c = await caches.open(META); await c.put(POINTER, new Response(name)); }

/* Download every shell file; resolve with { name, entries } or null if anything is missing / not OK. */
async function downloadSet() {
  const got = [];
  for (const path of SHELL) {
    let res;
    try { res = await fetch(path, { cache: 'no-cache', credentials: 'same-origin' }); } catch (e) { return null; }
    if (!res || !res.ok || res.redirected || res.type === 'opaque') return null;
    got.push({ path, buf: await res.clone().arrayBuffer(), res });
  }
  const all = new Uint8Array(got.reduce((n, g) => n + g.buf.byteLength + 1, 0)); let off = 0;
  for (const g of got) { all.set(new Uint8Array(g.buf), off); off += g.buf.byteLength; all[off++] = 0; }
  return { name: SET_PREFIX + hex(await crypto.subtle.digest('SHA-256', all)).slice(0, 24), entries: got };
}

/* Bring the cached set up to date. Returns 'unchanged' | 'updated' | 'failed'. Safe to call any time. */
async function revalidate(announce) {
  if (checking) return checking;
  checking = (async () => {
    lastCheck = Date.now();
    const d = await downloadSet(); if (!d) return 'failed';
    const cur = await currentSet();
    if (cur === d.name) { if (await caches.has(cur)) return 'unchanged'; }
    const cache = await caches.open(d.name);
    await Promise.all(d.entries.map((e) => cache.put(e.path, e.res)));
    if ((await cache.keys()).length !== SHELL.length) { await caches.delete(d.name); return 'failed'; }
    await setPointer(d.name);                                            // the switch: atomic (one small write)
    for (const k of await caches.keys()) if (k.startsWith(SET_PREFIX) && k !== d.name) await caches.delete(k);
    if (announce && cur) { for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'crm-update', version: d.name }); }
    return 'updated';
  })().catch(() => 'failed').finally(() => { checking = null; });
  return checking;
}

self.addEventListener('install', (event) => { self.skipWaiting(); event.waitUntil(revalidate(false).catch(() => {})); });
self.addEventListener('activate', (event) => { event.waitUntil((async () => { await self.clients.claim(); })()); });
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'crm-check') event.waitUntil(revalidate(true));
  if (d.type === 'crm-clear') event.waitUntil((async () => { for (const k of await caches.keys()) if (k.startsWith('crm-')) await caches.delete(k); })());
});

// zip 162: the page learns which set answered (X-Crm-Set) so it can tell that a lazily loaded file (crm-admin-more.js) belongs to the same release as the page it runs in
function stamped(res, name) {
  try { const h = new Headers(res.headers); h.set('X-Crm-Set', name); return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }); } catch (e) { return res; }
}
const shellKey = (url) => {
  if (url.pathname === '/crm' || url.pathname === '/crm/' || url.pathname === '/crm/index.html') return '/crm/index.html';
  return SHELL.includes(url.pathname) ? url.pathname : null;
};
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;   // never data, never cross-origin
  if (url.searchParams.has('nosw')) return;                                              // the kill switch bypasses the cache
  const key = shellKey(url); if (!key) return;
  if (req.mode === 'navigate' && url.pathname === '/crm') return;                        // "/crm" is redirected to "/crm/" by the host: leave that to the network
  event.respondWith((async () => {
    const name = await currentSet(); let hit = null;
    if (name) { try { hit = await (await caches.open(name)).match(key); } catch (e) { hit = null; } }
    if (Date.now() - lastCheck > MIN_GAP_MS) event.waitUntil(revalidate(true));          // stale-while-revalidate
    return hit ? stamped(hit, name) : fetch(req);
  })());
});
