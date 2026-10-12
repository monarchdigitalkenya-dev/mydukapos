import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// Zip 259 — Till Payments: callback storage (idempotent, minimal), newest-first list, apply-once linking, release, retention, access.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const ORIGIN = 'https://shop-c1.mydukapos.store';
async function world() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), ROOT_DOMAIN: 'mydukapos.store' };
  const cb = await load('functions/api/mpesa-c2b-confirmation.js');
  const tp = await load('functions/api/till-payments.js');
  const key = (await (await load('functions/api/_callback-key.js')).ensureCallbackKey(env, 'C1', 'c2b')).k;
  const post = (body, k = key) => cb.onRequestPost({ request: new Request(`${ORIGIN}/api/pay-cb-till-confirm?c=C1&k=${k}`, { method: 'POST', body: JSON.stringify(body) }), env });
  const get = (qs = '') => tp.onRequestGet({ request: new Request(`${ORIGIN}/api/till-payments?c=C1${qs}`), env }).then((r) => r.json());
  const act = (body) => tp.onRequestPost({ request: new Request(`${ORIGIN}/api/till-payments?c=C1`, { method: 'POST', body: JSON.stringify(body) }), env }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  return { kv, env, post, get, act };
}
const pay = (id, amt, time, extra = {}) => ({ TransID: id, TransAmount: String(amt), TransTime: time, MSISDN: '254712345678', FirstName: 'Jane', LastName: 'Wanjiru', BillRefNumber: 'INV7', OrgAccountBalance: '99999.00', BusinessShortCode: '123456', ...extra });

test('callback stores one narrow row; a repeat is the same row; the raw body is not kept', async () => {
  const w = await world();
  await w.post(pay('QAB1000001', 500, '20261011100000'));
  await w.post(pay('QAB1000001', 500, '20261011100000'));        // Safaricom retry
  const rows = w.env.LEDGER_DB.query('select * from till_payments');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.status, 'UNLINKED'); assert.equal(r.amount, 500); assert.equal(r.name, 'Jane Wanjiru'); assert.equal(r.ref, 'INV7');
  assert.equal(r.paid_at, Date.UTC(2026, 9, 11, 7, 0, 0), 'TransTime is East Africa Time');
  assert.equal(r.phone_hint, '2547***678', 'only a masked hint of the phone');
  assert.ok(!JSON.stringify(r).includes('254712345678') && !JSON.stringify(r).includes('99999') && !JSON.stringify(r).includes('123456'), 'no full number, balance or shortcode');
  const kvRec = JSON.parse(w.kv.data.get('till-payment:C1:QAB1000001').value);
  assert.ok(!('phone' in kvRec) && !('orgBalance' in kvRec) && !('businessShortCode' in kvRec), 'the KV copy (read by mpesa-verify) is minimal too');
  assert.equal(kvRec.trusted, true);
});

test('v2 hashed MSISDN is never stored; an unsigned callback stores nothing in the list', async () => {
  const w = await world();
  await w.post(pay('QAB1000002', 100, '20261011100100', { MSISDN: 'a'.repeat(64) }));
  assert.equal(w.env.LEDGER_DB.query('select phone_hint from till_payments')[0].phone_hint, null);
  await w.post(pay('QAB1000003', 100, '20261011100200'), 'wrong-key');
  assert.equal(w.env.LEDGER_DB.query('select count(*) n from till_payments')[0].n, 1);
});

test('list is newest first (by Safaricom payment time), paged, and filterable', async () => {
  const w = await world();
  await w.post(pay('QAB0000001', 10, '20261011080000'));
  await w.post(pay('QAB0000003', 30, '20261011120000'));
  await w.post(pay('QAB0000002', 20, '20261011100000'));        // arrives late, older time
  const all = await w.get();
  assert.deepEqual(all.payments.map((p) => p.code), ['QAB0000003', 'QAB0000002', 'QAB0000001']);
  assert.equal(all.payments[0].name, 'Jane Wanjiru');
  const p1 = await w.get('&limit=2'); assert.equal(p1.payments.length, 2); assert.equal(p1.more, true);
  const p2 = await w.get('&limit=2&before=' + p1.next); assert.deepEqual(p2.payments.map((p) => p.code), ['QAB0000001']); assert.equal(p2.more, false);
  await w.act({ action: 'apply', code: 'QAB0000002', targetType: 'bill', targetId: 'B1', label: 'Jane' });
  assert.deepEqual((await w.get('&status=UNLINKED')).payments.map((p) => p.code), ['QAB0000003', 'QAB0000001']);
  assert.deepEqual((await w.get('&status=APPLIED')).payments.map((p) => p.code), ['QAB0000002']);
});

