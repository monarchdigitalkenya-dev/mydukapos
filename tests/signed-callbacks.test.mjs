import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 143 — payment callbacks carry a per-shop secret key. Before, anyone who knew a shop's id (it is visible to whoever opens the
// shop's link) could post a fake "payment received" and then have a made-up M-Pesa code accepted by /api/mpesa-verify.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const post = (url, body) => new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('C2B / KCB: a shop with no key yet (URLs registered before this release) works exactly as before', async () => {
  for (const [file, body, id] of [
    ['functions/api/mpesa-c2b-confirmation.js', { TransID: 'QAB12345', TransAmount: '500' }, 'QAB12345'],
    ['functions/api/kcb-ipn.js', { transactionReference: 'KCB12345', transactionAmount: '750' }, 'KCB12345'],
  ]) {
    const m = await load(file); const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };   // zip 185: callbacks for a shop id that has no licence are ignored
    await m.onRequestPost({ request: post('https://x/api/cb?c=C1', body), env });
    const rec = JSON.parse(await kv.get(`till-payment:C1:${id}`));
    assert.equal(rec.trusted, true, file);
  }
});

test('C2B: once the shop registers its URLs, a forged confirmation (no key / wrong key) is refused and cannot verify a code', async () => {
  const cb = await load('functions/api/_callback-key.js');
  const conf = await load('functions/api/mpesa-c2b-confirmation.js');
  const verifyMod = await load('functions/api/mpesa-verify.js');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };   // zip 185: callbacks for a shop id that has no licence are ignored
  const key = await cb.ensureCallbackKey(env, 'C1', 'c2b');               // what "Register Till URLs" does
  // forged: no key, then a wrong key
  await conf.onRequestPost({ request: post('https://x/api/mpesa-c2b-confirmation?c=C1', { TransID: 'FAKE1234', TransAmount: '9000' }), env });
  await conf.onRequestPost({ request: post('https://x/api/mpesa-c2b-confirmation?c=C1&k=' + '0'.repeat(32), { TransID: 'FAKE1234', TransAmount: '9000' }), env });
  assert.equal(await kv.get('till-payment:C1:FAKE1234'), null, 'not stored as a payment');
  assert.equal(await kv.get('till-payment-index:C1'), null, 'not listed');
  assert.ok(await kv.get('till-payment-rejected:C1:FAKE1234'), 'kept aside for the record');
  // the real one (Safaricom posts to the registered URL, key included) is stored — the forged attempt did not pre-empt it
  await conf.onRequestPost({ request: post(cb.withKey('https://x/api/mpesa-c2b-confirmation?c=C1', key), { TransID: 'REAL1234', TransAmount: '500' }), env });
  assert.equal(JSON.parse(await kv.get('till-payment:C1:REAL1234')).trusted, true);
  // mpesa-verify: the fake code is not proof; the real one is
  const license = { valid: true, clientId: 'C1' };
  kv.data.set('license:C1', { value: JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop-c1' }) });
  const ver = async (code) => {
    const req = post('https://shop-c1.mydukapos.store/api/mpesa-verify?c=C1', { code, amount: 500, saleId: 'S-' + code });
    const res = await verifyMod.onRequestPost({ request: req, env: { ...env, ROOT_DOMAIN: 'mydukapos.store' } });
    return res.json();
  };
  assert.notEqual((await ver('FAKE1234')).status, 'verified', 'a forged code never verifies');
  assert.equal((await ver('REAL1234')).status, 'verified');
  void license;
});

test('STK: a callback without the shop\'s key cannot mark a prompt paid; the real (keyed) callback does; an in-flight prompt from before the key existed still completes', async () => {
  const cb = await load('functions/api/_callback-key.js');
  const m = await load('functions/api/mpesa-callback.js');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };   // zip 185: callbacks for a shop id that has no licence are ignored
  const ok = (id, receipt) => ({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'Amount', Value: 100 }] } } } });
  // a prompt sent before the key existed
  await kv.put('mpesa-tx:C1:OLD', JSON.stringify({ status: 'pending', createdAt: Date.now() - 60000 }));
  const key = await cb.ensureCallbackKey(env, 'C1', 'stk');
  await kv.put('mpesa-tx:C1:NEW', JSON.stringify({ status: 'pending', createdAt: Date.now() + 1 }));
  await m.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', ok('NEW', 'QFORGED01')), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:NEW')).status, 'pending', 'forged: still pending');
  assert.equal(await kv.get('mpesa-receipt:C1:QFORGED01'), null);
  await m.onRequestPost({ request: post(cb.withKey('https://x/api/mpesa-callback?c=C1', key), ok('NEW', 'QREAL0001')), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:NEW')).status, 'success', 'real: paid');
  await m.onRequestPost({ request: post('https://x/api/mpesa-callback?c=C1', ok('OLD', 'QOLD00001')), env });
  assert.equal(JSON.parse(await kv.get('mpesa-tx:C1:OLD')).status, 'success', 'the prompt sent before the key existed still completes');
});
