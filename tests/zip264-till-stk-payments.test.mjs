import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// Zip 264 - payments confirmed through an STK push are listed under Sales Counter -> Till (a record, with the payer's phone), beside the direct ones.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const ORIGIN = 'https://shop-c1.mydukapos.store';
async function world() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  const cb = await load('functions/api/mpesa-callback.js');
  const tp = await load('functions/api/till-payments.js');
  const store = await load('functions/api/_till-store.js');
  const key = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'stk')).k;
  kv.data.set('mpesa-tx:C1:ws_CO_1', { value: JSON.stringify({ provider: 'daraja', status: 'pending', phone: '254712345678', amount: 100, createdAt: Date.now() }) });
  const result = (extra = []) => ({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [ { Name: 'Amount', Value: 100 }, { Name: 'MpesaReceiptNumber', Value: 'TJA1B2C3D4' }, { Name: 'TransactionDate', Value: 20261011100000 }, { Name: 'PhoneNumber', Value: 254712345678 }, ...extra ] } } } });
  const callback = (b = result()) => cb.onRequestPost({ request: new Request(`${ORIGIN}/api/pay-cb-stk?c=C1&k=${key}`, { method: 'POST', body: JSON.stringify(b) }), env });
  const get = (qs = '') => tp.onRequestGet({ request: new Request(`${ORIGIN}/api/till-payments?c=C1${qs}`), env }).then((r) => r.json());
  return { env, store, callback, get };
}

test('a successful STK push is listed once, with the phone, and is not counted as waiting', async () => {
  const w = await world();
  await w.callback(); await w.callback();                       // Safaricom retry
  const stk = await w.get('&status=STK');
  assert.equal(stk.payments.length, 1);
  const p = stk.payments[0];
  assert.equal(p.status, 'STK'); assert.equal(p.code, 'TJA1B2C3D4'); assert.equal(p.amount, 100); assert.equal(p.phoneHint, '254712345678'); assert.equal(p.paidAt, Date.UTC(2026, 9, 11, 7, 0, 0));
  assert.equal((await w.get('&status=UNLINKED')).payments.length, 0, 'not in the waiting list, so no badge');
  assert.equal((await w.get()).payments.length, 1, 'the full list shows it');
});

test('a payment confirmed by the status query first (no receipt) is replaced by the real receipt, not duplicated', async () => {
  const w = await world();
  await w.store.noteStkPayment(w.env, 'C1', { checkoutId: 'ws_CO_1', receipt: '', amount: 100, phone: '254712345678', provider: 'daraja' });
  let rows = (await w.get('&status=STK')).payments;
  assert.equal(rows.length, 1); assert.match(rows[0].code, /^W/);
  await w.callback();
  rows = (await w.get('&status=STK')).payments;
  assert.equal(rows.length, 1); assert.equal(rows[0].code, 'TJA1B2C3D4');
});

test('an STK row can never be applied to a sale or bill', async () => {
  const w = await world();
  await w.callback();
  const db = w.env.LEDGER_DB;
  const r = await w.store.applyTill(db, 'C1', 'TJA1B2C3D4', { type: 'sale', id: 'S1', label: 'x', by: 'a' });
  assert.equal(r.ok, false);
});
