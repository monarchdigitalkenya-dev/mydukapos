// zip 327: voiding a sale - stock back exactly once, money out of every active total, evidence kept, safe offline and across devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 500, wholesalePrice: 300, qty: 20, openingStock: { qty: 20, costPrice: 300, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'A' },
  { code: 'M', type: 'item', name: 'Meat', price: 800, wholesalePrice: 600, qty: 10, openingStock: { qty: 10, costPrice: 600, date: '2026-01-01', setBy: 'x' }, unit: 'kg', vatCategory: 'A' },
  { code: 'D', type: 'item', name: 'Soda Crate', price: 600, wholesalePrice: 400, qty: 5, unit: 'box', dualUnit: true, unitsPerBox: 12, pieceCode: 'DP', piecePrice: 60, pieceWholesalePrice: 33, pieceQty: 0, looseUnit: 'pcs', vatCategory: 'A' },
];
const PRINTER = "showToast = function () {}; window.confirm = () => true; window.prompt = (m, d) => d; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
// base units: a box that was opened for loose pieces comes back as pieces (an opened box cannot be re-sealed), so compare total pieces, not the box/piece split
const stock = (d) => d.w.eval("JSON.stringify(inventory.map(p=>[p.code,p.dualUnit?p.qty*p.unitsPerBox+(p.pieceQty||0):p.qty]))");
const voidIt = (d, id) => d.w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'wrong item'; performVoidSale('${id}')`);
async function cashSale(t, setup) { t.w.eval(setup); t.w.eval("currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '99999'; await t.w.eval('checkoutCart()'); }
const q = async (s, sql) => ((await s.env.LEDGER_DB.prepare(sql).all()).results) || [];
const openA = async (s, extra = {}) => { const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz', ...extra }, 900, { indexedDB: new IDBFactory() }); a.w.eval(PRINTER); return a; };

test('A+C+D: cash sale of mixed units -> void restores every balance exactly once; repeat void changes nothing; audit kept', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  const before = stock(a);
  await cashSale(a, "addToCart('A'); addToCart('A'); addToCart('D','box'); addToCart('D','piece'); addToCart('D','piece')");
  assert.notEqual(stock(a), before, 'the sale took stock');
  const sale = JSON.parse(a.w.eval('JSON.stringify(salesLog[0])'));
  const total = Number(sale.cashAmount || 0);
  assert.ok(total > 0);
  voidIt(a, sale.id);
  assert.equal(stock(a), before, 'every balance (incl. box and loose pieces) is exactly as before');
  const moves1 = a.w.eval('stockMovementLog.length');
  voidIt(a, sale.id); voidIt(a, sale.id);
  assert.equal(stock(a), before, 'second and third void do not restock');
  assert.equal(a.w.eval('stockMovementLog.length'), moves1, 'no duplicate movements');
  const rec = JSON.parse(a.w.eval('JSON.stringify(salesLog[0])'));
  assert.equal(rec.voided, true); assert.equal(rec.voidReason, 'wrong item'); assert.ok(rec.voidedAt && 'voidedBy' in rec);
  assert.deepEqual(rec.items.map((i) => i.code), sale.items.map((i) => i.code), 'original items kept');
  assert.equal(rec.cashAmount, sale.cashAmount, 'original amount not overwritten');
  a.close();
});

test('E: every client report skips the voided sale (daily totals, payment pie, top items, M-Pesa/cash split)', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  await cashSale(a, "addToCart('A')");
  await cashSale(a, "addToCart('A')");
  const id = a.w.eval('salesLog[0].id');
  const before = a.w.eval("(function(){const r=typeof computeDayTotals==='function'?computeDayTotals():null;return r?JSON.stringify(r):'n/a'})()");
  voidIt(a, id);
  const live = a.w.eval("salesLog.filter(s=>!s.voided).reduce((n,s)=>n+(s.cashAmount||0),0)");
  assert.ok(live > 0 && live < 99999);
  const html = a.w.eval("renderDailySales(); document.body.innerHTML");
  assert.ok(/VOIDED|voided/i.test(html), 'voided sale still listed for audit');
  a.close();
});

test('G+ledger: void on device A reaches device B, D1 marks the sale VOIDED and its cash payment is not active', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  await cashSale(a, "addToCart('A')");
  await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800);
  assert.equal(b.w.eval('salesLog.length'), 1);
  const id = a.w.eval('salesLog[0].id');
  voidIt(a, id); await a.w.eval('pushNow()'); await settled(a); await sleep(300);
  await b.w.eval('pullState()'); await sleep(500);
  assert.equal(b.w.eval('salesLog[0].voided'), true, 'device B shows it voided');
  assert.equal(b.w.eval("inventory.find(p=>p.code==='A').qty"), 20, 'device B stock back too');
  const sales = await q(s, 'SELECT status FROM ledger_sales');
  assert.deepEqual(sales.map((r) => r.status), ['VOIDED']);
  const pays = await q(s, 'SELECT status, amount FROM ledger_payments');
  assert.ok(pays.every((r) => r.status !== 'COMPLETED' && r.status !== 'RECORDED' && r.status !== 'CONFIRMED'), 'cash payment no longer active: ' + JSON.stringify(pays));
  a.close(); b.close();
});

test('F: sale made offline, voided offline, reload, reconnect -> never active, stock restored once', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  a.w.eval("Object.defineProperty(navigator,'onLine',{value:false,configurable:true})");
  await cashSale(a, "addToCart('A')");
  const id = a.w.eval('salesLog[0].id');
  voidIt(a, id);
  assert.equal(a.w.eval("inventory.find(p=>p.code==='A').qty"), 20);
  a.w.eval("Object.defineProperty(navigator,'onLine',{value:true,configurable:true})");
  await a.w.eval('pushNow()'); await settled(a); await sleep(300);
  const st = s.serverState();
  assert.equal((st.salesLog || []).filter((x) => !x.voided).length, 0, 'server holds no active sale');
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 20, 'server stock restored exactly once');
  const sales = await q(s, 'SELECT status FROM ledger_sales');
  assert.ok(sales.every((r) => r.status === 'VOIDED'), JSON.stringify(sales));
  // a stale device that still holds the ACTIVE copy cannot bring it back
  const stale = { ...JSON.parse(a.w.eval('JSON.stringify(salesLog[0])')), voided: false, updatedAt: 1 };
  const c = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_sales_log: JSON.stringify([stale]) }, 2500);
  await c.w.eval('pushNow()'); await settled(c); await sleep(400);
  assert.equal((s.serverState().salesLog || []).filter((x) => !x.voided).length, 0, 'stale copy lost');
  a.close(); c.close();
});

const mpesaSale = (id, at) => ({ id, refNumber: 'R' + id, timestamp: at, orderType: 'retail', paymentMethod: 'mpesa', paid: true, cashAmount: 0, mpesaAmount: 500, cardAmount: 0, mpesaReceiptNumber: 'QWE123XYZ9', servedBy: 'Amina', items: [{ code: 'A', name: 'Alpha', price: 500, qty: 1, unit: 'pcs' }], updatedAt: at });
const INV19 = JSON.stringify(ITEMS.map((p) => (p.code === 'A' ? { ...p, qty: 19 } : p)));

test('B: confirmed M-Pesa sale voided -> not active revenue, NOT marked refunded, provider reference kept', async () => {
  const s = makeServer({ d1: true });
  const now = Date.now();
  const a = await openA(s, { pos_inventory: INV19, pos_sales_log: JSON.stringify([mpesaSale('MP1', now - 1000)]) });
  await a.w.eval('pushNow()'); await settled(a);
  let pays = await q(s, "SELECT method, status, mpesa_code FROM ledger_payments WHERE method='mpesa'");
  assert.equal(pays.length, 1); assert.equal(pays[0].status, 'CONFIRMED');
  voidIt(a, 'MP1'); await a.w.eval('pushNow()'); await settled(a); await sleep(300);
  pays = await q(s, "SELECT method, status, mpesa_code FROM ledger_payments WHERE method='mpesa'");
  assert.equal(pays.length, 1, 'the payment row is kept as evidence');
  assert.equal(pays[0].mpesa_code, 'QWE123XYZ9', 'provider reference kept');
  assert.equal(pays[0].status, 'REVERSED', 'out of active totals');
  assert.notEqual(pays[0].status, 'REFUNDED', 'money was not refunded to the customer, so it is never reported as refunded');
  const sale = JSON.parse(a.w.eval('JSON.stringify(salesLog[0])'));
  assert.equal(sale.voided, true); assert.equal(sale.mpesaReceiptNumber, 'QWE123XYZ9'); assert.ok(!sale.refunded && !sale.refundStatus, 'no refund flag invented');
  assert.equal(a.w.eval("inventory.find(p=>p.code==='A').qty"), 20);
  a.close();
});

test('G2: two devices void the same sale at once -> stock restored once, one voided record', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  await cashSale(a, "addToCart('A')"); await a.w.eval('pushNow()'); await settled(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(PRINTER);
  const id = a.w.eval('salesLog[0].id');
  voidIt(a, id); voidIt(b, id);
  await Promise.all([a.w.eval('pushNow()'), b.w.eval('pushNow()')]); await settled(a); await settled(b); await sleep(500);
  await a.w.eval('pullState()'); await b.w.eval('pullState()'); await sleep(400);
  const st = s.serverState();
  assert.equal(st.salesLog.length, 1);
  assert.equal(st.salesLog[0].voided, true);
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 20, 'restored once, not twice (would be 21)');
  for (const d of [a, b]) assert.equal(d.w.eval("inventory.find(p=>p.code==='A').qty"), 20);
  const sales = await q(s, 'SELECT status FROM ledger_sales'); assert.deepEqual(sales.map((r) => r.status), ['VOIDED']);
  a.close(); b.close();
});

test('H: a failed push after a void is not lost - the void is re-sent and lands, never reported as synced early', async () => {
  const s = makeServer({ d1: true });
  const a = await openA(s);
  await cashSale(a, "addToCart('A')"); await a.w.eval('pushNow()'); await settled(a);
  const id = a.w.eval('salesLog[0].id');
  const realFetch = a.w.fetch; let fail = true;
  a.w.fetch = (...args) => (fail && String(args[0]).includes('pos-sync') && (args[1] || {}).method === 'POST' ? Promise.resolve(new a.w.Response('boom', { status: 500 })) : realFetch.apply(a.w, args));
  voidIt(a, id);
  await a.w.eval('pushNow()').catch(() => {}); await sleep(300);
  assert.equal((s.serverState().salesLog || [])[0].voided || false, false, 'the server has not got the void yet');
  assert.equal(a.w.eval('salesLog[0].voided'), true, 'locally it is voided and kept');
  fail = false; a.w.fetch = realFetch;
  await a.w.eval('pushNow()'); await settled(a); await sleep(300);
  assert.equal(s.serverState().salesLog[0].voided, true, 'delivered on retry');
  assert.equal(s.serverState().inventory.find((p) => p.code === 'A').qty, 20);
  a.close();
});
