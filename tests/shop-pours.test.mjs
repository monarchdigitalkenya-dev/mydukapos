import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 153 — General Shop: a bottle sold by the shot / tot on the shop's box-and-piece stock, and stock shown on the sales counter.
const INV = [
  { code: 'GIN', type: 'item', name: 'Gin 750ml', price: 3000, wholesalePrice: 1500, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 7, unit: 'pcs', vatCategory: 'A' },
];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); };");
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const setup = async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(INV) }, wait: 900 });
  quiet(b.w);
  b.w.eval("inventoryEditModalCode = 'GIN'");
  const set = (id, v) => { const el = b.w.document.getElementById(id); el.value = v; };
  set('inv-bottle-ml', '750'); set('inv-shot-ml', '25'); set('inv-shot-price', '150'); set('inv-tot-ml', '50'); set('inv-tot-price', '280');
  b.w.eval('shopSaveBottle()');
  return b;
};

test('a bottle can be set up for shot and tot; a bad set-up is refused', async () => {
  const b = await setup(); const { w } = b;
  const p = J(w, "inventory.find(i => i.code === 'GIN')");
  assert.deepEqual([p.bottleMl, p.dualUnit, p.unitsPerBox, p.looseUnit, p.shotMl, p.totMl], [750, true, 750, 'ml', 25, 50]);
  assert.equal(p.piecePrice, 6, '150 / 25 ml');
  w.document.getElementById('inv-shot-price').value = '0'; w.eval('shopSaveBottle()');
  assert.match(w.document.getElementById('inv-bottle-msg').textContent, /needs both/);
  b.close();
});

test('shots and tots come out of the bottle in ml at their own price; a new bottle opens itself; never more than is there', async () => {
  const b = await setup(); const { w } = b;
  w.eval("shopAddPour('GIN','shot'); shopAddPour('GIN','shot'); shopAddPour('GIN','tot')");
  const cart = J(w, 'Object.values(currentCart).map(l => [l.cartKey, l.qty, l.price * l.qty])');
  assert.deepEqual(cart, [['GIN::piece::shot', 50, 300], ['GIN::piece::tot', 50, 280]]);
  w.eval("currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '5000'");
  await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
  const p = J(w, "(function (p) { return { qty: p.qty, ml: p.pieceQty }; })(inventory.find(i => i.code === 'GIN'))");
  assert.deepEqual(p, { qty: 1, ml: 650 }, 'a bottle opened and 100 ml poured');
  const sale = J(w, 'salesLog[salesLog.length - 1]');
  assert.equal(sale.cashAmount, 580, 'the till took the shot + shot + tot prices');
  // 1400 ml left in all; a tot fits, but not after everything is in the cart
  w.eval("currentCart = {}; for (let i = 0; i < 40; i++) shopAddPour('GIN','tot')");
  assert.equal(J(w, "currentCart['GIN::piece::tot'].qty"), 1400, 'stops at the ml that exist');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Only 0 ml left/.test(t)));
  b.close();
});

test('the sales counter shows how much is in stock for each result', async () => {
  const b = await setup(); const { w } = b;
  w.document.getElementById('sales-search').value = 'alpha';
  w.eval("liveSearch('alpha')");
  const html = w.document.getElementById('search-results').innerHTML;
  assert.match(html, /7 pcs in stock|7 in stock/);
  w.document.getElementById('sales-search').value = 'gin';
  w.eval("liveSearch('gin')");
  const g = w.document.getElementById('search-results').innerHTML;
  assert.match(g, /2 sealed/); assert.match(g, /Shot 25ml/); assert.match(g, /Tot 50ml/);
  b.close();
});
