// zip 287: a payment made by STK push also produces Safaricom's Till message, which can arrive BEFORE the STK result. The live watcher must not announce that
// payment as "DIRECT TILL PAYMENT" (it would be wrong, and a second alert for money the sale already shows). A real direct payment is still announced, with the
// payer's NAME and M-PESA CODE, a few seconds later.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function server() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  const cb = await load('functions/api/mpesa-c2b-confirmation.js'), tp = await load('functions/api/till-payments.js'), stkCb = await load('functions/api/mpesa-callback.js');
  const key = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'c2b')).k;
  const skey = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'stk')).k;
  const till = (id, amt, first, last, msisdn = '254712345678') => cb.onRequestPost({ request: new Request(`https://shop-c1.mydukapos.store/api/pay-cb-till-confirm?c=C1&k=${key}`, { method: 'POST', body: JSON.stringify({ TransID: id, TransAmount: String(amt), TransTime: '20261015100000', FirstName: first, LastName: last, MSISDN: msisdn, BillRefNumber: 'x' }) }), env });
  const stkDone = async (checkoutId, receipt, amt, phone) => {
    await kv.put(`mpesa-tx:C1:${checkoutId}`, JSON.stringify({ status: 'pending', amount: amt, phone, createdAt: Date.now() - 20000 }));
    return stkCb.onRequestPost({ request: new Request(`https://shop-c1.mydukapos.store/api/mpesa-callback?c=C1&k=${skey}`, { method: 'POST', body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: amt }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'PhoneNumber', Value: Number(phone) }, { Name: 'TransactionDate', Value: 20261015100001 }] } } } }) }), env });
  };
  const fetchStub = async (u, init = {}) => {
    const s = String(u); if (!/\/api\/till-payments/.test(s)) return new Response('{}', { status: 404 });
    const req = new Request('https://shop-c1.mydukapos.store/api/till-payments' + (s.includes('?') ? s.slice(s.indexOf('?')) : '?c=C1'), { method: init.method || 'GET', body: init.body });
    return (init.method === 'POST' ? tp.onRequestPost : tp.onRequestGet)({ request: req, env });
  };
  return { till, stkDone, fetchStub };
}

test('hotel/shop watcher: an STK payment whose Till message came first is never announced as direct; a real direct payment is, with name and code', { timeout: 120000 }, async () => {
  const sv = await server();
  await sv.till('QAA0000001', 100, 'Old', 'Payment');                                  // already there when the device first looks
  const b = await boot('index.html', { storage: {}, wait: 900 });
  const { w } = b; w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push(m); }; window.Notification = undefined;");
  w.fetch = sv.fetchStub;
  w.eval("window.__told = []; window.__tillPay.pendLookMs(60); window.__tillPay.daraja = true;");
  const J = (js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
  const told = () => J('window.__told');
  // capture what the banner would say, without relying on audio/DOM timing
  w.eval("var __t = document.createElement('div'); document.body.appendChild(__t); (function(){ var o = window.__tillPay; })();");
  const seenBanner = () => { const t = w.document.getElementById('tp-toast'); return t && t.classList.contains('on') ? t.textContent : ''; };

  await w.eval('window.__tillPay.watch()'); await tick(300);                          // first read: records what is there, announces nothing
  assert.equal(seenBanner(), '', 'the first read announces nothing');

  // 1) an STK payment: the Till message arrives FIRST
  await sv.till('QAB1111111', 500, 'Mary', 'Wanjiku', '254722000111');
  await w.eval('window.__tillPay.watch()'); await tick(30);                            // first look: held back
  assert.equal(seenBanner(), '', 'first sight is held back, not announced');
  await sv.stkDone('ws_CO_1', 'QAB1111111', 500, '254722000111');                      // the STK result claims it
  await tick(300);                                                                     // the second look
  assert.equal(seenBanner(), '', 'an STK payment is never announced as DIRECT');

  // 2) a real direct payment: announced on the second look, with the payer's name and code
  await sv.till('QAB2222222', 750, 'Peter', 'Kamau', '254733000222');
  await w.eval('window.__tillPay.watch()'); await tick(300);
  const msg = seenBanner();
  assert.match(msg, /DIRECT TILL PAYMENT/); assert.match(msg, /Peter Kamau/); assert.match(msg, /QAB2222222/);
  assert.doesNotMatch(msg, /Mary/, 'the STK payer is not announced');
});

test('server: a direct Till payment stays direct (UNLINKED) and an STK payment is listed as STK, whichever message came first', async () => {
  const sv = await server();
  const list = async () => (await (await sv.fetchStub('/api/till-payments?limit=50')).json()).payments;
  await sv.till('QAD0000001', 300, 'Direct', 'Payer', '254700000001');
  await sv.till('QAS0000002', 400, 'Stk', 'Payer', '254700000002');                  // Till message first ...
  await sv.stkDone('ws_CO_7', 'QAS0000002', 400, '254700000002');                    // ... then the STK result
  await sv.stkDone('ws_CO_8', 'QAS0000003', 450, '254700000003');                    // STK result first ...
  await sv.till('QAS0000003', 450, 'Other', 'Stk', '254700000003');                  // ... then the Till message
  const by = Object.fromEntries((await list()).map((r) => [r.code, r]));
  assert.equal(by.QAD0000001.status, 'UNLINKED'); assert.equal(by.QAD0000001.source, 'direct'); assert.equal(by.QAD0000001.name, 'Direct Payer');
  assert.equal(by.QAS0000002.status, 'STK'); assert.equal(by.QAS0000002.source, 'stk'); assert.equal(by.QAS0000002.name, 'Stk Payer', 'the STK payment keeps the payer name from the Till message');
  assert.equal(by.QAS0000003.status, 'STK'); assert.equal(by.QAS0000003.source, 'stk');
});
