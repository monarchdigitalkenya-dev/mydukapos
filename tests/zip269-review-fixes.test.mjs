import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - fixes from the pre-migration review of the hotel till.
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A', sizes: [{ id: 'sL', name: 'Large', price: 900, factor: 1 }, { id: 'sR', name: 'Regular', price: 650, factor: 1 }] },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
async function app(extra = {}) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']), pos_kitchen_ticket_enabled: 'true', ...extra }, wait: 1500 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; kdsBeep = function () {}");
  return b;
}
const post = (w, d, adds) => { d.getElementById('svc-new-location').value = 'Table 05'; w.eval(adds); w.eval('svcPostOrder()'); };

test('the + on an order line adds one more of THAT line (same size and price), not the plain dish', async () => {
  const { w, d, close } = await app();
  post(w, d, "svcAdd('BRG', 'sL')");
  const tabId = J(w, "tabs.find(t => t.status === 'OPEN').id");
  const lineId = J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}'))[0].lineId`);
  w.eval(`hospAddProduct('${tabId}', 'BRG', 1, '', '${lineId}')`);
  const lines = J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}')).map(l => ({ name: l.name, price: l.price, size: l.size && l.size.name, qty: l.qty }))`);
  assert.equal(lines.length, 2); for (const l of lines) { assert.equal(l.price, 900, 'Large price'); assert.equal(l.size, 'Large'); assert.equal(l.qty, 1); }
  close();
});

test('an order paid before it was served stays on the Kitchen board until it is served', async () => {
  const { w, d, close } = await app();
  post(w, d, "svcAdd('BRG', 'sR')");
  const tabId = J(w, "tabs.find(t => t.status === 'OPEN').id");
  w.eval(`hospCloseTab(tabs.find(t => t.id === '${tabId}'), { paymentMethod: 'cash', total: 650 })`);
  assert.equal(J(w, "tabs.find(t => t.id === '" + tabId + "').status"), 'CLOSED');
  assert.equal(J(w, "hospKdsCards('kitchen').length"), 1, 'still on the board');
  const lineId = J(w, `hospTabLines(tabs.find(t => t.id === '${tabId}'))[0].lineId`);
  w.eval(`hospSetLineStatus('${tabId}', '${lineId}', 'SERVED')`);
  assert.equal(J(w, "hospKdsCards('kitchen').length"), 0, 'gone once served');
  w.eval("tabs.find(t => t.id === '" + tabId + "').closedAt = new Date(Date.now() - 5 * 3600000).toISOString(); tabs.find(t => t.id === '" + tabId + "').lineStatus = {}");
  assert.equal(J(w, "hospKdsCards('kitchen').length"), 0, 'a tab closed hours ago is not shown');
  close();
});

test('a payment method switched off in Settings is never the active one; a card slip number does not ride along to the next sale', async () => {
  const { w, d, close } = await app();
  w.eval("posPaySetAccepted(['mpesa', 'card'], true)");
  w.eval("setPaymentMethod('cash')"); assert.equal(w.eval('currentPaymentMethod'), 'mpesa', 'Cash is off: the till moved to a shown method');
  w.eval("setPaymentMethod('card')"); d.getElementById('card-reference-input').value = 'SLIP-1';
  w.eval("setPaymentMethod('mpesa')"); assert.equal(d.getElementById('card-reference-input').value, '', 'the reference is cleared when leaving Card');
  w.eval("tabs.push({ id: 'T-x', label: 'T1', kind: 'table', status: 'OPEN', orders: [{ id: 'o1', timestamp: new Date().toISOString(), entries: [{ code: 'TSK', name: 'Tusker', qty: 1, price: 300, unit: 'pcs', lineId: 'L1' }] }] }); activeTabDetailId = 'T-x'; openTabSettleModal()");
  const on = [...d.querySelectorAll('#tab-settle-pay-toggle button')].filter((x) => x.style.display !== 'none' && x.classList.contains('active'));
  assert.equal(on.length, 1); assert.doesNotMatch(on[0].textContent, /Cash/, 'Settle Tab does not open on a hidden Cash');
  close();
});

test('Daily Sales has a Card total, a Card badge and a Card filter', async () => {
  const { w, d, close } = await app({ pos_sales_log: JSON.stringify([{ id: 'c1', refNumber: 'R1', timestamp: new Date().toISOString(), paymentMethod: 'card', paid: true, cashAmount: 0, mpesaAmount: 0, cardAmount: 200, items: [{ name: 'Tea', qty: 2, price: 100, unit: 'pcs' }] }]) });
  w.eval('renderDailySales()');
  assert.equal(d.getElementById('daily-card-total').textContent, 'KES 200.00'); assert.equal(d.getElementById('daily-cash-total').textContent, 'KES 0.00');
  assert.equal(d.getElementById('daily-revenue-total').textContent, 'KES 200.00');
  assert.ok(d.querySelector('#daily-sales-method-filter-bar [data-method="card"]'), 'a Card filter');
  assert.match(d.body.innerHTML, /payment-badge card/, 'the Card badge');
  close();
});
