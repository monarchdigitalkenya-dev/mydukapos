import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { recordPush } from '../functions/api/_ledger.js';

// Zip 153 — the QR ordering state machine on REAL SQL (node:sqlite behind a D1-shaped fake): atomic claim, cancel, exchange, guest payments,
// cashier confirmation against a real sale, settle, release / session rotation. (Master prompt §QR tests, §payments tests.)
const mod = await import(pathToFileURL(path.join(ROOT, 'functions/api/qr-order.js')).href);
const call = async (env, body, by) => { const r = await mod.onRequestPost({ request: new Request('https://x.pages.dev/api/qr-order?c=C1', { method: 'POST', body: JSON.stringify({ by, ...body }) }), env }); return { status: r.status, d: await r.json() }; };
const get = async (env, q) => { const r = await mod.onRequestGet({ request: new Request(`https://x.pages.dev/api/qr-order?c=C1&${q}`), env }); return { status: r.status, d: await r.json() }; };
const MENU = { business: 'Lake View', payment: { mpesa: true, cash: true, tillNumber: '123456', accountName: 'LAKE VIEW' }, items: [
  { code: 'BRG', name: 'Beef Burger', price: 650, station: 'kitchen' }, { code: 'TSK', name: 'Tusker Lager', price: 300, station: 'bar' }, { code: 'FNT', name: 'Fanta', price: 100, station: 'bar' }] };
async function shop() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  await call(env, { action: 'publishMenu', menu: MENU });
  const t = (await call(env, { action: 'create', kind: 'table', label: 'Table 7' })).d.code;
  const r = (await call(env, { action: 'create', kind: 'room', label: 'Room 101' })).d.code;
  return { env, t, r };
}
let n = 0;
const order = async (env, token, items, name = 'Mary') => (await call(env, { action: 'order', t: token, key: 'key-' + (++n) + '-abcdefgh', name, items })).d;
const sale = (id, total, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: total, paid: true, servedBy: 'Cashier', items: [{ code: 'BRG', name: 'Beef Burger', qty: 1, price: total }], ...extra });
const q = (env, sql, ...a) => env.LEDGER_DB.query(sql, ...a);

test('each table / room has a stable id and its own code; ensure() is idempotent and rename keeps the same code', async () => {
  const { env, t } = await shop();
  const a = (await call(env, { action: 'ensure', kind: 'table', labels: ['Table 1', 'Table 2', 'Table 7'] })).d.codes;
  const b = (await call(env, { action: 'ensure', kind: 'table', labels: ['Table 1', 'Table 2', 'Table 7'] })).d.codes;
  assert.deepEqual(a.map((c) => c.token), b.map((c) => c.token));
  assert.equal(new Set(a.map((c) => c.locId)).size, 3);
  assert.equal(a.find((c) => c.label === 'Table 7').token, t.token, 'a table that already has a code keeps it');
  const rn = await call(env, { action: 'rename', kind: 'table', label: 'Table 1', newLabel: 'Patio 1' });
  assert.equal(rn.d.code.token, a.find((c) => c.label === 'Table 1').token);
  assert.equal(rn.d.code.locId, a.find((c) => c.label === 'Table 1').locId);
  assert.equal((await get(env, `t=${rn.d.code.token}`)).d.location.label, 'Patio 1');
});

test('CONCURRENT CLAIM: two waiters at once — exactly one owns it, the other is told who', async () => {
  const { env, t } = await shop();
  const o = await order(env, t.token, [{ code: 'BRG', qty: 1 }]);
  const [a, b] = await Promise.all([call(env, { action: 'claim', orderId: o.orderId }, 'Alice'), call(env, { action: 'claim', orderId: o.orderId }, 'Bob')]);
  const won = [a, b].filter((x) => x.status === 200), lost = [a, b].filter((x) => x.status === 409);
  assert.equal(won.length, 1); assert.equal(lost.length, 1);
  assert.match(lost[0].d.message, /Already claimed by (Alice|Bob)/);
  assert.equal(q(env, `select count(*) n from qr_order_events where event = 'CLAIMED'`)[0].n, 1, 'one CLAIMED event, no duplicate');
  const owner = won[0].d.order.owner, other = owner === 'Alice' ? 'Bob' : 'Alice';
  // only the owner prints the bill
  const no = await call(env, { action: 'billPrinted', orderId: o.orderId }, other);
  assert.equal(no.status, 403); assert.equal(no.d.code, 'not_owner');
  const yes = await call(env, { action: 'billPrinted', orderId: o.orderId }, owner);
  assert.equal(yes.d.order.status, 'BILLED');
});

