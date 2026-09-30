import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 158 — hotel tab audit: rounding of per-person service charge, repeated checkout, split settle tolerance, voiding a tab
// (paid lines, pours, piece mode) and pulling a part-paid tab into the cart.
const INV = [
  { code: 'A33', type: 'item', name: 'Plate', category: 'Mains', price: 33.33, wholesalePrice: 10, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'BRG', type: 'item', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 250, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
  { code: 'JWB', type: 'item', name: 'JW Black 750ml', category: 'Whisky', price: 7000, wholesalePrice: 3000, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'CEM', type: 'item', name: 'Sugar', price: 800, wholesalePrice: 700, qty: 40, unit: 'bag', vatCategory: 'A', dualUnit: true, unitsPerBox: 50, piecePrice: 18, pieceWholesalePrice: 14, pieceQty: 0, looseUnit: 'kg' },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']) }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}; hospConfig.serviceChargePct = 10");
  return b;
}
async function order(w, table, codes) {
  await w.eval(`routeOrderToTab('${table}'); currentPaymentMethod = 'tab'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; checkoutCart()`);
  return J(w, `findOpenTabByLabel('${table}')`);
}
const lines = (w, id) => J(w, `hospTabLines(tabs.find(t => t.id === '${id}'))`);
const qty = (w, code) => J(w, `inventory.find(i => i.code === '${code}').qty`);

test('H2: three people paying their own plate at 10% service charge close the tab with balance 0', async () => {
  const b = await app(); const { w } = b;
  const tab = await order(w, 'Table 05', ['A33', 'A33', 'A33']);
  const ls = lines(w, tab.id);
  const each = ls.map((l) => l.lineId);
  assert.equal(J(w, `hospTabDue(tabs.find(t => t.id === '${tab.id}'))`), 109.99);
  const one = ls[0];
  // three units on ONE line (qty 3) or three lines: pay one unit at a time
  for (let i = 0; i < 3; i++) {
    const s = J(w, `hospPayPart('${tab.id}', { lines: { '${one.lineId}': 1 }, method: 'cash' })`);
    assert.ok(s, 'part ' + (i + 1) + ' taken');
  }
  assert.equal(J(w, `hospTabBalance(tabs.find(t => t.id === '${tab.id}'))`), 0);
  assert.equal(J(w, `tabs.find(t => t.id === '${tab.id}').status`), 'CLOSED', 'the tab closes, no 0.01 left hanging');
  const paid = J(w, 'salesLog.filter(s => s.partOfTab).reduce((n, s) => n + s.cashAmount, 0)');
  assert.equal(Math.round(paid * 100) / 100, 109.99, 'the parts add up to the bill exactly');
  void each; b.close();
});

test('H1: pressing check-out twice charges the room once', async () => {
  const b = await app(); const { w } = b;
  w.eval("roomStays['Room 204'] = { guestName: 'Jane', checkInAt: new Date().toISOString(), checkOutDue: null, nightlyRate: 5000, depositAmount: 1000, creditLimit: null }; setLocStatus('room', 'Room 204', 'occupied')");
  w.eval("openCheckOutRoomModal('Room 204'); confirmCheckOut(); closeTabSettleModal(); openCheckOutRoomModal('Room 204'); confirmCheckOut()");
  const tab = J(w, "findOpenTabByLabel('Room 204')");
  const ls = lines(w, tab.id);
  assert.equal(ls.filter((l) => /Room Charge/.test(l.name)).length, 1, 'one room charge line');
  assert.equal(ls.filter((l) => /Advance Deposit/.test(l.name)).length, 1, 'one deposit line');
  assert.equal(J(w, `hospTabDue(tabs.find(t => t.id === '${tab.id}'))`), 4000);
  b.close();
});

test('H3: a split settle that is 0.01 short is refused', async () => {
  const b = await app(); const { w, d } = b;
  const tab = await order(w, 'Table 06', ['BRG']);
  w.eval("hospConfig.serviceChargePct = 0");
  w.eval(`openTabDetailModal('${tab.id}'); openTabSettleModal(); tabSettlePayMethod = 'split'`);
  d.getElementById('tab-settle-split-cash-input').value = '649.99';
  d.getElementById('tab-settle-split-mpesa-input').value = '0';
  d.getElementById('tab-settle-split-card-input').value = '0';
  d.getElementById('tab-settle-split-cash-tendered-input').value = '650';
  w.eval('confirmTabSettle()');
  assert.equal(J(w, `tabs.find(t => t.id === '${tab.id}').status`), 'OPEN', 'not settled 0.01 short');
  b.close();
});

test('H5: voiding a tab gives back only what was not paid; pours and piece-mode sales go back correctly', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospConfig.serviceChargePct = 0; hospMakePours('JWB', 750, { shot: 350 })");
  const tab = await order(w, 'Table 05', ['BRG', 'BRG', 'TSK', 'JWB-shot', 'JWB-shot']);
  assert.equal(qty(w, 'BRG'), 18);
  const tsk = lines(w, tab.id).find((l) => l.code === 'TSK');
  assert.ok(J(w, `hospPayPart('${tab.id}', { lines: { '${tsk.lineId}': 1 }, method: 'cash' })`));
  assert.equal(qty(w, 'TSK'), 47);
  assert.deepEqual(J(w, "(function (p) { return { qty: p.qty, ml: p.pieceQty || 0 }; })(inventory.find(i => i.code === 'JWB'))"), { qty: 1, ml: 690 });
  w.eval(`activeTabDetailId = '${tab.id}'; voidActiveTab()`);
  assert.equal(qty(w, 'BRG'), 20, 'burgers back');
  assert.equal(qty(w, 'TSK'), 47, 'the paid beer was sold: it does not come back');
  assert.deepEqual(J(w, "(function (p) { return { qty: p.qty, ml: p.pieceQty || 0 }; })(inventory.find(i => i.code === 'JWB'))"), { qty: 1, ml: 750 }, 'the poured ml go back to the bottle');
  // the give-back moves are keyed, so a second device does not apply them twice
  assert.ok(J(w, "stockMovementLog.filter(m => /^tabvoid:/.test(m.id)).length") >= 2);
  b.close();
});

test('H6: pulling a part-paid tab into the cart brings only the unpaid quantities', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospConfig.serviceChargePct = 0");
  const tab = await order(w, 'Table 05', ['BRG', 'TSK', 'TSK']);
  const ls = lines(w, tab.id); const brg = ls.find((l) => l.code === 'BRG');
  assert.ok(J(w, `hospPayPart('${tab.id}', { lines: { '${brg.lineId}': 1 }, method: 'cash' })`));
  w.eval(`activeTabDetailId = '${tab.id}'; clearTabToCart()`);
  const cart = J(w, 'Object.values(currentCart).map(l => l.code + ":" + l.qty)');
  assert.ok(!cart.some((c) => c.startsWith('BRG')), 'the paid burger is not charged again: ' + cart);
  assert.ok(cart.some((c) => c.startsWith('TSK')));
  b.close();
});
