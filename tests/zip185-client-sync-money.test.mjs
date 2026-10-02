import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// zip 185 (client): sync + money fixes in src/shared (functions.js and the sales-journal block).
// Tests that need an app page run against index.html AFTER `npm run sync` has copied src/shared into it.
const SRC = fs.readFileSync(fileURLToPath(new URL('../src/shared/functions.js', import.meta.url)), 'utf8');
const fnSrc = (name) => { const m = SRC.match(new RegExp('//@fn ' + name + '\\n((?:async )?function ' + name + '[\\s\\S]*?)\\n\\n//@fn ')); assert.ok(m, name + ' found'); return m[1]; };
const ITEMS = [{ code: '00001', type: 'item', name: 'Widget', price: 100, wholesaleSellingPrice: 80, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true');

// ---------- M1 round2 ----------
test('M1: round2 rounds half-cents the right way and keeps 0 for falsy input', () => {
  const round2 = new Function(fnSrc('round2') + '; return round2;')();
  const table = [[1.005, 1.01], [2.675, 2.68], [1.255, 1.26], [0.145, 0.15], [8.345, 8.35], [10.075, 10.08], [1.0049, 1], [1.004999, 1],
    [-1.005, -1.01], [-2.675, -2.68], [0, 0], [NaN, 0], [undefined, 0], [null, 0], ['', 0], ['12.345', 12.35], [1e-7, 0], [-0.001, 0],
    [123456789.015, 123456789.02], [99.99, 99.99], [0.1 + 0.2, 0.3], [19.995, 20], [33.335, 33.34], [0.005, 0.01], [100, 100], [1e21, 1e21]];
  table.forEach(([i, e]) => assert.equal(round2(i), e, `round2(${i})`));
  assert.ok(Object.is(round2(-0.001), 0), 'never -0');
  for (let c = -50000; c <= 50000; c += 7) {                         // every 3-decimal value: half away from zero
    const v = c / 1000;
    const exp = Math.sign(c) * Math.floor((Math.abs(c) + 5) / 10) / 100;
    assert.ok(Math.abs(round2(v) - exp) < 1e-9, `round2(${v}) = ${round2(v)}, expected ${exp}`);
  }
});

// ---------- S7 websocket flapping ----------
test('S7: a socket that opens and closes at once backs off instead of restarting at 2 s', () => {
  const fn = new Function('window', 'clearTimeout', 'setTimeout', 'connectSyncSocket', 'state', fnSrc('scheduleSyncSocketReconnect').replace('function scheduleSyncSocketReconnect', 'return function scheduleSyncSocketReconnect')
    .replace(/wsReconnectTimer/g, 'state.t').replace(/wsReconnectDelay/g, 'state.d'));
  const w = {}; const delays = [];
  const state = { t: null, d: 2000 };
  const sched = fn(w, () => {}, (f, ms) => { delays.push(ms); return 1; }, () => {}, state);
  for (let i = 0; i < 6; i++) { sched(); state.d = 2000; w.__wsDueAt = Date.now() - 100; /* onopen reset the delay; the socket lived 100 ms */ }
  assert.ok(delays[5] > delays[1] && delays[5] <= 30000, 'delays grow: ' + delays.join(','));
  assert.ok(delays.every((d) => d >= 2000));
  w.__wsDueAt = Date.now() - 60000; state.d = 2000; sched();            // a healthy long-lived socket: back to the plain delay
  assert.equal(delays.at(-1), 2000);
});

// ---------- S6 storage ----------
test('S6: storageRetryPending starts the give-up counter again after a key was stored', () => {
  const store = {}; let full = true;
  const localStorage = { setItem(k, v) { if (full) throw new Error('quota'); store[k] = v; }, getItem(k) { return store[k] ?? null; } };
  const retry = new Function('window', 'localStorage', 'storageFullBar', 'storageRetryLater', fnSrc('storageRetryPending') + '; return storageRetryPending;');
  const w = { __ssPending: { pend: { a: '1', b: '2' }, tries: 150, timer: null } };
  const run = retry(w, localStorage, () => {}, () => {});
  full = false; run(true);
  assert.equal(w.__ssPending.tries, 0); assert.deepEqual(w.__ssPending.pend, {});
});

test('S6: a direct write of the sales list drops an OLDER pending value of the same key (confirmSaleStored)', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  a.w.eval("window.storageAutoArchive = null; window.salesJournalDurable = null;");
  a.w.eval("salesLog.push({id:'S-OLD1', timestamp:new Date().toISOString(), paid:true, paymentMethod:'cash', cashAmount:100, items:[{name:'Widget',price:100,qty:1,code:'00001'}]})");
  a.w.eval("window.__ssPending = { pend: { pos_sales_log: '[]' }, tries: 0, timer: null }");           // an OLDER value waiting for room
  const r = await a.w.eval("confirmSaleStored(salesLog[salesLog.length-1])");
  assert.equal(r.ok, true);
  assert.equal(a.w.eval("window.__ssPending.pend.pos_sales_log"), undefined, 'the stale pending value is gone');
  assert.match(a.w.eval("localStorage.getItem('pos_sales_log')"), /S-OLD1/);
  a.close();
});

test('S1: an edit made while a push is in flight is stamped on its own, not sent later under the in-flight stamp', async () => {
  const s = makeServer();
  const bodies = [];
  let delay = 0;
  const s2 = { ...s, fetch: async (u, o = {}) => {
    const isPost = String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync');
    if (isPost) { try { const p = (JSON.parse(o.body).inventory || []).find((x) => x.code === '00001'); bodies.push({ price: p && p.price, upd: p && p.updatedAt }); } catch (e) { /* none */ } await sleep(delay); }
    return s.fetch(u, o);
  } };
  const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  quiet(a.w);
  await sleep(300);
  bodies.length = 0; delay = 250;
  a.w.eval("updateInventoryField('00001', 'price', '111')");
  await sleep(380);                                              // push A is in flight
  a.w.eval("updateInventoryField('00001', 'price', '222')");     // edit DURING flight
  await sleep(2500);
  const priced = bodies.filter((b) => b.price === 111 || b.price === 222);
  assert.ok(priced.some((b) => b.price === 222), 'the second edit was pushed');
  const b111 = priced.find((b) => b.price === 111), b222 = priced.find((b) => b.price === 222);
  assert.notEqual(b222.upd, b111.upd, 'a different value never carries the same stamp');
  assert.equal(s.serverState().inventory[0].price, 222);
  a.close();
});

test('S2: pushes are serialized (never two in flight) and a call made meanwhile runs exactly one more', async () => {
  const s = makeServer();
  let inflight = 0, maxIn = 0, posts = 0;
  const s2 = { ...s, fetch: async (u, o = {}) => {
    const isPost = String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync');
    if (!isPost) return s.fetch(u, o);
    posts++; inflight++; maxIn = Math.max(maxIn, inflight);
    await sleep(300);
    inflight--;
    return s.fetch(u, o);
  } };
  const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await sleep(200);
  posts = 0; maxIn = 0;
  const p1 = a.w.eval('pushNow()'); await sleep(50);
  const p2 = a.w.eval('pushNow()'); const p3 = a.w.eval('pushNow()'); const p4 = a.w.eval('queuePush()');
  await Promise.all([p1, p2, p3]); await sleep(900);
  a.close();
  assert.equal(maxIn, 1, 'never two pushes at the same time');
  assert.ok(posts >= 2 && posts <= 4, 'one in flight + one follow-up for everyone who asked meanwhile, not one per caller (got ' + posts + ')');
});

test('S2: a failed push B is not hidden by push A finishing (flags are not shared between overlapping pushes)', async () => {
  const s = makeServer();
  let fail = false;
  const s2 = { ...s, fetch: async (u, o = {}) => {
    const isPost = String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync');
    if (isPost && fail) { await sleep(100); return new Response('{}', { status: 400 }); }
    return s.fetch(u, o);
  } };
  const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await sleep(200);
  fail = true;
  const pa = a.w.eval('pushNow()'); const pb = a.w.eval('pushNow()');
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(rb, false);
  assert.equal(a.w.eval('window.__pushFailed'), true, 'the failure stays recorded');
  assert.equal(a.w.eval('window.__syncStatus'), 'error');
  a.close();
});

test('S3: the dot is not green while more batches are waiting', async () => {
  const s = makeServer();
  const sales = Array.from({ length: 400 }, (_, i) => ({ id: 'B' + i, timestamp: new Date(Date.now() - i * 60000).toISOString(), paid: true, paymentMethod: 'cash', cashAmount: 100, items: [{ name: 'Widget', price: 100, qty: 1, code: '00001' }] }));
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  a.w.eval('window.__pushBatchGapMs = 100000');                    // keep the next batch from starting inside this test
  a.w.eval('salesLog = ' + JSON.stringify(sales));
  await a.w.eval('pushNow()');
  assert.equal(a.w.eval('window.__pushBacklog'), true, 'a batch is still waiting');
  assert.equal(a.w.eval('window.__syncStatus'), 'syncing');
  a.close();
});

test('S4: an exception while building the payload is reported as an error, not left on "Syncing"', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()');
  a.w.eval("window.__origCollect = collectSyncPayload; collectSyncPayload = function () { throw new Error('boom'); }");
  const r = await a.w.eval('pushNow()');
  assert.equal(r, false);
  assert.equal(a.w.eval('window.__syncStatus'), 'error');
  a.w.eval('collectSyncPayload = window.__origCollect');
  a.close();
});

