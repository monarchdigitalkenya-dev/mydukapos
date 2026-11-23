import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 314: the catalogue file. The old inventory export wrote one row per product and dropped every variant and batch, and the import wizard
// read variants only from a second file with four fixed attributes - so export -> edit -> import lost data. One format now goes both ways.
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));
const open = () => boot('index.html', { storage: { pos_inventory: '[]' }, wait: 900 });

const SHOP = [
  { code: 'MILK', type: 'item', name: 'Milk 500ml', category: 'Dairy', subCat: 'Fresh', unit: 'pcs', price: 60, wholesalePrice: 45, wholesaleSellingPrice: 55, minimumPrice: 58, reorderLevel: 12, barcode: '6161100000011', vatCategory: 'A', location: 'Fridge 1', expiryDate: '2026-11-30', qty: 30,
    batches: [{ id: 'b1', batchNumber: 'L-101', expiryDate: '2026-11-30', qty: 10 }, { id: 'b2', batchNumber: 'L-102', expiryDate: '2026-12-15', qty: 20 }] },
  { code: 'SWT', type: 'item', name: 'School Sweater', category: 'Uniforms', unit: 'pcs', price: 900, wholesalePrice: 600, vatCategory: 'A', qty: 9, hasVariants: true, variants: [
    { id: 'v-swt-1', code: 'SWT-BLU-28', name: 'Blue / 28', attrs: { Colour: 'Blue', Size: '28' }, price: 900, wholesalePrice: 600, wholesaleSellingPrice: 850, minimumPrice: 880, barcode: '200000000028', reorderLevel: 3, qty: 4, active: true },
    { id: 'v-swt-2', code: 'SWT-BLU-30', name: 'Blue / 30', attrs: { Colour: 'Blue', Size: '30' }, price: 950, wholesalePrice: 630, barcode: '200000000030', qty: 5, active: true },
    { id: 'v-swt-3', code: 'SWT-WHT-30', name: 'White / 30', attrs: { Colour: 'White', Size: '30' }, price: 950, wholesalePrice: 630, qty: 0, active: false },
  ] },
  { code: 'SHOE', type: 'item', name: 'School Shoe', category: 'Shoes', unit: 'pair', price: 2500, wholesalePrice: 1800, vatCategory: 'A', qty: 2, hasVariants: true, variants: [
    { id: 'v-shoe-1', code: 'SHOE-BATA-6', name: 'Bata 6', attrs: { Brand: 'Bata', Size: '6', Material: 'Leather' }, price: 2500, wholesalePrice: 1800, qty: 2, active: true },
  ] },
  { code: 'SVC', type: 'service', name: 'Name embroidery', price: 100 },
];
const toCsv = (w, rows) => w.eval(`(${JSON.stringify(rows)}).map(r => r.map(csvEscape).join(',')).join('\\r\\n')`);
const parse = (w, text) => E(w, `parseCsvText(${JSON.stringify(text)})`);

