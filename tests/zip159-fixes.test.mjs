import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// Zip 159 fixes: (1) Aqua tank refillLog is unioned by entry id (client pull + server merge); (2) returning a PRODUCED item puts its materials back
// (like a void) instead of raising the finished item's own qty.
const M = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const tank = (log, extra = {}) => ({ id: 'tank-1', name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 1000, lowStockThresholdLiters: 500, siteId: 'site-shop-1', refillLog: log, updatedAt: 1000, ...extra });
const e = (id, t, l) => ({ id, timestamp: t, litersAdded: l, cost: 0, supplier: 'S', servedBy: 'x' });

test('T1 server: two tills append a refill to the same tank, both entries survive, in both push orders', () => {
  const base = [e('r0', '2026-01-01T00:00:00Z', 100)];
  const a = tank([...base, e('rf-a', '2026-01-02T00:00:00Z', 50)], { updatedAt: 2000 });
  const b = tank([...base, e('rf-b', '2026-01-02T00:00:01Z', 70)], { updatedAt: 3000 });
  const ab = M.mergeRecordsById([a], [b], false, 'tanks')[0].refillLog.map((x) => x.id);
  const ba = M.mergeRecordsById([b], [a], false, 'tanks')[0].refillLog.map((x) => x.id);
  assert.deepEqual(ab, ['r0', 'rf-a', 'rf-b']);
  assert.deepEqual(ba, ab, 'order independent');
  const st = M.mergeIncomingState({ tanks: [a] }, { tanks: [b] });
  assert.equal((st.state || st).tanks[0].refillLog.length, 3, 'through mergeIncomingState too');
});

test('T2 server: legacy entries without ids do not duplicate and get a stable id; re-merging is a no-op', () => {
  const legacy = { timestamp: '2026-01-01T00:00:00Z', litersAdded: 300, cost: 10, supplier: 'Borehole', servedBy: 'Ann' };
  const a = tank([{ ...legacy }]), b = tank([{ ...legacy }, e('rf-b', '2026-01-03T00:00:00Z', 5)]);
  const m1 = M.mergeRecordsById([a], [b], false, 'tanks')[0];
  assert.equal(m1.refillLog.length, 2);
  assert.ok(m1.refillLog.every((x) => x.id), 'every entry has an id now');
  const m2 = M.mergeRecordsById([m1], [b], false, 'tanks')[0];
  const m3 = M.mergeRecordsById([m2], [m2], false, 'tanks')[0];
  assert.deepEqual(m3.refillLog, m1.refillLog);
  assert.equal(M.refillEntryId(legacy), M.refillEntryId({ ...legacy }));
  assert.notEqual(M.refillEntryId(legacy), M.refillEntryId({ ...legacy, litersAdded: 301 }));
});

test('T3 server: the log is capped at the newest 500; tombstoned or log-less tanks behave as before', () => {
  const many = Array.from({ length: 520 }, (_, i) => e('r' + i, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), 1));
  const m = M.mergeRecordsById([tank(many.slice(0, 300))], [tank(many.slice(200))], false, 'tanks')[0];
  assert.equal(m.refillLog.length, 500);
  assert.equal(m.refillLog[499].id, 'r519');
  assert.equal(m.refillLog[0].id, 'r20');
  const nolog = M.mergeRecordsById([{ id: 't', updatedAt: 1, name: 'A' }], [{ id: 't', updatedAt: 2, name: 'B' }], false, 'tanks')[0];
  assert.equal(nolog.name, 'B'); assert.ok(!('refillLog' in nolog));
  const dead = M.mergeRecordsById([tank([e('x', '2026-01-01T00:00:00Z', 1)], { _deleted: true })], [tank([e('y', '2026-01-01T00:00:00Z', 1)], { updatedAt: 5 })], false, 'tanks')[0];
  assert.equal(dead._deleted, true, 'a deleted tank stays deleted');
});

test('T4 client: a pull keeps the refill logged offline on this device and adds the other till\'s', async () => {
  const mine = tank([e('r0', '2026-01-01T00:00:00Z', 100), e('rf-a', '2026-01-02T00:00:00Z', 50)]);
  const { w, close } = await boot('water/index.html', { storage: { aqua_tanks: JSON.stringify([mine]), aqua_biz_name: 'Aqua Test' } });
  const theirs = tank([e('r0', '2026-01-01T00:00:00Z', 100), e('rf-b', '2026-01-02T00:00:01Z', 70), { timestamp: '2026-01-01T00:00:00Z', litersAdded: 9, cost: 0, supplier: 'Old', servedBy: 'z' }]);
  w.eval(`window.__out = preparePulledPayload({ tanks: [${JSON.stringify(theirs)}] })`);
  const out = J(w, 'window.__out.tanks').find((t) => t.id === 'tank-1');
  assert.deepEqual(out.refillLog.map((x) => x.id).filter((i) => !/^rf-legacy/.test(i)), ['r0', 'rf-a', 'rf-b']);
  assert.equal(out.refillLog.length, 4);
  const again = J(w, `preparePulledPayload({ tanks: [${JSON.stringify(out)}] }).tanks[0].refillLog.length`);
  assert.equal(again, 4, 'a second pull adds nothing');
  close();
});

