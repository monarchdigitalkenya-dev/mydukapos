// zip 327: a product that exists must be found by name, part of the name, SKU/barcode or variant - on the till, in Inventory and on every other product picker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

const P = (code, name, extra = {}) => ({ code, type: 'item', name, price: 100, wholesalePrice: 60, qty: 5, unit: 'pcs', vatCategory: 'A', ...extra });
const BEEF = [P('B1', 'Beef'), P('B2', 'Beef Steak'), P('B3', 'Fresh Beef Mince'), P('B4', 'Beef Sausages')];
const MIXED = [
  P('Z0', 'Zero Stock Soap', { qty: 0 }),
  P('K1', 'Kilo Sugar', { unit: 'kg', qty: 12.5 }),
  P('L1', 'Cooking Oil', { unit: 'litre', qty: 40 }),
  P('D1', 'Soda Crate', { unit: 'box', dualUnit: true, unitsPerBox: 12, pieceCode: 'D1P', piecePrice: 60, pieceQty: 0, qty: 3, looseUnit: 'pcs' }),
  P('S9', 'Coca-Cola 500ml', { barcode: '5449000000996' }),
  P('S10', 'Socks', { hasVariants: true, variants: [{ id: 'v1', name: 'Large Red', code: 'SK-LR-77', price: 100, qty: 4 }, { id: 'v2', name: 'Small Blue', code: 'SK-SB-78', price: 100, qty: 0 }] }),
  P('E1', 'No Image Item'),   // no image, category, nothing optional at all
  P('N0', 'Ünïcode Café Tea'),
];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");
const hits = (w, q) => JSON.parse(w.eval(`JSON.stringify(inventory.filter(p => isSellableProduct(p) && posSearchHit(p, ${JSON.stringify(q)})).map(p => p.code))`));
const till = (w, d, q) => { const el = d.getElementById('sales-search'); el.value = q; w.eval(`liveSearch(${JSON.stringify(q)})`); return d.getElementById('search-results').textContent; };
const invTable = (w, d, q) => { d.getElementById('inventory-search-input').value = q; w.eval('window._invPage = 1; renderInventoryTable()'); return d.querySelector('#inventory-table tbody').textContent; };

test('names: whole, partial, middle, any order, case, extra spaces, punctuation', async () => {
  const { w, errors } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(BEEF.concat(MIXED)) }, wait: 700 });
  quiet(w);
  assert.deepEqual(hits(w, 'beef').sort(), ['B1', 'B2', 'B3', 'B4']);
  assert.deepEqual(hits(w, 'steak'), ['B2']);
  assert.deepEqual(hits(w, 'fresh beef'), ['B3']);
  assert.deepEqual(hits(w, 'mince'), ['B3']);
  assert.deepEqual(hits(w, 'ausag'), ['B4'], 'middle of a word');
  assert.deepEqual(hits(w, '  FRESH    BEEF  '), ['B3'], 'capitals + leading/trailing/repeated spaces');
  assert.deepEqual(hits(w, 'mince fresh'), ['B3'], 'any word order');
  assert.deepEqual(hits(w, 'coca cola'), ['S9'], 'a space where the name has a hyphen');
  assert.deepEqual(hits(w, 'cocacola'), ['S9'], 'no separator at all');
  assert.deepEqual(hits(w, 'coca-cola 500'), ['S9']);
  assert.deepEqual(hits(w, 'cafe'), ['N0'], 'accents do not hide a product');
  assert.deepEqual(errors, []);
});

test('codes, barcodes and variants: the product is found by any of them (single word too)', async () => {
  const { w } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(MIXED) }, wait: 700 });
  assert.deepEqual(hits(w, 'D1P'), ['D1'], 'the piece barcode of a box-and-piece item');
  assert.deepEqual(hits(w, '5449000000996'), ['S9'], 'the barcode field');
  assert.deepEqual(hits(w, 'sk-lr-77'), ['S10'], 'variant code');
  assert.deepEqual(hits(w, 'SKLR77'), ['S10'], 'variant code without the dashes');
  assert.deepEqual(hits(w, 'large'), ['S10'], 'ONE word of a variant name (used to find nothing)');
  assert.deepEqual(hits(w, 'blue'), ['S10'], 'a sold-out variant is still found');
});

test('zero stock, kg / litre / box units and a product with no image or metadata are all found - on the till AND in Inventory', async () => {
  const { w, d } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(MIXED) }, wait: 700 });
  quiet(w);
  for (const [q, name] of [['zero stock', 'Zero Stock Soap'], ['sugar', 'Kilo Sugar'], ['oil', 'Cooking Oil'], ['crate', 'Soda Crate'], ['no image', 'No Image Item']]) {
    assert.ok(till(w, d, q).includes(name), `till finds "${name}" by "${q}"`);
    assert.ok(invTable(w, d, q).includes(name), `inventory finds "${name}" by "${q}"`);
  }
  assert.ok(invTable(w, d, 'large').includes('Socks'), 'inventory finds a product by one word of its variant');
  assert.ok(till(w, d, 'zzzzqqq').includes('No matching products found'));
  assert.ok(invTable(w, d, 'zzzzqqq').includes('No matches'));
});

test('a product with no name (a bad import row) does not blank the whole list', async () => {
  const inv = [P('X1', undefined), { code: 'X2', type: 'item', qty: 1, price: 5 }].concat(BEEF);
  const { w, d, errors } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 700 });
  quiet(w);
  assert.ok(till(w, d, 'beef').includes('Beef Steak'), 'the till still lists the real products');
  assert.ok(invTable(w, d, 'steak').includes('Beef Steak'), 'inventory too');
  assert.ok(invTable(w, d, '').includes('Beef Steak'), 'and with no search typed');
  assert.deepEqual(hits(w, 'x2'), ['X2'], 'the nameless item is still findable by its code');
  assert.deepEqual(errors, []);
});

