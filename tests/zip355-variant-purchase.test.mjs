import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

const ITEMS = [
  { code: 'V', type: 'item', name: 'Shirt', price: 100, wholesalePrice: 60, qty: 8, unit: 'pcs', vatCategory: 'A', hasVariants: true,
    variants: [{ id: 'v1', name: 'Red', code: 'V-R', qty: 5, price: 100, wholesalePrice: 60 }, { id: 'v2', name: 'Blue', code: 'V-B', qty: 3, price: 100, wholesalePrice: 60 }] },
];
const po = (w, code, name, n) => w.eval(`(function(){ const o = { id: 'po' + Math.random(), orderNo: 'P', createdAt: new Date().toISOString(), supplierName: 'S', items: [{ id: 'pl' + Math.random(), code: ${JSON.stringify(code)}, name: ${JSON.stringify(name)}, unit: 'pcs', qty: ${n}, cost: 10, receivedQty: 0 }], status: 'pending', statusHistory: [] }; purchaseOrders.push(o); poOpenArriveModal(o.id); poConfirmArrival(); return o.status; })()`);
const state = (w) => w.eval("JSON.stringify({ parent: inventory[0].qty, v: inventory[0].variants.map(v => v.code + ':' + v.qty), log: stockMovementLog.map(m => m.code + ':' + m.delta) })");

async function dev() {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('showToast = function () {}; window.confirm = () => true');
  return a;
}

test('a purchase order line naming the item (not a variant) is refused, nothing is half-received', async () => {
  const a = await dev();
  assert.equal(await po(a.w, '', 'Shirt', 6), 'pending', 'the order stays open');
  assert.equal(await state(a.w), JSON.stringify({ parent: 8, v: ['V-R:5', 'V-B:3'], log: [] }));
  assert.match(await a.w.eval("document.getElementById('po-arrive-msg').textContent"), /has variants/);
  a.close();
});

test('a purchase order line naming a variant (by code or by label) adds to that variant and the parent total', async () => {
  const a = await dev();
  assert.equal(await po(a.w, 'V-R', '', 4), 'received');
  assert.equal(await po(a.w, '', 'Shirt · Blue', 2), 'received');
  assert.equal(await state(a.w), JSON.stringify({ parent: 14, v: ['V-R:9', 'V-B:5'], log: ['V-R:4', 'V-B:2'] }));
  a.close();
});

test('a variant purchase survives the server: still there after a sync and a fresh load', async () => {
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('showToast = function () {}; window.confirm = () => true');
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  await po(a.w, 'V-R', '', 4);
  await a.w.eval('flushThenPull()'); await sleep(400);
  const srv = () => s.serverState().inventory[0].variants.map((v) => v.code + ':' + v.qty).join('|');
  assert.equal(srv(), 'V-R:9|V-B:3', 'server');
  assert.equal(await state(a.w), JSON.stringify({ parent: 12, v: ['V-R:9', 'V-B:3'], log: ['V-R:4'] }));
  const st = deviceStorage(a.w); a.close();
  a = await openDevice('index.html', s, st, 1200);
  assert.equal(await a.w.eval('inventory[0].variants[0].qty'), 9);
  a.close();
});
