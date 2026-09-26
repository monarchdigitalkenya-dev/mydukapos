import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';

// STOCK LEDGER (zip 118): the server owns stock quantities; every movement is applied exactly once; a stock-take count is
// absolute. Every scenario runs against BOTH storage backends (single-record KV and the per-shop database).
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
async function backends() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{
    name: 'kv',
    push: async (b) => (await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', updatedAt: Date.now(), _cells: 1, ...b }), env, waitUntil() {} })).json(),
    state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json(),
  }];
  if (hasSqlite) {
    const { ShopStore } = await load('wildcard-router/shop-store.js');
    const store = new ShopStore(fakeDoState(), {});
    out.push({
      name: 'db',
      push: async (b) => (await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', updatedAt: Date.now(), _cells: 1, ...b }, serverNow: Date.now() }) }))).json(),
      state: async () => JSON.parse(store.stateText(null)),
    });
  }
  return out;
}
// every scenario ends with the Phase 19 integrity check: applied movements chain, end at today's figure, none applied twice
const { ledgerIntegrity } = await load('functions/api/_merge.js');
const test = (name, fn) => baseTest(name, async () => {
  for (const b of await backends()) {
    try {
      await fn(b);
      const r = ledgerIntegrity(await b.state());
      assert.ok(r.ok, 'integrity: ' + JSON.stringify(r.problems));
    } catch (e) { e.message = `[${b.name}] ${e.message}`; throw e; }
  }
});
const tick = () => new Promise((r) => setTimeout(r, 3));
const iso = (t) => new Date(t).toISOString();
let n = 0;
const uid = (p = 'm') => `${p}${++n}-${Math.random().toString(36).slice(2, 7)}`;
const item = (qty, extra = {}) => ({ code: 'A', type: 'item', name: 'Alpha', price: 10, qty, unit: 'pcs', updatedAt: Date.now(), ...extra });
const sale = (code = 'A', delta = -1, t = Date.now()) => ({ id: uid('s'), code, name: 'Alpha', delta, reason: 'Sale', unit: 'qty', timestamp: iso(t) });
const count = (counted, before, t = Date.now(), extra = {}) => ({ id: uid('c'), kind: 'count', code: 'A', name: 'Alpha', counted, before, delta: counted - before, reason: 'Stock take', unit: 'qty', timestamp: iso(t), stocktakeId: 'st1', ...extra });
const qtyOf = async (b, code = 'A') => (await b.state()).inventory.find((i) => i.code === code).qty;
const movesOf = async (b, pred = () => true) => (await b.state()).stockMovementLog.filter(pred);
async function seed(b, qty = 100) { await b.push({ inventory: [item(qty, { updatedAt: 1 })], stockMovementLog: [] }); await tick(); }

test('TEST 1/2/9/10 — a stock take of 100 -> 120 gives 120, and re-sending everything (refresh x20, restart, re-login) keeps 120', async (b) => {
  await seed(b);
  const c = count(120, 100);
  await b.push({ inventory: [item(120)], stockMovementLog: [c] });
  assert.equal(await qtyOf(b), 120);
  for (let i = 0; i < 20; i++) { await tick(); await b.push({ inventory: [item(120 + i)], stockMovementLog: [c] }); }   // a device's first push after opening re-sends everything
  assert.equal(await qtyOf(b), 120, 'never 140 / 160 / 180');
  const logged = await movesOf(b, (m) => m.kind === 'count');
  assert.equal(logged.length, 1, 'one stock-take movement');
  assert.deepEqual([logged[0]._srv.applied, logged[0]._srv.before, logged[0]._srv.after], [true, 100, 120], 'audit: 100 -> 120, once');
});

test('TEST 3/5 — the same stock-take movement (and the same sale) sent twice or many times changes stock once', async (b) => {
  await seed(b);
  const c = count(120, 100);
  for (let i = 0; i < 5; i++) await b.push({ stockMovementLog: [c] });
  assert.equal(await qtyOf(b), 120);
  const s = sale();
  for (let i = 0; i < 5; i++) await b.push({ inventory: [item(119)], stockMovementLog: [s, c] });
  assert.equal(await qtyOf(b), 119);
  assert.equal((await movesOf(b)).length, 2);
});

