import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// Zip 141 — split bill: guests at one table pay separately, by person (what they had) or by amount (a share). Each part is a real
// sale with its own receipt; the order keeps its balance; totals never double-count and stock is never deducted twice.
const INV = [{ code: 'BRG', type: 'item', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 250, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' }];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'tabs-tab', 'hosp-role:waiter'] }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']), pos_staff: JSON.stringify(STAFF) }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}; hospConfig.serviceChargePct = 10");
  return b;
}
async function order(w, table, codes) {
  await w.eval(`routeOrderToTab('${table}'); currentPaymentMethod = 'tab'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; checkoutCart()`);
  return J(w, `findOpenTabByLabel('${table}')`);
}
const lineOf = (w, tabId, code, i = 0) => J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}')).filter(l => l.code === '${code}')[${i}]`);

test('by person + by amount + the rest: every part a real sale, the balance right, the final receipt nets them off, reports add up, stock once', async () => {
  const b = await app(); const { w, d } = b;
  const tab = await order(w, 'Table 05', ['BRG', 'BRG', 'TSK', 'TSK', 'TSK']);
  assert.equal(J(w, `hospTabDue(tabs.find(t => t.id === '${tab.id}'))`), 2420, '2 burgers + 3 beers + 10% service');
  const brg = lineOf(w, tab.id, 'BRG'), tsk = lineOf(w, tab.id, 'TSK');
  // Jane: one burger and one beer, cash 1100
  const a = J(w, `hospPayPart('${tab.id}', { lines: { '${brg.lineId}': 1, '${tsk.lineId}': 1 }, method: 'cash', tendered: 1100, label: 'Jane' })`);
  assert.equal(a.cashAmount, 1045); assert.equal(a.change, 55);
  assert.deepEqual(a.items.map((i) => `${i.qty}x${i.code}`), ['1xBRG', '1xTSK', '1xSVC-CHARGE']);
  // Tom: a share of 500 by M-Pesa
  const t = J(w, `hospPayPart('${tab.id}', { amount: 500, method: 'mpesa', mpesaCode: 'QWE1234567', label: 'Tom' })`);
  assert.equal(t.mpesaAmount, 500); assert.equal(t.mpesaReceiptNumber, 'QWE1234567');
  assert.equal(J(w, `hospTabBalance(tabs.find(x => x.id === '${tab.id}'))`), 875);
  // more than the balance, a paid item taken off, a waiter taking money: all refused
  assert.equal(J(w, `hospPayPart('${tab.id}', { amount: 900, method: 'cash' })`), null);
  assert.equal(J(w, `hospPayPart('${tab.id}', { lines: { '${brg.lineId}': 2 }, method: 'cash' })`), null, 'only one burger left to pay for');
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${brg.lineId}', 2, 'mistake')`), false, 'a paid burger cannot be taken off');
  assert.equal(w.eval(`!!hospMoveLines('${tab.id}', ['${tsk.lineId}'], 'Table 06')`), false, 'a paid beer cannot be moved');
  w.eval(`currentServer = staff.find(s => s.id === 'w1')`);
  assert.equal(J(w, `hospPayPart('${tab.id}', { amount: 100, method: 'cash' })`), null, 'a waiter does not take payment');
  w.eval('currentServer = null');
  // the rest through the normal Settle screen
  w.eval(`settleTabDirect('${tab.id}')`);
  assert.match(d.getElementById('tab-settle-total').textContent, /875/);
  assert.match(d.getElementById('tab-settle-summary').textContent, /already paid in 2 part/);
  w.eval(`document.getElementById('tab-settle-cash-tendered-input').value = '1000'; confirmTabSettle()`);
  const last = J(w, 'salesLog[salesLog.length - 1]');
  assert.equal(last.cashAmount, 875);
  assert.equal(Math.round(last.items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100, 875);
  assert.deepEqual(last.items.map((i) => `${i.qty}x${i.code}`), ['1xBRG', '2xTSK', '1xSVC-CHARGE', '1xPART-PAID']);
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'CLOSED');
  // reports: 2420 once; payments by method; burgers 2 and beers 3; nothing outstanding
  const r = J(w, 'hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 })');
  assert.equal(r.gross, 2420); assert.equal(r.pay.cash, 1045 + 875); assert.equal(r.pay.mpesa, 500);
  assert.equal(r.outstanding, 0);
  assert.deepEqual(r.topProducts.map((x) => `${x[0]}:${x[1]}`).sort(), ['Beef Burger:2', 'Tusker Lager:3']);
  assert.equal(r.cost, 2 * 250 + 3 * 180, 'cost of goods counted once');
  assert.equal(J(w, "inventory.find(i => i.code === 'TSK').qty"), 45, 'stock left at order time only');
  b.close();
});

