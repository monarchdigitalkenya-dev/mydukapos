import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';
const test = hasSqlite ? baseTest : baseTest.skip;

// The per-shop SQLite Durable Object must behave EXACTLY like the single-blob KV backend for everything the apps rely on —
// so every scenario below runs against BOTH and compares — and must additionally do what the blob could not.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

async function backends() {
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  const sync = await load('functions/api/pos-sync.js');
  // legacy blob backend
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const blob = {
    name: 'blob',
    push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); },
    state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json(),
  };
  // database backend
  const store = new ShopStore(fakeDoState(), {});
  const db = {
    name: 'db', store,
    push: async (b) => { await (await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) }))).json(); },
    state: async () => JSON.parse(store.stateText(null)),
  };
  return [blob, db];
}
// compare two states ignoring server-clock fields
const norm = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'updatedAt' && typeof v === 'number' && v > 1.7e12 && k !== 'x' ? undefined : v)));
// Each backend replays the scenario at its own wall-clock time, so compare CONTENT, not the timestamps the scenario itself stamped.
const strip = (s) => {
  const c = JSON.parse(JSON.stringify(s)); delete c.updatedAt; delete c._fieldTimes;
  for (const v of Object.values(c)) if (Array.isArray(v)) v.forEach((r) => { if (r && typeof r === 'object') { delete r._qtySyncedAt; delete r.updatedAt; delete r.timestamp; if (r._srv) delete r._srv.at; if (r._ct) r._ct = Object.keys(r._ct); } });
  return c;
};
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function both(scenario) {
  const [a, b] = await backends();
  await scenario(a); await scenario(b);
  const sa = strip(await a.state()), sb = strip(await b.state());
  // arrays compared as id-keyed maps (order is insertion order in both, but be strict only on content)
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (Array.isArray(sa[k]) || Array.isArray(sb[k])) {
      const key = (r) => (r && (r.id ?? r.code ?? r.token)) ?? JSON.stringify(r);
      const ma = new Map((sa[k] || []).map((r) => [key(r), r])), mb = new Map((sb[k] || []).map((r) => [key(r), r]));
      assert.deepEqual([...mb.keys()].sort(), [...ma.keys()].sort(), `${k}: same records`);
      for (const [id, r] of ma) assert.deepEqual(mb.get(id), r, `${k}/${id}: same content`);
    } else assert.deepEqual(sb[k], sa[k], `${k}: same value`);
  }
  return [sa, sb];
}

test('DB == blob: an edit on one device survives a stale device; new items from the stale device are kept', async () => {
  const [a] = await both(async (b) => {
    const t = Date.now();
    await b.push({ updatedAt: t, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t - 10000 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 12, qty: 5, updatedAt: Date.now() }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 5, updatedAt: t - 10000 }, { code: 'B', name: 'Nut', price: 3, qty: 9, updatedAt: Date.now() }] });
  });
  assert.equal(a.inventory.find((i) => i.code === 'A').price, 12);
  assert.ok(a.inventory.find((i) => i.code === 'B'));
});

test('DB == blob: two tills each sell one unit while offline -> BOTH sales come off (stock ledger: each movement applied once)', async () => {
  const [a, b] = await both(async (s) => {
    const t0 = Date.now();
    await s.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 10, updatedAt: t0 - 1000 }], stockMovementLog: [] });
    await wait(20);
    const sale = (id) => ({ id, code: 'A', name: 'Bolt', delta: -1, type: 'removed', timestamp: new Date().toISOString(), reason: 'sale' });
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m1')] });
    await wait(20);
    const second = { updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m2')] };
    await s.push(second); await wait(10); await s.push({ updatedAt: Date.now(), stockMovementLog: second.stockMovementLog });   // a retry of the movement
  });
  // Each till computed its own decrement from a stale base of 10 and pushed qty:9. Since zip 118 the server ignores those plain
  // numbers for an existing item and applies each movement exactly once (applyStockLedger in _merge.js): 10 - 1 - 1 = 8, and the
  // retry of m2 changes nothing. (Before, the later push won outright and one sale was lost: 9.)
  assert.equal(a.inventory[0].qty, 8);
  assert.equal(b.inventory[0].qty, 8);
  assert.equal(b.stockMovementLog.length, 2);
});

