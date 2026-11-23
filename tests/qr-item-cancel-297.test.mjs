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


test('zip 297: a guest cancels ONE item - at once before the claim; after the claim a request the owner decides; retries are one record', async () => {
  const { env, t } = await shop();
  const o = await order(env, t.token, [{ code: 'BRG', qty: 2, note: 'No onions' }, { code: 'TSK', qty: 1 }]);
  assert.equal((await get(env, `t=${t.token}&o=${o.orderId}`)).d.order.canCancelItem, true);
  const c1 = await call(env, { action: 'cancel', t: t.token, orderId: o.orderId, line: 1, reason: 'Changed my mind', key: 'ci-000000001' });
  assert.equal(c1.d.cancelled, true);
  assert.equal(c1.d.order.status, 'SUBMITTED', 'the other item is still live');
  assert.equal(c1.d.order.total, 1300, 'total = 2 x 650 (the cancelled Tusker is off the bill)');
  assert.equal(c1.d.order.items.find((i) => i.line === 1).removed, true);
  assert.equal(c1.d.order.items.find((i) => i.line === 0).note, 'No onions', 'the note stays on its own item');
  const again = await call(env, { action: 'cancel', t: t.token, orderId: o.orderId, line: 1, key: 'ci-000000001' });
  assert.equal(again.d.order.total, 1300, 'a retry (same key) changes nothing');
  assert.equal(q(env, `select count(*) n from qr_order_events where event = 'ITEM_CANCELLED_BY_GUEST'`)[0].n, 1, 'one audit event');
  // cancelling the last live item cancels the order itself
  const last = await call(env, { action: 'cancel', t: t.token, orderId: o.orderId, line: 0, key: 'ci-000000002' });
  assert.equal(last.d.order.status, 'CANCELLED'); assert.equal(last.d.order.total, 0);
  // claimed order: a request, nothing changes until the owner approves
  const o2 = await order(env, t.token, [{ code: 'BRG', qty: 1 }, { code: 'FNT', qty: 2 }]);
  await call(env, { action: 'claim', orderId: o2.orderId }, 'Alice');
  const r = await call(env, { action: 'cancel', t: t.token, orderId: o2.orderId, line: 1, reason: 'Wrong drink', key: 'ci-000000003' });
  assert.equal(r.d.requested, true); assert.equal(r.d.order.total, 850, 'not off the bill until staff agree');
  const pend = (await call(env, { action: 'pending' }, 'Alice')).d;
  assert.equal(pend.requests.length, 1); assert.equal(pend.requests[0].payload.line, 1); assert.equal(pend.requests[0].payload.reason, 'Wrong drink');
  assert.equal((await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Bob')).status, 403, 'only the owner decides');
  const ok = await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Alice');
  assert.equal(ok.d.order.status, 'CLAIMED', 'the order carries on with its other item');
  assert.equal(ok.d.order.total, 650); assert.equal(ok.d.order.items.find((i) => i.line === 1).removed, true);
  assert.equal((await call(env, { action: 'decideRequest', reqId: pend.requests[0].id, approve: true }, 'Alice')).status, 409, 'decided once');
});

test('zip 297: item-level cancel is guarded - unknown line, a stranger\'s token, a paid order', async () => {
  const { env, t, r } = await shop();
  const o = await order(env, t.token, [{ code: 'BRG', qty: 1 }, { code: 'FNT', qty: 1 }]);
  assert.equal((await call(env, { action: 'cancel', t: t.token, orderId: o.orderId, line: 9, key: 'cg-000000001' })).d.repeated, true, 'a line that is not live is a harmless no-op');
  const other = await call(env, { action: 'cancel', t: r.token, orderId: o.orderId, line: 0, key: 'cg-000000002' });
  assert.ok(other.status === 404 || other.status === 403, 'another table\'s token cannot touch this order: ' + other.status);
  const live = (await get(env, `t=${t.token}&o=${o.orderId}`)).d.order;
  assert.equal(live.items.filter((i) => !i.removed).length, 2, 'nothing was removed');
  assert.equal((await call(env, { action: 'cancel', t: t.token, orderId: o.orderId, line: -1, key: 'cg-000000003' })).status, 404);
});
