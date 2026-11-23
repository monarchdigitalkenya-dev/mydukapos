import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 140 — roles & permissions, outlets, reports that reconcile, and "a typed M-Pesa code is not proof of payment" (§49–54, §60–61, §8, §94 RBAC).
const INV = [{ code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, wholesalePrice: 250, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' }];
const STAFF = [
  { id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'tabs-tab', 'hosp-role:waiter'] },
  { id: 'c1', name: 'Cashier Cate', roles: ['service-tab', 'bills-tab', 'hosp-role:cashier', 'perm:payments', 'perm:orders.viewAll'] },
  { id: 's1', name: 'Supervisor Sam', roles: ['service-tab', 'hosp-reports-tab', 'hosp-role:supervisor', 'perm:payments', 'perm:orders.viewAll', 'perm:orders.void', 'perm:orders.manage', 'perm:reports'] },
  { id: 'o1', name: 'Old Staff', roles: ['service-tab'] },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(fetch) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05', 'Table 06']), pos_staff: JSON.stringify(STAFF), pos_kitchen_ticket_enabled: 'true' }, fetch, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}");
  return b;
}
const as = (w, id) => w.eval(`currentServer = staff.find(s => s.id === '${id}') || null`);

test('RBAC: a waiter sends orders but cannot take payment or cancel what the kitchen started; a cashier takes payment; a supervisor can do both; old staff unchanged', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 'w1');
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); checkoutCart()");
  const tab = J(w, "findOpenTabByLabel('Table 05')");
  assert.ok(tab, 'the waiter sent the order');
  await w.eval("addToCart('TSK'); currentPaymentMethod = 'cash'; checkoutCart()");
  assert.ok((w.eval('window.__toasts') || []).some((t) => /taking payment/i.test(t)), 'no direct sale for a waiter');
  assert.equal(J(w, 'salesLog.length'), 0);
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '5000'; confirmTabSettle()`);
  assert.equal(J(w, 'salesLog.length'), 0, 'the waiter cannot settle the bill');
  // the kitchen started the burger: the waiter cannot cancel it; a NEW (not started) beer can be removed
  const brg = J(w, "hospTabLines(findOpenTabByLabel('Table 05')).find(l => l.code === 'BRG')");
  const tsk = J(w, "hospTabLines(findOpenTabByLabel('Table 05')).find(l => l.code === 'TSK')");
  w.eval(`hospSetLineStatus('${tab.id}', '${brg.lineId}', 'PREPARING')`);
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${brg.lineId}', 1, 'changed mind')`), false);
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${tsk.lineId}', 1, 'changed mind')`), true);
  w.eval('renderServiceOrders()');
  assert.doesNotMatch(d.getElementById('svc-active-orders').innerHTML, /Take payment/);
  // the supervisor can cancel the started item; the cashier takes the payment
  as(w, 's1');
  assert.equal(w.eval(`hospReduceLine('${tab.id}', '${brg.lineId}', 1, 'kitchen error')`), true);
  w.eval("hospAddProduct(findOpenTabByLabel('Table 05').id, 'TSK', 2)");
  as(w, 'c1');
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '600'; confirmTabSettle()`);
  assert.equal(J(w, 'salesLog.length'), 1);
  // staff from before hospitality roles: unchanged (can still sell)
  as(w, 'o1');
  await w.eval("routeOrderToTab(''); currentPaymentMethod = 'cash'; addToCart('TSK'); document.getElementById('cash-tendered-input').value = '1000'; checkoutCart()");
  assert.equal(J(w, 'salesLog.length'), 2);
  b.close();
});

test('REPORTS reconcile with the transactions: sales vs payments vs outstanding vs profit, by outlet / type / waiter; changes with reasons', async () => {
  const b = await app(); const { w, d } = b;
  as(w, 's1');
  w.eval("hospAddOutlet('Restaurant'); hospAddOutlet('Pool Bar'); hospSetDeviceOutlet('Restaurant')");
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('BRG'); addToCart('TSK'); checkoutCart()");
  const t5 = J(w, "findOpenTabByLabel('Table 05').id");
  w.eval(`hospSetDeviceOutlet('Pool Bar')`);
  await w.eval("routeOrderToTab('Table 06'); currentPaymentMethod = 'tab'; addToCart('TSK'); addToCart('TSK'); checkoutCart()");
  const t6 = J(w, "findOpenTabByLabel('Table 06').id");
  w.eval(`hospReduceLine('${t6}', hospTabLines(tabs.find(t => t.id === '${t6}'))[0].lineId, 1, 'spilt')`);
  // Table 05 paid by M-Pesa with a typed code; Table 06 stays open (outstanding)
  w.eval(`settleTabDirect('${t5}'); setTabSettlePayMethod('mpesa'); document.getElementById('tab-settle-mpesa-code-input').value = 'QWE1234567'; confirmTabSettle()`);
  const r = J(w, 'hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 })');
  assert.equal(r.gross, 950); assert.equal(r.pay.mpesa, 950); assert.equal(r.pay.cash, 0);
  assert.equal(r.outstanding, 300, 'Table 06 still owes one beer');
  assert.equal(r.cost, 250 + 180); assert.equal(r.profit, 950 - 430);
  assert.deepEqual(r.byOutlet.map((x) => x[0]), ['Restaurant']);
  assert.equal(r.byWaiter[0][0], 'Supervisor Sam');
  assert.ok(r.changes.some((c) => /reduced 1× Tusker/.test(c[2]) && c[4] === 'spilt'));
  assert.equal(r.unverified.length, 1, 'the typed M-Pesa code is not counted as verified');
  w.eval('renderHospReports()');   // zip 153: the hospitality reports live inside the one Reports screen; this draws them
  assert.match(d.getElementById('hosp-reports-body').textContent, /Sales, payments, outstanding and profit[\s\S]*M-Pesa payments not verified[\s\S]*QWE1234567/);
  as(w, 'w1'); w.eval('renderHospReports()');
  assert.match(d.getElementById('hosp-reports-body').textContent, /for supervisors/, 'a waiter cannot see the reports');
  b.close();
});

test('M-PESA: a typed code is checked against M-Pesa\'s own records — verified, too little, used twice, or not found — and one payment can never pay two sales', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const cb = await import(pathToFileURL(path.join(ROOT, 'functions/api/mpesa-callback.js')).href);
  // zip 185: a callback only counts for a prompt this shop created: mpesa-stkpush.js stores this pending record first
  kv.data.set('mpesa-tx:C1:ws_CO_1', { value: JSON.stringify({ status: 'pending', amount: 950, createdAt: Date.now() }) });
  // an STK prompt completed: Safaricom's callback (indexed by receipt now)
  await cb.onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-callback?c=C1', { method: 'POST', body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 950 }, { Name: 'MpesaReceiptNumber', Value: 'QWE1234567' }, { Name: 'PhoneNumber', Value: 254712000000 }] } } } }) }), env });
  // a customer paid straight to the till (C2B confirmation)
  kv.data.set('till-payment:C1:TIL9876543', { value: JSON.stringify({ transId: 'TIL9876543', amount: 200, customerName: 'JOHN' }) });
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/mpesa-verify.js')).href);
  const v = async (code, amount, saleId) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/mpesa-verify?c=C1', { method: 'POST', body: JSON.stringify({ code, amount, saleId }) }), env })).json();
  assert.equal((await v('qwe1234567', 950, 's1')).status, 'verified', 'STK receipt');
  assert.equal((await v('QWE1234567', 950, 's1')).status, 'verified', 'the same sale again: still fine');
  assert.equal((await v('QWE1234567', 950, 's2')).status, 'duplicate', 'one payment cannot pay two sales');
  assert.equal((await v('TIL9876543', 500, 's3')).status, 'amount_mismatch');
  assert.equal((await v('TIL9876543', 200, 's3')).status, 'verified', 'till payment');
  assert.equal((await v('NOPE123456', 100, 's4')).status, 'not_found');
  // on the till: the sale is marked, and the banner shows only what is not verified
  const fetch = async (url, opts = {}) => { if (/mpesa-verify/.test(String(url))) { const b = JSON.parse(opts.body); return new Response(JSON.stringify(await v(b.code, b.amount, b.saleId)), { status: 200 }); } return new Response('{}', { status: 404 }); };
  const b = await app(fetch); const { w, d } = b;
  w.eval("salesLog.push({ id: 's1', refNumber: 'R1', timestamp: new Date().toISOString(), paymentMethod: 'mpesa', mpesaAmount: 950, mpesaReceiptNumber: 'QWE1234567', items: [{ name: 'x', qty: 1, price: 950 }] }, { id: 's9', refNumber: 'R9', timestamp: new Date().toISOString(), paymentMethod: 'mpesa', mpesaAmount: 300, mpesaReceiptNumber: 'QWE1234567', items: [{ name: 'y', qty: 1, price: 300 }] }, { id: 's5', refNumber: 'R5', timestamp: new Date().toISOString(), paymentMethod: 'mpesa', mpesaAmount: 100, mpesaReceiptNumber: 'FAKE000000', items: [{ name: 'z', qty: 1, price: 100 }] })");
  assert.equal(await w.eval('mpesaVerifyNow()'), 3);
  assert.deepEqual(J(w, "salesLog.map(s => s.id + ':' + s.mpesaCheck.status)"), ['s1:verified', 's9:duplicate', 's5:not_found']);
  w.eval(`document.querySelector('.tab-link[data-tab="daily-sales-tab"]').click(); mpesaVerifyBanner()`);
  const banner = d.getElementById('mpesa-verify-banner').textContent;
  // zip 378: only real problems are shown (a code used twice / paid less); "no M-Pesa record found yet" is not shown - it caused needless panic
  assert.match(banner, /1 M-Pesa payment to check:[\s\S]*R9 QWE1234567 — code already used for another sale/);
  assert.doesNotMatch(banner, /FAKE000000|no M-Pesa record/);
  assert.equal(await w.eval('mpesaVerifyNow()'), 0, 'final answers are not re-asked; "not found" waits before it is asked again');
  b.close();
});

test('every app carries the M-Pesa check; the role presets exist for the hospitality roles of the brief', async () => {
  const fs = await import('node:fs');
  for (const f of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /window\.mpesaVerifyNow = /, f);
  const b = await app(); const { w } = b;
  assert.deepEqual(J(w, 'Object.keys(HOSP_ROLE_PRESETS)'), ['waiter', 'bartender', 'kitchen', 'cashier', 'receptionist', 'housekeeping', 'pool_attendant', 'event_manager', 'storekeeper', 'supervisor', 'accountant']);
  w.eval("newStaffSelectedRoles = []; hospApplyRolePreset('waiter')");
  assert.deepEqual(J(w, 'newStaffSelectedRoles'), ['service-tab', 'hosp-role:waiter'], 'zip 147: a waiter gets the Orders tab only');
  b.close();
});
