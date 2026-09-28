import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeServer, openDevice, sleep, closeWhenIdle } from './e2e-harness.mjs';

// Zip 129: "the POS says OFFLINE although the internet works" and "retrying… sending… no transaction ever succeeds".
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };

/* ---------- server ---------- */
test('/api/health: fast, not cached, no licence, writes nothing; ?deep=1 reports storage trouble as 503 (TEST 9)', async () => {
  const h = await load('health.js');
  const kv = makeKV(); const puts = []; const put0 = kv.put; kv.put = async (...a) => { puts.push(a[0]); return put0.apply(kv, a); };
  const r = await h.onRequest({ request: new Request('https://shop.mydukapos.store/api/health'), env: { mydukapos_kv: kv } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  assert.match(r.headers.get('CDN-Cache-Control'), /no-store/);
  assert.equal((await r.json()).ok, true);
  const d = await h.onRequest({ request: new Request('https://x/api/health?deep=1'), env: { mydukapos_kv: kv } });
  assert.equal((await d.json()).kv, true);
  const bad = await h.onRequest({ request: new Request('https://x/api/health?deep=1'), env: { mydukapos_kv: { get: async () => { throw new Error('down'); } } } });
  assert.equal(bad.status, 503);
  const head = await h.onRequest({ request: new Request('https://x/api/health', { method: 'HEAD' }), env: {} });
  assert.equal(head.status, 200);
  assert.deepEqual(puts, [], 'nothing written');
  const sw = (await import('node:fs')).readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /if \(url\.pathname\.includes\('\/api\/'\)\) return;/, 'the service worker never answers /api/ (so never a stale health answer)');
});

test('/api/sync-have: the server says which records it already has, in which version — the same version the app computes', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const sync = await load('pos-sync.js');
  const s1 = { id: 'a', timestamp: '2026-05-01T10:00:00.000Z', paymentMethod: 'cash', items: [{ code: 'A', qty: 2, price: 50 }] };
  const s2 = { id: 'b', timestamp: '2026-05-01T11:00:00.000Z', paymentMethod: 'cash', items: [{ code: 'A', qty: 1, price: 50 }] };
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), salesLog: [s1, s2] }) }), env, waitUntil() {} });
  const have = await load('sync-have.js');
  const r = await have.onRequestPost({ request: new Request('https://x.pages.dev/api/sync-have?c=C1', { method: 'POST', body: JSON.stringify({ col: 'salesLog', ids: ['a', 'b', 'zzz'] }) }), env });
  const out = (await r.json()).have;
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b']);
  const t = await boot('index.html', { wait: 500, indexedDB: new IDBFactory() });
  assert.equal(t.w.eval(`salesJournalSig(${JSON.stringify(s1)})`), out.a, 'client and server agree on the version');
  t.close();
});

/* ---------- the connectivity manager ---------- */
function netFetch(ctl) {
  return async (url, opts = {}) => {
    const u = String(url);
    ctl.calls.push(u);
    // no internet at all: NOTHING answers — the POS, this site itself (zip 147 asks it before saying "offline"), anything
    if (ctl.internet === false) throw new TypeError('Failed to fetch');
    if (u.includes('/api/health')) {
      if (ctl.health === 'down') throw new TypeError('Failed to fetch');
      if (typeof ctl.health === 'number') return json({ ok: false }, ctl.health);
      return json({ ok: true, t: Date.now() });
    }
    if (u.includes('/api/pos-sync')) {
      if (ctl.health === 'down') throw new TypeError('Failed to fetch');
      if (ctl.sync) return json({ error: 'x', code: ctl.syncCode || '' }, ctl.sync);
      return json({ unchanged: true, updatedAt: 1 });
    }
    return json({}, 404);
  };
}
async function app(ctl, extra = {}) {
  const t = await boot(extra.app || 'index.html', { fetch: netFetch(ctl), wait: 900, indexedDB: new IDBFactory(), storage: extra.storage || {} });
  t.w.__posNetInternetProbe = async () => ctl.internet !== false;
  t.w.eval("showToast = function () {}; document.getElementById('login-screen') && (document.getElementById('login-screen').style.display = 'none')");
  t.state = () => t.w.eval('PosNet.state');
  t.dot = () => { const el = t.d.getElementById('sync-status'); return el ? { state: el.dataset.state, net: el.dataset.net, title: el.title } : null; };
  return t;
}

test('TESTS 1, 2, 15: internet available -> ONLINE at start (whatever an earlier session thought); nothing about "offline" is stored', async () => {
  const ctl = { calls: [], internet: true };
  const t = await app(ctl, { storage: { pos_net_state: 'offline', pos_offline: 'true' } });
  assert.ok(await until(() => t.state() === 'online'), 'online');
  assert.equal(t.dot().net, 'online');
  assert.ok(ctl.calls.some((u) => u.includes('/api/health')), 'decided by a real health check');
  assert.equal(t.w.eval("Object.keys(localStorage).filter(k => /net_state|offline/i.test(k)).filter(k => k !== 'pos_net_state' && k !== 'pos_offline').length"), 0, 'no connectivity flag is persisted');
  t.close();
});