test('a payment can be applied once: same target is idempotent, another target is refused, concurrent presses have one winner', async () => {
  const w = await world();
  await w.post(pay('QAB2000001', 700, '20261011100000'));
  const a = await w.act({ action: 'apply', code: 'QAB2000001', targetType: 'bill', targetId: 'B1', label: 'Jane', by: 'Cashier' });
  assert.equal(a.status, 200); assert.equal(a.payment.status, 'APPLIED'); assert.equal(a.payment.targetId, 'B1'); assert.equal(a.payment.appliedBy, 'Cashier');
  const again = await w.act({ action: 'apply', code: 'QAB2000001', targetType: 'bill', targetId: 'B1' });
  assert.equal(again.status, 200); assert.equal(again.repeated, true);
  const other = await w.act({ action: 'apply', code: 'QAB2000001', targetType: 'bill', targetId: 'B2' });
  assert.equal(other.status, 409); assert.equal(other.code, 'already_applied'); assert.equal(other.payment.targetId, 'B1');
  await w.post(pay('QAB2000002', 50, '20261011110000'));
  const rs = await Promise.all(['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => w.act({ action: 'apply', code: 'QAB2000002', targetType: 'sale', targetId: id })));
  assert.equal(rs.filter((r) => r.status === 200 && !r.repeated).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(rs.filter((r) => r.status === 409).length, 4);
  // a callback repeat after applying does not reset it
  await w.post(pay('QAB2000001', 700, '20261011100000'));
  assert.equal(w.env.LEDGER_DB.query("select status from till_payments where code='QAB2000001'")[0].status, 'APPLIED');
});

test('release only undoes the same target; the code can then be applied elsewhere; unknown code is 404', async () => {
  const w = await world();
  await w.post(pay('QAB3000001', 300, '20261011100000'));
  await w.act({ action: 'apply', code: 'QAB3000001', targetType: 'bill', targetId: 'B1' });
  assert.equal((await w.act({ action: 'release', code: 'QAB3000001', targetType: 'bill', targetId: 'B9' })).status, 409, 'wrong target cannot release');
  assert.equal((await w.act({ action: 'release', code: 'QAB3000001', targetType: 'bill', targetId: 'B1' })).status, 200);
  assert.equal(w.env.LEDGER_DB.query('select count(*) n from mpesa_code_claims')[0].n, 0);
  assert.equal((await w.act({ action: 'apply', code: 'QAB3000001', targetType: 'bill', targetId: 'B2' })).status, 200);
  assert.equal((await w.act({ action: 'apply', code: 'NOPE00000X', targetType: 'bill', targetId: 'B2' })).status, 404);
  await w.post(pay('QAB3000002', 1, '20261011100000'));
  assert.equal((await w.act({ action: 'apply', code: 'QAB3000002', targetType: 'bogus', targetId: 'x' })).status, 400);
});

test('shares the M-PESA code claim with typed codes: a verified sale blocks apply; an applied code blocks a typed sale', async () => {
  const w = await world();
  const verify = await load('functions/api/mpesa-verify.js');
  const ver = (code, saleId, amount = 400) => verify.onRequestPost({ request: new Request(`${ORIGIN}/api/mpesa-verify?c=C1`, { method: 'POST', body: JSON.stringify({ code, amount, saleId }) }), env: w.env }).then((r) => r.json());
  await w.post(pay('QAB4000001', 400, '20261011100000'));
  assert.equal((await ver('QAB4000001', 'SALE-1')).status, 'verified');
  const row = (await w.get()).payments[0];
  assert.equal(row.status, 'APPLIED'); assert.equal(row.targetType, 'sale'); assert.equal(row.targetId, 'SALE-1');
  const x = await w.act({ action: 'apply', code: 'QAB4000001', targetType: 'bill', targetId: 'B1' });
  assert.equal(x.status, 409);
  await w.post(pay('QAB4000002', 400, '20261011100500'));
  assert.equal((await w.act({ action: 'apply', code: 'QAB4000002', targetType: 'bill', targetId: 'B1' })).status, 200);
  assert.equal((await ver('QAB4000002', 'SALE-2')).status, 'duplicate', 'a code applied to a bill cannot also pay a sale');
});

test('retention: old APPLIED rows are purged on a list call; UNLINKED rows and the ledger record stay', async () => {
  const w = await world();
  await w.post(pay('QAB5000001', 10, '20240101100000')); await w.post(pay('QAB5000002', 20, '20240101110000')); await w.post(pay('QAB5000003', 30, '20261011110000'));
  await w.act({ action: 'apply', code: 'QAB5000001', targetType: 'bill', targetId: 'B1' });
  w.env.LEDGER_DB.query("update till_payments set applied_at = 1 where code = 'QAB5000001'");   // linked long ago
  await w.get();
  const codes = w.env.LEDGER_DB.query('select code from till_payments order by code').map((r) => r.code);
  assert.deepEqual(codes, ['QAB5000002', 'QAB5000003'], 'old linked row purged; unlinked (even old) kept');
  assert.ok(w.env.LEDGER_DB.query("select count(*) n from ledger_gateway where code = 'QAB5000001'")[0].n === 1, 'the append-only gateway ledger still has the payment');
});

test('access: a shop link is required; when staff sessions are enforced an unsigned apply is refused', async () => {
  const w = await world();
  const tp = await load('functions/api/till-payments.js');
  const bad = await tp.onRequestGet({ request: new Request("https://x.pages.dev/api/till-payments?c=NOPE"), env: w.env });
  assert.equal(bad.status, 403);
  await w.post(pay('QAB6000001', 5, '20261011100000'));
  const sa = await load('functions/api/_staff-auth.js'); await sa.writeMode(w.env, 'C1', 'enforce');
  const r = await w.act({ action: 'apply', code: 'QAB6000001', targetType: 'bill', targetId: 'B1' });
  assert.equal(r.status, 401); assert.equal(w.env.LEDGER_DB.query("select status from till_payments")[0].status, 'UNLINKED');
  await sa.writeMode(w.env, 'C1', 'off');
});
