import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 127: "a sale was completed, paid and printed, but it is missing from Daily Sales". These tests follow the whole life of a sale:
// cart -> checkout -> saved on the device -> journal -> sync -> Daily Sales / reports, online and offline, across restarts.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const BASE = { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' };
const PRINTER = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.__prints = (window.__prints || 0) + 1; window.dispatchEvent(new window.Event('afterprint')); }; document.getElementById('login-screen').style.display = 'none'";

async function till(storage, idb, extra = {}) {
  const t = await boot('index.html', { storage, indexedDB: idb, wait: 900, ...extra });
  t.w.eval(PRINTER);
  t.sell = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
      t.d.getElementById('cash-tendered-input').value = '1000';
      await t.w.eval('checkoutCart()');
    }
  };
  t.print = async () => { await t.w.eval('printReceipt()'); };
  t.dailyRows = () => { t.w.eval('renderDailySales()'); return [...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state')); };
  t.ids = () => JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
  return t;
}
// Fill the device's storage completely (photos, long history...): the next save of the sales list fails.
const FILL = `(function(){ var s=''; for (var i=0;i<11000;i++) s+=String.fromCharCode(0x4e00+Math.floor(Math.random()*20000));
  var n=0; [10000,1000,100,10,1].forEach(function(sz){ try { for(;;){ localStorage.setItem('pos_photo_'+n, s.slice(0,sz)); n++; } } catch(e) {} }); return n; })()`;

test('ROOT CAUSE: storage full — a completed, printed sale survives a restart (it used to vanish)', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, idb);
  await sleep(200);
  t.w.eval(FILL);
  await t.sell();
  assert.equal(t.w.eval("localStorage.getItem('pos_sales_log')"), null, 'the device could not save the sale list (this is the failure)');
  const id = t.ids()[0];
  const d = JSON.parse(await t.w.eval(`salesJournalDurable('${id}').then(JSON.stringify)`));
  assert.equal(d.local, false);
  assert.equal(d.journal, true, 'but the journal holds it');
  assert.match(t.d.getElementById('receipt-save-status').textContent, /Sale saved/);
  await t.print();
  const st = deviceStorage(t.w); t.close();
  const t2 = await till(st, idb);                         // the app is closed and opened again, still offline
  await t2.w.eval('salesJournalReady');
  assert.deepEqual(t2.ids(), [id], 'the sale is back');
  assert.equal(t2.dailyRows().length, 1, 'and in Daily Sales');
  assert.match(t2.w.eval('syncJournalAuditEvents().map(e => e.action).join()'), /Sales recovered on this device/);
  t2.close();
});

