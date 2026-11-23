import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - Purchases: every restock is ONE purchase record (supplier, reference, date, who, lines, total), listed for a period, filterable, downloadable.
const INV = JSON.stringify([
  { code: 'FLR', type: 'item', name: 'Flour 2kg', category: 'Ingredients', price: 150, wholesalePrice: 100, qty: 5, unit: 'pcs', vatCategory: 'A' },
  { code: 'OIL', type: 'item', name: 'Cooking oil', category: 'Ingredients', price: 400, wholesalePrice: 300, qty: 2, unit: 'pcs', vatCategory: 'A' },
]);
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
const row = (code, name, qty, cost) => ({ id: 1 + Math.floor(Math.random() * 1e6), code, name, qty: String(qty), cost: String(cost), sellPrice: '', wholesaleSell: '', unit: 'pcs' });
async function restock(w, rows, supplier, ref) {
  w.eval("suppliers.length = 0; suppliers.push({ id: 's1', name: 'Brew Co' }, { id: 's2', name: 'Mill Ltd' })");
  w.eval(`(function(){ const sel = document.getElementById('restock-supplier-select'); sel.innerHTML = '<option value="">none</option><option value="s1">Brew Co</option><option value="s2">Mill Ltd</option>'; sel.value = '${supplier}'; document.getElementById('restock-reference-input').value = '${ref}'; })()`);
  w.eval(`restockDraft = ${JSON.stringify(rows)}; renderRestockRows(); window.__lastRestockAt = 0; completeRestock()`);
}

for (const app of ['hotel/index.html', 'index.html', 'pharmacy/index.html']) {
  test(`${app}: a restock is ONE purchase on the Purchases screen, with its lines, supplier, reference and total`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 1200 }); const { w, d } = b;
    w.eval("showToast = function () {}; window.print = () => {}; window.confirm = () => true; try { printRestockNote = function () {}; } catch (e) {}");
    await restock(w, [row('FLR', 'Flour 2kg', 10, 90), row('OIL', 'Cooking oil', 4, 310)], 's2', 'INV-100');
    const recs = J(w, "inventory.flatMap(p => (p.purchases || []).map(x => x.batch))");
    assert.equal(recs.length, 2); assert.ok(recs[0] && recs[0] === recs[1], 'both lines share one purchase id');
    await restock(w, [row('FLR', 'Flour 2kg', 5, 95)], 's1', 'INV-101');
    const docs = J(w, 'msPurchaseDocs(30, "", "")');
    assert.equal(docs.length, 2, 'two restocks = two purchases (not three lines)');
    const big = docs.find((x) => x.ref === 'INV-100');
    assert.equal(big.lines.length, 2); assert.equal(big.supplier, 'Mill Ltd'); assert.equal(Math.round(big.total), 10 * 90 + 4 * 310);
    // filters
    assert.deepEqual(J(w, 'msPurchaseDocs(30, "Brew Co", "").map(x => x.ref)'), ['INV-101']);
    assert.deepEqual(J(w, 'msPurchaseDocs(30, "", "cooking").map(x => x.ref)'), ['INV-100'], 'search by item name');
    assert.deepEqual(J(w, 'msPurchaseDocs(30, "", "inv-101").map(x => x.ref)'), ['INV-101'], 'search by reference');
    // the screen
    w.eval('msOpenPurchasesReport(30)');
    const modal = d.getElementById('ms-modal');
    assert.match(modal.textContent, /Purchases/); assert.match(modal.textContent, /2 purchases/);
    assert.equal(modal.querySelectorAll('details').length >= 2, true);
    assert.match(modal.textContent, /INV-100/); assert.match(modal.textContent, /Mill Ltd/); assert.match(modal.textContent, /Cooking oil/);
    assert.match(modal.textContent, /Record a purchase/);
    // stock really went up and the cost was updated (the purchase screen records what the restock did)
    assert.equal(Number(w.eval("inventory.find(p => p.code === 'FLR').qty")), 5 + 10 + 5);
    // CSV
    const csv = J(w, 'msPurchasesCsv(msPurchaseDocs(30, "", ""))');
    assert.match(csv, /^"Date","Supplier","Reference"/); assert.match(csv, /"Mill Ltd","INV-100"/); assert.equal(csv.split('\r\n').length, 4, 'header + 3 lines');
    b.close();
  });
}

test('restocks from before this release (no purchase id) are still grouped, by minute + reference + supplier', async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: INV }, wait: 1200 }); const { w } = b;
  w.eval(`(function(){ const at = new Date().toISOString(); inventory[0].purchases = [{ id: 'a', at, ref: 'OLD-1', supplier: 'Mill Ltd', invQty: 3, invUnit: 'pcs', purchaseQty: 3, purchaseUnit: 'pcs', totalCost: 300, effUnitCost: 100 }];
    inventory[1].purchases = [{ id: 'b', at, ref: 'OLD-1', supplier: 'Mill Ltd', invQty: 2, invUnit: 'pcs', purchaseQty: 2, purchaseUnit: 'pcs', totalCost: 600, effUnitCost: 300 }]; })()`);
  const docs = J(w, 'msPurchaseDocs(30, "", "")');
  assert.equal(docs.length, 1); assert.equal(docs[0].lines.length, 2); assert.equal(docs[0].total, 900);
  assert.deepEqual(J(w, 'msPurchaseDocs(30, "Nobody", "")'), []);
  w.eval('msOpenPurchasesReport(30); msPurchasesFilter("supplier", "Nobody")');
  assert.match(w.document.getElementById('ms-modal').textContent, /No purchase matches this search/, 'the empty search says so');
  b.close();
});
