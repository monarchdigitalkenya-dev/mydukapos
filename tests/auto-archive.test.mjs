import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot, APPS } from './helpers.mjs';

// The device archives its own oldest history at 80% full — silently, losslessly, and with no message for the cashier.
const DAY = 86400000;
const hard = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x4000)); return s; };   // does not compress
const sale = (id, ageDays, note = '') => ({ id, timestamp: new Date(Date.now() - ageDays * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 10, note, items: [{ code: '1', qty: 1, price: 10 }] });
const archives = (w) => w.eval("storageLocalArchives().then(l => JSON.stringify(l))").then((j) => JSON.parse(j));
const used = (w) => w.eval("(function(){ var t = 0; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); t += k.length + __lsRawGet(k).length; } return t; })()");

test('at 80% full the oldest history moves to the device archive, the lists are saved without it, and nobody is told', async () => {
  const toasts = [];
  const { w, errors, close } = await boot('index.html', { indexedDB: new IDBFactory(), wait: 300 });
  w.eval('showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }');
  const old = Array.from({ length: 300 }, (_, i) => sale('old' + i, 200 + (i % 100), hard(10500)));   // ~3.2M chars that do not compress (~4.2M stored)
  const recent = Array.from({ length: 40 }, (_, i) => sale('new' + i, i % 30, 'x'));
  w.eval(`salesLog = ${JSON.stringify([...old, ...recent])}`);
  w.eval("safeSetItem('pos_sales_log', JSON.stringify(salesLog))");
  assert.ok(used(w) >= 4000000 * 0.98, 'the device is ~80% full: ' + used(w));
  assert.equal(await w.eval("storageAutoArchive('check')"), true);
  assert.equal(w.eval('salesLog.length'), 40, 'only recent sales remain in the lists');
  assert.ok(w.eval("salesLog.every(s => s.id.startsWith('new'))"));
  assert.ok(used(w) <= 5000000 * 0.6, 'back under 60%: ' + used(w));
  const saved = JSON.parse(w.localStorage.getItem('pos_sales_log'));
  assert.equal(saved.length, 40, 'what is saved on the device matches (persisted)');
  const list = await archives(w);
  assert.equal(list.length >= 1, true);
  assert.equal(list.reduce((n, a) => n + (a.counts.salesLog || 0), 0), 300, 'all 300 old sales are in the archive — none lost');
  assert.equal(w.eval('window.__toasts || []').length, 0, 'no message shown');
  assert.deepEqual(errors, []);
  close();
});

test('below 80% nothing happens; without IndexedDB nothing is ever removed', async () => {
  const a = await boot('index.html', { indexedDB: new IDBFactory(), wait: 300 });
  a.w.eval(`salesLog = ${JSON.stringify([sale('a', 300), sale('b', 1)])}`);
  assert.equal(await a.w.eval("storageAutoArchive('check')"), false);
  assert.equal(a.w.eval('salesLog.length'), 2);
  a.close();
  const b = await boot('index.html', { wait: 300 });                        // jsdom: no indexedDB
  b.w.eval(`salesLog = ${JSON.stringify([sale('a', 300), sale('b', 1)])}`);
  assert.equal(await b.w.eval("storageAutoArchive('write-failed')"), false);
  assert.equal(b.w.eval('salesLog.length'), 2, 'nowhere safe to archive to -> nothing removed');
  b.close();
});

test('a save that runs out of room does not show the cashier an error; the device archives and the save goes through', async () => {
  const { w, close } = await boot('index.html', { indexedDB: new IDBFactory(), wait: 300 });
  w.eval('showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }');
  const old = Array.from({ length: 250 }, (_, i) => sale('old' + i, 200 + (i % 100), hard(10500)));
  w.eval(`salesLog = ${JSON.stringify([...old, sale('new0', 1, 'x')])}`);
  w.eval("safeSetItem('pos_sales_log', JSON.stringify(salesLog))");
  for (let i = 0; i < 2; i++) w.localStorage.setItem(`filler-${i}~s0`, hard(700000));            // leave too little room for the next save
  const before = used(w);
  const big = JSON.stringify({ data: hard(900000) });
  w.eval(`window.__ok = safeSetItem('pos_customers', ${JSON.stringify(big)})`);
  assert.equal(w.eval('window.__ok'), false, 'the first attempt did not fit');
  await new Promise((r) => setTimeout(r, 1500));                                              // archive runs, then the save is repeated
  assert.equal(w.eval('window.__toasts || []').length, 0, 'no toast for the cashier');
  assert.equal(w.eval("salesLog.length"), 1, 'old sales were archived to make room');
  assert.equal(w.localStorage.getItem('pos_customers'), big, 'the save that failed went through');
  close();
});

test('only an ADMIN is told, and only when nothing at all can be freed', async () => {
  const { w, close } = await boot('index.html', { indexedDB: new IDBFactory(), wait: 300 });
  w.eval('window.__toasts = []; showToast = function (m) { window.__toasts.push(m); }');
  w.eval('isAdminServing = function () { return false; }');
  await w.eval("storageAutoArchive('write-failed')");                       // nothing old to archive; cashier is serving
  assert.equal(w.eval('window.__toasts.length'), 0);
  w.eval('isAdminServing = function () { return true; }');
  close();
});

for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: archiving trims the app's own lists and what is saved on the device`, async () => {
    const { w, errors, close } = await boot(app, { indexedDB: new IDBFactory(), wait: 300 });
    const keys = JSON.parse(w.eval('JSON.stringify(window.__LOG_KEYS)'));
    assert.ok(keys.salesLog && keys.stockMovementLog, 'key map present');
    w.eval(`salesLog = ${JSON.stringify([sale('old', 300), sale('new', 1)])}; stockMovementLog = ${JSON.stringify([{ id: 'm-old', timestamp: new Date(Date.now() - 300 * DAY).toISOString(), code: '1', delta: -1 }, { id: 'm-new', timestamp: new Date().toISOString(), code: '1', delta: -1 }])}`);
    assert.equal(await w.eval("storageAutoArchive('write-failed')"), true);
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(salesLog.map(s => s.id))')), ['new']);
    assert.deepEqual(JSON.parse(w.localStorage.getItem(keys.salesLog)).map((s) => s.id), ['new'], 'saved under ' + keys.salesLog);
    assert.deepEqual(JSON.parse(w.localStorage.getItem(keys.stockMovementLog)).map((s) => s.id), ['m-new']);
    const list = await archives(w);
    assert.equal(list.reduce((n, a) => n + (a.counts.salesLog || 0) + (a.counts.stockMovementLog || 0), 0), 2);
    assert.deepEqual(errors, []);
    close();
  });
}