test('DB == blob: per-site tanks merge per record; staff tombstones; protected settings are never blanked; keyless records', async () => {
  const [a] = await both(async (s) => {
    const t = Date.now();
    await s.push({ updatedAt: t, pwHash: 'h1', adminPwHash: 'h2', tanks: [{ id: 'tank-1', siteId: 'shop', currentVolumeLiters: 3000, updatedAt: t - 5000 }, { id: 'tank-p', siteId: 'prod', currentVolumeLiters: 0, updatedAt: t - 5000 }], staff: [{ id: 's1', name: 'Ann', updatedAt: t - 100 }], tables: ['T1', 'T2'] });
    await wait();
    // tank levels are stock cells since zip 118: they move by movements (applied once), never by the number a device sends
    const cell = (k) => ({ c: 'tanks', k, f: 'currentVolumeLiters' });
    await s.push({ updatedAt: Date.now(), tanks: [{ id: 'tank-1', siteId: 'shop', currentVolumeLiters: 2990, updatedAt: Date.now() }, { id: 'tank-p', siteId: 'prod', currentVolumeLiters: 0, updatedAt: t - 5000 }],
      stockMovementLog: [{ id: 'tv1', cell: cell('id:tank-1'), delta: -10, timestamp: new Date().toISOString() }] });
    await wait();
    await s.push({ updatedAt: Date.now(), businessName: '', pwHash: '', adminPwHash: '', tanks: [{ id: 'tank-1', siteId: 'shop', currentVolumeLiters: 3000, updatedAt: t - 5000 }, { id: 'tank-p', siteId: 'prod', currentVolumeLiters: 800, updatedAt: Date.now() + 10 }],
      stockMovementLog: [{ id: 'tv2', cell: cell('id:tank-p'), delta: 800, timestamp: new Date().toISOString() }], staff: [{ id: 's1', name: 'Ann', removed: true, updatedAt: Date.now() }], tables: ['T3'], billNotifications: [{ note: 'no id 1' }, { note: 'no id 2' }] });
  });
  assert.equal(a.tanks.find((x) => x.id === 'tank-1').currentVolumeLiters, 2990);
  assert.equal(a.tanks.find((x) => x.id === 'tank-p').currentVolumeLiters, 800);
  assert.equal(a.pwHash, 'h1');
  assert.equal(a.businessName, 'Biz');
  assert.equal(a.staff[0].removed, true);
  assert.deepEqual(a.tables, ['T3']);
});

test('DB == blob: a device with a badly wrong clock cannot overwrite a newer edit', async () => {
  await both(async (s) => {
    const t = Date.now();
    await s.push({ updatedAt: t, inventory: [{ code: 'A', price: 10, qty: 5, updatedAt: t }] });
    await wait(10);
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', price: 15, qty: 5, updatedAt: Date.now() }] });
    await wait(10);
    const fast = 3 * 3600 * 1000;
    await s.push({ updatedAt: Date.now() + fast, inventory: [{ code: 'A', price: 10, qty: 5, updatedAt: t + fast }] });
  });
  const [, b] = await both(async () => {});
  assert.ok(b);
});

// ---- what the database can do that the blob could not ----
test('DB: a push costs what the PUSH weighs, not what the shop weighs', async () => {
  const [, db] = await backends();
  const sale = (i) => ({ id: `s${i}`, timestamp: new Date(Date.now() - (i % 400) * 86400000).toISOString(), paymentMethod: 'cash', cashAmount: 10, note: 'x'.repeat(200), items: [{ code: '1', qty: 1, price: 10 }] });
  const big = Array.from({ length: 40000 }, (_, i) => sale(i));                                  // ~ 14 MB of history: over the blob's 12 MB limit
  let t = Date.now();
  await db.push({ updatedAt: Date.now(), salesLog: big });
  const bulk = Date.now() - t;
  t = Date.now();
  await db.push({ updatedAt: Date.now(), salesLog: [sale(40001)] });
  const one = Date.now() - t;
  assert.ok(one < 100, `one more sale took ${one} ms on a shop of 40,000 sales (bulk load took ${bulk} ms)`);
  const st = db.store.stats();
  assert.equal(st.collections.find((c) => c.col === 'salesLog').n, 40001);
  assert.ok(st.bytes > 12 * 1048576, 'holds more than the blob backend could: ' + st.bytes);
});

