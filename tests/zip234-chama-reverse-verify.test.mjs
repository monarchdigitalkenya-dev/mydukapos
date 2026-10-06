import test from 'node:test';
import assert from 'node:assert/strict';
import { safaricomCheck } from '../functions/api/_chama-a.js';
import { makeKV } from './kv-fake.mjs';
// zip 234 — is a pasted M-Pesa code real? Checked against Safaricom's own confirmation for the chama's till when one is connected.
const ctx = (kv) => ({ env: { mydukapos_kv: kv }, c: 'G1' });
test('V1: no till connected -> unavailable (a pasted message alone proves nothing)', async () => { assert.equal((await safaricomCheck(ctx(makeKV()), 'ABC1234567', 100000)).state, 'unavailable'); });
test('V2: Safaricom reported the code for the same amount -> confirmed (code case does not matter)', async () => {
  const kv = makeKV(); await kv.put('till-payment:G1:ABC1234567', JSON.stringify({ amount: 1000, customerName: 'JACINTA W', trusted: true })); await kv.put('till-payment-index:G1', '["ABC1234567"]');
  const r = await safaricomCheck(ctx(kv), 'abc1234567', 100000); assert.equal(r.state, 'confirmed'); assert.equal(r.name, 'JACINTA W');
});
test('V3: same code but another amount -> amount_differs; unknown code while a till IS connected -> not_found; another chama never matches', async () => {
  const kv = makeKV(); await kv.put('till-payment:G1:ABC1234567', JSON.stringify({ amount: 500, trusted: true })); await kv.put('till-payment-index:G1', '["ABC1234567"]');
  assert.equal((await safaricomCheck(ctx(kv), 'ABC1234567', 100000)).state, 'amount_differs');
  assert.equal((await safaricomCheck(ctx(kv), 'FAKE000000', 100000)).state, 'not_found');
  assert.equal((await safaricomCheck({ env: { mydukapos_kv: kv }, c: 'G2' }, 'ABC1234567', 50000)).state, 'unavailable', 'another chama sees nothing');
});
test('V4: a confirmation that was not signed with the chama key is never proof', async () => {
  const kv = makeKV(); await kv.put('till-payment:G1:ABC1234567', JSON.stringify({ amount: 1000, trusted: false })); await kv.put('till-payment-index:G1', '["X"]');
  assert.equal((await safaricomCheck(ctx(kv), 'ABC1234567', 100000)).state, 'not_found');
});