test('export -> CSV text -> import into an EMPTY shop rebuilds the same catalogue (variants, custom attributes, SKUs, barcodes, prices, active), then batches', async () => {
  const { w, close } = await open();
  try {
    const exported = E(w, `catalogueExportRows(${JSON.stringify(SHOP)})`);
    assert.deepEqual(exported[0].filter((h) => h.startsWith('Attr: ')), ['Attr: Colour', 'Attr: Size', 'Attr: Brand', 'Attr: Material'], 'every attribute used anywhere gets a column');
    assert.equal(exported.length, 1 + 1 + 3 + 1, 'one row per sellable item: MILK, 3 sweater variants, 1 shoe; the service is not stock');
    const rows = parse(w, toCsv(w, exported));
    const plan = E(w, `cataloguePlan(${JSON.stringify(rows)}, { inventory: [], policy: 'both', opening: true })`);
    assert.equal(plan.failed, 0, JSON.stringify(plan.rows.filter((r) => r.errors.length)));
    assert.equal(plan.newProducts, 3); assert.equal(plan.newVariants, 4); assert.equal(plan.openingRows, 4);
    w.eval('window.__inv = []');
    const res = E(w, `catalogueApply(cataloguePlan(${JSON.stringify(rows)}, { inventory: [], policy: 'both', opening: true }), { inventory: window.__inv }, { importId: 'imp1', now: 1 })`);
    assert.equal(res.failed, 0);
    assert.deepEqual(res.movements.map((m) => m.delta).sort(), [2, 30, 4, 5].sort(), 'opening stock is a logged movement per new item');
    assert.deepEqual(E(w, 'catalogueExportRows(window.__inv)'), exported, 'exporting the rebuilt shop gives the identical file');
    const swt = E(w, "window.__inv.find(p => p.code === 'SWT')");
    assert.deepEqual(swt.variants.map((v) => v.id), ['v-swt-1', 'v-swt-2', 'v-swt-3'], 'stable variant ids are kept');
    assert.equal(swt.qty, 9, 'product quantity = sum of its variants');
    // batches: the catalogue already recorded MILK's 30 as opening stock; "assign" splits it into the batches without moving stock
    const bRows = parse(w, toCsv(w, E(w, `batchExportRows(${JSON.stringify(SHOP)})`)));
    const add = E(w, `batchPlan(${JSON.stringify(bRows)}, { inventory: window.__inv, mode: 'opening' })`);
    assert.equal(add.failed, 2, 'opening stock is refused: MILK already holds stock (it would double)');
    const bres = E(w, `batchApply(batchPlan(${JSON.stringify(bRows)}, { inventory: window.__inv, mode: 'assign' }), { inventory: window.__inv }, { importId: 'imp2' })`);
    assert.equal(bres.updated, 2); assert.equal(bres.movements.length, 0, 'assigning batches moves no stock');
    const milk = E(w, "window.__inv.find(p => p.code === 'MILK')");
    assert.equal(milk.qty, 30);
    assert.deepEqual(milk.batches.map((b) => [b.id, b.batchNumber, b.expiryDate, b.qty]), [['b1', 'L-101', '2026-11-30', 10], ['b2', 'L-102', '2026-12-15', 20]]);
    assert.deepEqual(E(w, 'batchExportRows(window.__inv)'), E(w, `batchExportRows(${JSON.stringify(SHOP)})`), 'batch file round-trips too');
  } finally { close(); }
});

test('re-importing an unchanged export changes nothing; an update never changes stock; empty cells keep values; [clear] empties one', async () => {
  const { w, close } = await open();
  try {
    w.eval(`window.__inv = ${JSON.stringify(SHOP)}`);
    const rows = E(w, 'catalogueExportRows(window.__inv)');
    const res = E(w, `catalogueApply(cataloguePlan(${JSON.stringify(rows)}, { inventory: window.__inv, policy: 'both', opening: true }), { inventory: window.__inv }, { importId: 'same' })`);
    assert.deepEqual([res.created, res.updated, res.failed, res.movements.length], [0, 0, 0, 0]);
    assert.deepEqual(E(w, 'window.__inv'), SHOP, 'nothing at all changed');
    // a partial update file: only SKUs + a new price + a WRONG quantity
    const upd = [['Product SKU', 'Variant SKU', 'Selling price', 'Quantity on hand', 'Barcode'], ['SWT', 'SWT-BLU-30', '990', '500', ''], ['MILK', '', '65', '1', '[clear]']];
    const plan = E(w, `cataloguePlan(${JSON.stringify(upd)}, { inventory: window.__inv, policy: 'update' })`);
    assert.equal(plan.failed, 0, JSON.stringify(plan.rows)); assert.ok(plan.rows.every((r) => r.warns.some((x) => /never changes stock/.test(x))), 'the ignored quantity is reported, not applied');
    E(w, `catalogueApply(cataloguePlan(${JSON.stringify(upd)}, { inventory: window.__inv, policy: 'update' }), { inventory: window.__inv }, { importId: 'u1' })`);
    const swt = E(w, "window.__inv.find(p => p.code === 'SWT')"), v = swt.variants.find((x) => x.code === 'SWT-BLU-30'), milk = E(w, "window.__inv.find(p => p.code === 'MILK')");
    assert.equal(v.price, 990); assert.equal(v.qty, 5); assert.equal(swt.qty, 9); assert.equal(v.barcode, '200000000030', 'an empty cell keeps the value');
    assert.equal(milk.price, 65); assert.equal(milk.qty, 30); assert.equal(milk.barcode, undefined, '[clear] removed it'); assert.equal(milk.location, 'Fridge 1', 'a column not in the file is kept');
  } finally { close(); }
});

