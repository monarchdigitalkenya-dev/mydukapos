import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
import { mergeRecordsById, FINAL_TOMBSTONE_FIELDS, applyStockLedger, applyCellLedger, countTime } from '../functions/api/_merge.js';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

test('zip 185: a deleted customer / staff / offer / site / agent / patient / resource stays deleted against a stale touched copy', () => {
  for (const f of ['customers', 'staff', 'offers', 'sites', 'deliveryAgents', 'patients', 'resources']) {
    assert.ok(FINAL_TOMBSTONE_FIELDS.includes(f), f);
    const out = mergeRecordsById([{ id: 'x1', _deleted: true, updatedAt: 100 }], [{ id: 'x1', name: 'back', updatedAt: 999 }], FINAL_TOMBSTONE_FIELDS.includes(f), f);
    assert.equal(out.find((r) => r.id === 'x1')._deleted, true, f);
  }
});
test('zip 185: inventory and inventoryCategories are deliberately NOT final (codes / name-built ids are re-used)', () => {
  for (const f of ['inventory', 'products', 'inventoryCategories']) assert.ok(!FINAL_TOMBSTONE_FIELDS.includes(f), f);
  const out = mergeRecordsById([{ id: 'cat-food-drinks', _deleted: true, updatedAt: 100 }], [{ id: 'cat-food-drinks', name: 'Drinks', updatedAt: 200 }], false, 'inventoryCategories');
  assert.notEqual(out[0]._deleted, true);
});

const item = (o = {}) => ({ code: 'A', qty: 10, _sv: 1, ...o });
const run = (existing, moves, later = () => [], serverNow = 1_000_000_000_000) => applyStockLedger({ existingInv: [existing], mergedInv: [{ ...existing }], newMoves: moves, laterMoves: later, serverNow });
test('zip 185: a stock COUNT with no / invalid time is applied at receipt time and does not add all of history on top', () => {
  const stored = [{ id: 'old1', code: 'A', delta: -3, timestamp: 1000, _srv: { applied: true, before: 13, after: 10 } }];
  const later = (code, unit, T) => stored.filter((m) => m.timestamp > T);
  for (const ts of [undefined, 'garbage', 0]) {
    const r = run(item(), [{ id: 'c1', code: 'A', kind: 'count', counted: 50, timestamp: ts }], later);
    assert.equal(r.inventory[0].qty, 50, String(ts));
    assert.equal(r.notes.get('c1').applied, true);
  }
});
test('zip 185: a clock-fast till cannot date a count in the server\'s future (counts are capped at receipt time, not +60 s)', () => {
  const now = Date.now();
  assert.equal(countTime({ timestamp: now + 90000 }, now), now);
  assert.equal(countTime({ timestamp: now - 5000 }, now), now - 5000, 'a correctly-clocked count keeps its own time');
  const r = applyStockLedger({ existingInv: [item()], mergedInv: [item()], newMoves: [{ id: 'c1', code: 'A', kind: 'count', counted: 20, timestamp: now + 90000 }], laterMoves: () => [], serverNow: now });
  assert.equal(r.inventory[0]._ct.qty, now);
  // another till's real sale taken 30 s before the server received the count is still before the count - and one after it applies
  const sale = (id, t) => applyStockLedger({ existingInv: [r.inventory[0]], mergedInv: [r.inventory[0]], newMoves: [{ id, code: 'A', delta: -1, timestamp: t }], laterMoves: () => [], serverNow: now + 5 }).inventory[0].qty;
  assert.equal(sale('s1', now - 1), 20, 'a sale stamped at/before the count is already in the count (unchanged behaviour)');
  assert.equal(sale('s2', now + 1), 19, 'a sale after the count is deducted');
});
test('zip 185: Aqua cell floor records the amount it swallowed (_srv.lost); a normal movement has none', () => {
  const p = [{ id: 'p1', code: 'P', stock: { s1: 1 }, bottleStockBySite: {} }];
  const mv = (id, d) => ({ id, delta: d, cell: { c: 'products', k: 'id:p1', f: 'stock', s: 's1' }, timestamp: 1000 });
  const r = applyCellLedger({ col: 'products', existingArr: p, mergedArr: p.map((x) => ({ ...x })), newMoves: [mv('m1', -5)], serverNow: 2000 });
  assert.equal(r.arr[0].stock.s1, 0);
  assert.equal(r.notes.get('m1').lost, 4);
  const r2 = applyCellLedger({ col: 'products', existingArr: p, mergedArr: p.map((x) => ({ ...x })), newMoves: [mv('m2', -1)], serverNow: 2000 });
  assert.equal(r2.notes.get('m2').lost, undefined);
});

