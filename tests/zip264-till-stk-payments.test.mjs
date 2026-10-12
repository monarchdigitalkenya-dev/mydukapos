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

// ---- zip 265: the payer NAME comes from Safaricom's Till confirmation for the same payment ----
import { createHash } from 'node:crypto';
async function world2() {
  const w = await world();
  const c2b = await load('functions/api/mpesa-c2b-confirmation.js');
  const st = await load('functions/api/mpesa-status.js');
  const ck = await load('functions/api/_callback-key.js');
  const k2 = (await ck.ensureCallbackKey(w.env, 'C1', 'c2b')).k;
  const till = (id, amt, extra = {}) => c2b.onRequestPost({ request: new Request(`${ORIGIN}/api/pay-cb-till-confirm?c=C1&k=${k2}`, { method: 'POST', body: JSON.stringify({ TransID: id, TransAmount: String(amt), TransTime: '20261011100500', MSISDN: '254712345678', FirstName: 'Jane', LastName: 'Wanjiru', BillRefNumber: '', ...extra }) }), env: w.env });
  const status = (id = 'ws_CO_1') => st.onRequestGet({ request: new Request(`${ORIGIN}/api/mpesa-status?c=C1&checkoutRequestId=${id}`), env: w.env }).then((r) => r.json());
  return { ...w, till, status };
}

test('STK result first, Till confirmation second: the row gains the name, stays one STK row, and the till gets name + code', async () => {
  const w = await world2();
  await w.callback();
  await w.till('TJA1B2C3D4', 100);
  const rows = w.env.LEDGER_DB.query('select * from till_payments');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'STK'); assert.equal(rows[0].name, 'Jane Wanjiru');
  const s = await w.status();
  assert.equal(s.status, 'success'); assert.equal(s.receiptNumber, 'TJA1B2C3D4'); assert.equal(s.payerName, 'Jane Wanjiru');
});

test('Till confirmation first, STK result second: the waiting row becomes an STK row and keeps the name', async () => {
  const w = await world2();
  await w.till('TJA1B2C3D4', 100);
  assert.equal((await w.get('&status=UNLINKED')).payments.length, 1);
  await w.callback();
  assert.equal((await w.get('&status=UNLINKED')).payments.length, 0);
  const p = (await w.get('&status=STK')).payments[0];
  assert.equal(p.name, 'Jane Wanjiru'); assert.equal(p.phoneHint, '254712345678');
  assert.equal((await w.status()).payerName, 'Jane Wanjiru');
});

test('a direct Till payment stays a direct payment (never labelled STK)', async () => {
  const w = await world2();
  await w.till('QAB9999999', 250, { MSISDN: '254799999999' });
  const all = (await w.get()).payments;
  assert.equal(all.length, 1); assert.equal(all[0].status, 'UNLINKED'); assert.equal(all[0].name, 'Jane Wanjiru');
});

test('STK result lost: the Till confirmation with the same amount and phone supplies the code and name; a different phone or amount does not', async () => {
  for (const [msisdn, amt, adopted] of [['254712345678', 100, true], [createHash('sha256').update('254712345678').digest('hex'), 100, true], ['254799999999', 100, false], ['254712345678', 101, false]]) {
    const w = await world2();
    await w.store.noteStkPayment(w.env, 'C1', { checkoutId: 'ws_CO_1', receipt: '', amount: 100, phone: '254712345678', provider: 'daraja' });
    const rec = JSON.parse(w.env.mydukapos_kv.data.get('mpesa-tx:C1:ws_CO_1').value); rec.status = 'success'; rec.receiptNumber = ''; w.env.mydukapos_kv.data.set('mpesa-tx:C1:ws_CO_1', { value: JSON.stringify(rec) });
    await w.till('TJA1B2C3D4', amt, { MSISDN: msisdn });
    const rows = w.env.LEDGER_DB.query('select * from till_payments order by code');
    if (adopted) {
      assert.equal(rows.length, 1, msisdn); assert.equal(rows[0].code, 'TJA1B2C3D4'); assert.equal(rows[0].status, 'STK'); assert.equal(rows[0].name, 'Jane Wanjiru');
      const s = await w.status(); assert.equal(s.receiptNumber, 'TJA1B2C3D4'); assert.equal(s.payerName, 'Jane Wanjiru');
    } else { assert.equal(rows.length, 2, 'not guessed: ' + msisdn + '/' + amt); assert.equal((await w.status()).receiptNumber, ''); }
  }
});

test('two pending prompts of the same amount and phone: nothing is guessed', async () => {
  const w = await world2();
  await w.store.noteStkPayment(w.env, 'C1', { checkoutId: 'ws_CO_1', receipt: '', amount: 100, phone: '254712345678', provider: 'daraja' });
  await w.store.noteStkPayment(w.env, 'C1', { checkoutId: 'ws_CO_2', receipt: '', amount: 100, phone: '254712345678', provider: 'daraja' });
  await w.till('TJA1B2C3D4', 100);
  assert.equal(w.env.LEDGER_DB.query("select * from till_payments where status = 'STK'").length, 2);
  assert.equal(w.env.LEDGER_DB.query("select * from till_payments where status = 'UNLINKED'").length, 1);
});
