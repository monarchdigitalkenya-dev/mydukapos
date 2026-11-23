// zip 328 (prompt 8): customers, bills and contracts across devices - offline, retries, concurrent creation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, openingStock: { qty: 100, costPrice: 50, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'A' },
];
const PRINTER = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const settled = (d) => until(() => !d.w.eval('window.__pushQueued') && !(d.w.eval('window.__pushInFlight') > 0));
const J = (d, code) => JSON.parse(d.w.eval(`JSON.stringify(${code})`));
const qty = (d) => d.w.eval("inventory.find(p => p.code === 'A').qty");
const mk = async (s, extra, w = 900) => { const d = await openDevice('index.html', s, extra, w, { indexedDB: new IDBFactory() }); d.w.eval(PRINTER); return d; };
const pull = async (d) => { await d.w.eval('pullState()'); await sleep(400); };
const push = async (d) => { await d.w.eval('pushNow()'); await settled(d); await sleep(200); };
const offline = (d, off) => d.w.eval(`Object.defineProperty(navigator,'onLine',{value:${!off},configurable:true})`);
const seed = { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' };

test('23. a customer created offline reaches the server and the other device after reconnecting - once', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  offline(a, true);
  a.w.eval(`upsertCustomer({ name: 'Jane Wanjiru', phone: '0712345678', idNumber: '12345678' }, {}); queuePush()`);
  assert.equal((s.serverState().customers || []).length, 0, 'not on the server while offline');
  offline(a, false); await push(a); await pull(b);
  assert.equal(s.serverState().customers.length, 1); assert.equal(J(b, 'custActive().length'), 1);
  assert.equal(J(b, 'customers[0].idNumber'), '12345678');
  await push(a); assert.equal(s.serverState().customers.length, 1, 'a second push adds nothing');
  a.close(); b.close();
});

test('24. a bill created on one device is on the other with its customer, and the customer profile lists it', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  a.w.eval("addToCart('A'); currentPaymentMethod = 'bill'");
  a.d.getElementById('bill-customer-name-input').value = 'Jane Wanjiru'; a.d.getElementById('sms-checkout-phone-input').value = '0712345678';
  await a.w.eval('checkoutCart()'); await push(a); await pull(b);
  assert.equal(J(b, 'bills.length'), 1); assert.equal(J(b, 'bills[0].customerName'), 'Jane Wanjiru');
  assert.equal(J(b, 'custActive().length'), 1); assert.equal(J(b, 'bills[0].customerId'), J(b, 'customers[0].id'));
  assert.equal(J(b, 'customerTransactions(customers[0], { limit: 20 }).items.map(x => x.kind)').join(), 'bill');
  a.close(); b.close();
});

test('25. a contract issued on A, and its stock movement, reach B and the server once; the stock is reduced once everywhere', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  const r = J(a, `contractIssue({ opId: 'op-s1', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 7 }] })`); assert.ok(r.ok, r.error);
  await push(a); await pull(b); await push(a); await pull(b);
  assert.equal(J(b, 'contracts.length'), 1); assert.equal(J(b, 'contracts[0].visits[0].opId'), 'op-s1'); assert.equal(J(b, 'contracts[0].items.A.qtyCarried'), 7);
  assert.equal(s.serverState().inventory.find((p) => p.code === 'A').qty, 93, 'server stock = 100 - 7, once');
  assert.equal(qty(a), 93); assert.equal(qty(b), 93);
  assert.equal(s.serverState().stockMovementLog.filter((m) => m.contractOp === 'op-s1').length, 1);
  a.close(); b.close();
});

test('26. the same person created on two devices at once is ONE customer; pushing / retrying again adds no duplicates', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  offline(a, true); offline(b, true);
  a.w.eval(`upsertCustomer({ name: 'Jane Wanjiru', phone: '0712345678' }, {}); queuePush()`);
  b.w.eval(`upsertCustomer({ name: 'Jane W', phone: '+254 712 345 678', idNumber: '12345678' }, {}); queuePush()`);
  offline(a, false); offline(b, false);
  await push(a); await push(b); await pull(a); await pull(b); await push(a); await push(b); await push(a); await pull(b);
  assert.equal(s.serverState().customers.filter((c) => !c._deleted).length, 1, 'one record on the server');
  for (const d of [a, b]) assert.equal(J(d, 'custActive().length'), 1);
  // two contracts for the same person made at the same moment on both devices keep BOTH issues and deduct both
  offline(a, true); offline(b, true);
  a.w.eval(`contractIssue({ opId: 'op-a', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 2 }] })`);
  b.w.eval(`contractIssue({ opId: 'op-b', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 3 }] })`);
  offline(a, false); offline(b, false);
  await push(a); await push(b); await pull(a); await pull(b); await push(a); await push(b); await pull(a); await pull(b);
  const srv = s.serverState();
  const mine = srv.contracts.filter((c) => c.phone && c.phone.endsWith('722000111'));
  const opIds = mine.flatMap((c) => c.visits.map((v) => v.opId)).sort();
  assert.deepEqual(opIds, ['op-a', 'op-b'], 'both issues survive the merge, exactly once each');
  assert.equal(srv.inventory.find((p) => p.code === 'A').qty, 95, 'both deductions applied once: 100 - 2 - 3');
  assert.equal(J(a, 'custActive().filter(c => /Otieno/.test(c.name)).length'), 1, 'one profile for the contract recipient');
  a.close(); b.close();
});

test('27. existing features keep working: a normal sale reduces stock, appears in the daily report totals and prints a receipt', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed);
  a.w.eval("addToCart('A'); addToCart('A'); currentPaymentMethod = 'cash'"); a.d.getElementById('cash-tendered-input').value = '500';
  await a.w.eval('checkoutCart()');
  assert.equal(qty(a), 98); assert.equal(J(a, 'salesLog.length'), 1); assert.equal(J(a, 'salesLog[0].cashAmount'), 200);
  assert.match(a.d.getElementById('receipt-body').textContent, /Alpha/);
  await push(a); assert.equal(s.serverState().salesLog.length, 1);
  a.w.eval('renderDailySales()');
  assert.match(a.d.body.textContent, /200/);
  a.close();
});

test('26b. two devices add issues to the SAME contract at the same time: both issues survive and the carried total is derived from them', async () => {
  const s = makeServer({ d1: true });
  const a = await mk(s, seed); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  const r = J(a, `contractIssue({ opId: 'op-0', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 1 }] })`); assert.ok(r.ok, r.error);
  await push(a); await pull(b);
  const cid = J(b, 'contracts[0].id'); assert.equal(J(b, 'contracts.length'), 1);
  offline(a, true); offline(b, true);
  assert.ok(J(a, `contractIssue({ opId: 'op-a', contractId: '${cid}', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 2 }] })`).ok);
  assert.ok(J(b, `contractIssue({ opId: 'op-b', contractId: '${cid}', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 3 }] })`).ok);
  offline(a, false); offline(b, false);
  await push(a); await push(b); await pull(a); await pull(b); await push(a); await push(b); await pull(a); await pull(b);
  const srv = s.serverState(); const c = srv.contracts.find((x) => x.id === cid);
  assert.deepEqual(c.visits.map((v) => v.opId).sort(), ['op-0', 'op-a', 'op-b']);
  assert.equal(c.items.A.qtyCarried, 6, '1 + 2 + 3');
  assert.equal(srv.inventory.find((p) => p.code === 'A').qty, 94);
  for (const d of [a, b]) { assert.equal(J(d, `contracts.find(c => c.id === '${cid}').visits.length`), 3); assert.equal(qty(d), 94); }
  a.close(); b.close();
});