test('zip 185: an archived stock movement re-sent with a fresh updatedAt is dropped (never applied twice)', async () => {
  const st = await load('functions/api/_state-store.js');
  const kv = makeKV();
  const cutoff = 5000;
  const key = (id) => id;
  // build the archive index the way the store reads it
  const mod = st;
  assert.equal(typeof mod.dropArchivedIncoming, 'function');
  const env = { mydukapos_kv: kv };
  await st.addToArchiveIndex(env, 'C1', { stockMovementLog: [{ id: 'm-old' }] }, 4000);
  const body = { stockMovementLog: [{ id: 'm-old', code: 'A', delta: -1, timestamp: 1000, updatedAt: 9000 }, { id: 'm-new', code: 'A', delta: -1, timestamp: 9000 }] };
  const out = await mod.dropArchivedIncoming(env, 'C1', body, cutoff, { serverNow: 9500 });
  void key;
  const ids = (out.stockMovementLog || []).map((m) => m.id);
  assert.ok(!ids.includes('m-old'), JSON.stringify(ids));
  assert.ok(ids.includes('m-new'));
});

const opts = { skip: !hasSqlite };
test('zip 185: the shop database never moves updatedAt backwards', opts, async () => {
  const binding = await makeBinding();
  const call = async (op, b) => (await binding.get('C9').fetch('https://shop-store/' + op, { method: 'POST', body: JSON.stringify(b) })).json();
  const a = await call('push', { body: { businessName: 'X', updatedAt: 1 }, serverNow: 5_000_000 });
  const b = await call('push', { body: { businessName: 'Y', updatedAt: 2 }, serverNow: 4_000_000 });
  assert.ok(b.updatedAt > a.updatedAt, `${b.updatedAt} > ${a.updatedAt}`);
});

test('zip 185: cross-branch sale into a shop database - the stock check is atomic with the push (last unit sold once)', opts, async () => {
  const xb = await load('functions/api/cross-branch-sale.js');
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV();
  seedShop(kv, 'C1', { branchGroupId: 'G1', label: 'One' }); seedShop(kv, 'C2', { branchGroupId: 'G1', label: 'Two' });
  kv.data.set('branch-group:G1', { value: JSON.stringify(['C1', 'C2']) });
  const real = await makeBinding();
  const env = { mydukapos_kv: kv, MIGRATE_SETTLE_MS: 10, SHOP_STORE: real };
  await kv.put('pos-data:mode:C2', 'do');
  const req = (c, m, b) => new Request(`https://x.pages.dev/api/pos-sync?c=${c}`, { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  await sync.onRequestPost({ request: req('C2', 'POST', { businessName: 'B2', inventory: [{ code: 'A', name: 'Alpha', qty: 1, price: 5, updatedAt: 1 }], salesLog: [], updatedAt: Date.now() }), env, waitUntil() {} });
  // another branch takes the last unit AFTER this request planned its sale but before it pushed: intercept the DO op
  let stole = false;
  env.SHOP_STORE = { ...real, get: (id) => ({ fetch: async (url, o) => {
    if (!stole && String(url).endsWith('/xb-sell')) { stole = true; await real.get(id).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body: { stockMovementLog: [{ id: 'other-1', lg: 1, timestamp: new Date().toISOString(), code: 'A', delta: -1, type: 'removed', unit: 'qty' }] }, serverNow: Date.now() }) }); }
    return real.get(id).fetch(url, o);
  } }) };
  const res = await xb.onRequestPost({ request: new Request('https://x.pages.dev/api/cross-branch-sale?c=C1', { method: 'POST', body: JSON.stringify({ action: 'sellBatch', targetClientId: 'C2', paymentMethod: 'cash', servedBy: 'J', saleId: 'race-sale-01', items: [{ itemCode: 'A', qty: 1 }] }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  assert.equal(res.status, 409, await res.clone().text());
  const state = await (await real.get('C2').fetch('https://shop-store/state', { method: 'POST', body: '{}' })).json();
  assert.equal(state.inventory.find((p) => p.code === 'A').qty, 0, 'stock is 0, not -1');
  assert.equal((state.salesLog || []).filter((s) => s.id === 'xb-race-sale-01').length, 0, 'no sale in the shop');
});
