import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeD1 } from './d1-fake.mjs';
import { recordPush, recordPayment, dailyTotals, reconcile, ensureLedgerSchema } from '../functions/api/_ledger.js';
import { migrationText } from '../tools/gen-migration.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 153 — the D1 ledger, run against a REAL SQL engine (node:sqlite behind a D1-shaped fake): constraints, triggers and batch
// transactions are the actual SQL, not mocks.
const env = () => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV() });
const T0 = Date.parse('2026-09-29T09:00:00+03:00');
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date(T0).toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 2, price: 500, wholesalePrice: 300 }], ...extra });
const q = (e, sql, ...a) => e.LEDGER_DB.query(sql, ...a);

test('the shipped migration file is exactly what the code creates (they cannot drift)', () => {
  assert.equal(fs.readFileSync(new URL('../migrations/0001_ledger.sql', import.meta.url), 'utf8'), migrationText());
});

test('a sale is written once: sale row, its lines and its payment — a repeated push adds nothing', async () => {
  const e = env();
  for (let i = 0; i < 3; i++) assert.equal((await recordPush(e, 'C1', { salesLog: [sale('s1')] })).ok, true);
  assert.equal(q(e, 'select count(*) n from ledger_sales')[0].n, 1);
  assert.equal(q(e, 'select count(*) n from ledger_sale_items')[0].n, 1);
  assert.equal(q(e, 'select count(*) n from ledger_payments')[0].n, 1);
  assert.equal(q(e, 'select count(*) n from ledger_audit')[0].n, 1, 'one CREATE in the audit, no noise from repeats');
  const s = q(e, 'select * from ledger_sales')[0];
  assert.deepEqual([s.total, s.cash_amount, s.business_date, s.status], [1000, 1000, '2026-09-29', 'COMPLETED']);
});

test('cash + M-Pesa split: two payments on the one sale; on-account sales record no payment', async () => {
  const e = env();
  await recordPush(e, 'C1', { salesLog: [
    sale('sp', { paymentMethod: 'split', cashAmount: 400, mpesaAmount: 600, mpesaReceiptNumber: 'QWE123', items: [{ code: 'A', qty: 1, price: 1000 }] }),
    sale('cr', { paymentMethod: 'tab', paid: false, cashAmount: 0 }),
  ] });
  const p = q(e, `select method, amount, mpesa_code from ledger_payments where sale_id = 'sp' order by method`);
  assert.deepEqual(p.map((x) => [x.method, x.amount, x.mpesa_code]), [['cash', 400, null], ['mpesa', 600, 'QWE123']]);
  assert.equal(q(e, `select count(*) n from ledger_payments where sale_id = 'cr'`)[0].n, 0);
  assert.equal(q(e, `select credit_amount from ledger_sales where sale_id = 'cr'`)[0].credit_amount, 1000);
  assert.deepEqual((await reconcile(e.LEDGER_DB, 'C1')).salesWithoutPayment, []);
});

test('a void moves the record forward (payment reversed, both versions audited); a stale older copy cannot undo it', async () => {
  const e = env();
  await recordPush(e, 'C1', { salesLog: [sale('v1', { updatedAt: 100 })] });
  await recordPush(e, 'C1', { salesLog: [sale('v1', { updatedAt: 200, voided: true })] });
  assert.equal(q(e, `select status from ledger_sales where sale_id='v1'`)[0].status, 'VOIDED');
  assert.equal(q(e, `select status from ledger_payments where sale_id='v1'`)[0].status, 'REVERSED');
  await recordPush(e, 'C1', { salesLog: [sale('v1', { updatedAt: 100 })] });   // an offline device re-sends the old version
  assert.equal(q(e, `select status from ledger_sales where sale_id='v1'`)[0].status, 'VOIDED', 'stale copy ignored');
  assert.deepEqual(q(e, `select action from ledger_audit where rec_id='v1' order by id`).map((x) => x.action), ['CREATE', 'UPDATE']);
  const d = await dailyTotals(e.LEDGER_DB, 'C1', '2026-09-29', '2026-09-29');
  assert.deepEqual(d.sales, [], 'a voided sale is not in the day\'s sales');
});

test('the database itself refuses to delete money records or edit the audit / a payment amount', async () => {
  const e = env();
  await recordPush(e, 'C1', { salesLog: [sale('d1')] });
  for (const sql of [`delete from ledger_sales`, `delete from ledger_payments`, `delete from ledger_records`, `delete from ledger_audit`, `update ledger_audit set amount = 1`, `update ledger_payments set amount = 1`])
    assert.throws(() => e.LEDGER_DB._db.exec(sql), /never deleted|append-only|cannot be edited/i, sql);
});

test('ONE record is ONE transaction: if its payment cannot be written, the sale is not written either', async () => {
  const e = env();
  await ensureLedgerSchema(e.LEDGER_DB);
  e.LEDGER_DB._state.failOnSql = /INTO ledger_payments/;
  const r = await recordPush(e, 'C1', { salesLog: [sale('t1')] });
  assert.equal(r.ok, false, 'the push is reported as failed (the till will resend)');
  for (const t of ['ledger_sales', 'ledger_sale_items', 'ledger_records', 'ledger_payments']) assert.equal(q(e, `select count(*) n from ${t}`)[0].n, 0, t + ' rolled back');
  e.LEDGER_DB._state.failOnSql = null;
  assert.equal((await recordPush(e, 'C1', { salesLog: [sale('t1')] })).ok, true, 'the resend succeeds');
  assert.equal(q(e, 'select count(*) n from ledger_sales')[0].n, 1);
});

test('shops are isolated: the same sale id in two shops is two rows, totals never mix', async () => {
  const e = env();
  await recordPush(e, 'A', { salesLog: [sale('x')] }); await recordPush(e, 'B', { salesLog: [sale('x', { cashAmount: 200, items: [{ code: 'A', qty: 1, price: 200 }] })] });
  assert.equal((await dailyTotals(e.LEDGER_DB, 'A', '2026-09-29', '2026-09-29')).sales[0].total, 1000);
  assert.equal((await dailyTotals(e.LEDGER_DB, 'B', '2026-09-29', '2026-09-29')).sales[0].total, 200);
});

test('a gateway payment is recorded once however often the provider calls; a D1 outage parks it and it is replayed', async () => {
  const e = env();
  const p = { paymentId: 'mpesa:QWE999', method: 'mpesa', amount: 750, code: 'QWE999', source: 'mpesa-callback', raw: { x: 1 } };
  await recordPayment(e, 'C1', p); await recordPayment(e, 'C1', p);
  assert.equal(q(e, `select count(*) n from ledger_payments`)[0].n, 1);
  e.LEDGER_DB._state.failNext = 5;
  const r = await recordPayment(e, 'C1', { ...p, paymentId: 'mpesa:LATER1', code: 'LATER1' });
  assert.equal(r.parked, true);
  assert.ok(e.mydukapos_kv.data.get('ledger-outbox:C1'));
  e.LEDGER_DB._state.failNext = 0;
  await recordPush(e, 'C1', { salesLog: [] });                                 // the next request drains it
  assert.equal(q(e, `select count(*) n from ledger_payments where payment_id='mpesa:LATER1'`)[0].n, 1);
  assert.equal(e.mydukapos_kv.data.get('ledger-outbox:C1'), undefined);
});

test('without a D1 binding the push is still accepted (degraded, flagged) — the till never loses a sale to a missing binding', async () => {
  const r = await recordPush({ mydukapos_kv: makeKV() }, 'C1', { salesLog: [sale('n1')] });
  assert.deepEqual([r.ok, r.skipped], [true, 'no_db']);
});
