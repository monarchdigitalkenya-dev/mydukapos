import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { boot } from './helpers.mjs';

// zip 186 (item 5), every till app: a restock / a stock take applied and the page refreshed straight away (server up or down) must come back with the new figure.
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 10, wholesalePrice: 5, qty: 30, unit: 'pcs', vatCategory: 'A' },
];
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const qty = (w, c = 'A') => w.eval(`inventory.find(p => p.code === '${c}').qty`);
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true; window.print = () => {}');
const srv = (s, c = 'A') => s.serverState().inventory.find((p) => p.code === c).qty;
const refresh = async (dev, app, s, wait = 900) => { const st = deviceStorage(dev.w); dev.close(); const n = await openDevice(app, s, st, wait); quiet(n.w); return n; };

for (const app of APPS) for (const mode of ['down', 'up']) test(`${app}: restock, immediate refresh, server ${mode}: the stock is still 150 and reaches the server once`, { timeout: 90000 }, async () => {
  const s = makeServer();
  let a = await openDevice(app, s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  if (mode === 'down') s.state.down = true;
  a.w.eval(`restockDraft = [{ rowId: 1, code: 'A', name: '', unit: 'pcs', qty: '50', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()`);
  assert.equal(qty(a.w), 150);
  a = await refresh(a, app, s, 1200);
  assert.equal(qty(a.w), 150, 'after the refresh');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 150, 'after sync');
  assert.equal(srv(s), 150, 'server');
  a = await refresh(a, app, s, 1200);
  assert.equal(qty(a.w), 150, 'after the second refresh');
  a.close();
});

for (const app of APPS) for (const mode of ['down', 'up']) test(`${app}: stock take, immediate refresh, server ${mode}: the count survives`, { timeout: 90000 }, async () => {
  const s = makeServer();
  let a = await openDevice(app, s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  if (mode === 'down') s.state.down = true;
  a.w.eval("stockTakeSet('A','qty','120'); stockTakeApplyOne('A')");
  assert.equal(qty(a.w), 120);
  a = await refresh(a, app, s, 1200);
  assert.equal(qty(a.w), 120, 'after the refresh');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  a = await refresh(a, app, s, 1200);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  a.close();
});

// Aqua POS has its own restock form and stock-take (per site cells)
const PROD = { code: 'W20', category: 'bottled', name: '20L Bottle', price: 50, wholesalePrice: 20, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 20000, stock: { 'site-production': 100, 'site-shop-1': 10 } };
const WURL = 'https://x.mydukapos.store/water/?c=x#shop';
const wopen = async (s, storage, wait = 1200) => { const b = await boot('water/index.html', { url: WURL, fetch: s.fetch, storage, wait }); b.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}"); return b; };
const wqty = (w) => w.eval("products.find(x => x.code === 'W20').qty");
const wsrv = (s) => s.serverState().products.find((p) => p.code === 'W20').stock['site-shop-1'];
for (const mode of ['down', 'up']) test(`water: restock, immediate refresh, server ${mode}: 10 + 5 = 15 survives`, { timeout: 90000 }, async () => {
  const s = makeServer();
  let a = await wopen(s, { aqua_products: JSON.stringify([PROD]) });
  await a.w.eval('doPush()'); await a.w.eval('pullFromServer()');
  if (mode === 'down') s.state.down = true;
  a.w.eval("restockIsNewEntry = false; restockClassification = 'item'; renderRestockExistingPicker()");
  const d = a.w.document;
  d.getElementById('restock-existing-select').value = 'W20'; d.getElementById('restock-qty-input').value = '5';
  a.w.eval('submitRestock()');
  assert.equal(wqty(a.w), 15);
  const st = deviceStorage(a.w); a.close();
  a = await wopen(s, st);
  assert.equal(wqty(a.w), 15, 'after the refresh');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(wqty(a.w), 15); assert.equal(wsrv(s), 15);
  const st2 = deviceStorage(a.w); a.close();
  a = await wopen(s, st2);
  assert.equal(wqty(a.w), 15); assert.equal(wsrv(s), 15);
  a.close();
});
for (const mode of ['down', 'up']) test(`water: stock take, immediate refresh, server ${mode}: the count survives`, { timeout: 90000 }, async () => {
  const s = makeServer();
  let a = await wopen(s, { aqua_products: JSON.stringify([PROD]) });
  await a.w.eval('doPush()'); await a.w.eval('pullFromServer()');
  if (mode === 'down') s.state.down = true;
  const key = a.w.eval("aquaCellKey(aquaStockTakeRows().find(x => x.rec.code === 'W20' && x.cell.f === 'stock').cell)");
  a.w.eval(`aquaStockTakeState().counts[${JSON.stringify(key)}] = '7'`);
  a.w.eval(`aquaStockTakeApply(${JSON.stringify(key)})`);
  assert.equal(wqty(a.w), 7);
  const st = deviceStorage(a.w); a.close();
  a = await wopen(s, st);
  assert.equal(wqty(a.w), 7, 'after the refresh');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(wqty(a.w), 7); assert.equal(wsrv(s), 7);
  const st2 = deviceStorage(a.w); a.close();
  a = await wopen(s, st2);
  assert.equal(wqty(a.w), 7); assert.equal(wsrv(s), 7);
  a.close();
});