test('TESTS 3, 4: internet lost -> OFFLINE; internet back -> ONLINE by itself, no refresh, and the waiting work is sent', async () => {
  const ctl = { calls: [], internet: true };
  const t = await app(ctl);
  assert.ok(await until(() => t.state() === 'online'));
  ctl.health = 'down'; ctl.internet = false;
  t.w.dispatchEvent(new t.w.Event('offline'));
  assert.ok(await until(() => t.state() === 'offline'), 'offline');
  await sleep(3200);
  assert.equal(t.dot().state, 'offline', 'the dot says offline');
  t.w.eval('window.__retried = 0; const o = syncRetryNow; syncRetryNow = function () { window.__retried++; return o.apply(this, arguments); }');
  ctl.health = undefined; ctl.internet = true;
  t.w.dispatchEvent(new t.w.Event('online'));
  assert.ok(await until(() => t.state() === 'online'), 'back online by itself');
  assert.ok(await until(() => t.w.eval('window.__retried') > 0), 'and it sends / fetches at once');
  t.close();
});

test('TESTS 3/4 without any browser event (the online event never fires on some phones): the retry timer brings it back', async () => {
  const ctl = { calls: [], internet: true, health: 'down' };
  ctl.internet = false;
  const t = await app(ctl);
  assert.ok(await until(() => t.state() === 'offline'));
  ctl.health = undefined; ctl.internet = true;                         // no event at all
  assert.ok(await until(() => t.state() === 'online', 12000), 'recovered by the backoff retry (2 s, 4 s, ...)');
  t.close();
});

test('TESTS 7, 8, 10, 12: POS server unreachable but internet fine -> "server unavailable", never "offline"; it retries and comes back', async () => {
  const ctl = { calls: [], internet: true, health: 'down' };            // a TypeError, like a CORS or DNS failure of the POS only
  const t = await app(ctl);
  assert.ok(await until(() => t.state() === 'backend_unavailable'));
  await sleep(3200);
  assert.notEqual(t.dot().state, 'offline', 'the dot does not claim "no internet"');
  assert.match(t.dot().title, /internet works/);
  ctl.health = 503;                                                     // the server answers, but failing
  await t.w.eval("PosNet.check('test')");
  assert.equal(t.state(), 'backend_unavailable');
  ctl.health = undefined;                                               // back
  assert.ok(await until(() => t.state() === 'online', 12000), 'online again by itself');
  t.close();
});

test('TEST 11: a 401 / 403 is "sign-in / pairing needed", NOT offline; a later success clears it', async () => {
  const ctl = { calls: [], internet: true, sync: 401, syncCode: 'device_not_paired' };
  const t = await app(ctl);
  await t.w.eval('pullStateOnce()');
  assert.equal(t.state(), 'auth_required');
  assert.match(t.w.eval('PosNet.message()'), /paired/);
  ctl.sync = 403; ctl.syncCode = '';
  await t.w.eval('pullStateOnce()');
  assert.equal(t.state(), 'auth_required');
  ctl.sync = 0;                                                         // paired / licence fixed: the next sync attempt clears it
  await t.w.eval('syncRetryNow()');
  assert.ok(await until(() => t.state() === 'online'));
  t.close();
});

test('a failed sync request alone never sets offline; a push the server calls "too large" is not offline either', async () => {
  const ctl = { calls: [], internet: true };
  const t = await app(ctl);
  assert.ok(await until(() => t.state() === 'online'));
  t.w.eval("markSync('offline')");                                      // what every old code path did on a slow answer
  await sleep(300);
  assert.equal(t.state(), 'online', 'checked: the internet is fine');
  t.w.eval("PosNet.reportHttp(413, 'shop_too_large')");
  assert.equal(t.state(), 'config_error');
  t.close();
});

test('TESTS 5, 6, 13, 14: network change (Wi-Fi <-> mobile), back on screen, waking from sleep -> the connection is re-checked at once', async () => {
  const ctl = { calls: [], internet: true };
  const t = await app(ctl);
  assert.ok(await until(() => t.state() === 'online'));
  const n = () => ctl.calls.filter((u) => u.includes('/api/health')).length;
  let before = n();
  t.w.dispatchEvent(new t.w.Event('online'));                          // Wi-Fi -> mobile data: the browser reports a new network
  assert.ok(await until(() => n() > before), 'network change');
  await sleep(100); before = n();
  t.d.dispatchEvent(new t.w.Event('visibilitychange'));
  assert.ok(await until(() => n() > before), 'back on screen');
  await sleep(100); before = n();
  t.w.eval('PosNet._state.lastTick = Date.now() - 120000');            // timers were frozen for two minutes (sleep)
  assert.ok(await until(() => n() > before, 4000), 'woke up');
  assert.ok(t.w.eval("PosNet.history().some(h => h.kind === 'wake')"));
  await sleep(100); before = n();
  t.w.dispatchEvent(new t.w.Event('pageshow'));                        // PWA reopened from the background
  assert.ok(await until(() => n() > before), 'pageshow');
  t.close();
});