test('TEST 7 — a stale device (still thinks 100) cannot overwrite the counted 120; its sale still counts', async (b) => {
  await seed(b);
  await b.push({ inventory: [item(120)], stockMovementLog: [count(120, 100)] });
  await tick();
  await b.push({ inventory: [item(99, { updatedAt: Date.now() + 5000 })], stockMovementLog: [sale()] });      // stale till: 100 - 1, newer time
  assert.equal(await qtyOf(b), 119, '120 - 1, not 99');
  await b.push({ inventory: [item(100, { price: 12, updatedAt: Date.now() + 9000 })] });                          // a price edit from a stale copy
  const st = (await b.state()).inventory[0];
  assert.equal(st.qty, 119, 'its old quantity is ignored');
  assert.equal(st.price, 12, 'its real edit (price) still goes through');
});

test('PHASE 6 — five tills selling the same item concurrently: 10 - 5 = 5, never a lost sale', async (b) => {
  await seed(b, 10);
  for (let i = 0; i < 5; i++) await b.push({ inventory: [item(9)], stockMovementLog: [sale()] });                   // each till started from 10
  assert.equal(await qtyOf(b), 5);
});

test('TEST 4 / 11 — an offline till\'s sale made BEFORE the count syncs late: the count already includes it (no double deduction)', async (b) => {
  await seed(b);
  const t0 = Date.now();
  await tick();
  const early = sale('A', -1, t0);                                  // sold at t0 while offline
  await b.push({ stockMovementLog: [count(120, 100, t0 + 2)] });  // counted after that sale
  await b.push({ stockMovementLog: [sale('A', -2, t0 + 5)] });     // a sale after the count
  await b.push({ inventory: [item(99)], stockMovementLog: [early] });
  assert.equal(await qtyOf(b), 118, '120 counted, -2 afterwards; the earlier sale is already in the count');
  const e = (await movesOf(b, (m) => m.id === early.id))[0];
  assert.equal(e._srv.applied, false); assert.equal(e._srv.reason, 'before-count');
});

test('TEST 8 — two devices counting the same item: the LATER count wins whatever order they arrive in, nothing stacks', async (b) => {
  await seed(b);
  const t = Date.now();
  const late = count(118, 100, t + 10), early = count(121, 100, t);
  await b.push({ stockMovementLog: [late] });
  await b.push({ stockMovementLog: [early] });
  assert.equal(await qtyOf(b), 118);
  const logs = await movesOf(b, (m) => m.kind === 'count');
  assert.equal(logs.find((m) => m.id === early.id)._srv.reason, 'older-count');
});

test('a count made from an out-of-date figure (stale device) is flagged, still sets the physical count', async (b) => {
  await seed(b);
  await b.push({ stockMovementLog: [sale()] });                       // server now 99, version 1
  const c = count(120, 100, Date.now(), { baseSv: 0 });              // device saw version 0 / 100
  await b.push({ stockMovementLog: [c] });
  assert.equal(await qtyOf(b), 120);
  const m = (await movesOf(b, (x) => x.id === c.id))[0];
  assert.equal(m._srv.stale, true); assert.equal(m._srv.before, 99);
});

test('new items are taken as sent (their movements are already in the number); variants and loose pieces are ledgered', async (b) => {
  await seed(b);
  const newItem = { code: 'N', type: 'item', name: 'New', qty: 7, pieceQty: 4, dualUnit: true, updatedAt: Date.now() };
  await b.push({ inventory: [newItem], stockMovementLog: [{ id: uid(), code: 'N', delta: 8, timestamp: iso(Date.now()), reason: 'Restock' }, sale('N', -1)] });
  assert.equal(await qtyOf(b, 'N'), 7);
  await b.push({ stockMovementLog: [{ id: uid(), code: 'N', delta: -2, unit: 'pieceQty', timestamp: iso(Date.now() + 1) }] });
  assert.equal((await b.state()).inventory.find((i) => i.code === 'N').pieceQty, 2);
  const shoe = { code: 'P', name: 'Shoe', hasVariants: true, qty: 5, updatedAt: Date.now(), variants: [{ code: 'P-1', name: '40', qty: 2, price: 5 }, { code: 'P-2', name: '41', qty: 3, price: 5 }] };
  await b.push({ inventory: [shoe] });
  const c = { ...count(9, 2), code: 'P-1' };
  await b.push({ stockMovementLog: [c] }); await b.push({ stockMovementLog: [c] });
  const p = (await b.state()).inventory.find((i) => i.code === 'P');
  assert.equal(p.variants[0].qty, 9); assert.equal(p.qty, 12, 'parent = sum of variants');
});

