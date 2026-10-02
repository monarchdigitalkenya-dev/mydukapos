import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeServer, openDevice, deviceStorage } from './e2e-harness.mjs';

// PHASE 18 (zip 118): "what happens if this exact request is received twice?" must never be "it happens twice".
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const post = (url, body) => new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('M-Pesa C2B and KCB confirmations re-delivered: the payment is stored once and a matched payment stays matched', async () => {
  for (const [file, body] of [
    ['functions/api/mpesa-c2b-confirmation.js', { TransID: 'QAB123', TransAmount: '500', MSISDN: '2547', FirstName: 'Jane' }],
    ['functions/api/kcb-ipn.js', { transactionReference: 'KCB9', transactionAmount: '750', customerMobileNumber: '2547' }],
  ]) {
    const m = await load(file);
    const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };   // zip 185: callbacks for an unlicensed shop id are ignored
    const id = body.TransID || body.transactionReference;
    await m.onRequestPost({ request: post('https://x/api/cb?c=C1', body), env });
    const key = `till-payment:C1:${id}`;
    const rec = JSON.parse(await kv.get(key)); rec.matched = true; await kv.put(key, JSON.stringify(rec));   // a cashier attached it to a sale
    for (let i = 0; i < 3; i++) await m.onRequestPost({ request: post('https://x/api/cb?c=C1', body), env });   // provider retries
    assert.equal(JSON.parse(await kv.get(key)).matched, true, `${file}: still attached — cannot be used for a second sale`);
    assert.deepEqual(JSON.parse(await kv.get('till-payment-index:C1')), [id], `${file}: listed once`);
  }
});

test('STK / Paywave: a late or repeated "failed" callback never downgrades a completed payment', async () => {
  const m = await load('functions/api/mpesa-callback.js');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };   // zip 185: callbacks for an unlicensed shop id are ignored
  const ok = { Body: { stkCallback: { CheckoutRequestID: 'ws_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'R1' }, { Name: 'Amount', Value: 100 }] } } } };
  const bad = { Body: { stkCallback: { CheckoutRequestID: 'ws_1', ResultCode: 1032, ResultDesc: 'cancelled' } } };
  await kv.put('mpesa-tx:C1:ws_1', JSON.stringify({ status: 'pending', createdAt: Date.now() - 5000 }));   // zip 185: a real STK callback answers a prompt this shop sent
  await kv.put('mpesa-tx:C1:pw_1', JSON.stringify({ status: 'pending', createdAt: Date.now() - 5000 }));
  await m.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', ok), env });
  await m.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', bad), env });
  await m.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', ok), env });
  const keys = [...kv.data.keys()].filter((k) => k.includes('ws_1'));
  assert.equal(keys.length, 1);
  const rec = JSON.parse(await kv.get(keys[0]));
  assert.equal(rec.status, 'success'); assert.equal(rec.receiptNumber, 'R1');
  const pw = await load('functions/api/paywave-webhook.js');
  await pw.onRequestPost({ request: post('https://x/api/paywave-webhook?c=C1', { CheckoutRequestID: 'pw_1', ResponseCode: 0, TransactionReceipt: 'P1' }), env }).catch(() => {});
  await pw.onRequestPost({ request: post('https://x/api/paywave-webhook?c=C1', { CheckoutRequestID: 'pw_1', ResponseCode: 1, status: 'failed' }), env }).catch(() => {});
  const pk = [...kv.data.keys()].find((k) => k.includes('pw_1'));
  if (pk) assert.equal(JSON.parse(await kv.get(pk)).status, 'success');
});

const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 10, unit: 'pcs', vatCategory: 'A' }];
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);

test('a sale voided twice — double tap, or a second till that had not seen the first void — restocks ONCE', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  a.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  // a sale of 3 recorded the way checkout records it
  a.w.eval(`(function(){ const p = inventory.find(x => x.code === 'A'); p.qty -= 3; logStockMovement('A', 'Alpha', -3, 'Sale');
    salesLog.push({ id: 'S1', timestamp: new Date().toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 3, price: 100, unit: 'pcs' }] });
    safeSetItem('pos_inventory', JSON.stringify(inventory)); safeSetItem('pos_sales_log', JSON.stringify(salesLog)); safeSetItem('pos_stock_movement_log', JSON.stringify(stockMovementLog)); queuePush(); })()`);
  await settled(a); await a.w.eval('pullState()');
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1000);          // till B holds the sale, not yet voided
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  const voidOn = (w) => w.eval("pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('S1')");
  voidOn(a.w); voidOn(a.w);                                                       // double tap
  assert.match((a.w.__toasts || []).join(' '), /already voided/);
  await settled(a);
  voidOn(b.w);                                                                    // the stale till voids it again
  await settled(b);
  await a.w.eval('pullState()'); await b.w.eval('pullState()');
  assert.equal(s.serverState().inventory[0].qty, 10, '10 - 3 + 3, not 13');
  assert.equal(a.w.eval("inventory[0].qty"), 10); assert.equal(b.w.eval("inventory[0].qty"), 10);
  assert.equal(s.serverState().stockMovementLog.filter((m) => /void/i.test(m.reason) && m._srv && m._srv.applied).length, 1);
  a.close(); b.close();
});

test('checkout tapped twice while the first is still waiting on the network records ONE sale', async () => {
  const { boot } = await import('./helpers.mjs');
  const { w, close } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 1200 });
  w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '100000';
  const before = w.eval('salesLog.length');
  await Promise.all([w.eval('checkoutCart()'), w.eval('checkoutCart()'), w.eval('checkoutCart()')]);
  assert.equal(w.eval('salesLog.length') - before, 1);
  close();
});

test('a receipt cannot be refunded or exchanged beyond what it sold — not twice on one till, not again on another', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  a.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("addToCart('A'); addToCart('A'); currentPaymentMethod = 'cash'");
  a.w.document.getElementById('cash-tendered-input').value = '1000';
  await a.w.eval('checkoutCart()');                                                 // sold 2 on one receipt
  const ref = a.w.eval('salesLog[salesLog.length - 1].refNumber');
  await settled(a); await a.w.eval('pullState()');
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1000);
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  const returnOn = (w, qty) => {
    w.eval(`(function(){ const sale = salesLog.find(x => x.refNumber === '${ref}'); selectReturnRefItem(sale.id, 0); })()`);
    w.document.getElementById('return-qty-input').value = String(qty);
    w.document.getElementById('return-condition-select').value = 'good';
    w.eval('saveSimpleReturn()');
    return w.document.getElementById('return-save-error').textContent;
  };
  assert.equal(returnOn(a.w, 2), '', 'returning what was sold is fine');
  await settled(a); await b.w.eval('pullState()');
  assert.match(returnOn(b.w, 1), /already been fully returned/, 'the other till cannot refund it again');
  assert.match(returnOn(a.w, 1), /already been fully returned/, 'nor this one');
  assert.equal(s.serverState().returns.length, 1);
  assert.equal(s.serverState().inventory[0].qty, 10, '10 - 2 + 2: restocked once');
  a.close(); b.close();
});