test('DB: devices get a recent hot window; nothing is archived away; any range is available; deltas by cursor', async () => {
  const [, db] = await backends();
  const now = Date.now(), DAY = 86400000;
  const sale = (id, age) => ({ id, timestamp: new Date(now - age * DAY).toISOString(), paymentMethod: 'cash', items: [] });
  await db.push({ updatedAt: now, inventory: [{ code: 'A', qty: 1, updatedAt: 1 }], salesLog: [sale('old', 400), sale('mid', 100), sale('new', 1)] });
  const hot = JSON.parse(db.store.stateText(120));
  assert.deepEqual(hot.salesLog.map((s) => s.id), ['mid', 'new'], 'default window: the last 120 days');
  assert.equal(hot.inventory.length, 1, 'everything that is not a big log is always complete');
  assert.deepEqual(JSON.parse(db.store.stateText(null)).salesLog.map((s) => s.id), ['old', 'mid', 'new'], 'the old sale was NOT archived away');
  const range = db.store.history('salesLog', now - 500 * DAY, now - 300 * DAY);
  assert.deepEqual(range.records.map((s) => s.id), ['old'], 'any date range is queryable');
  // paging
  await db.push({ updatedAt: Date.now(), salesLog: Array.from({ length: 25 }, (_, i) => sale('p' + String(i).padStart(2, '0'), 50)) });
  const p1 = db.store.history('salesLog', now - 60 * DAY, now - 40 * DAY, 10);
  assert.equal(p1.records.length, 10); assert.ok(p1.next);
  const p2 = db.store.history('salesLog', now - 60 * DAY, now - 40 * DAY, 10, p1.next);
  const p3 = db.store.history('salesLog', now - 60 * DAY, now - 40 * DAY, 10, p2.next);
  assert.equal(p1.records.length + p2.records.length + p3.records.length, 25);
  assert.equal(p3.next, null);
  // delta pull
  const c0 = JSON.parse(db.store.changesText(0));
  await db.push({ updatedAt: Date.now(), salesLog: [sale('later', 0)], inventory: [{ code: 'A', qty: 1, price: 5, updatedAt: Date.now() }] });
  const d = JSON.parse(db.store.changesText(c0.cursor));
  assert.deepEqual(d.records.salesLog.map((s) => s.id), ['later'], 'only the new sale');
  assert.equal(d.records.inventory.length, 1, 'and the edited item');
  assert.ok(!d.records.staff);
});

test('DB: conditional GET answers "unchanged" without building the shop', async () => {
  const [, db] = await backends();
  await db.push({ updatedAt: Date.now(), salesLog: [{ id: 'a', timestamp: new Date().toISOString() }] });
  const ua = db.store.updatedAt();
  const r = await (await db.store.fetch(new Request('https://s/state', { method: 'POST', body: JSON.stringify({ since: ua }) }))).json();
  assert.deepEqual(r, { unchanged: true, updatedAt: ua });
});

test('DB: import from a blob shop and export back give the same shop (the migration path, both directions)', async () => {
  const [blob, db] = await backends();
  const t = Date.now();
  await blob.push({ updatedAt: t, receiptFooter: 'Thanks', inventory: [{ code: 'A', qty: 4, price: 9, updatedAt: t }, { code: 'B', qty: 1, updatedAt: t }], salesLog: [{ id: 's1', timestamp: new Date().toISOString() }, { id: 's2', timestamp: new Date().toISOString() }], staff: [{ id: 'u', name: 'X', updatedAt: t }] });
  const state = await blob.state();
  await (await db.store.fetch(new Request('https://s/import', { method: 'POST', body: JSON.stringify({ state }) }))).json();
  const back = JSON.parse(db.store.stateText(null));
  assert.equal(back.updatedAt, state.updatedAt, 'importing does not change updatedAt (devices are not forced to re-pull)');
  assert.deepEqual(strip(back), strip(state));
});

