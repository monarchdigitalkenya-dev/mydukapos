import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, deviceStorage } from './e2e-harness.mjs';
import { ledgerIntegrity } from '../functions/api/_merge.js';

// Aqua POS on the stock ledger (zip 118b): per-site product stock, bottle counts, tanks and raw materials are server-owned
// cells, each change applied once. Real Aqua apps (jsdom) talking to the real pos-sync server code.
const APP = 'water/index.html';
const PROD = { code: 'W20', category: 'bottled', name: '20L Bottle', price: 50, wholesalePrice: 20, qty: 0, unit: 'pcs', vatCategory: 'A', sizeML: 20000,
  stock: { 'site-production': 100, 'site-shop-1': 10 } };
const MAT = { id: 'mat-1', siteId: 'site-production', name: 'Caps', unitCost: 1, stockQty: 500 };
const open = async (s, hash, storage) => {
  const b = await boot(APP, { url: `https://x.mydukapos.store/water/?c=x#${hash}`, fetch: s.fetch, storage, wait: 1200 });
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  return b;
};
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);
const srvProd = (s) => s.serverState().products.find((p) => p.code === 'W20');
const sellAtShop = async (dev, n = 1) => { dev.w.eval(`(function(){ const p = products.find(x => x.code === 'W20'); p.qty -= ${n}; queuePush(); })()`); await settled(dev); };

async function shop() {
  const s = makeServer();
  const p = await open(s, 'production', { aqua_products: JSON.stringify([PROD]), aqua_raw_materials: JSON.stringify([MAT]) });
  await p.w.eval('doPush()'); await p.w.eval('pullFromServer()');
  assert.equal(p.w.eval('stockLedgerOn()'), true);
  assert.deepEqual(JSON.parse(p.w.eval("JSON.stringify(products[0]._ss.stock)")), PROD.stock, 'the server stamped its figures');
  return { s, p };
}

test('Aqua: two Shop tills selling from the same figure both count (10 - 1 - 1 = 8); Production output is untouched; refreshes change nothing', async () => {
  const { s, p } = await shop();
  const t1 = await open(s, 'shop', deviceStorage(p.w));
  const t2 = await open(s, 'shop', deviceStorage(p.w));
  assert.equal(t1.w.eval("products[0].qty"), 10);
  p.w.eval("(function(){ addStockAt(products[0], 'site-production', 50); syncQtyView(activeSiteId); queuePush(); })()");
  await settled(p);
  await sellAtShop(t1); await sellAtShop(t2);                      // neither till has seen the other's sale
  assert.deepEqual(srvProd(s).stock, { 'site-production': 150, 'site-shop-1': 8 });
  for (const d of [t1, t2, p]) { await d.w.eval('doPush()'); }      // re-sending everything (a refresh's first push)
  const again = await open(s, 'shop', deviceStorage(t1.w));        // t1 refreshed
  await again.w.eval('pullFromServer()');
  assert.deepEqual(srvProd(s).stock, { 'site-production': 150, 'site-shop-1': 8 });
  assert.equal(again.w.eval("products[0].qty"), 8);
  const moves = s.serverState().stockMovementLog.filter((m) => m.cell);
  assert.equal(moves.length, 3, 'one movement per real change (production +50, two sales)');
  assert.ok(moves.every((m) => m._srv && m._srv.applied), 'each confirmed by the server');
  assert.ok(ledgerIntegrity(s.serverState()).ok, 'PHASE 19: history and figures agree');
  [p, t1, t2, again].forEach((d) => d.close());
});

test('Aqua: tank litres and raw materials are ledgered too — a stale device cannot put an old level back', async () => {
  const { s, p } = await shop();
  const t = await open(s, 'shop', deviceStorage(p.w));
  const tankId = p.w.eval("tanks.find(x => x.siteId === 'site-shop-1').id");
  // Shop: tank filled to 3000 L; then a stale Production device renames its material and consumes 24 caps
  t.w.eval(`(function(){ const tk = tanks.find(x => x.id === '${tankId}'); tk.currentVolumeLiters = 3000; queuePush(); })()`);
  await settled(t);
  p.w.eval("(function(){ const m = rawMaterials.find(x => x.id === 'mat-1'); m.stockQty -= 24; m.name = 'Caps (blue)'; queuePush(); })()");
  await settled(p);
  t.w.eval("(function(){ const m = rawMaterials.find(x => x.id === 'mat-1'); m.stockQty -= 6; queuePush(); })()");   // the stale shop device also uses 6
  await settled(t);
  const st = s.serverState();
  assert.equal(st.tanks.find((x) => x.id === tankId).currentVolumeLiters, 3000);
  const m = st.rawMaterials.find((x) => x.id === 'mat-1');
  assert.equal(m.stockQty, 470, '500 - 24 - 6: both uses count');
  assert.equal(m.name, 'Caps (blue)', 'and the rename from the other device is kept');
  await p.w.eval('pullFromServer()'); await t.w.eval('pullFromServer()');
  assert.equal(p.w.eval("rawMaterials.find(x => x.id === 'mat-1').stockQty"), 470);
  assert.equal(t.w.eval(`tanks.find(x => x.id === '${tankId}').currentVolumeLiters`), 3000);
  p.close(); t.close();
});