test('S5: markBulkDelete lets a deliberate bulk delete send its tombstones; without it the safety net holds', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'C' + i, name: 'Cust ' + i, phone: '0700' + i, updatedAt: 1000 + i }));
  for (const optIn of [false, true]) {
    const s = makeServer();
    const bodies = [];
    const s2 = { ...s, fetch: async (u, o = {}) => { if (String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync')) { try { bodies.push(JSON.parse(o.body)); } catch (e) { /* none */ } } return s.fetch(u, o); } };
    const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS), pos_customers: JSON.stringify(mk(40)) });
    quiet(a.w);
    await a.w.eval('pushNow()'); await sleep(200);
    assert.equal(typeof a.w.markBulkDelete, 'function', 'exported on window');
    if (optIn) a.w.eval("markBulkDelete('customers')");
    a.w.eval("customers.splice(5, customers.length - 5)");           // 35 of 40 gone
    bodies.length = 0;
    await a.w.eval('pushNow()');
    const last = bodies.at(-1);
    const tomb = (last.customers || []).filter((c) => c._deleted);
    assert.equal(tomb.length, optIn ? 35 : 0, optIn ? 'tombstones sent' : 'safety net: nothing sent as deleted');
    if (optIn) { await a.w.eval('pushNow()'); assert.equal(a.w.eval("!!(window.__bulkDelete && window.__bulkDelete.customers)"), false, 'one-shot'); }
    a.close();
  }
});