test('T5 client and server agree on the legacy id', async () => {
  const { w, close } = await boot('water/index.html', { storage: { aqua_biz_name: 'Aqua Test' } });
  const legacy = { timestamp: '2026-01-01T00:00:00Z', litersAdded: 300, cost: 10, supplier: 'Borehole', servedBy: 'Ann' };
  assert.equal(w.eval(`refillEntryId(${JSON.stringify(legacy)})`), M.refillEntryId(legacy));
  close();
});

// ---------- production return ----------
const INV = () => [
  { code: 'FLR', type: 'item', name: 'Flour', category: 'Raw', price: 0, wholesalePrice: 100, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'SGR', type: 'item', name: 'Sugar', category: 'Raw', price: 0, wholesalePrice: 150, qty: 5, unit: 'kg', vatCategory: 'A' },
  { code: 'CAKE', type: 'item', name: 'Cake', category: 'Baked', price: 900, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'FLR', qty: 2 }, { code: 'SGR', qty: 1 }] },
  { code: 'TEA', type: 'item', name: 'Tea', category: 'Raw', price: 20, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A' },
];
async function prod() {
  const b = await boot('production/index.html', { storage: { pos_inventory: JSON.stringify(INV()) }, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {};");
  return b;
}
const sell = async (w, codes) => {
  w.eval(`currentCart = {}; currentPaymentMethod = 'cash'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; document.getElementById('cash-tendered-input').value = '100000'`);
  await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
};
const qty = (w, c) => J(w, `inventory.find(i => i.code === '${c}').qty`);

test('P1 returning a produced item gives its materials back (scaled by qty), not a finished unit', async () => {
  const b = await prod(); const { w } = b;
  await sell(w, ['CAKE', 'CAKE', 'CAKE']);
  assert.equal(qty(w, 'FLR'), 4); assert.equal(qty(w, 'SGR'), 2);
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  const sel = J(w, `returnSelectionFromSaleItem(${JSON.stringify(sale.items[0])}, ${JSON.stringify(sale)})`);
  assert.equal(w.eval(`restockReturnedItem(inventory.find(i => i.code === 'CAKE'), 1, ${JSON.stringify(sel)}, 'Returned Goods (restock)')`), true);
  assert.equal(qty(w, 'FLR'), 6); assert.equal(qty(w, 'SGR'), 3);
  assert.equal(qty(w, 'CAKE'), 0, 'no finished unit invented');
  // a later void gives back only the un-returned share, so nothing is restored twice
  w.eval(`returns.push({ id: 'r1', refNumber: '${sale.refNumber}', itemCode: 'CAKE', qty: 1 })`);
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'x'; performVoidSale('${sale.id}')`);
  assert.equal(qty(w, 'FLR'), 10); assert.equal(qty(w, 'SGR'), 5);
  assert.ok(J(w, "stockMovementLog.some(m => m.code === 'FLR' && /materials restored/.test(m.reason || ''))"));
  b.close();
});

test('P2 the Returns screen path (saveSimpleReturn) restores materials for Good, nothing for Damaged; ordinary items unchanged', async () => {
  const b = await prod(); const { w, d } = b;
  await sell(w, ['CAKE', 'CAKE', 'TEA']);
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  const run = (code, cond) => {
    const it = sale.items.find((l) => l.code === code);
    w.eval(`selectedReturnItem = returnSelectionFromSaleItem(${JSON.stringify(it)}, ${JSON.stringify(sale)}); returnMode = 'return'`);
    d.getElementById('return-qty-input').value = '1';
    d.getElementById('return-condition-select').value = cond;
    w.eval('saveSimpleReturn()');
  };
  run('CAKE', 'damaged'); assert.equal(qty(w, 'FLR'), 6, 'damaged: nothing goes back');
  run('CAKE', 'good'); assert.equal(qty(w, 'FLR'), 8); assert.equal(qty(w, 'SGR'), 4);
  assert.equal(qty(w, 'CAKE'), 0);
  run('TEA', 'good'); assert.equal(qty(w, 'TEA'), 10, 'a plain item is restocked exactly as before');
  b.close();
});

test('P3 reusableFinished keeps the old behaviour; a legacy sale with no recorded materials falls back to the recipe', async () => {
  const b = await prod(); const { w } = b;
  w.eval("restockReturnedItem(inventory.find(i => i.code === 'CAKE'), 2, { reusableFinished: true }, 'x')");
  assert.equal(qty(w, 'CAKE'), 2); assert.equal(qty(w, 'FLR'), 10);
  w.eval("restockReturnedItem(inventory.find(i => i.code === 'CAKE'), 2, {}, 'x')");
  assert.equal(qty(w, 'FLR'), 14); assert.equal(qty(w, 'SGR'), 7); assert.equal(qty(w, 'CAKE'), 2);
  b.close();
});
