import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 128: "make every hidden sale appear — including the ones from before the fix". Sales that existed but showed nowhere:
//  * in the SERVER's archive of a shop's old history (auto-archived at 80% of the size limit) — /api/history never read it, and a
//    shop moved to its own database left it behind;
//  * in THIS device's archive (moved there to save space) or only on the server (a device that lost them / a new device);
//  * with a broken date or item list on the device (showed on no day, or stopped Daily Sales from drawing).
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const DAY = 86400000;
const sale = (id, ageDays, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date(Date.now() - ageDays * DAY).toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }], ...extra });

async function serverWithArchive(kv, ids, ageDays) {
  const store = await load('_state-store.js');
  const keepDays = Math.max(7, ageDays - 10);                        // an archive holds records older than what the shop kept live
  await store.writeArchive({ mydukapos_kv: kv }, 'C1', { old: { salesLog: ids.map((id) => sale(id, ageDays)) }, keepDays, cutoff: Date.now() - keepDays * DAY, auto: true });
}
async function history(env, q) {
  const m = await load('history.js');
  const res = await m.onRequestGet({ request: new Request('https://x.pages.dev/api/history?c=C1&col=salesLog&' + q), env });
  return res.json();
}
async function allHistory(env, from, to, limit) {
  let after = '', out = [];
  for (let i = 0; i < 50; i++) {
    const b = await history(env, `from=${from}&to=${to}&limit=${limit}` + (after ? '&after=' + encodeURIComponent(after) : ''));
    out = out.concat(b.records); if (!b.next) break; after = b.next;
  }
  return out;
}

test('server: sales in the shop\'s ARCHIVE are returned by /api/history and counted by the day check (single-record shop)', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const sync = await load('pos-sync.js');
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), salesLog: [sale('live1', 1), sale('live2', 200)] }) }), env, waitUntil() {} });
  await serverWithArchive(kv, ['arch1', 'arch2', 'arch3'], 200);
  const got = await allHistory(env, Date.now() - 400 * DAY, Date.now() + DAY, 2);
  assert.deepEqual(got.map((s) => s.id).sort(), ['arch1', 'arch2', 'arch3', 'live1', 'live2'], 'archived sales now reachable, paged, no duplicates');
  const d = await load('day-summary.js');
  const day = new Date(Date.parse(sale('x', 200).timestamp)); const from = day.getTime() - 12 * 3600000, to = day.getTime() + 12 * 3600000;
  const sum = await (await d.onRequestGet({ request: new Request(`https://x.pages.dev/api/day-summary?c=C1&from=${from}&to=${to}`), env })).json();
  assert.equal(sum.count, 4, 'the day check counts the archived sales of that day too');
});

test('server: a shop moved to its own database still reaches the archive it had before the move', { skip: !hasSqlite && 'node:sqlite missing' }, async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  const sync = await load('pos-sync.js');
  const push = (b) => sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', updatedAt: Date.now(), ...b }) }), env, waitUntil() {} });
  await push({ salesLog: [sale('db1', 150), sale('db2', 150), sale('db3', 1)] });
  await serverWithArchive(kv, ['old1', 'old2', 'old3'], 150);
  const os = await load('owner-storage.js');
  const m = await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-storage', { method: 'POST', body: JSON.stringify({ action: 'migrate', clientId: 'C1' }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env });
  assert.equal((await m.json()).changed, true);
  assert.equal(kv.data.get('pos-data:mode:C1').value, 'do');
  for (const limit of [2, 1000]) {
    const got = await allHistory(env, Date.now() - 400 * DAY, Date.now() + DAY, limit);
    assert.deepEqual(got.map((s) => s.id).sort(), ['db1', 'db2', 'db3', 'old1', 'old2', 'old3'], 'page size ' + limit);
  }
});

const PRINTER = "showToast = function () {}; window.confirm = () => true; document.getElementById('login-screen').style.display = 'none'";
const openDaily = (t, dateKey) => {
  t.d.querySelector('.tab-link[data-tab="daily-sales-tab"]').click();
  if (dateKey) { const p = t.d.getElementById('sales-table-date-picker'); p.value = dateKey; p.dataset.auto = '0'; }
  t.w.eval('renderDailySales()');
};
const rows = (t) => [...t.d.querySelectorAll('#daily-sales-table tbody tr')].filter((r) => !r.querySelector('.empty-state'));