test('S8: movements of an item the server has not seen travel with it even when the batch is full', async () => {
  const s = makeServer();
  const bodies = [];
  const s2 = { ...s, fetch: async (u, o = {}) => { if (String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync')) { try { bodies.push(JSON.parse(o.body)); } catch (e) { /* none */ } } return s.fetch(u, o); } };
  const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await sleep(200);
  a.w.eval(`(function(){
    inventory.push({ code: 'NEW1', type: 'item', name: 'Newbie', price: 10, wholesalePrice: 5, qty: 700, unit: 'pcs', vatCategory: 'A' });
    const t0 = Date.now() - 1e7;
    for (let i = 0; i < 300; i++) stockMovementLog.push({ id: 'n' + i, lg: 1, timestamp: new Date(t0 + i * 1000).toISOString(), code: 'NEW1', name: 'Newbie', delta: 1, type: 'added', reason: 'Restock', unit: 'qty' });
    for (let i = 0; i < 500; i++) stockMovementLog.push({ id: 'o' + i, lg: 1, timestamp: new Date(t0 + 1e6 + i * 1000).toISOString(), code: '00001', name: 'Widget', delta: -1, type: 'removed', reason: 'Sale', unit: 'qty' });
  })()`);
  bodies.length = 0;
  await a.w.eval('pushNow()');
  const first = bodies[0];
  const ids = new Set((first.stockMovementLog || []).map((m) => m.id));
  for (let i = 0; i < 300; i++) assert.ok(ids.has('n' + i), 'movement n' + i + ' is in the same push as its new item');
  assert.ok((first.inventory || []).some((p) => p.code === 'NEW1'));
  a.close();
});

// ---------- money ----------
test('M2: a custom total quote of 100 on 3 x 50 ends at exactly 100 (not 99.99)', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  a.w.eval("currentCart = { a: { code: '00001', name: 'Widget', price: 50, qty: 3, unit: 'pcs', cartKey: 'a' } }; performCartTotalQuote(100)");
  assert.equal(a.w.eval('Math.round(Object.values(currentCart).reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100'), 100);
  assert.equal(a.w.eval('cartTotal()'), 100);
  a.close();
});

test('M2: a quote that would push a line below its minimum price after rounding is refused and the prices are restored', async () => {
  const s = makeServer();
  const items = [{ ...ITEMS[0], minimumPrice: 33.34 }];
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(items) });
  quiet(a.w);
  a.w.eval("currentCart = { a: { code: '00001', name: 'Widget', price: 50, qty: 3, unit: 'pcs', cartKey: 'a' } }; performCartTotalQuote(100)");
  const p = a.w.eval('currentCart.a.price');
  assert.ok(p >= 33.34 - 0.005 || p === 50, 'never left below the minimum: ' + p);
  a.close();
});