test('TEST 1: online sale -> complete -> print -> Daily Sales; synced exactly once, one sync audit line', async () => {
  const server = makeServer();
  const idb = new IDBFactory();
  const t = await openDevice('index.html', server, BASE, 900, { indexedDB: idb });
  t.w.eval(PRINTER);
  t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000';
  await t.w.eval('checkoutCart()');
  await t.w.eval('printReceipt()');
  await t.w.eval('flushPendingPush()');
  await sleep(300);
  const id = t.w.eval('salesLog[0].id');
  t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();          // the cashier opens Daily Sales
  t.w.eval('renderDailySales()');
  const rows = [...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state'));
  assert.equal(rows.length, 1);
  assert.equal(t.w.eval(`salesSyncStatus('${id}')`), 'synced');
  assert.match(rows[0].innerHTML, /✓ synced/);
  const srv = server.serverState();
  assert.equal(srv.salesLog.filter((s) => s.id === id).length, 1, 'on the server once');
  const syncLines = JSON.parse(t.w.eval('JSON.stringify(syncJournalAuditEvents().filter(e => e.action === "Synced to the server"))'));
  assert.equal(syncLines.length, 1, 'one audit line for the successful sync');
  assert.match(syncLines[0].detail, /1 sale/);
  // pushing again (a retry, the next poll) never adds a second line or a second copy
  t.w.eval('markLocalDirty && markLocalDirty()'); await t.w.eval('pushNow()'); await t.w.eval('pushNow()');
  assert.equal(JSON.parse(t.w.eval('JSON.stringify(syncJournalAuditEvents().filter(e => e.action === "Synced to the server"))')).length, 1);
  assert.equal(server.serverState().salesLog.filter((s) => s.id === id).length, 1);
  t.close();
});

test('TESTS 2, 3, 4: offline sale -> Daily Sales at once -> restart -> still there -> online -> synced exactly once', async () => {
  const server = makeServer();
  server.state.down = true;
  const idb = new IDBFactory();
  const t = await openDevice('index.html', server, BASE, 900, { indexedDB: idb });
  t.w.eval(PRINTER);
  t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000';
  await t.w.eval('checkoutCart()');
  await t.w.eval('printReceipt()');
  const id = t.w.eval('salesLog[0].id');
  t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();
  t.w.eval('renderDailySales()');
  assert.equal([...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state')).length, 1, 'TEST 2: listed at once, offline');
  assert.notEqual(t.w.eval(`salesSyncStatus('${id}')`), 'synced');
  assert.match(t.d.getElementById('sj-summary').textContent, /not on the server yet/);
  const st = deviceStorage(t.w); t.close();
  // TEST 3: closed and reopened, still offline
  const t2 = await openDevice('index.html', server, st, 900, { indexedDB: idb });
  t2.w.eval(PRINTER);
  await t2.w.eval('salesJournalReady');
  assert.deepEqual(JSON.parse(t2.w.eval('JSON.stringify(salesLog.map(s => s.id))')), [id]);
  assert.equal(t2.w.eval(`salesSyncStatus('${id}')`) === 'synced', false, 'still waiting to be sent — and it says so');
  // TEST 4: back online
  server.state.down = false;
  await t2.w.eval('flushPendingPush()');
  await sleep(200);
  assert.equal(server.serverState().salesLog.filter((s) => s.id === id).length, 1, 'on the server exactly once');
  assert.equal(t2.w.eval(`salesSyncStatus('${id}')`), 'synced');
  assert.equal(t2.w.eval('salesLog.length'), 1, 'and still on the device');
  t2.close();
});

test('TESTS 5, 6, 12: server unavailable — the sale stays, retries by itself, no failure lines in the Audit; repeated sends never duplicate', async () => {
  const server = makeServer();
  const idb = new IDBFactory();
  const t = await openDevice('index.html', server, BASE, 900, { indexedDB: idb });
  t.w.eval(PRINTER);
  t.w.eval('window.__pushBusyRetryMs = 5');
  server.state.status = 503;                                         // the server answers "busy / failed"
  t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000';
  await t.w.eval('checkoutCart()');
  const id = t.w.eval('salesLog[0].id');
  for (let i = 0; i < 3; i++) { await t.w.eval('pushNow()'); }
  assert.equal(t.w.eval('salesLog.length'), 1, 'TEST 5: kept on the device');
  assert.equal(t.w.eval(`salesSyncStatus('${id}')`), 'retrying');
  assert.equal(t.w.eval('salesJournalPendingCount()'), 1, 'still queued');
  assert.ok(t.w.eval('window.__pushRetryTimer != null'), 'a retry is scheduled by itself');
  const audit = t.w.eval('JSON.stringify(buildAuditEvents().filter(e => e.module === "Sync"))');
  assert.doesNotMatch(audit, /fail|busy|refused|retry|error/i, 'TEST 12: no failure noise in the business Audit');
  assert.match(t.w.eval("localStorage.getItem('pos_sync_journal_v1')"), /server was busy|refused/, 'the technical journal still records it');
  server.state.status = null;
  for (let i = 0; i < 4; i++) { t.w.eval('markLocalDirty()'); await t.w.eval('pushNow()'); }   // TEST 6: the same send, several times
  assert.equal(server.serverState().salesLog.filter((s) => s.id === id).length, 1, 'no duplicate on the server');
  assert.equal(t.w.eval('salesLog.length'), 1, 'no duplicate on the device');
  assert.equal(JSON.parse(t.w.eval('JSON.stringify(syncJournalAuditEvents().filter(e => e.action === "Synced to the server"))')).length, 1, 'TEST 13: one sync line');
  t.close();
});

test('TESTS 7, 8: several sales in quick succession, each printed — every one is in Daily Sales and in reports', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, idb);
  for (let i = 0; i < 8; i++) { await t.sell(); await t.print(); }
  assert.equal(t.dailyRows().length, 8);
  t.w.eval("document.getElementById('reports-range-select') && (document.getElementById('reports-range-select').value = 'today')");
  assert.equal(t.w.eval('reportSales(reportsRange()).length'), 8, 'reports see them all');
  const printed = JSON.parse(t.w.eval('JSON.stringify(salesLog.filter(s => s.printedAt).length)'));
  assert.equal(printed, 8, 'every printed receipt has its sale');
  const st = deviceStorage(t.w); t.close();
  const t2 = await till(st, idb);
  await t2.w.eval('salesJournalReady');
  assert.equal(t2.dailyRows().length, 8, 'and after a restart');
  t2.close();
});

test('TEST 9: business date is Kenya time — a sale at 00:30 EAT is today even on a till whose clock zone is UTC', async () => {
  const t = await till(BASE, new IDBFactory());
  // 2026-03-10 00:30 in Nairobi = 2026-03-09 21:30 UTC; the tests run with the machine on UTC
  assert.equal(t.w.eval("bizDayKey('2026-03-09T21:30:00.000Z')"), '2026-03-10');
  assert.equal(t.w.eval("bizDayKey('2026-03-09T20:59:59.000Z')"), '2026-03-09', 'one second before midnight in Nairobi');
  assert.equal(t.w.eval("dateKey(new Date('2026-03-09T21:30:00.000Z'))"), '2026-03-10');
  assert.equal(t.w.eval('dateKey(new Date(2026, 2, 10))'), '2026-03-10', 'a calendar day picked on the device keeps its date');
  const b = JSON.parse(t.w.eval("JSON.stringify(bizDayBounds('2026-03-10'))"));
  assert.equal(new Date(b.from).toISOString(), '2026-03-09T21:00:00.000Z');
  assert.equal(new Date(b.to).toISOString(), '2026-03-10T20:59:59.999Z');
  // the dashboard / daily totals count it on the right day (they used the UTC date of the timestamp)
  t.w.eval("salesLog.push({ id: 'late', timestamp: '2026-03-09T21:30:00.000Z', paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }] })");
  assert.equal(t.w.eval("revenueForDate('2026-03-10')"), 100);
  assert.equal(t.w.eval("revenueForDate('2026-03-09')"), 0);
  // Daily Sales for that day lists it
  t.w.eval("document.getElementById('sales-table-date-picker').value = '2026-03-10'; document.getElementById('sales-table-date-picker').dataset.auto = '0'");
  assert.equal(t.dailyRows().length, 1);
  t.close();
});

test('a device whose clock is wrong: new sales are dated by the server clock, and a banner says so', async () => {
  const t = await till(BASE, new IDBFactory());
  t.w.eval("localStorage.setItem('pos_clock_offset', JSON.stringify({ off: 2 * 86400000, at: Date.now() }))");
  t.close();
  const t2 = await till(Object.assign({}, BASE, { pos_clock_offset: JSON.stringify({ off: 2 * 86400000, at: Date.now() }) }), new IDBFactory());
  await t2.sell();
  const s = JSON.parse(t2.w.eval('JSON.stringify(salesLog[0])'));
  assert.ok(Date.parse(s.timestamp) - Date.parse(s.deviceTimestamp) > 86400000, 'dated by the correct (server) time');
  assert.match(t2.d.getElementById('journal-clock-banner').textContent, /clock is 2 days behind/);
  t2.close();
});

test('deliberate removals are respected: reset / delete voided never come back from the journal', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, idb);
  await t.w.eval('salesJournalReady');
  await t.sell(3);
  t.w.eval('salesLog[0].voided = true; salesLog[0].voidedAt = Date.now(); safeSetItem("pos_sales_log", JSON.stringify(salesLog))');
  t.w.eval('performDeleteVoidedSales()');
  assert.equal(t.w.eval('salesLog.length'), 2);
  await sleep(100);
  const st = deviceStorage(t.w); t.close();
  const t2 = await till(st, idb);
  await t2.w.eval('salesJournalReady');
  assert.equal(t2.w.eval('salesLog.length'), 2, 'the deleted voided sale stays deleted');
  t2.w.eval('performResetExceptInventory()');
  await sleep(100);
  const st2 = deviceStorage(t2.w); t2.close();
  const t3 = await till(st2, idb);
  await t3.w.eval('salesJournalReady');
  assert.equal(t3.w.eval('salesLog.length'), 0, 'a reset stays reset');
  t3.close();
});

