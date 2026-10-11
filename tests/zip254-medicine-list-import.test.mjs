import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 254: a medicine list (Drugs / Doses / Minimum Qty / Cost) imports as the owner described: "4 Tabs" = a box of 4 pieces, "200mg/400mg" = variants,
// ml / mg / g stay one piece and part of the name, Minimum Qty = the item's own low-stock level, Qty and Price stay 0.
const ROWS = [
  ['DRUGS ', 'DOSES', 'MINIMUM QTY', 'COST'],
  ['10% Dextrose', '500ml', '2', '300'],
  ['Abz', '400mg', '5', '50'],
  ['Artequick', '4 Tabs', '1', '900'],
  ['Trust condoms', '3pcs ', '10', '100/-'],
  ['Brufen  tabs', '200mg/400mg', '100', '5'],
  ['Flagyl /Metronidazole', '200/400mg', '100', '5'],
  ['Neurofit', '1 tab/cap', '30', '20'],
  ['Sylate Tabs', '500mg', '5', '@150'],
  ['Vitamin C', '', '50', '5'],
];
const APPS = ['index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

for (const app of APPS) {
  test(`${app}: a medicine list imports packs, variants, low-stock levels and zero stock/price`, async () => {
    const { w, errors, close } = await boot(app, { wait: 900 });
    w.eval('showToast = function () {}; showBusyBanner = function () {}; hideBusyBanner = function () {}; detectCsvColumnsAI = async function () { return null; }');
    await w.eval('beginInventoryFileImportInner(' + JSON.stringify(ROWS) + ', "drugs.xlsx")');
    w.eval('commitCaptureReview()');
    const inv = JSON.parse(w.eval('JSON.stringify(inventory)'));
    const by = (n) => inv.find((p) => p.name === n);
    assert.equal(inv.length, 9);
    const a = by('Abz 400mg');
    assert.ok(a && by('10% Dextrose 500ml'), 'a plain dose becomes part of the name');
    assert.equal(a.wholesalePrice, 50); assert.equal(a.minStock, 5); assert.equal(a.qty, 0); assert.equal(a.price, 0);
    const art = by('Artequick');
    assert.equal(art.dualUnit, true); assert.equal(art.unitsPerBox, 4); assert.equal(art.wholesalePrice, 900);
    assert.equal(art.pieceWholesalePrice, 225, 'cost per piece = box cost / pieces');
    assert.equal(art.piecePrice, 0); assert.equal(art.minStock, 1); assert.equal(art.packPrice, 900); assert.equal(art.packPieces, 4);
    const con = by('Trust condoms');
    assert.equal(con.unitsPerBox, 3); assert.equal(con.wholesalePrice, 100);
    for (const n of ['Brufen tabs', 'Flagyl /Metronidazole']) {
      const v = by(n);
      assert.ok(v && v.hasVariants, n + ' has variants');
      assert.deepEqual(v.variants.map((x) => x.name), ['200mg', '400mg']);
      assert.deepEqual(v.variants.map((x) => x.wholesalePrice), [5, 5]);
      assert.equal(v.minStock, 100); assert.equal(v.qty, 0);
    }
    const neuro = by('Neurofit');
    assert.ok(neuro && !neuro.dualUnit, '1 tab/cap is a single piece');
    assert.equal(by('Sylate Tabs 500mg').wholesalePrice, 150, '"@150" reads as 150');
    assert.equal(by('Vitamin C').minStock, 50);
    assert.deepEqual(errors, []);
    close();
  });
}

test('parseDoseCell / splitVariantNames rules', async () => {
  const { w, close } = await boot('hospital/index.html', { wait: 700 });
  const p = (s) => JSON.parse(w.eval('JSON.stringify(parseDoseCell(' + JSON.stringify(s) + '))'));
  assert.equal(p('9 Tabs').pieces, 9);
  assert.equal(p('3pcs ').pieces, 3);
  assert.equal(p('1 tab/cap').pieces, 0);
  assert.equal(p('1 tab/cap').suffix, '');
  assert.deepEqual(p('200mg/400mg').variants, ['200mg', '400mg']);
  assert.deepEqual(p('200/400mg').variants, ['200mg', '400mg']);
  assert.equal(p('500ml').suffix, '500ml');
  assert.equal(p('28 Cycle').suffix, '28 Cycle');
  assert.equal(p('').suffix, '');
  close();
});