test('cancel: a guest cancels at once before claim; after claim it is a REQUEST the owner approves; after paid it is refused', async () => {
  const { env, t } = await shop();
  const o1 = await order(env, t.token, [{ code: 'BRG', qty: 1 }]);
  const c1 = await call(env, { action: 'cancel', t: t.token, orderId: o1.orderId, key: 'cx-000000001' });
  assert.equal(c1.d.order.status, 'CANCELLED');
  assert.equal((await call(env, { action: 'claim', orderId: o1.orderId }, 'Alice')).status, 409, 'a cancelled order cannot be claimed');
  const o2 = await order(env, t.token, [{ code: 'TSK', qty: 2 }]);
  await call(env, { action: 'claim', orderId: o2.orderId }, 'Alice');
  const c2 = await call(env, { action: 'cancel', t: t.token, orderId: o2.orderId, key: 'cx-000000002' });
  assert.equal(c2.d.requested, true); assert.equal(c2.d.order.status, 'CLAIMED', 'not cancelled until staff agree');
  const pend = (await call(env, { action: 'pending' }, 'Alice')).d;
  assert.equal(pend.requests.length, 1);
  assert.equal((await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Bob')).status, 403, 'only the owner decides');
  const ok = await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Alice');
  assert.equal(ok.d.order.status, 'CANCELLED');
  assert.equal((await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Alice')).status, 409, 'a request is decided once');
  const o3 = await order(env, t.token, [{ code: 'BRG', qty: 1 }]);
  await call(env, { action: 'claim', orderId: o3.orderId }, 'Alice');
  await recordPush(env, 'C1', { salesLog: [sale('s3', 650)] });
  await call(env, { action: 'settle', orderIds: [o3.orderId], saleId: 's3' }, 'Alice');
  const late = await call(env, { action: 'cancel', t: t.token, orderId: o3.orderId, key: 'cx-000000003' });
  assert.equal(late.status, 409); assert.match(late.d.error, /paid/);
});

test('exchange: free before claim; after claim a request that swaps the line and re-prices the order', async () => {
  const { env, t } = await shop();
  const o = await order(env, t.token, [{ code: 'FNT', qty: 2 }]);
  const x = await call(env, { action: 'exchange', t: t.token, orderId: o.orderId, line: 0, toCode: 'TSK', key: 'ex-000000001' });
  assert.equal(x.d.order.total, 600, 'swapped before the staff saw it');
  await call(env, { action: 'claim', orderId: o.orderId }, 'Alice');
  const y = await call(env, { action: 'exchange', t: t.token, orderId: o.orderId, line: 1, toCode: 'BRG', key: 'ex-000000002' });
  assert.equal(y.d.requested, true); assert.equal(y.d.order.total, 600);
  const rq = (await call(env, { action: 'pending' }, 'Alice')).d.requests[0];
  const ap = await call(env, { action: 'decideRequest', reqId: rq.id, approve: true }, 'Alice');
  assert.equal(ap.d.order.total, 1300);
  assert.deepEqual(ap.d.order.items.filter((i) => !i.removed).map((i) => i.code), ['BRG']);
});

test('PAYMENTS: cash / M-Pesa only, the code is optional and never proof, duplicates are one, the cashier confirms against a real sale', async () => {
  const { env, t } = await shop();
  const o = await order(env, t.token, [{ code: 'BRG', qty: 2 }]);      // 1300
  await call(env, { action: 'claim', orderId: o.orderId }, 'Alice');
  assert.equal((await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'card', key: 'pay-00000001' })).status, 400, 'no card');
  assert.equal((await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'mpesa', mpesaCode: 'BAD', key: 'pay-00000002' })).d.code, 'bad_code');
  const p1 = await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'mpesa', amount: 500, key: 'pay-00000003' });     // no code: allowed
  assert.equal(p1.status, 200);
  const dup = await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'mpesa', amount: 500, key: 'pay-00000003' });
  assert.equal(dup.d.repeated, true);
  assert.equal(q(env, `select count(*) n from qr_order_payments`)[0].n, 1, 'a double tap is ONE payment note');
  assert.equal((await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'cash', amount: 900, key: 'pay-00000004' })).status, 400, 'more than is unclaimed is refused');
  const p2 = await call(env, { action: 'pay', t: t.token, orderId: o.orderId, method: 'mpesa', mpesaCode: 'QGH7XY2LMN', key: 'pay-00000005' });
  assert.equal(p2.status, 200);
  const st = (await get(env, `t=${t.token}&o=${o.orderId}`)).d.order;
  assert.equal(st.paid, 0, 'nothing is PAID because a guest typed something'); assert.equal(st.pendingPay, 1300);
  const pays = (await call(env, { action: 'pending' }, 'Cass')).d.payments;
  assert.equal(pays.length, 2);
  // confirming without a real sale in the ledger waits — nothing is marked paid
  const early = await call(env, { action: 'confirmPayment', payId: pays[0].id, saleId: 'nosale' }, 'Cass');
  assert.equal(early.status, 202); assert.equal(early.d.code, 'sale_not_in_ledger');
  // the cashier takes 500 (a part payment sale) → confirm; two tills pressing at once → still ONE confirmation
  await recordPush(env, 'C1', { salesLog: [sale('part1', 500, { paymentMethod: 'mpesa', cashAmount: 0, mpesaAmount: 500 })] });
  const [c1, c2] = await Promise.all([call(env, { action: 'confirmPayment', payId: pays[0].id, saleId: 'part1' }, 'Cass'), call(env, { action: 'confirmPayment', payId: pays[0].id, saleId: 'part1' }, 'Dan')]);
  assert.deepEqual([c1.status, c2.status], [200, 200]);
  assert.equal(q(env, `select count(*) n from qr_order_events where event = 'PAYMENT_CONFIRMED'`)[0].n, 1);
  const mid = (await get(env, `t=${t.token}&o=${o.orderId}`)).d.order;
  assert.equal(mid.paid, 500); assert.equal(mid.outstanding, 800); assert.notEqual(mid.status, 'PAID', 'partial payment keeps the outstanding balance');
  // the same sale cannot be used to confirm more than it paid
  const tooBig = await call(env, { action: 'confirmPayment', payId: pays[1].id, saleId: 'part1' }, 'Cass');
  assert.equal(tooBig.status, 409); assert.equal(tooBig.d.code, 'sale_too_small');
  await recordPush(env, 'C1', { salesLog: [sale('part2', 800, { paymentMethod: 'mpesa', cashAmount: 0, mpesaAmount: 800, mpesaReceiptNumber: 'QGH7XY2LMN' })] });
  const fin = await call(env, { action: 'confirmPayment', payId: pays[1].id, saleId: 'part2' }, 'Cass');
  assert.equal(fin.d.order.status, 'PAID'); assert.equal(fin.d.order.outstanding, 0);
});