test('the list lost on the device (unreadable storage): the journal puts back the unsynced sales; missing-sales check agrees', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, idb);
  await t.sell(2);
  await sleep(100);
  const st = deviceStorage(t.w); t.close();
  delete st.pos_sales_log; Object.keys(st).filter((k) => k.startsWith('pos_sales_log')).forEach((k) => delete st[k]);
  const t2 = await till(st, idb);
  await t2.w.eval('salesJournalReady');
  assert.equal(t2.w.eval('salesLog.length'), 2);
  const r = JSON.parse(await t2.w.eval('salesJournalReconcile().then(JSON.stringify)'));
  assert.equal(r.local, 2);
  assert.equal(r.journalMissing.length, 0);
  assert.equal(r.printedMissing.length, 0);
  t2.close();
});

test('receipt: the button reads "Cancel / Save" and closing it never cancels the sale', async () => {
  const t = await till(BASE, new IDBFactory());
  await t.sell();
  const btn = [...t.d.querySelectorAll('#receipt-modal .receipt-actions button')].find((b) => /Cancel/.test(b.textContent));
  assert.equal(btn.textContent.trim(), 'Cancel / Save');
  btn.click();
  assert.equal(t.d.getElementById('receipt-modal').style.display, 'none');
  assert.equal(t.w.eval('salesLog.length'), 1);
  assert.equal(t.dailyRows().length, 1);
  t.close();
});