test('the last part closes the order; a voided part puts its amount back on the balance; the printed bill shows what was paid', async () => {
  const b = await app(); const { w } = b;
  const tab = await order(w, 'Table 06', ['TSK', 'TSK']);
  const tsk = lineOf(w, tab.id, 'TSK');
  const p1 = J(w, `hospPayPart('${tab.id}', { lines: { '${tsk.lineId}': 1 }, method: 'cash', label: 'A' })`);
  assert.equal(p1.cashAmount, 330);
  assert.match(w.eval(`hospBillText(tabs.find(x => x.id === '${tab.id}'))`), /PAID \(A\): -KES 330\.00[\s\S]*BALANCE DUE: KES 330\.00/);
  // void A's sale: the balance is the whole bill again
  w.eval(`salesLog.find(s => s.id === '${p1.id}').voided = true`);
  assert.equal(J(w, `hospTabBalance(tabs.find(x => x.id === '${tab.id}'))`), 660);
  w.eval(`salesLog.find(s => s.id === '${p1.id}').voided = false`);
  J(w, `hospPayPart('${tab.id}', { lines: { '${tsk.lineId}': 1 }, method: 'cash', label: 'B' })`);
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'CLOSED', 'fully paid in parts: closed');
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').settlement.paymentMethod`), 'parts');
  b.close();
});

test('the split-bill screen: tick items, take the payment, repeat', async () => {
  const b = await app(); const { w, d } = b;
  const tab = await order(w, 'Table 05', ['BRG', 'TSK']);
  w.eval(`settleTabDirect('${tab.id}'); hospOpenSplitBill('person')`);
  const inputs = d.querySelectorAll('#hosp-split-modal [data-split-line]');
  assert.equal(inputs.length, 2);
  inputs[0].value = '1'; w.eval('hospSplitTotal()');
  assert.match(d.getElementById('split-total').textContent, /715/, 'burger + 10%');
  d.getElementById('split-label').value = 'Jane';
  w.eval("hospConfirmSplit('person')");
  assert.equal(d.getElementById('hosp-split-modal'), null);
  assert.equal(J(w, `hospTabBalance(tabs.find(x => x.id === '${tab.id}'))`), 330);
  w.eval("hospOpenSplitBill('amount')");
  d.getElementById('split-amount').value = '330';
  w.eval("hospConfirmSplit('amount')");
  assert.equal(J(w, `tabs.find(x => x.id === '${tab.id}').status`), 'CLOSED');
  b.close();
});

test('server merge: two tills taking part payments on the same order at the same moment keep both', async () => {
  const { mergeIncomingState } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const base = { id: 'tab1', label: 'Table 05', status: 'OPEN', orders: [{ id: 'o1', entries: [] }] };
  const a = { tabs: [{ ...base, partPayments: [{ id: 'pp-a', amount: 100 }], updatedAt: 10 }] };
  const bb = { tabs: [{ ...base, partPayments: [{ id: 'pp-b', amount: 200 }], updatedAt: 11 }] };
  const m = mergeIncomingState(mergeIncomingState({}, a), bb);
  assert.deepEqual(m.tabs[0].partPayments.map((p) => p.id).sort(), ['pp-a', 'pp-b']);
});