test('batch-tracked items keep their batches in line with the authoritative quantity', async (b) => {
  await b.push({ inventory: [{ code: 'D', name: 'Drug', qty: 10, updatedAt: 1, batches: [{ id: 'b1', expiryDate: '2027-01-01', qty: 4 }, { id: 'b2', expiryDate: '2028-01-01', qty: 6 }] }] });
  await b.push({ stockMovementLog: [{ ...count(15, 10), code: 'D' }] });
  let d = (await b.state()).inventory.find((i) => i.code === 'D');
  assert.equal(d.qty, 15); assert.equal(d.batches.reduce((s, x) => s + x.qty, 0), 15);
  await b.push({ stockMovementLog: [sale('D', -6, Date.now() + 50)] });
  d = (await b.state()).inventory.find((i) => i.code === 'D');
  assert.equal(d.qty, 9); assert.equal(d.batches.reduce((s, x) => s + x.qty, 0), 9);
  assert.equal(d.batches.find((x) => x.id === 'b1'), undefined, 'the soonest-expiring batch went first');
});

test('a stored movement is immutable: a device re-sending it without the server stamp does not erase the audit', async (b) => {
  await seed(b);
  const c = count(120, 100);
  await b.push({ stockMovementLog: [c] });
  await b.push({ stockMovementLog: [{ ...c, counted: 500, delta: 400 }] });     // tampered / re-sent copy of the same id
  assert.equal(await qtyOf(b), 120);
  const m = (await movesOf(b, (x) => x.id === c.id))[0];
  assert.equal(m.counted, 120); assert.equal(m._srv.after, 120);
});

// ---- Aqua POS stock cells: products per site (+ bottle counts), tanks, raw materials ----
const prod = (stock, extra = {}) => ({ code: 'W20', name: '20L Bottle', price: 50, stock, updatedAt: Date.now(), ...extra });
const cellMove = (cell, delta, t = Date.now(), extra = {}) => ({ id: uid('x'), cell, delta, reason: 'Stock change', timestamp: iso(t), ...extra });
const cellCount = (cell, counted, t = Date.now(), extra = {}) => ({ id: uid('k'), cell, kind: 'count', counted, reason: 'Stock take', timestamp: iso(t), ...extra });
const PROD = (s) => ({ c: 'products', k: 'code:W20', f: 'stock', s });
const prodOf = async (b) => (await b.state()).products.find((p) => p.code === 'W20');

test('Aqua: per-site stock is ledgered — a stale Shop till cannot overwrite what Production made; retries apply once', async (b) => {
  await b.push({ products: [prod({ prod: 100, shop: 10 }, { updatedAt: 1 })], stockMovementLog: [] });
  const made = cellMove(PROD('prod'), 50);                             // Production makes 50
  await b.push({ products: [prod({ prod: 150, shop: 10 })], stockMovementLog: [made] });
  await b.push({ products: [prod({ prod: 150, shop: 10 })], stockMovementLog: [made] });   // retry
  const sold = cellMove(PROD('shop'), -1);                             // the Shop till still thinks Production has 100
  await b.push({ products: [prod({ prod: 100, shop: 9 }, { updatedAt: Date.now() + 9000, siteTimes: { prod: Date.now() + 9000, shop: Date.now() + 9000 } })], stockMovementLog: [sold] });
  const p = await prodOf(b);
  assert.deepEqual([p.stock.prod, p.stock.shop], [150, 9]);
  assert.deepEqual(p._ss.stock, { prod: 150, shop: 9 }, 'the server echoes its own figures');
  const m = (await movesOf(b, (x) => x.id === made.id))[0];
  assert.deepEqual([m._srv.before, m._srv.after], [100, 150]);
});

test('Aqua: bottle counts, a stock-take count per site, a new site, tanks and raw materials', async (b) => {
  await b.push({
    products: [prod({ shop: 2 }, { updatedAt: 1, trackBottles: true, bottleStockBySite: { shop: 30 } })],
    tanks: [{ id: 'tank-shop', siteId: 'shop', name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 1000, updatedAt: 1 }],
    rawMaterials: [{ id: 'mat-1', siteId: 'shop', name: 'Caps', stockQty: 500, updatedAt: 1 }],
    stockMovementLog: [],
  });
  await b.push({ stockMovementLog: [cellMove({ c: 'products', k: 'code:W20', f: 'bottleStockBySite', s: 'shop' }, -3)] });
  const c = cellCount(PROD('shop'), 5);
  await b.push({ stockMovementLog: [c] }); await b.push({ stockMovementLog: [c] });
  await b.push({ products: [prod({ shop: 5, branch2: 7 }, { trackBottles: true, bottleStockBySite: { shop: 27 } })] });   // a site that is new on the server
  await b.push({ stockMovementLog: [cellMove({ c: 'tanks', k: 'id:tank-shop', f: 'currentVolumeLiters' }, -20)] });
  await b.push({ tanks: [{ id: 'tank-shop', siteId: 'shop', name: 'Main tank', capacityLiters: 5000, currentVolumeLiters: 1000, updatedAt: Date.now() + 5000 }] });   // renamed on a stale device
  await b.push({ stockMovementLog: [cellMove({ c: 'rawMaterials', k: 'id:mat-1', f: 'stockQty' }, -24), cellMove({ c: 'rawMaterials', k: 'id:mat-1', f: 'stockQty' }, -9999)] });
  const st = await b.state();
  const p = st.products[0];
  assert.deepEqual([p.bottleStockBySite.shop, p.stock.shop, p.stock.branch2], [27, 5, 7]);
  assert.deepEqual([st.tanks[0].currentVolumeLiters, st.tanks[0].name], [980, 'Main tank'], 'the stale level is ignored, the rename is kept');
  assert.equal(st.rawMaterials[0].stockQty, 0, 'never below zero');
  assert.equal(st.stockMovementLog.filter((m) => m.kind === 'count').length, 1);
});

