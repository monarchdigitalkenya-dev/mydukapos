import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { shapeCaptureResult, cleanVariants } from '../functions/api/_capture-shape.js';

// Zip 241 — Capture List reads a size grid (uniforms / shoes): one product per row, one variant per non-empty size cell.
test('S1: the server reply keeps variants per product, sums the stock, merges same size+price and keeps same size at another price', () => {
  const r = shapeCaptureResult({ document_type: 'items', items: [
    { detected_name: 'Navy blue/white Track', category: 'Tracksuits', quantity: 0, unit_cost: 0, confidence_score: 0.9, variants: [{ name: '22', quantity: 9, retail_price: 1200 }, { name: '24', quantity: 13, retail_price: 1200 }, { name: '26', quantity: 5, retail_price: 1300 }] },
    { detected_name: 'Plain item', quantity: 2, unit_cost: 50, confidence_score: 0.9 },
  ] });
  assert.equal(r.items[0].quantity, 27);
  assert.deepEqual(r.items[0].variants.map((v) => [v.name, v.quantity, v.retail_price]), [['22', 9, 1200], ['24', 13, 1200], ['26', 5, 1300]]);
  assert.equal(r.items[1].variants, undefined);
  const v = cleanVariants([{ name: '36', quantity: 3, retail_price: 1600 }, { name: '36', quantity: 2, retail_price: 1600 }, { name: '36', quantity: 1, retail_price: 2500 }, { name: ' ', quantity: 4 }]);
  assert.deepEqual(v.map((x) => [x.name, x.quantity]), [['36 (1600)', 5], ['36 (2500)', 1]]);
});

test('S2: past-sales mode and menus are untouched (no variants)', () => {
  const r = shapeCaptureResult({ items: [{ detected_name: 'X', quantity: 1, unit_cost: 0, confidence_score: 1, variants: [{ name: 'a', quantity: 1 }] }] }, { pastSales: true });
  assert.equal(r.items[0].variants, undefined);
});

async function app() {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([]) }, wait: 600 });
  b.w.eval("showToast = function (m) { (window.__t = window.__t || []).push(m); };");
  return b;
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));

test('S3: committing a captured size grid creates ONE product with a variant per size, each with its own price and stock', async () => {
  const b = await app(); const { w, d } = b;
  w.eval(`captureReviewState = { commitTarget: 'inventory-direct', sourceType: 'photo', items: [
    { id: 'a', code: '', name: 'Navy blue/white Track', category: 'Tracksuits', qty: 27, unitCost: '', retail: '', wholesale: '', confidence: 0.9, matchedItemId: null, isNew: true,
      variants: [{ id: 'v1', name: '22', qty: 9, retail: 1200 }, { id: 'v2', name: '24', qty: 13, retail: 1200 }, { id: 'v3', name: '26', qty: 5, retail: 1300 }] },
    { id: 'b', code: '', name: 'Navy blue/sky blue Track', qty: 4, unitCost: '', retail: '', wholesale: '', confidence: 0.9, matchedItemId: null, isNew: true, variants: [{ id: 'v4', name: '26', qty: 2, retail: 1300 }, { id: 'v5', name: '30', qty: 2, retail: 1400 }] } ] }; commitCaptureReview();`);
  const inv = J(w, 'inventory');
  assert.equal(inv.length, 2);
  const p = inv.find((x) => x.name === 'Navy blue/white Track');
  assert.ok(p.hasVariants); assert.equal(p.qty, 27); assert.equal(p.price, 1200); assert.equal(p.category, 'Tracksuits');
  assert.deepEqual(p.variants.map((v) => [v.name, v.qty, v.price]), [['22', 9, 1200], ['24', 13, 1200], ['26', 5, 1300]]);
  assert.equal(new Set(inv.flatMap((x) => [x.code, ...x.variants.map((v) => v.code)])).size, 2 + 5, 'every code unique');
  b.close();
});

