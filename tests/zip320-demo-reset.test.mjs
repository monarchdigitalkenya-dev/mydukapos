import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { deviceStorage } from './e2e-harness.mjs';

// zip 320: the public sample shops (demo-<name>.<domain>, server-confirmed sharedDemo) go back to their original sample every 60 minutes,
// online or offline; normal shops are never touched. Real Shop app in jsdom; the server is played by a fetch that answers /api/license-status.
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
const DAY = 86400000;
const SEED = {
  pos_inventory: JSON.stringify([
    { code: 'SUG', type: 'item', name: 'Sugar 1kg', category: 'Groceries', price: 160, wholesalePrice: 130, qty: 40, unit: 'pcs', vatCategory: 'A' },
    { code: 'MLK', type: 'item', name: 'Milk 500ml', category: 'Dairy', price: 60, wholesalePrice: 45, qty: 25, unit: 'pcs', vatCategory: 'A' }]),
  pos_sales_log: JSON.stringify([{ id: 'S-1', refNumber: 'R-0001', timestamp: new Date(Date.now() - DAY).toISOString(), paymentMethod: 'cash', cashAmount: 160, paid: true, items: [{ code: 'SUG', name: 'Sugar 1kg', qty: 1, price: 160 }] }]),
  pos_expenses: JSON.stringify([{ id: 'E-1', timestamp: new Date(Date.now() - DAY).toISOString(), category: 'Rent', description: 'Shop rent', amount: 5000 }]),
  pos_debts: JSON.stringify([{ id: 'D-1', customerName: 'Mama Njeri', phone: '0712000000', amount: 800, createdAt: new Date(Date.now() - 2 * DAY).toISOString(), payments: [] }]),
  pos_trade_credits: JSON.stringify([{ id: 'T-1', timestamp: new Date(Date.now() - DAY).toISOString(), partyName: 'Bidco', direction: 'i_owe', description: 'Oil', amount: 3000, status: 'open', settledAt: null }]),
  pos_customers: JSON.stringify([{ id: 'C-1', name: 'Mama Njeri', phone: '0712000000' }]),
  pos_last_synced_at: String(Date.now() - 1000),
};
const DEMO_URL = (k) => `https://demo-${k}.mydukapos.store/?c=demo_${k}`;
const net = (id, isDemo, calls) => async (url, o = {}) => {
  const u = String(url);
  if (calls) calls.push({ url: u, method: (o.method || 'GET').toUpperCase(), body: o.body ? String(o.body) : '' });
  if (/\/api\/license-status/.test(u)) return new Response(JSON.stringify({ valid: true, clientId: id, type: 'permanent', sharedDemo: isDemo }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('offline');
};
const offline = () => Promise.reject(new Error('offline'));
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.alert = () => {}; window.__demoResetNoReload = true;");
// open a demo for the first time, online: the server confirms it, the sample "arrives", the baseline is kept
async function firstVisit(t, key = 'retail', calls) {
  const dev = await boot('index.html', { url: DEMO_URL(key), storage: SEED, fetch: net('demo_' + key, true, calls), wait: 600 });
  t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  quiet(dev.w);
  assert.ok(await until(() => dev.w.eval("!!localStorage.getItem('sd_baseline') && !!localStorage.getItem('sd_reset_meta')"), 10000), 'the baseline is kept after the first pull');
  return dev;
}
// the same device later: a new page with the same storage (browser reopened), online or not
async function reopen(t, prev, url, fetch = offline, extra = {}) {
  const st = deviceStorage(prev.w); try { prev.close(); } catch (e) { /* closed */ }
  const dev = await boot('index.html', { url, storage: { ...st, ...extra }, fetch, wait: 600 });
  t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  quiet(dev.w);
  return dev;
}
// a visitor uses the demo: edits, price and stock changes, a sale, an expense, a debt payment, a new customer, a supplier debt paid, a setting
function useDemo(w) {
  w.eval(`inventory[0].price = 1; inventory[0].qty = 999; inventory.push({ code: 'MINE', type: 'item', name: 'My own product', price: 50, qty: 10, unit: 'pcs', vatCategory: 'A' });
    salesLog.push({ id: 'S-MINE', refNumber: 'R-9999', timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 50, paid: true, items: [{ code: 'MINE', name: 'My own product', qty: 1, price: 50 }] });
    expenses.push({ id: 'E-MINE', timestamp: new Date().toISOString(), category: 'Other', amount: 99 });
    debts[0].payments.push({ id: 'P-MINE', amount: 300, timestamp: new Date().toISOString(), method: 'cash' });
    customers.push({ id: 'C-MINE', name: 'My customer' });
    tradeCredits[0].status = 'settled'; tradeCredits[0].settledAt = new Date().toISOString();
    safeSetItem('pos_inventory', JSON.stringify(inventory)); safeSetItem('pos_sales_log', JSON.stringify(salesLog)); safeSetItem('pos_expenses', JSON.stringify(expenses));
    safeSetItem('pos_debts', JSON.stringify(debts)); safeSetItem('pos_customers', JSON.stringify(customers)); safeSetItem('pos_trade_credits', JSON.stringify(tradeCredits));
    localStorage.setItem('pos_business_name', 'MY REAL SHOP'); localStorage.setItem('pos_dirty_seq', '999');`);
}
// strict: right after a restore on a live page, before the app writes anything - every key is the sample's. Otherwise (the app has started on the
// restored data and written its own housekeeping keys): every business-data key is the original, and no visitor change survives ANYWHERE in storage.
const DATA = ['pos_inventory', 'pos_sales_log', 'pos_expenses', 'pos_debts', 'pos_trade_credits', 'pos_customers', 'pos_business_name', 'pos_stock_movement_log', 'pos_dirty_seq'];
function assertIsSample(w, label, strict) {
  const base = J(w, "JSON.parse(localStorage.getItem('sd_baseline')).keys");
  const now = J(w, "(function(){ const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/~s\\d+$/.test(k) || /^(sd_reset_meta|sd_baseline|sd_confirmed|mdp-theme|sd_buy_ref)$/.test(k)) continue; o[k] = localStorage.getItem(k); } return o; })()");
  if (strict) {
    assert.deepEqual(Object.keys(now).sort(), Object.keys(base).sort(), label + ': exactly the sample\u2019s keys, nothing added or missing');
    for (const k of Object.keys(base)) assert.equal(now[k], base[k], label + ': ' + k + ' is the original');
  } else {
    for (const k of DATA) assert.equal(now[k] == null ? null : now[k], base[k] == null ? null : base[k], label + ': ' + k + ' is the original');
  }
  for (const [k, v] of Object.entries(now)) assert.doesNotMatch(String(v), /S-MINE|E-MINE|P-MINE|C-MINE|My own product|MY REAL SHOP/, label + ': nothing of the visitor\u2019s is left (' + k + ')');
  const inv = JSON.parse(base.pos_inventory);
  assert.equal(inv.find((p) => p.code === 'SUG').price, 160); assert.equal(inv.find((p) => p.code === 'SUG').qty, 40); assert.equal(inv.some((p) => p.code === 'MINE'), false);
}

test('1-3, 6, 15: after 60 minutes the demo is exactly the original sample again (products, prices, stock, sales, expenses, debts, payments, customers, supplier debts, settings) - offline, and a reload alone never restarts the hour', async (t) => {
  const a = await firstVisit(t);
  const meta0 = J(a.w, "JSON.parse(localStorage.getItem('sd_reset_meta'))");
  assert.ok(meta0.deadline - meta0.startedAt === 3600000, 'a 60-minute hour');
  useDemo(a.w);
  // reload 10 minutes later (offline): the edits are still there and the deadline did NOT move
  const b = await reopen(t, a, DEMO_URL('retail'));
  assert.equal(J(b.w, "inventory.find(p => p.code === 'SUG').price"), 1, 'within the hour the visitor’s changes stay');
  assert.equal(J(b.w, "JSON.parse(localStorage.getItem('sd_reset_meta')).deadline"), meta0.deadline, 'reloading does not give another hour');
  // the hour passes while the device is offline; the demo is opened again
  const st = deviceStorage(b.w); const m = JSON.parse(st.sd_reset_meta); m.deadline = Date.now() - 1000; st.sd_reset_meta = JSON.stringify(m);
  b.close();
  const c = await boot('index.html', { url: DEMO_URL('retail'), storage: st, fetch: offline, wait: 600 }); t.after(() => { try { c.close(); } catch (e) { /* closed */ } });
  assertIsSample(c.w, 'reopened offline after the hour');
  // the app itself loaded the restored sample (the restore ran in <head>, before the app read anything)
  assert.equal(J(c.w, "inventory.find(p => p.code === 'SUG').price"), 160); assert.equal(J(c.w, "inventory.find(p => p.code === 'SUG').qty"), 40);
  assert.equal(J(c.w, "inventory.some(p => p.code === 'MINE')"), false, 'products added by the visitor are gone');
  assert.deepEqual(J(c.w, 'salesLog.map(s => s.id)'), ['S-1'], 'sales are the sample’s');
  assert.deepEqual(J(c.w, 'expenses.map(e => e.id)'), ['E-1']);
  assert.deepEqual(J(c.w, 'debts[0].payments'), [], 'debt payments are undone');
  assert.deepEqual(J(c.w, 'customers.map(x => x.id)'), ['C-1']);
  assert.equal(J(c.w, 'tradeCredits[0].status'), 'open', 'the supplier debt is open again');
  assert.notEqual(J(c.w, "localStorage.getItem('pos_business_name')"), 'MY REAL SHOP', 'settings are the sample’s');
  const m2 = J(c.w, "JSON.parse(localStorage.getItem('sd_reset_meta'))");
  assert.ok(m2.deadline > Date.now() + 3500000 && m2.resets === 1, 'a new hour starts at the reset');
  assert.equal(J(c.w, "window.__demoResetLast && window.__demoResetLast.result"), 'restored');
});

test('5, 7: an OPEN demo restores by itself when its hour is up (timer / tap), and repeated resets never duplicate anything', async (t) => {
  const a = await firstVisit(t);
  useDemo(a.w);
  a.w.eval('DemoReset._expireIn(0)');
  // the next tap after the hour does not reach the app: it restores instead
  let reached = false; a.w.document.getElementById('sales-search')?.addEventListener('click', () => { reached = true; });
  a.d.getElementById('sales-search')?.dispatchEvent(new a.w.MouseEvent('click', { bubbles: true }));
  assert.equal(reached, false, 'the old data is not used after the hour');
  assertIsSample(a.w, 'restored on the first tap', true);
  assert.ok(a.d.getElementById('dr-block'), 'the page is blocked while it restores (then reloads)');
  // the timer path (every 15 s): expire again and wait for it
  useDemo(a.w); a.w.eval('DemoReset._expireIn(0)');
  assert.ok(await until(() => a.w.eval("JSON.parse(localStorage.getItem('pos_inventory')).find(p => p.code === 'SUG').price === 160"), 20000), 'the 15-second check restores an open page');
  // three more resets in a row: still exactly the sample, no duplicates
  for (let i = 0; i < 3; i++) { a.w.eval('DemoReset._expireIn(0); DemoReset.check("again")'); }
  assertIsSample(a.w, 'after repeated resets', true);
  assert.equal(J(a.w, "JSON.parse(localStorage.getItem('pos_sales_log')).length"), 1);
});

test('8: an interrupted reset (cut off half-way) finishes on the next start; a broken baseline offline blocks the demo and deletes nothing; online it pulls the sample again', async (t) => {
  const a = await firstVisit(t);
  useDemo(a.w);
  // cut off half-way: some keys already removed, the rest still the visitor's, the deadline still old
  const st = deviceStorage(a.w); const m = JSON.parse(st.sd_reset_meta); m.deadline = Date.now() - 5; st.sd_reset_meta = JSON.stringify(m);
  delete st.pos_customers; delete st.pos_expenses;
  a.close();
  const b = await boot('index.html', { url: DEMO_URL('retail'), storage: st, fetch: offline, wait: 600 }); t.after(() => { try { b.close(); } catch (e) { /* closed */ } });
  assertIsSample(b.w, 'recovered after an interrupted reset');
  // a corrupt baseline, offline: nothing is deleted, the demo is blocked with a message
  quiet(b.w); useDemo(b.w);
  b.w.eval("localStorage.setItem('sd_baseline', '{\"v\":1,\"host\":\"demo-retail.mydukapos.store\",\"keys\":{}}')");
  Object.defineProperty(b.w.navigator, 'onLine', { configurable: true, get: () => false });
  b.w.eval('DemoReset._expireIn(0); DemoReset.check("offline")');
  assert.equal(J(b.w, "JSON.parse(localStorage.getItem('pos_inventory')).find(p => p.code === 'SUG').price"), 1, 'nothing was cleared');
  assert.match(b.d.getElementById('dr-block').textContent, /Connect to the internet/);
  // back online: the device's copy is cleared and the sample is pulled again from the server (which never stored the visitor's changes)
  Object.defineProperty(b.w.navigator, 'onLine', { configurable: true, get: () => true });
  b.w.eval("DemoReset.check('online')");
  assert.equal(J(b.w, "localStorage.getItem('pos_inventory')"), null, 'the visitor’s copy is gone; the next start pulls the sample');
  assert.equal(J(b.w, "localStorage.getItem('sd_baseline')"), null, 'the bad baseline is dropped (a new one is kept after the pull)');
  assert.ok(J(b.w, "!!localStorage.getItem('sd_confirmed')"), 'the demo stays confirmed');
});

test('9: stale offline edits never reach the server after the reset (no send of the old data)', async (t) => {
  const calls = [];
  const a = await firstVisit(t, 'retail', calls);
  useDemo(a.w);
  const st = deviceStorage(a.w); const m = JSON.parse(st.sd_reset_meta); m.deadline = Date.now() - 5; st.sd_reset_meta = JSON.stringify(m);
  a.close();
  calls.length = 0;
  const b = await boot('index.html', { url: DEMO_URL('retail'), storage: st, fetch: net('demo_retail', true, calls), wait: 2500 }); t.after(() => { try { b.close(); } catch (e) { /* closed */ } });
  assertIsSample(b.w, 'restored at start, online');
  const sent = calls.filter((c) => c.method === 'POST' && /pos-sync|push/.test(c.url));
  assert.ok(sent.every((c) => !/S-MINE|E-MINE|MY REAL SHOP|My own product/.test(c.body)), 'nothing of the old edits is sent: ' + sent.map((c) => c.url).join(','));
  assert.equal(J(b.w, "localStorage.getItem('pos_dirty_seq')"), J(b.w, "JSON.parse(localStorage.getItem('sd_baseline')).keys.pos_dirty_seq || null"), 'the unsent-work counter is the sample’s');
});

test('13, 14: two demos reset independently; a baseline from another demo address is never used', async (t) => {
  const r = await firstVisit(t, 'retail');
  const h = await firstVisit(t, 'hardware');
  useDemo(r.w); useDemo(h.w);
  r.w.eval('DemoReset._expireIn(0); DemoReset.check("x")');
  assertIsSample(r.w, 'retail reset', true);
  assert.equal(J(h.w, "JSON.parse(localStorage.getItem('pos_inventory')).find(p => p.code === 'SUG').price"), 1, 'hardware is untouched until its own hour');
  // a baseline copied from demo-hardware into demo-retail is rejected (its host is checked) - offline that means "blocked, nothing deleted"
  const hb = J(h.w, "localStorage.getItem('sd_baseline')");
  useDemo(r.w); r.w.eval(`localStorage.setItem('sd_baseline', ${JSON.stringify(hb)})`);
  Object.defineProperty(r.w.navigator, 'onLine', { configurable: true, get: () => false });
  r.w.eval('DemoReset._expireIn(0); DemoReset.check("y")');
  assert.equal(J(r.w, "JSON.parse(localStorage.getItem('pos_inventory')).find(p => p.code === 'SUG').price"), 1, 'not restored from another demo’s data');
});

// ----- normal shops: never eligible, nothing touched -----
const REAL = {
  pos_inventory: JSON.stringify([{ code: 'RICE', type: 'item', name: 'Pishori 2kg', price: 380, wholesalePrice: 300, qty: 17, unit: 'pcs', vatCategory: 'A' }]),
  pos_sales_log: JSON.stringify([{ id: 'REAL-UNSYNCED-1', refNumber: 'R-77', timestamp: new Date().toISOString(), paymentMethod: 'mpesa', mpesaAmount: 380, paid: true, items: [{ code: 'RICE', name: 'Pishori 2kg', qty: 1, price: 380 }] }]),
  pos_debts: JSON.stringify([{ id: 'RD-1', customerName: 'Otieno', amount: 1200, createdAt: new Date().toISOString(), payments: [] }]),
  pos_business_name: 'Mama Mboga Stores', pos_dirty_seq: '42', pos_acked_seq: '40',
  // even if old reset data were somehow on this device, a normal shop must ignore it
  sd_reset_meta: JSON.stringify({ host: 'x', deadline: 1, startedAt: 0, lastSeen: 0 }),
};
const snap = (w) => J(w, "(function(){ const o = {}; ['pos_inventory','pos_sales_log','pos_debts','pos_business_name','pos_dirty_seq','pos_acked_seq'].forEach(k => o[k] = localStorage.getItem(k)); return o; })()");

for (const [label, url, id, isDemo] of [
  ['a normal shop sub-domain', 'https://mama-mboga.mydukapos.store/', 'c_real1', false],
  ['a normal shop whose address starts with demo- (the server says it is NOT a shared demo)', 'https://demo-shop.mydukapos.store/', 'c_real2', false],
  ['a ?c=demo_ link on a shared address (its storage could hold a real shop)', 'https://mydukapos-3ao.pages.dev/?c=demo_retail', 'demo_retail', true],
]) {
  test(`10-12: ${label}: no reset ever runs - unsynced sales, stock, debts and settings stay exactly as they were`, async (t) => {
    const st = { ...REAL };
    if (/demo-shop/.test(url)) { st.sd_reset_meta = JSON.stringify({ host: 'demo-shop.mydukapos.store', deadline: 1, startedAt: 0, lastSeen: 0 }); st.sd_baseline = JSON.stringify({ v: 1, host: 'demo-shop.mydukapos.store', at: 1, keys: { pos_inventory: '[]' } }); }
    const dev = await boot('index.html', { url, storage: st, fetch: net(id, isDemo), wait: 2500 }); t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
    quiet(dev.w);
    const before = snap(dev.w);
    assert.equal(JSON.parse(before.pos_sales_log)[0].id, 'REAL-UNSYNCED-1');
    // use it, reload it, wait, tap: nothing resets
    dev.w.eval("try { DemoReset && DemoReset.check('x') } catch (e) {}");
    dev.d.body.dispatchEvent(new dev.w.MouseEvent('click', { bubbles: true }));
    dev.w.dispatchEvent(new dev.w.Event('focus'));
    const after = snap(dev.w);
    assert.deepEqual(after, before, 'every record unchanged');
    assert.equal(J(dev.w, "localStorage.getItem('sd_confirmed')"), null, 'never marked as a demo');
    assert.equal(dev.d.getElementById('dr-block'), null, 'never blocked');
    const again = await reopen(t, dev, url, net(id, isDemo));
    assert.deepEqual(snap(again.w), before, 'unchanged after a reopen too');
    assert.equal(J(again.w, "inventory.find(p => p.code === 'RICE').qty"), 17);
    if (!/pages\.dev/.test(url)) assert.equal(J(again.w, "typeof DemoReset === 'undefined' || !DemoReset.eligible()"), true);
  });
}

test('the manual Reset on a ?c=demo_ link on a shared address does not clear that address’s storage', async (t) => {
  const dev = await boot('index.html', { url: 'https://mydukapos-3ao.pages.dev/?c=demo_retail', storage: REAL, fetch: net('demo_retail', true), wait: 2500 }); t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  quiet(dev.w);
  if (!J(dev.w, "!!(window.SharedDemo && window.SharedDemo.reset)")) return;
  dev.w.eval('SharedDemo.reset()');
  assert.equal(J(dev.w, "localStorage.getItem('pos_business_name')"), 'Mama Mboga Stores', 'nothing cleared');
});

test('server: a shop named "Demo ..." made through the older address path never gets a demo- address', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../functions/api/_license.js', import.meta.url), 'utf8');
  assert.match(src, /async function pickUniqueSlug[\s\S]{0,300}startsWith\('demo-'\)\) wanted = 'shop-' \+ wanted/);
});

test('every app with the sample shops has the reset in <head>, straight after the storage layer and before any app script', async () => {
  const fs = await import('node:fs');
  for (const f of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html']) {
    const h = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const sc = h.indexOf('<!-- @shared-block:storage-compress:end -->'), dr = h.indexOf('<!-- @shared-block:demo-reset:begin -->'), head = h.indexOf('</head>');
    assert.ok(sc > 0 && dr > sc && dr < head, f);
    assert.equal(h.slice(sc, dr).replace(/\s+/g, ''), '<!--@shared-block:storage-compress:end-->', f + ': nothing runs between them');
    assert.ok(h.indexOf("if (label.indexOf('demo-') !== 0 || label.length < 6) return;") > dr, f + ': it does nothing off a demo address');
  }
});