test('a bill settled at the till (no guest payment note) marks the order PAID; the table is then released with a NEW session', async () => {
  const { env, t } = await shop();
  const s0 = q(env, `select session_id from qr_locations where loc_id = ?`, t.locId)[0].session_id;
  const o = await order(env, t.token, [{ code: 'BRG', qty: 1 }]);
  await call(env, { action: 'claim', orderId: o.orderId }, 'Alice');
  await call(env, { action: 'link', orderId: o.orderId, billNo: 'BILL-00000101', tabId: 'tab1', tabLabel: 'Table 7' }, 'Alice');
  assert.equal((await call(env, { action: 'release', kind: 'table', label: 'Table 7' }, 'Alice')).d.code, 'open_orders', 'not while an order is unpaid');
  assert.equal((await call(env, { action: 'settle', orderIds: [o.orderId], saleId: 'nope' }, 'Alice')).status, 202, 'no sale in the ledger yet: wait');
  await recordPush(env, 'C1', { salesLog: [sale('till1', 650, { billNo: 'BILL-00000101' })] });
  assert.equal((await call(env, { action: 'settle', orderIds: [o.orderId], saleId: 'till1' }, 'Alice')).d.settled, 1);
  await call(env, { action: 'settle', orderIds: [o.orderId], saleId: 'till1' }, 'Alice');
  assert.equal(q(env, `select count(*) n from qr_order_events where event = 'SETTLED_AT_TILL'`)[0].n, 1, 'settled once');
  const rel = await call(env, { action: 'release', kind: 'table', label: 'Table 7' }, 'Alice');
  assert.equal(rel.d.ok, true);
  assert.notEqual(q(env, `select session_id from qr_locations where loc_id = ?`, t.locId)[0].session_id, s0, 'a new session: nothing carries over');
  // the old guest's page no longer sees the old order as this table's live order
  const fresh = await order(env, t.token, [{ code: 'TSK', qty: 1 }], 'Next guest');
  assert.notEqual(fresh.orderId, o.orderId);
  assert.equal(q(env, `select count(*) n from qr_orders where session_id = ?`, s0)[0].n, 1);
});