test('Aqua: a change made offline syncs once on reconnect; the same push replayed does nothing', async () => {
  const { s, p } = await shop();
  const bodies = [];
  const f = s.fetch;
  s.fetch = async (url, opts = {}) => { if ((opts.method || 'GET').toUpperCase() === 'POST') bodies.push(opts.body); return f(url, opts); };
  const t = await open(s, 'shop', deviceStorage(p.w));
  s.state.down = true;
  await sellAtShop(t, 3);
  s.state.down = false;
  await t.w.eval('flushThenPull()'); await t.w.eval('flushThenPull()');
  assert.equal(srvProd(s).stock['site-shop-1'], 7);
  for (const b of bodies.slice()) await f('https://x.mydukapos.store/api/pos-sync', { method: 'POST', body: b });
  assert.equal(srvProd(s).stock['site-shop-1'], 7);
  p.close(); t.close();
});

test('Aqua Stock Take: counts one site (goods, bottle-tracked bales in bottles, tanks, materials), applies once, synced history', async () => {
  const { s, p } = await shop();
  const b = await open(s, 'shop', deviceStorage(p.w));
  const tankId = b.w.eval("tanks.find(x => x.siteId === 'site-shop-1').id");
  b.w.eval("document.getElementById('stock-take-tab-btn').click()");
  await new Promise((r) => setTimeout(r, 150));
  const rows = () => [...b.d.querySelectorAll('#aqua-st-table tbody tr[data-cell]')];
  const labels = rows().map((r) => r.textContent);
  assert.ok(labels.some((t) => /20L Bottle @/.test(t)), 'the product at this site');
  assert.ok(labels.some((t) => /litres/.test(t)), 'the tank at this site');
  assert.ok(!labels.some((t) => /Caps/.test(t)), 'Production\'s material is not counted at the Shop');
  const typeFor = (re, v) => { const tr = rows().find((r) => re.test(r.textContent)); const inp = tr.querySelector('input'); inp.value = v; inp.dispatchEvent(new b.w.Event('change')); };
  typeFor(/20L Bottle/, '12');
  typeFor(/litres/, '2500');
  assert.equal(b.w.eval('aquaStockTakeApply()'), true);
  await settled(b);
  const st = s.serverState();
  assert.equal(st.products[0].stock['site-shop-1'], 12, 'counted 12 at the Shop');
  assert.equal(st.products[0].stock['site-production'], 100, 'Production untouched');
  assert.equal(st.tanks.find((t) => t.id === tankId).currentVolumeLiters, 2500);
  const counts = st.stockMovementLog.filter((m) => m.kind === 'count');
  assert.equal(counts.length, 2); assert.ok(counts.every((m) => m._srv && m._srv.applied));
  for (let i = 0; i < 3; i++) await b.w.eval('doPush()');       // re-sent: nothing more happens
  assert.equal(s.serverState().products[0].stock['site-shop-1'], 12);
  await b.w.eval('pullFromServer()');
  await new Promise((r) => setTimeout(r, 900));   // zip 156: a pull that lands while a push is still settling is applied right after it
  await b.w.eval('pullFromServer()'); await settled(b);
  b.w.eval('renderAquaStockTake()');
  assert.match(b.d.getElementById('stock-take-history').textContent, /2 updated of 2 counted/);
  assert.match(b.d.getElementById('stock-take-history').textContent, /applied/);
  p.close(); b.close();
});

test('Aqua: "Check stock against the server" compares every site figure, tank and material with the database', async () => {
  const { s, p } = await shop();
  const t = await open(s, 'shop', deviceStorage(p.w));
  await sellAtShop(t, 2);
  const r = await t.w.eval('stockIntegrityCheck("stock-integrity-result")');
  assert.equal(r.ok, true); assert.equal(r.differ.length, 0);
  assert.match(t.d.getElementById('stock-integrity-result').textContent, /match the server/);
  p.close(); t.close();
});