test('a bad file: every problem is reported with its spreadsheet row, nothing in an invalid row is applied, and names never decide a match', async () => {
  const { w, close } = await open();
  try {
    w.eval(`window.__inv = ${JSON.stringify(SHOP)}`);
    const H = ['Product SKU', 'Product name', 'Variant SKU', 'Attr: Colour', 'Attr: Size', 'Selling price', 'Expiry date', 'Barcode'];
    const bad = [H,
      ['SWT', '', 'SWT-RED-28', 'Red', '28', 'abc', '', ''],               // 2: bad price
      ['', '', 'X-1', 'Red', '30', '10', '', ''],                           // 3: variant row without its product
      ['NEW1', 'Tie', 'SWT-BLU-28', 'Navy', '', '10', '', ''],             // 4: variant SKU owned by the sweater
      ['NEW2', 'Belt', 'BELT-1', 'Black', '', '10', '', ''],               // 5: ok
      ['NEW2', 'Belt', 'BELT-1', 'Brown', '', '10', '', ''],               // 6: SKU repeats row 5
      ['MILK', '', '', '', '', '10', '31/02/2026', ''],                    // 7: impossible date
      ['SWT', '', '', '', '', '10', '', ''],                               // 8: plain row for a product with variants
      ['NEW3', 'Socks', '', '', '', '10', '', '200000000028'],             // 9: barcode belongs to a sweater variant
      ['MILK2', 'Milk 500ml', '', '', '', '10', '', ''],                   // 10: same NAME as MILK: new product, with a warning (never merged)
    ];
    const p = E(w, `cataloguePlan(${JSON.stringify(bad)}, { inventory: window.__inv, policy: 'both' })`);
    const by = Object.fromEntries(p.rows.map((r) => [r.n, r]));
    assert.match(by[2].errors.join(), /Selling price/); assert.match(by[3].errors.join(), /Product SKU is missing/);
    assert.match(by[4].errors.join(), /already belongs to another item/); assert.equal(by[5].op, 'variant_create');
    assert.match(by[6].errors.join(), /repeats row 5/); assert.match(by[7].errors.join(), /not a date/);
    assert.match(by[8].errors.join(), /has variants/); assert.match(by[9].errors.join(), /Barcode .* another item/);
    assert.equal(by[10].op, 'product_create'); assert.match(by[10].warns.join(), /already exists \(SKU MILK\)/);
    const before = E(w, 'window.__inv.length');
    const res = E(w, `catalogueApply(cataloguePlan(${JSON.stringify(bad)}, { inventory: window.__inv, policy: 'both' }), { inventory: window.__inv }, { importId: 'bad' })`);
    assert.equal(res.failed, 7); assert.equal(E(w, 'window.__inv.length'), before + 2, 'only Belt and Milk 2 were created');
    assert.equal(E(w, "window.__inv.find(p => p.code === 'SWT').variants.length"), 3, 'the sweater got nothing from the invalid rows');
    assert.equal(E(w, "window.__inv.find(p => p.code === 'MILK').price"), 60);
    // header problems are explained, not guessed
    assert.match(E(w, "cataloguePlan([['Colour','Price'],['Red','1']], { inventory: [] }).headerError"), /Product SKU/);
  } finally { close(); }
});

test('a retried / resumed import never creates anything twice; batches received are logged and never added twice', async () => {
  const { w, close } = await open();
  try {
    w.eval('window.__inv = []');
    const f = [['Product SKU', 'Product name', 'Variant SKU', 'Attr: Size', 'Quantity on hand'], ['T', 'Tie', 'T-S', 'S', '3'], ['T', 'Tie', 'T-M', 'M', '4']];
    const run = (id, done) => E(w, `catalogueApply(cataloguePlan(${JSON.stringify(f)}, { inventory: window.__inv, policy: 'both', opening: true }), { inventory: window.__inv }, { importId: '${id}', doneKeys: ${JSON.stringify(done)} })`);
    const first = run('r1', []);
    assert.equal(first.created, 3, 'the product and its two variants');
    const resumed = run('r1', first.rowKeys);                 // the same run resumed after a dropped connection: every row is already done
    assert.equal(resumed.created, 0);
    const again = run('r2', []);                              // the whole file again under a new id: everything matches, nothing is added
    assert.equal(again.created, 0); assert.equal(again.movements.length, 0, 'no second opening stock');
    assert.equal(E(w, "window.__inv.filter(p => p.code === 'T').length"), 1);
    assert.equal(E(w, "window.__inv[0].variants.length"), 2); assert.equal(E(w, 'window.__inv[0].qty'), 7);
    // batches: received stock is a movement; the same batch id twice is skipped
    w.eval("window.__inv.push({ code: 'PCM', name: 'Paracetamol', qty: 0, unit: 'pcs' })");
    const b = [['Product SKU', 'Batch number', 'Expiry date', 'Quantity', 'Batch ID'], ['PCM', 'B1', '2027-01-31', '100', 'bx1'], ['PCM', 'B2', '15/03/2027', '50', 'bx2']];
    const r1 = E(w, `batchApply(batchPlan(${JSON.stringify(b)}, { inventory: window.__inv, mode: 'add' }), { inventory: window.__inv }, { importId: 'b1' })`);
    assert.deepEqual(r1.movements.map((m) => m.delta), [100, 50]);
    const bAgain = E(w, `batchPlan(${JSON.stringify(b)}, { inventory: window.__inv, mode: 'add' })`);
    assert.equal(bAgain.skipped, 2, 'already received');
    const pcm = E(w, "window.__inv.find(p => p.code === 'PCM')");
    assert.equal(pcm.qty, 150); assert.equal(pcm.expiryDate, '2027-01-31', 'the earliest expiry shows on the item');
    assert.equal(pcm.batches[1].expiryDate, '2027-03-15', 'DD/MM/YYYY read as a Kenyan date');
  } finally { close(); }
});