test('device: Daily Sales for an old day shows the sales kept only on the server and in this device\'s archive (📦), and they can be reprinted / voided', async () => {
  const server = makeServer();
  const env = server.env;
  await serverWithArchive(server.kv, ['srvA'], 40);
  const origFetch = server.fetch;
  const fetch = async (url, opts) => {
    const u = new URL(String(url), 'https://x');
    if (u.pathname.endsWith('/api/history')) { const m = await load('history.js'); return m.onRequestGet({ request: new Request('https://x.pages.dev/api/history?c=C1&' + u.search.slice(1)), env }); }
    return origFetch(url, opts);
  };
  const idb = new IDBFactory();
  const t = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, fetch, indexedDB: idb, wait: 900 });
  t.w.eval(PRINTER);
  // one more sale of that day sits in this device's own archive (moved there to save space)
  const dev = sale('devArch', 40);
  await t.w.eval(`new Promise(function (res) { var q = indexedDB.open('pos_local_archive', 1); q.onupgradeneeded = function () { q.result.createObjectStore('archives', { keyPath: 'id' }); };
    q.onsuccess = function () { var tx = q.result.transaction('archives', 'readwrite'); tx.objectStore('archives').put({ id: 'a1', at: Date.now(), keepDays: 30, counts: { salesLog: 1 }, fields: { salesLog: [${JSON.stringify(dev)}] } }); tx.oncomplete = function () { q.result.close(); res(); }; }; })`);
  const day = t.w.eval(`bizDayKey('${dev.timestamp}')`);
  openDaily(t, day);
  await sleep(600); t.w.eval('renderDailySales()');
  const shown = rows(t);
  assert.equal(shown.length, 2, 'both hidden sales are listed');
  assert.match(t.d.querySelector('#daily-sales-table').textContent, /R-srvA/);
  assert.match(t.d.querySelector('#daily-sales-table').textContent, /R-devArch/);
  assert.equal(t.d.querySelectorAll('#daily-sales-table .sj-badge').length >= 2, true);
  assert.match(t.d.querySelector('#daily-sales-table').textContent, /📦 history/);
  assert.equal(t.w.eval('salesLog.length'), 0, 'shown, not piled onto the device');
  t.w.eval("reprintSale('srvA')");
  assert.equal(t.d.getElementById('receipt-modal').style.display, 'flex', 'a history sale can be reprinted');
  assert.equal(t.w.eval('salesLog.length'), 1, '(it is taken into the device first)');
  t.close();
});

test('device, once: sales with a broken date / item list are repaired and appear; a sale the server has but this device lost comes back', async () => {
  const server = makeServer();
  const a = await openDevice('index.html', server, { pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval(PRINTER);
  a.w.eval(`salesLog.push(${JSON.stringify(sale('keep', 0))}, ${JSON.stringify(sale('lostHere', 0))}); safeSetItem('pos_sales_log', JSON.stringify(salesLog))`);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  assert.ok(server.serverState().salesLog.some((s) => s.id === 'lostHere'), 'the server has it');
  const st = deviceStorage(a.w); a.close();
  // this device then lost one of them (before zip 127), and holds an old record with no date and no item list
  const ts = Date.now() - 3600000;
  const list = JSON.parse(st.pos_sales_log ? st.pos_sales_log : '[]');
  const t = await openDevice('index.html', server, { ...st, pos_hidden_sales_recovery_v1: '', pos_sales_log: JSON.stringify([sale('keep', 0), { id: ts + '-brk', refNumber: 'R-brk', paymentMethod: 'cash', items: null }]) }, 900, { indexedDB: new IDBFactory() });
  t.w.eval(PRINTER);
  t.w.localStorage.removeItem('pos_hidden_sales_recovery_v1');
  const r = JSON.parse(await t.w.eval('salesJournalRecoverHidden(true).then(JSON.stringify)'));
  assert.equal(r.ok, true);
  // (the broken record was already repaired at start-up, before the app first drew — checked below)
  const ids = JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
  assert.ok(ids.includes('lostHere'), 'the sale this device lost is back from the server');
  const brk = JSON.parse(t.w.eval(`JSON.stringify(salesLog.find(s => s.id === '${ts}-brk'))`));
  assert.equal(Math.abs(Date.parse(brk.timestamp) - ts) < 1000, true, 'dated from its id (when it was made)');
  assert.deepEqual(brk.items, []);
  openDaily(t);
  assert.ok(rows(t).length >= 3, 'all of today\'s sales are listed, Daily Sales draws');
  assert.match(t.w.eval('syncJournalAuditEvents().map(e => e.detail).join()'), /fetched from the server/);
  assert.ok(t.w.localStorage.getItem('pos_hidden_sales_recovery_v1'), 'done once per device');
  void list;
  t.close();
});

test('the missing-sales check lists sales with an impossible date and moves one to today', async () => {
  const t = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, indexedDB: new IDBFactory(), wait: 900 });
  t.w.eval(PRINTER);
  t.w.eval(`salesLog.push(${JSON.stringify(sale('future', -400))}); safeSetItem('pos_sales_log', JSON.stringify(salesLog))`);
  assert.equal(t.w.eval('salesJournalImpossibleDates().length'), 1);
  openDaily(t);
  await t.w.eval('salesJournalReconcileUi()');
  assert.match(t.d.getElementById('sj-reconcile').textContent, /impossible date/);
  t.d.querySelector('#sj-reconcile [data-sj="today"]').click();
  await sleep(300);
  assert.equal(t.w.eval("bizDayKey(salesLog[0].timestamp) === todayDateString()"), true);
  assert.ok(t.w.eval('salesLog[0].deviceTimestamp'), 'the original date is kept');
  t.close();
});
