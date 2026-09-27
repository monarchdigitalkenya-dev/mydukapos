import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 141 → 142 — a bottle sold by the shot / double / glass and by the bottle. The bottle stays in bottles; the open bottle is counted
// in whole millilitres (exact, no rounding drift), a new bottle opens by itself, and every change is a stock movement the server applies.
const INV = [
  { code: 'JWB', type: 'item', name: 'JW Black 750ml', category: 'Whisky', price: 7000, wholesalePrice: 3000, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'BEEF', type: 'item', name: 'Beef', category: 'Raw', price: 0, wholesalePrice: 500, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'BRG', type: 'service', name: 'Burger', category: 'Mains', price: 650, recipe: [{ code: 'BEEF', qtyPerUnit: 0.2 }], vatCategory: 'A' },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']) }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}");
  return b;
}
const jwb = (w) => J(w, "(function (p) { return { qty: p.qty, ml: p.pieceQty || 0 }; })(inventory.find(i => i.code === 'JWB'))");
const moves = (w, code) => J(w, `stockMovementLog.filter(m => m.code === '${code}' && m.delta).map(m => [m.delta, m.unit, m.reason])`);
const sell = (w, codes, cash = 50000) => w.eval(`currentPaymentMethod = 'cash'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; document.getElementById('cash-tendered-input').value = '${cash}'; checkoutCart()`);

test('pours: shot / double from a 750 ml bottle; a shot opens a bottle; pours come off in whole ml; a new bottle opens by itself; never more than is there', async () => {
  const b = await app(); const { w } = b;
  const codes = J(w, "hospMakePours('JWB', 750, { shot: 350, double: 650 })");
  assert.deepEqual(codes, ['JWB-shot', 'JWB-double']);
  const shot = J(w, "inventory.find(i => i.code === 'JWB-shot')");
  assert.equal(shot.name, 'JW Black 750ml — Shot 30ml'); assert.equal(shot.type, 'service'); assert.equal(shot.price, 350);
  assert.equal(shot.wholesalePrice, 120, 'cost: 30/750 of the bottle');
  assert.equal(J(w, "hospStationFor('JWB-shot', '')"), 'bar');
  await sell(w, ['JWB-shot', 'JWB-double']);
  assert.deepEqual(jwb(w), { qty: 1, ml: 660 }, 'a bottle opened; 90 ml poured');
  // 23 doubles = 1380 ml: the open bottle (660) and the next one (750) → 30 ml left, no sealed bottles
  await sell(w, Array(23).fill('JWB-double'));
  assert.deepEqual(jwb(w), { qty: 0, ml: 30 });
  assert.ok(moves(w, 'JWB').every(([d]) => Number.isInteger(d)), 'no fractions of a bottle');
  // 30 ml left: one more shot yes; a double no (never more than is there)
  w.eval("addToCart('JWB-double')");
  assert.equal(J(w, 'Object.keys(currentCart).length'), 0);
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Only 30 ml of JW Black 750ml left/.test(t)));
  await sell(w, ['JWB-shot']);
  assert.deepEqual(jwb(w), { qty: 0, ml: 0 });
  w.eval("addToCart('JWB-shot')");
  assert.ok((w.eval('window.__toasts') || []).some((t) => /JW Black 750ml is OUT OF STOCK/.test(t)));
  // void the last sale: its 30 ml go back
  const last = J(w, 'salesLog[salesLog.length - 1].id');
  w.eval(`restoreEntriesForVoid(salesLog.find(s => s.id === '${last}').items)`);
  assert.deepEqual(jwb(w), { qty: 0, ml: 30 });
  b.close();
});

test('pours on a table order and removal; recipe ingredients are itemised movements; custom serving sizes', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospMakePours('JWB', 750, { shot: 350, glass: 1300 })");
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('JWB-shot'); addToCart('JWB-shot'); addToCart('BRG'); checkoutCart()");
  assert.deepEqual(jwb(w), { qty: 1, ml: 690 });
  const tab = J(w, "findOpenTabByLabel('Table 05')");
  const line = J(w, `hospTabLines(tabs.find(t => t.id === '${tab.id}')).find(l => l.code === 'JWB-shot')`);
  assert.deepEqual(line.serving, { kind: 'shot', label: 'Shot', ml: 30, consumedMl: 60 });
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${line.lineId}', 1, 'spilt')`), true);
  assert.deepEqual(jwb(w), { qty: 1, ml: 720 }, 'the removed shot goes back');
  assert.deepEqual(moves(w, 'BEEF'), [[-0.2, 'qty', 'Used in a recipe']]);
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '5000'; confirmTabSettle()`);
  const r = J(w, 'hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 })');
  assert.deepEqual(r.drinks.shots, [['JW Black 750ml', '750 ml bottle', 'Shot 30 ml', 1, '30 ml (0.04 bottles)', 'KES 350']]);
  assert.equal(w.eval("hospSetPourSizes('Tot:25, Glass:175')"), true);
  assert.deepEqual(J(w, 'hospPourSizes().map(z => z.id + z.ml)'), ['tot25', 'glass175']);
  b.close();
});