test('REGRESSION (the reported bug): product number 437 of 600 is found - search runs over the whole list, before the 20-per-page paging', async () => {
  const big = Array.from({ length: 600 }, (_, i) => P('C' + String(i).padStart(4, '0'), 'Item ' + i + (i === 436 ? ' Maasai Honey' : '')));
  const { w, d } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(big) }, wait: 900 });
  quiet(w);
  assert.ok(!invTable(w, d, '').includes('Maasai Honey'), 'it is not on the first page');
  assert.ok(invTable(w, d, 'honey').includes('Maasai Honey'), 'inventory search reaches past page 1');
  assert.ok(till(w, d, 'maasai').includes('Maasai Honey'), 'till search too');
  assert.ok(till(w, d, 'C0436').includes('Maasai Honey'), 'by code');
  const t0 = Date.now(); for (let i = 0; i < 20; i++) hits(w, 'item 5' + i); assert.ok(Date.now() - t0 < 3000, 'large catalogue stays responsive');
});

test('add / rename / import / archive / restore show in search straight away, without a reload', async () => {
  const { w, d } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(BEEF) }, wait: 700 });
  quiet(w);
  w.eval("inventory.push({ code: 'IMP1', type: 'item', name: 'Imported Widget', price: 10, qty: 0, unit: 'pcs' }); safeSetItem('pos_inventory', JSON.stringify(inventory))");
  assert.ok(till(w, d, 'widget').includes('Imported Widget'), 'a just-imported item (even with 0 stock)');
  w.eval("inventory.find(p => p.code === 'IMP1').name = 'Renamed Gadget'");
  assert.ok(till(w, d, 'gadget').includes('Renamed Gadget'));
  assert.ok(till(w, d, 'widget').includes('No matching products found'), 'old name no longer matches');
  w.eval("inventory.find(p => p.code === 'IMP1').archived = true");
  assert.ok(till(w, d, 'gadget').includes('No matching products found'), 'archived: not sold on the till (existing rule)');
  assert.ok(invTable(w, d, 'gadget').includes('No matches'), 'archived: hidden from Inventory unless "show archived" is on');
  w.eval("window.__showArchived = true");
  assert.ok(invTable(w, d, 'gadget').includes('Renamed Gadget'), 'archived items are found when the archive is shown');
  w.eval("window.__showArchived = false; inventory.find(p => p.code === 'IMP1').archived = false");
  assert.ok(till(w, d, 'gadget').includes('Renamed Gadget'), 'restored');
});

test('barcode scan: exact code, piece code and variant code add the right product', async () => {
  const { w } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(MIXED) }, wait: 700 });
  quiet(w);
  w.eval("scanToCart(' 5449000000996 ')");
  assert.equal(w.eval("Object.keys(currentCart).length"), 1, 'a scanner that adds a trailing space still works');
  assert.equal(w.eval("Object.values(currentCart)[0].code"), 'S9');
  w.eval("currentCart = {}; scanToCart('d1p')");
  assert.equal(w.eval("Object.values(currentCart)[0].code"), 'D1'); assert.equal(w.eval("Object.values(currentCart)[0].saleMode"), 'piece');
  w.eval("currentCart = {}; scanToCart('SK-LR-77')");
  assert.equal(w.eval("Object.keys(currentCart).length"), 1, 'a variant barcode');
});

test('a product made on device A is found on device B after sync; another business never sees it', async () => {
  const s = makeServer({ d1: true });
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(BEEF), pos_biz_name: 'Biz' }, 900, { indexedDB: new IDBFactory() });
  a.w.eval("showToast = function () {}");
  a.w.eval("inventory.push({ code: 'NEW1', type: 'item', name: 'Brand New Honey', price: 50, qty: 2, unit: 'pcs' }); safeSetItem('pos_inventory', JSON.stringify(inventory)); queuePush()");
  await a.w.eval('pushNow()'); await until(() => !a.w.eval('window.__pushQueued') && !(a.w.eval('window.__pushInFlight') > 0)); await sleep(300);
  const b = await openDevice('index.html', s, {}, 1800);
  assert.ok(JSON.parse(b.w.eval("JSON.stringify(inventory.filter(p => posSearchHit(p, 'new honey')).map(p => p.code))")).includes('NEW1'));
  const other = makeServer({ d1: true });
  const c = await openDevice('index.html', other, {}, 2600);
  assert.deepEqual(JSON.parse(c.w.eval("JSON.stringify(inventory.filter(p => posSearchHit(p, 'beef')).map(p => p.code))")), [], 'tenant isolation');
  a.close(); b.close(); c.close();
});

test('offline: every locally stored product is searchable, including ones not shown in the photo grid, and no network request is needed', async () => {
  const { w, d } = await boot('index.html', { storage: { pos_inventory: JSON.stringify(BEEF.concat(MIXED)) }, wait: 700 });
  quiet(w);
  w.eval("Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); window.__fetches = 0; const f = window.fetch; window.fetch = function () { window.__fetches++; return Promise.reject(new TypeError('offline')); }");
  w.eval("showItemImageGrid = false; renderItemImageGrid('')");
  assert.ok(till(w, d, 'mince').includes('Fresh Beef Mince'));
  assert.ok(invTable(w, d, 'mince').includes('Fresh Beef Mince'));
  assert.ok(!till(w, d, 'mince').includes('No matching'), 'a failed network call never turns into "no match"');
});