test('every app carries the journal and the "Cancel / Save" receipt button', async () => {
  for (const app of ['water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {
    const t = await boot(app, { indexedDB: new IDBFactory(), wait: 700 });
    assert.equal(t.w.eval('typeof salesJournalDurable'), 'function', app);
    assert.equal(t.w.eval('typeof syncToThisDevice'), 'function', app);
    assert.match(t.d.getElementById('receipt-modal').textContent, /Cancel \/ Save/, app);
    t.close();
  }
});

test('TEST 14: "Sync to this device" — sends this device\'s unsent sale first, fetches the other till\'s, no duplicates, nothing lost', async () => {
  const server = makeServer();
  const a = await openDevice('index.html', server, BASE, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER);
  for (let i = 0; i < 2; i++) { a.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); a.d.getElementById('cash-tendered-input').value = '1000'; await a.w.eval('checkoutCart()'); }
  await a.w.eval('flushPendingPush()');
  const aIds = JSON.parse(a.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
  a.close();
  // device B: made a sale while offline, has not seen A's sales
  server.state.down = true;
  const b = await openDevice('index.html', server, BASE, 900, { indexedDB: new IDBFactory() });
  b.w.eval(PRINTER);
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = '1000';
  await b.w.eval('checkoutCart()');
  const bId = b.w.eval('salesLog[0].id');
  server.state.down = false;
  b.w.eval("window.__steps = []");
  const r = JSON.parse(await b.w.eval("syncToThisDevice(function (i, s, t) { window.__steps.push([i, s]); }).then(JSON.stringify)"));
  assert.equal(r.ok, true, r.error);
  const ids = JSON.parse(b.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
  assert.deepEqual(ids.slice().sort(), [...aIds, bId].sort(), 'B now has all three sales, each once');
  const srv = server.serverState().salesLog.map((s) => s.id);
  assert.deepEqual(srv.slice().sort(), [...aIds, bId].sort(), 'the server has all three, each once');
  assert.equal(b.w.eval(`salesSyncStatus('${bId}')`), 'synced');
  const steps = JSON.parse(b.w.eval('JSON.stringify(window.__steps)'));
  assert.ok(steps.some(([i, s]) => i === 1 && s === 'ok') && steps.some(([i, s]) => i === 4), 'progress is reported step by step');
  // running it again changes nothing
  const r2 = JSON.parse(await b.w.eval('syncToThisDevice().then(JSON.stringify)'));
  assert.equal(r2.ok, true);
  assert.equal(b.w.eval('salesLog.length'), 3);
  assert.equal(server.serverState().salesLog.length, 3);
  // it appears in the Audit as one "Synced to this device" line each time it ran
  assert.match(b.w.eval('syncJournalAuditEvents().map(e => e.action).join()'), /Synced to this device/);
  b.close();
});

test('TEST 14: "Sync to this device" respects "only paired devices may sync" — an unpaired device is asked to pair, and loses nothing', async () => {
  const server = makeServer();
  server.kv.data.set('device-auth:C1', { value: JSON.stringify({ mode: 'paired', devices: {} }) });
  const b = await openDevice('index.html', server, BASE, 900, { indexedDB: new IDBFactory() });
  b.w.eval(PRINTER);
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = '1000';
  await b.w.eval('checkoutCart()');
  const r = JSON.parse(await b.w.eval('syncToThisDevice().then(JSON.stringify)'));
  assert.equal(r.ok, false);
  assert.match(r.error, /Pair this device/);
  assert.ok(b.d.getElementById('device-pair-screen'), 'the pairing screen is shown');
  assert.equal(b.w.eval('salesLog.length'), 1, 'the sale stays on the device');
  b.close();
});
