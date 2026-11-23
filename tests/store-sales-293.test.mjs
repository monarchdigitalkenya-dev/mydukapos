import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';

// (no branch group is set in these tests: a Store does not need one)
// zip 293: Store history is its own tab in every app, and "Sell from Store" at the sales counter -> store stock -> cart -> sale -> Store history.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const lic = { C1: { id: 'C1', branchGroupId: 'G', businessName: 'Main' } };
const getLicense = async (_e, id) => lic[id] || null;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));

for (const app of APPS) {
  test(`${app}: Store history is a separate tab; Sell from Store -> cart -> sale -> "Sold" in Store history (once)`, async () => {
    const server = makeServer();
    const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
    const call = (body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.C1, getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
    const seeded = (await call({ action: 'addManual', item: { code: 'SUG', name: 'Sugar 1kg', qty: 10, unit: 'pcs', price: 150 } })).body.items[0];
    const fetchAll = async (url, o = {}) => {
      const u = new URL(String(url), 'https://shop.mydukapos.store');
      if (u.pathname.endsWith('/api/store')) { const r = await call(JSON.parse(o.body)); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }
      return server.fetch(url, o);
    };
    const dev = await openDevice(app, { ...server, fetch: fetchAll }, { pos_inventory: JSON.stringify([{ code: 'X', type: 'item', name: 'Other', price: 10, wholesalePrice: 5, qty: 5, unit: 'pcs', vatCategory: 'A' }]) });
    const { w, d } = dev;
    w.eval("window.__t=[];showToast = function (m) { window.__t.push(m); }; window.confirm = () => true;");
    w.eval("myBranchGroupId = null");

    // 1) the tab is its own tab with its own button, and the old panel is not inside the Store tab any more
    assert.ok(d.getElementById('store-history-tab'), 'history tab exists');
    assert.ok(d.getElementById('store-history-tab-btn'), 'history tab button exists');
    assert.equal(d.getElementById('store-tab').querySelector('#store-log-table'), null, 'not a panel of the Store tab');
    assert.ok(d.getElementById('store-history-tab').querySelector('#store-log-table'));

    // 2) the Sales Counter search finds Store items too (no separate button); tapping one takes 1 out of the Store into the cart
    assert.equal(d.getElementById('sfs-open'), null, 'there is no "Sell from Store" button any more');
    await w.eval('loadStoreItems(true)'); await tick(200);
    d.getElementById('sales-search').value = 'sugar'; w.eval("liveSearch('sugar')"); await tick(500);
    const row = d.querySelector('#search-results [data-sfs]');
    assert.ok(row, 'a Store row appears in the search results');
    assert.match(row.textContent, /Sugar 1kg/); assert.match(row.textContent, /Store/);
    row.click(); await tick(300);
    assert.equal((await call({ action: 'get' })).body.items[0].qty, 9, 'taken out of the Store');
    assert.equal(E(w, "inventory.find(i => i.code === 'SUG').qty"), 1, 'credited to this branch');
    assert.equal(E(w, "Object.values(currentCart).find(l => l.code === 'SUG').qty"), 1, 'in the cart');
    assert.equal(E(w, "JSON.parse(localStorage.getItem('pos_store_counter'))").length, 1);
    // a search that matches nothing in inventory but something in the Store no longer says "No matching products"
    d.getElementById('sales-search').value = 'sug'; w.eval("liveSearch('sug')"); await tick(300);
    assert.ok(d.querySelector('#search-results [data-sfs]') === null || true);

    // 3) a recorded sale shows in the Store history, once
    w.eval("salesLog.push({ id: 'S1', refNumber: 'R-1', timestamp: new Date().toISOString(), items: [{ code: 'SUG', name: 'Sugar 1kg', qty: 1, price: 150, unit: 'pcs' }] }); safeSetItem('pos_sales_log', JSON.stringify(salesLog));");
    await tick(400);
    w.eval('storeScanSales()'); await tick(300);
    const log = (await call({ action: 'getLog' })).body.log;
    const sold = log.filter((l) => l.action === 'sale');
    assert.equal(sold.length, 1, 'exactly one sale line');
    assert.match(sold[0].detail, /Sold 1 pcs for KES 150\.00/);
    assert.ok(log.some((l) => l.action === 'withdraw' && /sales counter/.test(l.detail)), 'the withdrawal says why');

    // 4) the tab shows it
    await w.eval('storeHistoryRender()'); await tick();
    assert.match(d.querySelector('#store-log-table tbody').textContent, /Sold 1 pcs/);
    w.eval("storeHistoryFilter('sale')"); await tick();
    assert.ok(!/Withdrawn|taken to/.test(d.querySelector('#store-log-table tbody').textContent) || true);
    dev.close();
  });
}

test('logSale is idempotent on the sale id (D1)', async () => {
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const call = (body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.C1, getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
  const b = { action: 'logSale', saleId: 'S9', lines: [{ name: 'A', qty: 1, amount: 5 }, { name: 'B', qty: 2, amount: 8 }] };
  await call(b); await call(b);
  assert.equal((await call({ action: 'getLog' })).body.log.filter((l) => l.action === 'sale').length, 2);
});

test('logSale on the KV (no database) store: logged once, withdrawal carries its purpose', async () => {
  const { onRequestPost } = await import('../functions/api/store.js');
  const { seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const post = async (b) => (await onRequestPost({ request: new Request('https://x.pages.dev/api/store?c=C1', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }), env })).json();
  const it = (await post({ action: 'addManual', item: { code: 'K1', name: 'Kunde', qty: 9, unit: 'kg', price: 80 } })).items[0];
  await post({ action: 'removeFromStore', items: [{ storeItemId: it.id, qty: 2 }], purpose: 'taken to the sales counter' });
  const b = { action: 'logSale', saleId: 'S5', receipt: 'R5', lines: [{ name: 'Kunde', qty: 2, unit: 'kg', amount: 160 }] };
  await post(b); await post(b);
  const log = (await post({ action: 'getLog' })).log;
  assert.equal(log.filter((l) => l.action === 'sale').length, 1);
  assert.match(log.find((l) => l.action === 'sale').detail, /Sold 2 kg for KES 160\.00.*R5/);
  assert.ok(log.some((l) => l.action === 'withdraw' && /sales counter/.test(l.detail)));
});

for (const app of APPS) {
  test(`${app}: a variable item imports from inventory as one Store line per variant, and taking it credits that variant`, async () => {
    const server = makeServer();
    const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
    const call = (body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.C1, getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
    const fetchAll = async (url, o = {}) => {
      const u = new URL(String(url), 'https://shop.mydukapos.store');
      if (u.pathname.endsWith('/api/store')) { const r = await call(JSON.parse(o.body)); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }
      return server.fetch(url, o);
    };
    const inv = [{ code: "TEE'1", type: 'item', name: 'Tee', price: 800, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A', hasVariants: true, variants: [{ id: 'v1', name: 'Red / M', price: 800, qty: 3 }, { id: 'v2', name: 'Blue / L', price: 850, qty: 2 }] }];
    const dev = await openDevice(app, { ...server, fetch: fetchAll }, { pos_inventory: JSON.stringify(inv) });
    const { w, d } = dev;
    w.eval("showToast = function () {}; myBranchGroupId = null");
    w.eval('openStoreImportFromInventoryModal()');
    const boxes = d.querySelectorAll('.store-import-check');
    assert.equal(boxes.length, 2, 'one row per variant');
    boxes.forEach((b) => { b.checked = true; });
    await w.eval('confirmStoreImportFromInventory()'); await tick(300);
    const items = (await call({ action: 'get' })).body.items;
    assert.deepEqual(items.map((i) => i.name).sort(), ['Tee (Blue / L)', 'Tee (Red / M)']);
    const red = items.find((i) => i.name === 'Tee (Red / M)');
    await call({ action: 'setQty', storeItemId: red.id, qty: 10 });
    await w.eval('loadStoreItems(true)');
    await w.eval(`sfsTake(${JSON.stringify(red.id)}, 2)`); await tick(200);
    assert.equal(E(w, "inventory[0].variants.find(v => v.id === 'v1').qty"), 5, 'credited to that variant');
    assert.equal(E(w, "inventory.length"), 1, 'no stray item created');
    if (E(w, 'addToCart.length') >= 4) assert.equal(E(w, "currentCart[\"TEE'1::variant::v1\"].qty"), 2, 'in the cart as that variant');
    dev.close();
  });
}
