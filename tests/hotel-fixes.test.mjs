import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { boot, ROOT, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOP_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);

// ---------- 1. a settled bill is kept and shows under "Show closed bills" ----------
for (const app of SHOP_APPS) {
  test(`${app}: a fully settled bill is kept (closed) and shows under "Show closed bills"; a part-payment leaves it open; old closed bills are tidied away`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
    w.eval("showToast = function () {}; window.confirm = () => true");
    w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
    const nameEl = d.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane';
    await w.eval('checkoutCart()');
    assert.equal(w.eval('bills.length'), 1);
    const id = w.eval('bills[0].id');
    // part payment: still open
    w.eval(`openBillSettleModal('sale', '${id}')`);
    w.eval("setBillSettleType('partial')");
    d.getElementById('bill-settle-amount-input').value = '50';
    await w.eval('confirmBillSettle(true)');
    assert.equal(w.eval('bills[0].closed'), false); assert.equal(w.eval('bills[0].amountPaid'), 50);
    // the rest: closed, but KEPT
    w.eval(`openBillSettleModal('sale', '${id}')`);
    await w.eval('confirmBillSettle(true)');
    assert.equal(w.eval('bills.length'), 1, 'the settled bill is still in the list');
    assert.equal(w.eval('bills[0].closed'), true); assert.equal(w.eval('bills[0].amountPaid'), 200);
    assert.ok(w.eval('bills[0].closedAt'), 'with the time it was closed');
    // open list hides it; the closed toggle shows it
    w.eval('renderBillsTab()');
    assert.match(d.querySelector('#bills-table tbody').textContent, /No open bills right now/);
    const toggle = d.getElementById('bills-show-closed-toggle'); toggle.checked = true; w.eval('renderBillsTab()');
    assert.match(d.querySelector('#bills-table tbody').textContent, /Jane/); assert.match(d.querySelector('#bills-table tbody').textContent, /Closed/);
    assert.equal(d.getElementById('bills-open-count').textContent, '0', 'and it is not counted as open');
    // housekeeping: closed more than 90 days ago goes, recent stays
    w.eval("bills.push({ id: 'old1', customerName: 'Old', items: [{ name: 'x', price: 10, qty: 1 }], amountPaid: 10, closed: true, closedAt: new Date(Date.now() - 120 * 86400000).toISOString(), timestamp: new Date(Date.now() - 130 * 86400000).toISOString() })");
    assert.equal(w.eval('pruneClosedBills(90)'), 1);
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(bills.map(b => b.customerName))')), ['Jane']);
    assert.deepEqual(errors, []);
    close();
  });
}

// ---------- 2. bills only move forward on the server ----------
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
async function backends() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{ name: 'blob', push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); }, state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json() }];
  if (hasSqlite) {
    const { ShopStore } = await load('wildcard-router/shop-store.js');
    const store = new ShopStore(fakeDoState(), {});
    out.push({ name: 'db', store, push: async (b) => { await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) })); }, state: async () => JSON.parse(store.stateText(120)) });
  }
  return out;
}
test('server: a settled / more-paid bill is never put back by an older-looking copy, however new its timestamp; equal bills still go by time (both backends)', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    const open = { id: 'b1', customerName: 'Ann', items: [{ price: 100, qty: 2 }], amountPaid: 0, paymentHistory: [], closed: false, updatedAt: t };
    await b.push({ updatedAt: t, bills: [open] });
    await sleep(5);
    const paid = { ...open, amountPaid: 200, closed: true, paymentHistory: [{ amount: 200 }], updatedAt: t + 10 };
    await b.push({ updatedAt: Date.now(), bills: [paid] });
    await sleep(5);
    await b.push({ updatedAt: Date.now(), bills: [{ ...open, takeawayStatus: 'collected', updatedAt: t + 99999 }] });           // stale till, NEWER time, older state
    let st = await b.state();
    assert.equal(st.bills[0].closed, true, b.name + ': still closed'); assert.equal(st.bills[0].amountPaid, 200, b.name + ': the payment is still there');
    // a part payment is not lost either
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b2', customerName: 'Bob', items: [{ price: 100, qty: 2 }], amountPaid: 50, paymentHistory: [{ amount: 50 }], closed: false, updatedAt: t + 5 }] });
    await sleep(5);
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b2', customerName: 'Bob', items: [{ price: 100, qty: 2 }], amountPaid: 0, paymentHistory: [], closed: false, updatedAt: t + 5000 }] });
    st = await b.state();
    assert.equal(st.bills.find((x) => x.id === 'b2').amountPaid, 50, b.name + ': KES 50 paid is not wiped by a stale copy');
    // and a genuinely more advanced OLDER-stamped record still lands (a device with a skewed clock)
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b2', customerName: 'Bob', items: [{ price: 100, qty: 2 }], amountPaid: 200, paymentHistory: [{}, {}], closed: true, updatedAt: 1 }] });
    st = await b.state();
    assert.equal(st.bills.find((x) => x.id === 'b2').closed, true, b.name + ': the settled version wins even with an old stamp');
    // equally advanced: last write wins as before (a note edited on a bill)
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b3', customerName: 'Cy', items: [], amountPaid: 0, paymentHistory: [], dueDate: '2026-10-01', updatedAt: t }] });
    await sleep(5);
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b3', customerName: 'Cy', items: [], amountPaid: 0, paymentHistory: [], dueDate: '2026-11-01', updatedAt: t + 50 }] });
    st = await b.state();
    assert.equal(st.bills.find((x) => x.id === 'b3').dueDate, '2026-11-01', b.name + ': equal progress = newest wins');
  }
});