test('the Inventory import screen: Export products & variants, then import that same file back - nothing changes; a new variant row is added; opening stock needs the tick', async () => {
  const { makeServer, openDevice } = await import('./e2e-harness.mjs');
  const dev = await openDevice('index.html', makeServer(), { pos_inventory: JSON.stringify(SHOP) }, 900);
  const { w, d } = dev;
  try {
    w.eval("window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.__dl = []; downloadBlob = function (b, name) { const r = new FileReader(); r.onload = () => window.__dl.push({ name, t: r.result }); r.readAsText(b); };");
    const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
    w.eval("invProOpen('import')"); await tick();
    assert.equal(d.getElementById('ip-itype').value, 'catalogue', 'products & variants is the default import');
    d.querySelector('[data-ip-act="xport"][data-t="catalogue"]').click(); await tick(200);
    const file = E(w, 'window.__dl[0]');
    assert.match(file.name, /^products-and-variants-/);
    const rows = parse(w, file.t.replace(/^﻿/, ''));
    assert.equal(rows.length, 6, 'header + 5 sellable rows');
    const before = E(w, 'inventory');
    const load = async (sheet) => {
      w.eval(`(function () { const I = invProState.imp; I.headers = ${JSON.stringify(sheet[0])}; I.rows = ${JSON.stringify(sheet.slice(1))}; I.fileName = 'x.csv'; I.hash = 'h' + Math.random(); I.dup = null; I.map = importGuessMapping(I.headers); I.step = 3; })()`);
      w.eval("invProOpen('import')"); await tick();
      d.querySelector('[data-ip-act="iplan"]').click(); await tick();
    };
    await load(rows);
    assert.equal(E(w, 'invProState.imp.plan.failed'), 0);
    d.querySelector('[data-ip-act="irun"]').click(); await tick(400);
    assert.deepEqual(E(w, 'inventory').map((p) => [p.code, p.qty, p.price, (p.variants || []).length]), before.map((p) => [p.code, p.qty, p.price, (p.variants || []).length]), 'an unchanged file changes nothing');
    // add a Red / 28 sweater with 6 in hand: without the tick it is created with 0; the movement log stays clean
    const add = [rows[0], rows[0].map((h) => ({ 'Product SKU': 'SWT', 'Variant SKU': 'SWT-RED-28', 'Attr: Colour': 'Red', 'Attr: Size': '28', 'Selling price': '900', 'Quantity on hand': '6' })[h] || '')];
    await load(add);
    assert.match(d.getElementById('ip-card').textContent, /1 new variant/);
    d.querySelector('[data-ip-act="irun"]').click(); await tick(400);
    const red = E(w, "inventory.find(p => p.code === 'SWT').variants.find(v => v.code === 'SWT-RED-28')");
    assert.equal(red.qty, 0, 'no opening stock without the tick'); assert.deepEqual(red.attrs, { Colour: 'Red', Size: '28' });
    assert.equal(E(w, "inventory.find(p => p.code === 'SWT').qty"), 9);
    assert.equal(E(w, "stockMovementLog.filter(m => /Import/.test(m.reason || '')).length"), 0);
  } finally { dev.close(); }
});