test('the browser wrongly says "offline" but the POS answers -> ONLINE (navigator.onLine is only a hint)', async () => {
  const ctl = { calls: [], internet: true };
  const t = await app(ctl);
  Object.defineProperty(t.w.navigator, 'onLine', { value: false, configurable: true });
  t.w.dispatchEvent(new t.w.Event('offline'));
  await sleep(500);
  assert.equal(t.state(), 'online');
  t.close();
});

test('every app and the owner console carry the one connectivity manager', async () => {
  for (const a of ['water/index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'owner/index.html']) {
    const ctl = { calls: [], internet: true };
    const t = await app(ctl, { app: a });
    assert.ok(await until(() => t.state() === 'online'), a);
    t.close();
  }
});

/* ---------- the sync that never finished ---------- */
// A shop with a long history, reopened on a slow line: the first push used to carry the whole history, time out, be retried in
// full, time out again... "retrying, sending", no sale ever reaching the server, and the dot said OFFLINE.
async function slowLineShop() {
  const server = makeServer();
  const history = Array.from({ length: 3000 }, (_, i) => ({ id: 'h' + i, refNumber: 'R' + i, timestamp: new Date(Date.now() - (i + 10) * 3600000).toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }] }));
  await (await load('pos-sync.js')).onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), salesLog: history }) }), env: server.env, waitUntil() {} });
  const base = server.fetch;
  server.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'https://x');
    if (u.pathname.endsWith('/api/health')) return json({ ok: true });
    if (u.pathname.endsWith('/api/sync-have')) { const m = await load('sync-have.js'); return m.onRequestPost({ request: new Request('https://x.pages.dev/api/sync-have?c=C1', { method: 'POST', body: opts.body }), env: server.env }); }
    if ((opts.method || 'GET').toUpperCase() === 'POST' && u.pathname.endsWith('/api/pos-sync')) {
      const bytes = String(opts.body || '').length;
      await new Promise((resolve, reject) => {                          // a weak mobile uplink: ~10 KB per second
        const t = setTimeout(resolve, bytes / 10);
        if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    return base(url, opts);
  };
  return { server, history };
}

test('ROOT CAUSE: a device reopened on a slow line with a long history syncs a new sale (checks what the server has, sends only the rest, in batches) and is ONLINE', async () => {
  const { server, history } = await slowLineShop();
  const t = await openDevice('index.html', server, { pos_sales_log: JSON.stringify(history), pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 9999, unit: 'pcs' }]) }, 900, { indexedDB: new IDBFactory() });
  t.w.eval("showToast = function () {}; document.getElementById('login-screen').style.display = 'none'");
  t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000';
  await t.w.eval('checkoutCart()');
  const id = t.w.eval('salesLog[salesLog.length - 1].id');
  const ok = await until(() => server.serverState().salesLog.some((s) => s.id === id), 20000);
  assert.ok(ok, 'the new sale reached the server');
  assert.equal(server.serverState().salesLog.length, 3001, 'nothing duplicated');
  assert.equal(t.w.eval('PosNet.state'), 'online');
  const posts = server.state.log.filter((l) => l.startsWith('POST')).length;
  assert.ok(posts <= 3, 'no re-upload of the history (' + posts + ' pushes)');
  await closeWhenIdle(t);
});

test('a device that must upload a large backlog (the server never had it) sends it in batches that each succeed, until done', async () => {
  const server = makeServer();
  const backlog = Array.from({ length: 700 }, (_, i) => ({ id: 'b' + i, refNumber: 'B' + i, timestamp: new Date(Date.now() - (i + 5) * 60000).toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }] }));
  const t = await openDevice('index.html', server, { pos_sales_log: JSON.stringify(backlog) }, 900, { indexedDB: new IDBFactory() });
  t.w.eval("showToast = function () {}; window.__pushBatchGapMs = 10");
  assert.ok(await until(() => (server.serverState().salesLog || []).length === 700, 20000), 'all 700 arrived');
  assert.ok(server.state.log.filter((l) => l.startsWith('POST')).length >= 5, 'in batches');
  // (the server confirms its write before answering — zip 146 — so the last OK lands a moment after the data)
  assert.ok(await until(() => t.w.eval('hasUnsyncedWork()') === false, 10000), 'and the device knows it is done');
  t.close();
});
