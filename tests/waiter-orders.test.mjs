import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 147 — the waiter's job is the ORDERS tab, and nothing else:
//   create order → items → POST ORDER (kitchen / bar slips, NO prices) → "📋 Orders" (only their own) → update / exchange →
//   SETTLE (the customer's bill: prices, total, this shop's own payment details) → the CASHIER takes the payment (one sale).
// Root causes found (reproduced before the fix):
//   * "New order" switched the waiter to the Sales Counter to build the order — a waiter without it could not take an order at all,
//     so shops gave waiters the cashier's screen;
//   * a staff member created without the Sales Counter got it anyway at the next start (a one-time migration re-ran for every new
//     person — they were never marked), and an admin unticking it saw it come back;
//   * "Settle" sent the customer's bill to the KITCHEN printer, and printed nothing at all when kitchen tickets were off.
const APP = 'hotel/index.html';
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'CHP', type: 'service', name: 'Chips', category: 'Sides', price: 200, wholesalePrice: 0, unit: 'pcs', vatCategory: 'A' },
  { code: 'CKE', type: 'item', name: 'Coke 500ml', category: 'Soft drinks', price: 120, wholesalePrice: 60, qty: 24, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [
  { id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'hosp-role:waiter'], salesTabMigrated: true },
  { id: 'w2', name: 'Otieno', roles: ['service-tab', 'hosp-role:waiter'], salesTabMigrated: true },
  { id: 'c1', name: 'Cash', roles: ['sales-tab', 'service-tab', 'bills-tab', 'hosp-role:cashier', 'perm:payments', 'perm:orders.viewAll'], salesTabMigrated: true },
];
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
async function app(extra = {}) {
  const b = await boot(APP, { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']), pos_rooms: JSON.stringify(['Room 205']),
    pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true', pos_payment_details: 'M-Pesa Paybill 123456, Acc 789\nOr Till 555111', ...extra }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => 'Customer changed mind'; window.print = () => {}");
  b.w.eval('window.__tickets = []; queuePrintJob = function () { window.__tickets.push(lastKitchenTicketText); return Promise.resolve(); }');
  return b;
}
const as = (w, id) => w.eval(`currentServer = staff.find(s => s.id === '${id}') || null; applyServerVisibility()`);
const visible = (d, tab) => { const el = d.querySelector(`.tab-link[data-tab="${tab}"]`); return !!el && el.style.display !== 'none' && !el.hidden; };

test('a waiter created WITHOUT the Sales Counter never gets it back (not at the next start, not after an admin edit)', async () => {
  // an older record (no marker) the admin edits: unticking must stick
  const b = await app({ pos_staff: JSON.stringify([{ id: 'old', name: 'Old', roles: ['service-tab'] }]) });
  assert.ok(J(b.w, "staff.find(s => s.id === 'old').roles").includes('sales-tab'), '(the one-time migration still gives OLD staff the Sales Counter once, as before)');
  b.w.eval("updateStaffRole('old', 'sales-tab', false)");
  // a new waiter joins through an invite with only the Orders tab
  b.w.eval("pendingInvites.push({ token: 'tok1', name: 'Newbie', roles: ['service-tab', 'hosp-role:waiter'], createdAt: Date.now() }); document.getElementById('invite-screen').dataset.token = 'tok1'");
  b.d.getElementById('invite-pin-input').value = '4321'; b.d.getElementById('invite-pin-confirm-input').value = '4321';
  await b.w.eval('submitStaffInvite()');
  const store = JSON.parse(b.w.eval("JSON.stringify({ pos_staff: localStorage.getItem('pos_staff') })"));
  b.close();
  const b2 = await app({ pos_staff: store.pos_staff });                   // the app is opened again
  assert.deepEqual(J(b2.w, "staff.find(s => s.name === 'Newbie').roles").sort(), ['hosp-role:waiter', 'service-tab'], 'the new waiter did NOT get the Sales Counter');
  assert.ok(!J(b2.w, "staff.find(s => s.id === 'old').roles").includes('sales-tab'), 'the admin\'s untick stuck');
  b2.close();
});

test('WAITER: Orders tab only → create → POST (slips without prices) → own orders → update / exchange → SETTLE bill → cashier takes payment once', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1');
  assert.equal(visible(d, 'sales-tab'), false, 'no Sales Counter for a waiter');
  assert.equal(visible(d, 'service-tab'), true, 'the Orders tab');
  w.eval(`document.querySelector('.tab-link[data-tab="service-tab"]').click()`);
  assert.ok(d.body.classList.contains('svc-simple'), 'the simple waiter screen (cashier tools hidden)');
  assert.ok(d.getElementById('svc-menu').textContent.includes('Beef Burger'), 'the menu is on the Orders tab');
  // create + POST
  d.getElementById('svc-new-location').value = 'Table 05';
  w.eval("svcAdd('BRG'); svcAdd('BRG'); svcAdd('CHP'); svcAdd('TSK')");
  w.eval('svcPostOrder()');
  assert.ok(d.getElementById('service-tab').classList.contains('active'), 'the waiter stays on the Orders tab (never the Sales Counter)');
  const tab = J(w, "tabs.find(t => t.label === 'Table 05' && t.status === 'OPEN')");
  assert.deepEqual([tab.waiter, tab.source], ['Wanjiru', 'WAITER']);
  const slip = J(w, 'window.__tickets[0]');
  assert.match(slip, /KITCHEN ORDER \(KOT\)[\s\S]*TABLE 05[\s\S]*Order [A-Z0-9]+[\s\S]*Wanjiru[\s\S]*2x\s+Beef Burger[\s\S]*1x\s+Chips/);
  assert.match(slip, /BAR ORDER \(BOT\)[\s\S]*1x\s+Tusker Lager/);
  assert.doesNotMatch(slip, /KES|650|1,?300|300\.00/, 'NO prices on the kitchen / bar slip');
  assert.equal(Number(w.eval("inventory.find(p => p.code === 'TSK').qty")), 47, 'stock follows the order');
  assert.equal(J(w, 'salesLog.length'), 0, 'posting an order is not a sale');
  // another waiter's order is not in Wanjiru's list
  as(w, 'w2'); d.getElementById('svc-new-location').value = 'Table 06'; w.eval("svcAdd('CKE'); svcPostOrder()");
  as(w, 'w1'); w.eval('openMyOrders()');
  const panel = d.getElementById('svc-panel');
  assert.ok(panel.classList.contains('open'));
  assert.match(panel.textContent, /Table 05/); assert.doesNotMatch(panel.textContent, /Table 06/, 'only their own orders');
  assert.match(panel.textContent, /UPDATE ORDER[\s\S]*SETTLE/);
  // UPDATE: exchange the beer for a soda — the bar gets only the change; no duplicate lines, no double charge
  w.eval(`openHospPanel('${tab.id}')`);
  const beer = J(w, `hospTabLines(tabs.find(t => t.id === '${tab.id}')).find(l => l.code === 'TSK')`);
  w.eval(`hospExchangeLine('${tab.id}', '${beer.lineId}', 'CKE', 'Customer changed mind')`);
  assert.match(J(w, 'window.__tickets[window.__tickets.length - 1]'), /CANCEL:\s+1x\s+Tusker Lager[\s\S]*INSTEAD:\s+1x\s+Coke/);
  // add one more item through the Orders tab: only it prints
  w.eval(`svcAddItemsTo('${tab.id}')`);
  assert.match(d.getElementById('svc-draft-target').textContent, /Adding to Table 05/);
  w.eval("svcAdd('CHP'); svcPostOrder()");
  assert.doesNotMatch(J(w, 'window.__tickets[window.__tickets.length - 1]'), /Burger|Tusker|Coke/, 'only the new item prints');
  const lines = J(w, `hospTabLines(tabs.find(t => t.id === '${tab.id}')).map(l => l.qty + 'x ' + l.code)`).sort();
  assert.deepEqual(lines, ['1x CHP', '1x CHP', '1x CKE', '2x BRG'].sort(), 'what will be settled: exactly what the customer has');
  // SETTLE: the customer's bill on the receipt printer — prices, total, the shop's payment details; NOT a payment
  const before = J(w, 'window.__tickets.length');
  w.eval(`hospSettleForBilling('${tab.id}')`);
  assert.equal(J(w, 'window.__tickets.length'), before, 'the bill does NOT go to the kitchen printer');
  const bill = d.getElementById('receipt-body').textContent;
  assert.equal(d.getElementById('receipt-modal').style.display, 'flex', 'the bill is shown / printed');
  assert.match(bill, /RESTAURANT BILL/); assert.match(bill, /Table: Table 05/);
  assert.match(bill, /Beef Burger[\s\S]*1,?300/, 'with prices');
  assert.match(bill, /TOTAL[\s\S]*1,?820/, 'and the total (1300 + 200 + 200 + 120)');
  assert.match(bill, /NOT PAID — please pay the cashier/);
  assert.match(bill, /Pay to:[\s\S]*Paybill 123456, Acc 789[\s\S]*Till 555111/, "this shop's own payment details");
  assert.equal(J(w, 'salesLog.length'), 0, 'settling is NOT a payment');
  assert.equal(w.eval(`hospAddProduct('${tab.id}', 'CHP', 1)`), null, 'a printed bill is locked for the waiter');
  // the CASHIER takes the payment: one sale, no duplicate
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}')`);
  d.getElementById('tab-settle-cash-tendered-input').value = '2000';
  w.eval('confirmTabSettle()');
  assert.equal(J(w, 'salesLog.length'), 1, 'exactly one sale');
  assert.equal(J(w, 'salesLog[0].cashAmount'), 1820);
  assert.equal(J(w, `tabs.find(t => t.id === '${tab.id}').status`), 'CLOSED');
  b.close();
});

test('a CASHIER keeps the Sales Counter and every tool on the Orders tab', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'c1');
  assert.equal(visible(d, 'sales-tab'), true);
  w.eval(`document.querySelector('.tab-link[data-tab="service-tab"]').click()`);
  assert.ok(!d.body.classList.contains('svc-simple'), 'cashier tools shown');
  d.getElementById('svc-new-location').value = 'Room 205';
  w.eval('hospStartOrder()');
  assert.ok(d.getElementById('sales-tab').classList.contains('active'), 'a cashier can still build an order on the Sales Counter');
  b.close();
});
