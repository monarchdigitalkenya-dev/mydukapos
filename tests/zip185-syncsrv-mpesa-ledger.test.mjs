import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { recordPush } from '../functions/api/_ledger.js';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

test('zip 185: one M-Pesa code can be claimed by ONE sale only (atomic in D1); the same sale re-verifying succeeds', async () => {
  const verify = await load('functions/api/mpesa-verify.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  await kv.put('till-payment:C1:ABCD123456', JSON.stringify({ amount: 500, trusted: true }));
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  const ver = async (saleId) => (await verify.onRequestPost({ request: new Request('https://shop-c1.mydukapos.store/api/mpesa-verify?c=C1', { method: 'POST', body: JSON.stringify({ code: 'ABCD123456', amount: 500, saleId }) }), env })).json();
  const rs = await Promise.all([ver('S-A'), ver('S-B'), ver('S-C')]);
  const winners = rs.filter((r) => r.status === 'verified');
  assert.equal(winners.length, 1, JSON.stringify(rs));
  assert.equal(rs.filter((r) => r.status === 'duplicate').length, 2);
  const owner = env.LEDGER_DB.query('select sale_id from mpesa_code_claims')[0].sale_id;
  assert.equal((await ver(owner)).status, 'verified', 'idempotent for the owner');
  assert.equal((await ver(owner === 'S-A' ? 'S-B' : 'S-A')).status, 'duplicate');
});

test('zip 185: without D1 the old KV logic still works', async () => {
  const verify = await load('functions/api/mpesa-verify.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  await kv.put('till-payment:C1:ABCD123456', JSON.stringify({ amount: 500, trusted: true }));
  const env = { mydukapos_kv: kv, ROOT_DOMAIN: 'mydukapos.store' };
  const ver = async (saleId) => (await verify.onRequestPost({ request: new Request('https://shop-c1.mydukapos.store/api/mpesa-verify?c=C1', { method: 'POST', body: JSON.stringify({ code: 'ABCD123456', amount: 500, saleId }) }), env })).json();
  assert.equal((await ver('S1')).status, 'verified');
  assert.equal((await ver('S1')).status, 'verified');
  assert.equal((await ver('S2')).status, 'duplicate');
});

const T0 = Date.parse('2026-09-29T09:00:00+03:00');
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date(T0).toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 2, price: 500 }], ...extra });
test('zip 185: an edited sale reverses its old payment row and records the new amount (no stale CONFIRMED figure)', async () => {
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const q = (s, ...a) => env.LEDGER_DB.query(s, ...a);
  const conf = () => q(`select method, amount from ledger_payments where status = 'CONFIRMED' order by method, amount`).map((x) => [x.method, x.amount]);
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 1000 })] });
  assert.deepEqual(conf(), [['cash', 1000]]);
  // edit: 1000 cash -> 600 cash + 400 mpesa
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 2000, paymentMethod: 'split', cashAmount: 600, mpesaAmount: 400, mpesaReceiptNumber: 'QWE12345' })] });
  assert.deepEqual(conf(), [['cash', 600], ['mpesa', 400]]);
  // the same edit again, and an older stale copy: nothing changes
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 2000, paymentMethod: 'split', cashAmount: 600, mpesaAmount: 400, mpesaReceiptNumber: 'QWE12345' })] });
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 1000 })] });
  assert.deepEqual(conf(), [['cash', 600], ['mpesa', 400]]);
  // edit back to the original: the original row is revived, the others reversed
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 3000 })] });
  assert.deepEqual(conf(), [['cash', 1000]]);
  // void: nothing confirmed any more; rows are kept (never deleted)
  await recordPush(env, 'C1', { salesLog: [sale('s1', { updatedAt: 4000, voided: true })] });
  assert.deepEqual(conf(), []);
  assert.ok(q('select count(*) n from ledger_payments')[0].n >= 3);
});

test('zip 185: parked gateway events are not all treated as duplicates of the first; the outbox cap keeps a count of what it dropped instead of dropping silently', async () => {
  const led = await load('functions/api/_ledger.js');
  const kv = makeKV(); const db = makeD1();
  const env = { mydukapos_kv: kv, LEDGER_DB: db };
  db._state.failOnSql = /ledger_gateway/;                        // D1 refuses: every webhook is parked in the outbox
  for (let i = 0; i < 503; i++) await led.recordGatewayTxn(env, 'C1', { txnId: 'T' + i, provider: 'mpesa', code: 'X' + i, amount: 1, status: 'RECEIVED', ts: Date.now(), trusted: 1 });
  assert.equal(JSON.parse(await kv.get('ledger-outbox:C1')).length, 500);
  assert.ok(Number(await kv.get('ledger-outbox:C1:dropped')) >= 3);
});