test('a ROOM works the same way, and one room / table code never reaches another place\'s orders', async () => {
  const { env, t, r } = await shop();
  const ot = await order(env, t.token, [{ code: 'BRG', qty: 1 }]);
  const or = await order(env, r.token, [{ code: 'TSK', qty: 1 }], 'Room guest');
  await call(env, { action: 'claim', orderId: or.orderId }, 'Alice');
  assert.equal((await get(env, `t=${r.token}&o=${ot.orderId}`)).status, 404, 'the room code cannot read the table\'s order');
  assert.equal((await call(env, { action: 'cancel', t: r.token, orderId: ot.orderId, key: 'cx-100000001' })).status, 404);
  const pend = (await call(env, { action: 'pending' }, 'Alice')).d.orders;
  assert.deepEqual(pend.map((o) => o.label).sort(), ['Room 101', 'Table 7']);
  assert.equal(pend.find((o) => o.label === 'Room 101').kind, 'room');
});

test('DOUBLE / CONCURRENT SETTLEMENT: two tills settle the same bill — one counts, the other is kept as a DUPLICATE and reported', async () => {
  const { env } = await shop();
  const T0 = new Date().toISOString();
  const full = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: T0, paymentMethod: 'cash', cashAmount: 1000, paid: true, servedBy: 'T-' + id, tabId: 'tabX', billNo: 'BILL-00000777', tabOrderCount: 2, items: [{ code: 'BRG', name: 'Burger', qty: 1, price: 1000 }], ...extra });
  const [a, b] = await Promise.all([recordPush(env, 'C1', { salesLog: [full('sA')] }), recordPush(env, 'C1', { salesLog: [full('sB')] })]);
  const rows = q(env, `select sale_id, status from ledger_sales order by sale_id`);
  assert.equal(rows.filter((r) => r.status === 'COMPLETED').length, 1, 'exactly one settlement counts');
  assert.equal(rows.filter((r) => r.status === 'DUPLICATE').length, 1);
  assert.equal((a.duplicates || []).length + (b.duplicates || []).length, 1, 'the losing till is told');
  assert.equal(q(env, `select count(*) n from ledger_payments where status = 'CONFIRMED'`)[0].n, 1, 'money counted once');
  // pushing the same sales again changes nothing (no flip-flop, no audit noise)
  const before = q(env, 'select count(*) n from ledger_audit')[0].n;
  await recordPush(env, 'C1', { salesLog: [full('sA'), full('sB')] });
  assert.equal(q(env, 'select count(*) n from ledger_audit')[0].n, before);
  assert.deepEqual(q(env, `select status from ledger_sales order by sale_id`).map((r) => r.status).sort(), ['COMPLETED', 'DUPLICATE']);
  // a PART payment is never a duplicate
  await recordPush(env, 'C1', { salesLog: [full('sP1', { partOfTab: 'tabY', tabId: 'tabY', billNo: 'BILL-9', tabOrderCount: undefined }), full('sP2', { partOfTab: 'tabY', tabId: 'tabY', billNo: 'BILL-9', tabOrderCount: undefined })] });
  assert.equal(q(env, `select count(*) n from ledger_sales where bill_id = 'BILL-9' and status = 'COMPLETED'`)[0].n, 2);
  const { reconcile } = await import('../functions/api/_ledger.js');
  assert.equal((await reconcile(env.LEDGER_DB, 'C1')).duplicateSettlements.length, 1, 'the report flags it');
});