// ---------- 3. the sync dot: no words, no flicker ----------
for (const app of ['hotel/index.html', 'index.html', 'water/index.html', 'owner/index.html']) {
  test(`${app}: the sync indicator is a wordless dot (green online, black offline, orange syncing) that does not flicker on quick syncs or blips`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 800 });
    w.eval('window.__syncDotDelayMs = 120; window.__syncDotOfflineMs = 250');
    const el = d.getElementById('sync-status');
    const seen = [];
    new w.MutationObserver(() => seen.push(el.dataset.state)).observe(el, { attributes: true, attributeFilter: ['data-state'] });
    assert.equal(el.textContent, '', 'no words');
    assert.ok(el.classList.contains('sync-dot'));
    w.eval("markSync('synced')"); await sleep(30);
    assert.equal(el.dataset.state, 'synced'); assert.ok(el.classList.contains('sync-synced')); assert.equal(el.title, 'Online');
    seen.length = 0;
    // 20 quick polls (a poll that answers fast): the dot never leaves green
    for (let i = 0; i < 20; i++) { w.eval("markSync('syncing')"); await sleep(5); w.eval("markSync('synced')"); await sleep(5); }
    await sleep(200);
    assert.deepEqual(seen, [], 'no orange flashes on quick syncs');
    // a blip: offline for less than the delay, then back
    w.eval("markSync('offline')"); await sleep(60); w.eval("markSync('synced')"); await sleep(400);
    assert.deepEqual(seen, [], 'no black flash on a short blip');
    // a slow sync turns it orange, and it goes back to green
    w.eval("markSync('syncing')"); await sleep(300);
    assert.equal(el.dataset.state, 'syncing'); assert.ok(el.classList.contains('sync-syncing'));
    w.eval("markSync('synced')"); await sleep(30);
    assert.equal(el.dataset.state, 'synced');
    // really offline: black, and it stays black while it keeps trying (no orange every few seconds)
    seen.length = 0;
    w.eval("markSync('offline')"); await sleep(400);
    assert.equal(el.dataset.state, 'offline'); assert.ok(el.classList.contains('sync-offline')); assert.equal(el.title, 'Offline');
    for (let i = 0; i < 5; i++) { w.eval("markSync('syncing')"); await sleep(200); w.eval("markSync('offline')"); await sleep(20); }
    assert.deepEqual(seen, ['offline'], 'black stays black through repeated retries');
    w.eval("markSync('synced')"); await sleep(30);
    assert.equal(el.dataset.state, 'synced');
    assert.deepEqual(errors, []);
    close();
  });
}

// ---------- 4. printing does not wait on the network ----------
test('a receipt printed through the system dialog does not wait for a slow / hung "is a shop printer available" check, and remembers the answer', async () => {
  let checks = 0;
  const fetch = (url) => { if (String(url).includes('/api/print-relay')) { checks++; return new Promise(() => {}); } return Promise.reject(new Error('offline')); };   // hangs for ever
  const { w, close } = await boot('hotel/index.html', { fetch, wait: 600 });
  w.eval("showToast = function () {}; window.__relayWaitMs = 300; window.__printed = 0; window.print = () => { window.__printed++; window.dispatchEvent(new window.Event('afterprint')); }; lastReceiptText = 'x'");
  const t0 = Date.now();
  await w.eval('printViaSystemDialog()');
  assert.equal(w.eval('window.__printed'), 1, 'it printed');
  assert.ok(Date.now() - t0 < 2500, `and quickly (${Date.now() - t0} ms), not after the hung request`);
  const before = checks;
  const t1 = Date.now();
  await w.eval('printViaSystemDialog()');
  assert.ok(Date.now() - t1 < 2500);
  assert.equal(checks, before, 'the second print did not start another check while the first is still pending');
  close();
});

test('the print queue is not blocked for ever by a phone that never reports the print finished', async () => {
  const { w, close } = await boot('hotel/index.html', { wait: 500 });
  w.eval("window.__printSafetyMs = 250");
  const t0 = Date.now();
  await w.eval('runQueuedSystemPrint(() => { /* window.print() returns, no afterprint ever fires */ })');
  assert.ok(Date.now() - t0 < 3000);
  close();
});

// ---------- 5. the order ticket through the system printer: slip-sized paper, crisp black text ----------
for (const app of ['hotel/index.html', 'index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {
  test(`${app}: the order ticket sets a receipt-width, auto-length page (no wasted paper) and prints in pure heavy black like the receipt`, async () => {
    const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.match(html, /body\.printing-kitchen-ticket \.receipt-paper \* \{ color: #000 !important; background: transparent !important; \}/);
    assert.match(html, /body\.printing-kitchen-ticket \.receipt-paper \{[^}]*font-weight: 700/);
    assert.match(html, /body\.printing-kitchen-ticket \.receipt-paper \{[^}]*min-height: 0; height: auto/);
    assert.match(html, /setKitchenPrintPage\(\);\s*document\.body\.classList\.add\('printing-kitchen-ticket'\)/);
    const { w, d, close } = await boot(app, { fetch: () => Promise.reject(new Error('offline')), wait: 600 });
    w.eval("showToast = function () {}; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); }; lastKitchenTicketText = 'ORDER'; window.__relayWaitMs = 100");
    w.eval("receiptWidth = '80'");
    await w.eval('printKitchenTicketViaSystemDialog()');
    assert.match(d.getElementById('print-page-style').textContent, /@page \{ size: 80mm auto; margin: 0; \}/, 'a slip as wide as the receipt, as long as its lines');
    w.eval("receiptWidth = '58'");
    w.eval('setKitchenPrintPage()');
    assert.match(d.getElementById('print-page-style').textContent, /size: 58mm auto/, 'follows the receipt width setting');
    close();
  });
}