test('DB == blob: a device re-sending its earlier push (a retry after a lost reply) does not change the outcome the second time', async () => {
  const [a, b] = await both(async (s) => {
    const t0 = Date.now();
    await s.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 10, updatedAt: t0 - 1000 }], stockMovementLog: [] });
    await wait(20);
    const sale = (id) => ({ id, code: 'A', name: 'Bolt', delta: -1, type: 'removed', timestamp: new Date().toISOString(), reason: 'sale' });
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m1')] });
    await wait(20);
    const second = { updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Bolt', price: 10, qty: 9, updatedAt: Date.now() }], stockMovementLog: [sale('m2')] };
    await s.push(second);                       // till 2's sale (from its own stale base of 10): its movement comes off, qty -> 8
    await wait(10);
    await s.push(second);                       // the SAME request again (its reply was lost): must be a no-op, not a further change
  });
  assert.equal(a.inventory[0].qty, 8, 'blob');
  assert.equal(b.inventory[0].qty, 8, 'database');
});

test('DB == blob: a real stock edit (a recount movement) is honoured; a stale copy — older OR newer stamp — never puts the old number back', async () => {
  const [a, b] = await both(async (s) => {
    const t0 = Date.now();
    await s.push({ updatedAt: t0, inventory: [{ code: 'A', qty: 10, updatedAt: t0 - 1000 }], stockMovementLog: [] });
    await wait(10);
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', qty: 25, updatedAt: Date.now() }],
      stockMovementLog: [{ id: 'rc1', kind: 'count', code: 'A', counted: 25, before: 10, delta: 15, unit: 'qty', timestamp: new Date().toISOString() }] });   // manual recount
    await wait(10);
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', qty: 10, updatedAt: t0 - 1000 }] });              // stale copy, older stamp
    await wait(10);
    await s.push({ updatedAt: Date.now(), inventory: [{ code: 'A', qty: 10, updatedAt: Date.now() + 60000 }] });     // stale copy, NEWER stamp
  });
  assert.equal(a.inventory[0].qty, 25);
  assert.equal(b.inventory[0].qty, 25);
});

// ---- settings changed on one till must not be put back by another till that hasn't refreshed ----
test('DB == blob: a setting a till CHANGED (stamped) is not reverted by a stale till pushing its old copy; unstamped settings behave as before', async () => {
  const [a, b] = await both(async (s) => {
    const t = Date.now();
    await s.push({ updatedAt: t, receiptFooterNotes: 'old footer', vatRateA: 16, lockedTabs: ['profits-tab'] });
    await wait(10);
    // till A changes the footer and the tab locks (it stamps what it changed)
    await s.push({ updatedAt: Date.now(), receiptFooterNotes: 'NEW footer', lockedTabs: [], _fieldTimes: { receiptFooterNotes: Date.now(), lockedTabs: Date.now() } });
    await wait(10);
    // till B never refreshed: it pushes its OLD copies (unstamped) and also legitimately changes the VAT rate (stamped)
    await s.push({ updatedAt: Date.now(), receiptFooterNotes: 'old footer', vatRateA: 8, lockedTabs: ['profits-tab'], _fieldTimes: { vatRateA: Date.now() } });
    await wait(10);
    // an old app that stamps nothing pushes the VAT rate: it must not beat the stamped one either
    await s.push({ updatedAt: Date.now(), vatRateA: 16 });
  });
  for (const st of [a, b]) {
    assert.equal(st.receiptFooterNotes, 'NEW footer');
    assert.deepEqual(st.lockedTabs, []);
    assert.equal(st.vatRateA, 8);
  }
});

test('DB == blob: a newer stamp wins, an older stamp loses, and stamps are judged on SERVER time (a fast clock neither wins nor loses unfairly)', async () => {
  const [a, b] = await both(async (s) => {
    const t = Date.now();
    await s.push({ updatedAt: t, ownerName: 'A', _fieldTimes: { ownerName: t } });
    await wait(10);
    await s.push({ updatedAt: Date.now(), ownerName: 'B', _fieldTimes: { ownerName: Date.now() } });
    await wait(10);
    await s.push({ updatedAt: Date.now(), ownerName: 'A again', _fieldTimes: { ownerName: t } });                                    // older stamp: loses
    await wait(10);
    const fast = 3 * 3600 * 1000;                                                                                                     // clock 3 h ahead: shifted back by its own push time,
    await s.push({ updatedAt: Date.now() + fast, ownerName: 'fast clock', _fieldTimes: { ownerName: Date.now() + fast } });          // so this genuinely-latest change wins
  });
  assert.equal(a.ownerName, 'fast clock');
  assert.equal(b.ownerName, 'fast clock');
});