test('S4: capturing the same product again tops up its existing sizes and adds new ones (no duplicate product)', async () => {
  const b = await app(); const { w } = b;
  const items = (qty) => `[{ id: 'a', code: '', name: 'Red Track', qty: ${qty}, unitCost: '', retail: '', wholesale: '', confidence: 1, matchedItemId: window.__m || null, isNew: true, variants: [{ id: 'v1', name: '28', qty: ${qty}, retail: 1500 }, { id: 'v2', name: '${qty > 3 ? '30' : '32'}', qty: 1, retail: 1500 }] }]`;
  w.eval(`captureReviewState = { commitTarget: 'inventory-direct', sourceType: 'photo', items: ${items(3)} }; commitCaptureReview(); window.__m = inventory[0].code;`);
  w.eval(`captureReviewState = { commitTarget: 'inventory-direct', sourceType: 'photo', items: ${items(5)} }; commitCaptureReview();`);
  const inv = J(w, 'inventory');
  assert.equal(inv.length, 1);
  assert.deepEqual(inv[0].variants.map((v) => [v.name, v.qty]), [['28', 8], ['32', 1], ['30', 1]]);
  assert.equal(inv[0].qty, 10);
  b.close();
});

test('S5: the review table shows the sizes under the product, and Restock flattens them to one line per size', async () => {
  const b = await app(); const { w, d } = b;
  w.eval(`captureReviewState = { commitTarget: 'restock', sourceType: 'photo', items: [{ id: 'a', code: '', name: 'Red Track', qty: 5, unitCost: '', retail: '', wholesale: '', confidence: 1, matchedItemId: null, isNew: true, variants: [{ id: 'v1', name: '28', qty: 3, retail: 1500 }, { id: 'v2', name: '30', qty: 2, retail: 1600 }] }] }; renderCaptureReviewTable();`);
  assert.match(d.getElementById('capture-review-tbody').innerHTML, /2 size\(s\) of "Red Track"/);
  assert.equal(d.getElementById('capture-qty-a').value, '5');
  w.eval("captureVariantUpdate('a', 'v1', 'qty', '10')");
  assert.equal(d.getElementById('capture-qty-a').value, '12');
  const flat = J(w, "captureFlattenVariantItems(captureReviewState.items).map(x => [x.name, x.qty, x.retail])");
  assert.deepEqual(flat.map(([n, q, r]) => [n, Number(q), Number(r)]), [['Red Track - 28', 10, 1500], ['Red Track - 30', 2, 1600]]);
  b.close();
});

test('S6: an Excel/CSV with a Variant column becomes ONE product per Item Name, a variant per row (columns detected by header)', async () => {
  const b = await app(); const { w } = b;
  const rows = [['Category', 'Item Name', 'Variant', 'Retail Price', 'Quantity'],
    ['Tracksuits', 'Navy Track', '22', '1200', '9'], ['Tracksuits', 'Navy Track', '24', '1200', '13'], ['Tracksuits', 'Navy Track', '26', '1300', '0'],
    ['Tracksuits', 'Red Track', '22', '1200', '2'], ['Misc', 'Plain Item', '', '50', '4']];
  w.eval(`window.__rows = ${JSON.stringify(rows)}; finishInventoryFileImport(window.__rows.slice(1), detectCsvColumns(window.__rows[0]), 'x.xlsx');`);
  const st = J(w, 'captureReviewState.items.map(i => [i.name, (i.variants || []).length, i.qty])');
  assert.deepEqual(st, [['Navy Track', 3, 22], ['Red Track', 1, 2], ['Plain Item', 0, 4]]);
  w.eval('commitCaptureReview()');
  const inv = J(w, 'inventory');
  const navy = inv.find((p) => p.name === 'Navy Track');
  assert.ok(navy.hasVariants); assert.deepEqual(navy.variants.map((v) => [v.name, v.qty, v.price]), [['22', 9, 1200], ['24', 13, 1200], ['26', 0, 1300]]);
  assert.equal(navy.category, 'Tracksuits'); assert.equal(navy.qty, 22);
  assert.equal(inv.find((p) => p.name === 'Plain Item').hasVariants, undefined);
  b.close();
});
