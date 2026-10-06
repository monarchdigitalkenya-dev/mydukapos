import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { ensureCashSchema, handleCash, CashError } from '../functions/api/_cash.js';
// zip 234 — the Cash Register inside the Sales Counter, end to end: the page talks to the real server rules on a real SQL database.
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Milk', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
async function server(db, state = { down: false }) {
  await ensureCashSchema(db);
  const fetch = async (url, init) => {
    if (!String(url).includes('/api/cash-register')) throw new Error('offline');
    if (state.down) throw new Error('offline');
    const body = JSON.parse(init.body);
    try { const out = await handleCash({ db, c: 'SHOP1', body }); return { ok: true, status: 200, json: async () => ({ ok: true, ...out }) }; }
    catch (e) { if (e instanceof CashError) return { ok: false, status: e.status, json: async () => ({ ok: false, code: e.code, error: e.error, ...(e.extra || {}) }) }; throw e; }
  };
  return { fetch, state };
}
const settled = (b) => until(() => b.w.eval('CashRegister.state().state') !== 'checking', 12000);
const page = async (db, state, storage = {}) => { const s = await server(db, state); const b = await boot('index.html', { wait: 2600, fetch: s.fetch, storage: { pos_inventory: INV, pos_cash_reg_on: '1', ...storage } }); b.w.eval("showToast = function (m) { window.__t = (window.__t || []).concat(m); }"); await settled(b); return b; };
const type = (b, id, v) => { const el = b.d.getElementById(id); el.value = v; el.dispatchEvent(new b.w.Event('input', { bubbles: true })); };
const click = (b, id) => b.d.getElementById(id).click();
const text = (b, id) => (b.d.getElementById(id) ? b.d.getElementById(id).textContent.replace(/\s+/g, ' ').trim() : null);
const addSale = (b, o) => b.w.eval(`salesLog.push(${JSON.stringify(Object.assign({ id: 'S' + Math.random().toString(36).slice(2, 8), timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', items: [{ code: 'A1', name: 'Milk', price: 100, qty: 1 }], servedBy: 'John' }, o))})`);

test('U1: no session -> the counter shows Open Cash Session, hides the selling grid and refuses to check out', async () => {
  const db = makeD1(); const b = await page(db);
  assert.ok(b.d.getElementById('cr-gate'), 'the gate is there');
  assert.match(text(b, 'cr-gate'), /Open Cash Session/); assert.match(text(b, 'cr-gate'), /Count the physical cash currently in the drawer/);
  assert.ok(b.d.getElementById('sales-tab').classList.contains('cr-locked'));
  assert.equal(b.w.eval('CashRegister.blocked()'), true);
  await b.w.eval("checkoutCart()");
  assert.ok((b.w.__t || []).some((m) => /Open a cash session first/.test(m)));
  b.close();
});

test('U2: type the float, Open Sales -> a database session; the bar shows Cash -> Expected; another employee sees the same session', async () => {
  const db = makeD1(); const b = await page(db);
  type(b, 'cr-float', '5000'); click(b, 'cr-open-btn');
  assert.ok(await until(() => !b.d.getElementById('cr-gate'), 5000), 'the gate goes away');
  assert.equal(b.d.getElementById('sales-tab').classList.contains('cr-locked'), false);
  assert.match(text(b, 'cr-bar'), /Cash: KES 5,000 → Expected: KES 5,000/);
  const row = await db.prepare('SELECT * FROM cash_sessions').first();
  assert.equal(row.opening_float_cents, 500000); assert.equal(row.status, 'open'); assert.equal(row.client_id, 'SHOP1'); assert.ok(row.device_id);
  // a different employee on the same device (page reload, same storage) is NOT asked for a float again
  const b2 = await page(db, undefined, { pos_device_id: b.w.localStorage.getItem('pos_device_id') });
  assert.equal(b2.d.getElementById('cr-gate'), null); assert.match(text(b2, 'cr-bar'), /Cash/);
  b.close(); b2.close();
});

