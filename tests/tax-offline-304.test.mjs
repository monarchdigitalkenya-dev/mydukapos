import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, closeWhenIdle } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 304: the Tax & Returns figures with the network really cut (the sync server refuses every request): a sale made offline is in the report once,
// marked "not yet synced"; it survives closing and reopening the app offline; when the internet is back it reaches the server and is STILL counted once.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 116, wholesalePrice: 50, qty: 500, unit: 'pcs', vatCategory: 'A' }, { code: 'Z', type: 'item', name: 'Milk', price: 60, wholesalePrice: 40, qty: 500, unit: 'pcs', vatCategory: 'Z' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; autoPrintEnabled = false");
const sell = async (dev, codes) => {
  for (const c of codes) dev.w.eval(`addToCart('${c}')`);
  dev.w.eval("currentPaymentMethod = 'cash'");
  dev.w.document.getElementById('cash-tendered-input').value = '1000';
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].id');
};
const tax = (dev) => JSON.parse(dev.w.eval("(function(){ var t = Date.now(); var x = taxReturns.compile(t - 86400000, t + 60000); return JSON.stringify({ gross: x.gross, vat: x.vat, sales: x.sales, unsynced: x.unsynced, z: x.byCat.Z.gross }); })()"));

test('index.html: Tax & Returns offline - counted once, marked unsynced, survives a reopen, still once after it syncs', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  s.state.down = true;                                                                     // the internet goes
  const id = await sell(a, ['A', 'Z']);
  let t = tax(a);
  assert.equal(t.sales, 1); assert.equal(t.gross, 11600 + 6000); assert.equal(t.vat, 1600); assert.equal(t.z, 6000);
  assert.equal(t.unsynced, 1, 'marked: saved on this device, not yet on the server');
  // reopened with no internet: the device's own storage only
  const store = deviceStorage(a.w); await closeWhenIdle(a);
  const a2 = await openDevice('index.html', s, store, 1500); quiet(a2.w);
  await until(() => a2.w.eval("typeof taxReturns !== 'undefined'"), 5000);
  t = tax(a2);
  assert.equal(t.sales, 1, 'still there, once'); assert.equal(t.gross, 17600);
  assert.ok(a2.w.eval(`salesLog.some(x => x.id === ${JSON.stringify(id)})`));
  // back online: it reaches the server by itself; the report still counts it once, and no longer as unsynced
  s.state.down = false; a2.w.dispatchEvent(new a2.w.Event('online'));
  await until(() => (s.serverState().salesLog || []).some((x) => x.id === id), 20000);
  await a2.w.eval('pullState()');
  t = tax(a2);
  assert.equal(t.sales, 1, 'once after syncing (one id, one sale)'); assert.equal(t.gross, 17600);
  assert.equal(t.unsynced, 0, 'no longer marked once the server has it');
  assert.equal(new Set((s.serverState().salesLog || []).map((x) => x.id)).size, (s.serverState().salesLog || []).length, 'no sale stored twice on the server');
  await closeWhenIdle(a2);
});