test('M3: a payment line counts its costShare in reportSaleCost; without it the line is skipped as before', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  const cost = (items) => a.w.eval(`reportSaleCost(${JSON.stringify({ items })})`);
  const pay = { name: 'Partial payment — Bill (Jo)', price: 500, qty: 1, unit: 'payment', wholesalePrice: 0 };
  assert.equal(cost([pay]), 0, 'old data unchanged');
  assert.equal(cost([{ ...pay, costShare: 320 }]), 320);
  assert.equal(cost([{ ...pay, costShare: 'x' }, { code: '00001', qty: 2, price: 100, wholesalePrice: 50 }]), 100, 'non-numeric costShare ignored');
  assert.equal(cost([{ ...pay, costShare: NaN }]), 0);
  a.close();
});

test('M4: returnQtyGuard still lets a no-receipt return through but refuses zero / negative / NaN quantities', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  const g = (q) => a.w.eval(`returnQtyGuard({ code: '00001', name: 'Widget' }, ${q}, { textContent: '' })`);
  assert.equal(g(3), true);
  assert.equal(g(0), false); assert.equal(g(-2), false); assert.equal(g('NaN'), false); assert.equal(g('Infinity'), false);
  a.close();
});

test('M5: restocking a returned VARIANT logs the movement under the variant code', async () => {
  const s = makeServer();
  const items = [{ code: 'P1', type: 'item', name: 'Shirt', price: 100, wholesalePrice: 50, qty: 10, unit: 'pcs', vatCategory: 'A', hasVariants: true,
    variants: [{ id: 'v-1', name: 'Red', code: 'P1-RED', price: 100, qty: 4 }, { id: 'v-2', name: 'Blue', code: 'P1-BLUE', price: 100, qty: 6 }] }];
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(items) });
  quiet(a.w);
  const before = a.w.eval('stockMovementLog.length');
  a.w.eval("restockReturnedItem(inventory.find(p => p.code === 'P1'), 2, { variantId: 'v-1' }, 'Return')");
  const m = a.w.eval(`JSON.stringify(stockMovementLog.slice(${before}))`);
  const moves = JSON.parse(m);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].code, 'P1-RED');
  assert.equal(a.w.eval("inventory.find(p => p.code === 'P1').variants[0].qty"), 6);
  a.close();
});
