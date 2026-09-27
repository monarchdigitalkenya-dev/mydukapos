import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT, boot, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// Zip 131: final "no sale is ever hidden" audit.
//  1. A database shop only lists the logs it holds rows for: before its first sale arrives, its answer has NO salesLog at all.
//     Every app applied that as "no sales" and wiped the sales this device had not sent yet (e.g. one made while the pull was
//     on its way).
//  2. The journal put a lost unsent sale back only at the next start-up; now at once.
//  3. The device archive could move old sales the server had never confirmed; those are what gets sent, so they now stay.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sale = (id, extra = {}) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }], total: 100, ...extra });
const APPS6 = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

test('server: a database shop with no sales yet answers without any salesLog (the condition behind bug 1)', { skip: !hasSqlite && 'node:sqlite missing' }, async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  const sync = await load('pos-sync.js');
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', updatedAt: Date.now(), inventory: [] }) }), env, waitUntil() {} });
  const os = await load('owner-storage.js');
  await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-storage', { method: 'POST', body: JSON.stringify({ action: 'migrate', clientId: 'C1' }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env });
  const res = await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1'), env, waitUntil() {} });
  const body = await res.json();
  assert.ok(body.updatedAt > 0);
  assert.equal('salesLog' in body, false, 'no salesLog in the answer');
});

for (const app of APPS6) {
  test(`${app}: a pull whose answer has no salesLog keeps this device's unsent sales (bug 1)`, async () => {
    const t = await boot(app, { storage: { pos_biz_name: 'Biz' }, indexedDB: new IDBFactory(), wait: 900 });
    t.w.eval(`salesLog.push(${JSON.stringify(sale('mine1'))}); safeSetItem('pos_sales_log', JSON.stringify(salesLog))`);
    t.w.eval(`applyRemotePayload(preparePulledPayload({ updatedAt: Date.now() + 5000, businessName: 'Biz', inventory: [] }))`);
    assert.deepEqual(JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id))')), ['mine1'], 'still in the list');
    assert.deepEqual(JSON.parse(t.w.localStorage.getItem('pos_sales_log')).map((s) => s.id), ['mine1'], 'still saved on the device');
    // and an answer that DOES list sales still merges as before (the server's plus this device's own)
    t.w.eval(`applyRemotePayload(preparePulledPayload({ updatedAt: Date.now() + 9000, businessName: 'Biz', salesLog: [${JSON.stringify(sale('other1'))}] }))`);
    assert.deepEqual(JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id).sort())')), ['mine1', 'other1']);
    t.close();
  });
}

test('a sale not yet on the server that disappears from the list mid-session is put back at once (bug 2)', async () => {
  const t = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, indexedDB: new IDBFactory(), wait: 900 });
  await t.w.eval('salesJournalReady');
  t.w.eval(`salesLog.push(${JSON.stringify(sale('lost1'))}); safeSetItem('pos_sales_log', JSON.stringify(salesLog))`);
  await until(() => t.w.eval("salesJournalDurable('lost1').then(d => window.__d = d), window.__d && window.__d.journal"), 5000);
  t.w.eval("salesLog = []; safeSetItem('pos_sales_log', JSON.stringify(salesLog))");       // any code path that drops it
  await until(() => t.w.eval("salesLog.some(s => s.id === 'lost1')"), 5000);
  assert.ok(JSON.parse(t.w.localStorage.getItem('pos_sales_log')).some((s) => s.id === 'lost1'), 'saved again');
  t.close();
});

test('a deliberate removal (delete voided sales) is NOT undone by the safety net', async () => {
  const t = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, indexedDB: new IDBFactory(), wait: 900 });
  await t.w.eval('salesJournalReady');
  t.w.eval(`salesLog.push(${JSON.stringify(sale('void1', { voided: true }))}, ${JSON.stringify(sale('keep1'))}); safeSetItem('pos_sales_log', JSON.stringify(salesLog))`);
  await new Promise((r) => setTimeout(r, 300));
  t.w.eval('performDeleteVoidedSales()');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id))')), ['keep1']);
  t.close();
});