test('U3: a float is required — empty / negative / text are refused', async () => {
  const db = makeD1(); const b = await page(db);
  click(b, 'cr-open-btn'); assert.match(text(b, 'cr-err'), /Count the cash/);
  type(b, 'cr-float', '-5'); click(b, 'cr-open-btn'); assert.match(text(b, 'cr-err'), /Count the cash/);
  type(b, 'cr-float', 'abc'); click(b, 'cr-open-btn'); assert.match(text(b, 'cr-err'), /Count the cash/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM cash_sessions').first()).n, 0);
  b.close();
});

test('U4: expected cash counts THIS device\'s cash sales since opening — not M-Pesa, not voided, not unpaid, not another device, not earlier ones; split sales count only their cash part', async () => {
  const db = makeD1(); const b = await page(db);
  type(b, 'cr-float', '5000'); click(b, 'cr-open-btn'); await until(() => !b.d.getElementById('cr-gate'), 5000);
  const me = b.w.eval('getOrCreateDeviceId()');
  addSale(b, { items: [{ code: 'A1', name: 'Milk', price: 100, qty: 3 }], cashAmount: 300, servedBy: 'John' });          // +300 cash
  addSale(b, { items: [{ code: 'A1', name: 'Milk', price: 100, qty: 2 }], servedBy: 'Mary' });                               // legacy cash sale (method only): +200
  addSale(b, { paymentMethod: 'mpesa', mpesaAmount: 100 });                                                                  // not cash
  addSale(b, { paymentMethod: 'split', cashAmount: 40, mpesaAmount: 60, servedBy: 'Mary' });                                 // +40
  addSale(b, { voided: true, cashAmount: 100 });                                                                             // voided
  addSale(b, { paid: false, paymentMethod: 'bill' });                                                                        // unpaid bill
  addSale(b, { cashAmount: 100, ctx: { device: 'someone-else' } });                                                          // other drawer
  addSale(b, { cashAmount: 100, timestamp: new Date(Date.now() - 86400000).toISOString() });                                // yesterday
  const t = JSON.parse(b.w.eval('JSON.stringify(CashRegister.totals(CashRegister.state().session))'));
  assert.equal(t.f.cashSales, 540); assert.equal(t.expected, 5540); assert.equal(t.f.salesCount, 4);
  assert.deepEqual(t.f.byStaff, { John: 300, Mary: 240 });
  assert.equal(t.f.nonCashSales, 160);
  b.close();
});

test('U5: cash expenses and cash in/out change expected; the menu shows the breakdown', async () => {
  const db = makeD1(); const b = await page(db);
  type(b, 'cr-float', '5000'); click(b, 'cr-open-btn'); await until(() => !b.d.getElementById('cr-gate'), 5000);
  addSale(b, { items: [{ code: 'A1', name: 'Milk', price: 100, qty: 20 }], cashAmount: 2000 });
  b.w.eval("expenses.push({ id: 'X1', timestamp: new Date().toISOString(), amount: 150, category: 'Tea', paymentMethod: 'cash' }); expenses.push({ id: 'X2', timestamp: new Date().toISOString(), amount: 999, category: 'Rent', paymentMethod: 'mpesa' })");
  click(b, 'cr-menu-btn'); const m = text(b, 'cr-modal');
  assert.match(m, /Opening Float\s*KES 5,000/); assert.match(m, /Cash Sales\s*KES 2,000/); assert.match(m, /Cash Expenses\s*KES 150/); assert.match(m, /Expected Cash\s*KES 6,850/);
  click(b, 'cr-move'); type(b, 'cr-mv-kind', 'refund'); b.d.getElementById('cr-mv-kind').value = 'refund'; type(b, 'cr-mv-amt', '500'); click(b, 'cr-mv-save');
  assert.match(text(b, 'cr-err') || '', /reason/, 'a reason is required for money leaving the drawer');
  type(b, 'cr-mv-note', 'returned milk'); click(b, 'cr-mv-save');
  assert.ok(await until(() => /Expected Cash\s*KES 6,350/.test(text(b, 'cr-modal') || ''), 5000), text(b, 'cr-modal'));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM cash_movements').first()).n, 1);
  b.close();
});

test('U6: Close Sales shows Short / Over / Balanced very plainly, stores the permanent record, then asks for a NEW float', async () => {
  const db = makeD1(); const b = await page(db);
  type(b, 'cr-float', '5000'); click(b, 'cr-open-btn'); await until(() => !b.d.getElementById('cr-gate'), 5000);
  addSale(b, { items: [{ code: 'A1', name: 'Milk', price: 100, qty: 134 }], cashAmount: 13450, servedBy: 'Peter' });
  click(b, 'cr-menu-btn'); click(b, 'cr-close');
  assert.match(text(b, 'cr-modal'), /Close Sales/); assert.match(text(b, 'cr-modal'), /Expected Cash\s*KES 18,450/);
  type(b, 'cr-counted', '18250'); assert.match(text(b, 'cr-diff'), /Short: KES 200/); assert.ok(b.d.getElementById('cr-diff').classList.contains('short'));
  type(b, 'cr-counted', '18750'); assert.match(text(b, 'cr-diff'), /Over: KES 300/); assert.ok(b.d.getElementById('cr-diff').classList.contains('over'));
  type(b, 'cr-counted', '18450'); assert.match(text(b, 'cr-diff'), /Balanced/); assert.ok(b.d.getElementById('cr-diff').classList.contains('ok'));
  type(b, 'cr-counted', '18250'); click(b, 'cr-close-go');
  assert.ok(await until(() => /Cash session closed/.test(text(b, 'cr-modal') || ''), 5000));
  assert.match(text(b, 'cr-modal'), /Short: KES 200/);
  const r = await db.prepare('SELECT * FROM cash_sessions').first();
  assert.equal(r.status, 'closed'); assert.equal(r.expected_cents, 1845000); assert.equal(r.counted_cents, 1825000); assert.equal(r.difference_cents, -20000); assert.equal(r.cash_sales_cents, 1345000);
  click(b, 'cr-done');
  assert.match(text(b, 'cr-gate'), /Start New Cash Session/); assert.equal(b.w.eval('CashRegister.blocked()'), true, 'no sales under a closed session');
  assert.equal(b.d.getElementById('cr-float').value, '', 'the old closing amount is NOT carried over');
  b.close();
});

test('U7: a cashier (not admin / manager) sees only "Cash Session Active" — no amounts, no View Session, no Close Sales', async () => {
  const db = makeD1(); const b = await page(db);
  type(b, 'cr-float', '5000'); click(b, 'cr-open-btn'); await until(() => !b.d.getElementById('cr-gate'), 5000);
  b.w.eval("staff = [{ id: 'st1', name: 'Mary', isManager: false }]; currentServer = { id: 'st1', name: 'Mary' }; CashRegister.paint()");
  assert.match(text(b, 'cr-bar'), /Cash Session Active/); assert.doesNotMatch(text(b, 'cr-bar'), /5,000/);
  click(b, 'cr-menu-btn'); const m = text(b, 'cr-modal');
  assert.doesNotMatch(m, /Expected Cash/); assert.ok(!b.d.getElementById('cr-close') && !b.d.getElementById('cr-view')); assert.ok(b.d.getElementById('cr-move'));
  b.w.eval("staff[0].isManager = true; CashRegister.paint()"); click(b, 'cr-menu-btn');
  assert.ok(b.d.getElementById('cr-close'), 'a Manager can close');
  b.close();
});

test('U8: offline — the drawer can still be opened and closed; it reaches the server (once) when the internet is back', async () => {
  const db = makeD1(); const state = { down: true }; const b = await page(db, state);
  type(b, 'cr-float', '3000'); click(b, 'cr-open-btn'); await until(() => !b.d.getElementById('cr-gate'), 3000);
  assert.match(text(b, 'cr-bar'), /not yet sent/); assert.equal(b.w.eval('CashRegister.queue().length'), 1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM cash_sessions').first()).n, 0);
  addSale(b, { items: [{ code: 'A1', name: 'Milk', price: 100, qty: 5 }], cashAmount: 500 });
  click(b, 'cr-menu-btn'); click(b, 'cr-close'); type(b, 'cr-counted', '3500'); click(b, 'cr-close-go');
  await until(() => /Cash session closed/.test(text(b, 'cr-modal') || ''), 3000);
  assert.equal(b.w.eval('CashRegister.queue().length'), 2);
  state.down = false; await b.w.eval('CashRegister.flush()');
  assert.equal(b.w.eval('CashRegister.queue().length'), 0);
  const rows = (await db.prepare('SELECT * FROM cash_sessions').all()).results; assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'closed'); assert.equal(rows[0].difference_cents, 0); assert.equal(rows[0].cash_sales_cents, 50000);
  await b.w.eval('CashRegister.flush()'); assert.equal((await db.prepare('SELECT COUNT(*) n FROM cash_sessions').first()).n, 1, 'a second flush changes nothing');
  b.close();
});

test('U9: the Settings switch turns the cash register off — no gate, no bar, checkout is not blocked', async () => {
  const db = makeD1(); const b = await page(db, undefined, { pos_cash_reg_on: '0' });
  assert.equal(b.d.getElementById('cr-gate'), null); assert.equal(b.w.eval('CashRegister.blocked()'), false);
  b.w.eval('setCashRegister(true)'); assert.ok(await until(() => !!b.d.getElementById('cr-gate'), 3000));
  b.close();
});

test('U10: if the database is not connected the counter is NOT locked out (it says so instead)', async () => {
  const db = makeD1(); const b = await boot('index.html', { wait: 2600, storage: { pos_inventory: INV, pos_cash_reg_on: '1' }, fetch: async (u) => (String(u).includes('cash-register') ? { ok: false, status: 503, json: async () => ({ ok: false, code: 'no_d1', error: 'no db' }) } : Promise.reject(new Error('offline'))) });
  await settled(b); assert.equal(b.w.eval('CashRegister.state().state'), 'unavailable'); assert.equal(b.w.eval('CashRegister.blocked()'), false);
  b.close();
});