test('Aqua: raw materials are merged per record now (not the whole list from the last device)', async (b) => {
  await b.push({ rawMaterials: [{ id: 'mat-1', name: 'Caps', stockQty: 5, updatedAt: 1 }, { id: 'mat-2', name: 'Labels', stockQty: 9, updatedAt: 1 }] });
  await b.push({ rawMaterials: [{ id: 'mat-1', name: 'Caps (blue)', stockQty: 5, updatedAt: Date.now() }] });      // a device that only knows mat-1
  const st = await b.state();
  assert.equal(st.rawMaterials.length, 2);
  assert.equal(st.rawMaterials.find((m) => m.id === 'mat-1').name, 'Caps (blue)');
});

test('an Aqua movement log is never touched by the shop-inventory ledger (no "item not found" stamps)', async (b) => {
  await b.push({ products: [prod({ shop: 3 }, { updatedAt: 1 })], stockMovementLog: [{ id: uid(), code: 'W20', delta: -1, reason: 'Sale', timestamp: iso(Date.now()) }] });
  const m = (await b.state()).stockMovementLog[0];
  assert.equal(m._srv, undefined);
});

baseTest('the integrity check really catches the corruption this bug caused', () => {
  const mv = (id, sv, before, after) => ({ id, code: 'A', delta: after - before, unit: 'qty', _srv: { applied: true, before, after, sv } });
  const good = { inventory: [{ code: 'A', qty: 119 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m2', 2, 120, 119)] };
  assert.equal(ledgerIntegrity(good).ok, true);
  const replayed = { inventory: [{ code: 'A', qty: 140 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m1', 2, 120, 140)] };
  assert.match(JSON.stringify(ledgerIntegrity(replayed).problems), /duplicate movement/, 'a movement applied twice (120 -> 140)');
  const reverted = { inventory: [{ code: 'A', qty: 99 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m2', 2, 120, 119)] };
  assert.match(JSON.stringify(ledgerIntegrity(reverted).problems), /figure differs from its history/, 'a figure overwritten by a stale device (119 -> 99)');
  const broken = { inventory: [{ code: 'A', qty: 110 }], stockMovementLog: [mv('m1', 1, 100, 120), mv('m2', 2, 100, 110)] };
  assert.match(JSON.stringify(ledgerIntegrity(broken).problems), /does not chain/);
});

baseTest('/api/stock-integrity answers for the linked shop only, from the stored data', async () => {
  const sync = await load('functions/api/pos-sync.js');
  const integ = await load('functions/api/stock-integrity.js');
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const env = { mydukapos_kv: kv };
  const post = (c, b) => sync.onRequestPost({ request: new Request(`https://x.pages.dev/api/pos-sync?c=${c}`, { method: 'POST', body: JSON.stringify({ businessName: 'B', updatedAt: Date.now(), ...b }) }), env, waitUntil() {} });
  await post('C1', { inventory: [item(100, { updatedAt: 1 })] });
  await post('C1', { stockMovementLog: [count(120, 100)] });
  await post('C2', { inventory: [{ ...item(5, { updatedAt: 1 }), code: 'Z' }] });
  const res = await integ.onRequestGet({ request: new Request('https://x.pages.dev/api/stock-integrity?c=C1&clientId=C2'), env });
  const out = await res.json();
  assert.equal(out.ok, true); assert.equal(out.checked, 1);
  assert.equal(out.figures.A, 120);
  assert.equal(out.figures.Z, undefined, 'nothing from the other shop, whatever the request adds');
});

test('rollout: an Aqua till still on the OLD app (plain numbers, no movements) keeps the previous merge rules until it updates', async (b) => {
  await b.push({ _cells: undefined, tanks: [{ id: 'tk', siteId: 's', currentVolumeLiters: 1000, updatedAt: 1 }] });
  await b.push({ _cells: undefined, tanks: [{ id: 'tk', siteId: 's', currentVolumeLiters: 990, updatedAt: Date.now() }] });   // old app sold 10 L
  const st = await b.state();
  assert.equal(st.tanks[0].currentVolumeLiters, 990, 'its sale is not lost while it waits for the update');
  assert.equal(st._cells, undefined, 'the flag is never stored');
});

test('till numbers: each device gets one, once, from the server; a device cannot overwrite the map', async (b) => {
  const r1 = await b.push({ _till: 'dev_a' });
  const r2 = await b.push({ _till: 'dev_b' });
  const r3 = await b.push({ _till: 'dev_a', tillNumbers: { dev_a: 7, dev_x: 1 } });
  assert.deepEqual([r1.till, r2.till, r3.till], [1, 2, 1]);
  const st = await b.state();
  assert.deepEqual(st.tillNumbers, { dev_a: 1, dev_b: 2 });
  assert.equal(st._till, undefined);
});

test('hotel tabs: two tills adding orders to the same open tab both keep theirs; a stale copy cannot re-open a closed tab', async (b) => {
  const t = Date.now();
  await b.push({ tabs: [{ id: 'tab1', label: 'Room 1', status: 'OPEN', orders: [], updatedAt: t }] });
  await b.push({ tabs: [{ id: 'tab1', label: 'Room 1', status: 'OPEN', orders: [{ id: 'o1', entries: [] }], updatedAt: t + 10 }] });   // till A
  await b.push({ tabs: [{ id: 'tab1', label: 'Room 1', status: 'OPEN', orders: [{ id: 'o2', entries: [] }], updatedAt: t + 20 }] });   // till B (never saw o1)
  let tab = (await b.state()).tabs[0];
  assert.deepEqual(tab.orders.map((o) => o.id).sort(), ['o1', 'o2']);
  await b.push({ tabs: [{ ...tab, status: 'CLOSED', updatedAt: t + 30 }] });
  await b.push({ tabs: [{ id: 'tab1', label: 'Room 1', status: 'OPEN', orders: [{ id: 'o1', entries: [] }], updatedAt: t + 40 }] });   // stale, newer stamp
  tab = (await b.state()).tabs[0];
  assert.equal(tab.status, 'CLOSED'); assert.equal(tab.orders.length, 2);
});

test('cash shifts: two managers\' adjustments both kept; a stale "pending" never undoes an approval; closed stays closed', async (b) => {
  const t = Date.now();
  const sh = { id: 'sh1', cashier: 'Ann', status: 'closed', openingFloat: 1000, approval: { status: 'pending' }, adjustments: [], updatedAt: t };
  await b.push({ cashShifts: [sh] });
  await b.push({ cashShifts: [{ ...sh, adjustments: [{ id: 'a1', amount: 50 }], updatedAt: t + 10 }] });
  await b.push({ cashShifts: [{ ...sh, adjustments: [{ id: 'a2', amount: -20 }], updatedAt: t + 20 }] });
  await b.push({ cashShifts: [{ ...sh, approval: { status: 'approved', by: 'Boss' }, updatedAt: t + 30 }] });
  await b.push({ cashShifts: [{ ...sh, status: 'open', approval: { status: 'pending' }, updatedAt: t + 40 }] });   // stale device
  const s = (await b.state()).cashShifts[0];
  assert.deepEqual(s.adjustments.map((a) => a.id).sort(), ['a1', 'a2']);
  assert.equal(s.approval.status, 'approved'); assert.equal(s.status, 'closed');
});

test('ZIP 121 — a till whose clock runs a day fast cannot date a stock count into the future and block every later sale', async (b) => {
  await seed(b);
  await b.push({ inventory: [item(120)], stockMovementLog: [count(120, 100, Date.now() + 86400000)] });   // the fast clock
  assert.equal(await qtyOf(b), 120);
  await new Promise((r) => setTimeout(r, 5));
  const later = Date.now() + 61000;                                                                        // a normal till, a minute later
  await b.push({ stockMovementLog: [sale('A', -1, later)] });
  assert.equal(await qtyOf(b), 119, 'the real sale after the count is applied, not refused as "before the count"');
});
