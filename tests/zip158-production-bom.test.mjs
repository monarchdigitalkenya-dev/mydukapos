import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 158 — production BOM audit: every material change is a keyed stock movement, a short material is never invented back on a void,
// materials go back to the right item (by code), the whole cart is checked against stock together, an assembly cannot use one material
// twice beyond what is there.
const INV = () => [
  { code: 'FLR', type: 'item', name: 'Flour', category: 'Raw', price: 0, wholesalePrice: 100, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'FLR2', type: 'item', name: 'Flour', category: 'Raw', price: 0, wholesalePrice: 90, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'SGR', type: 'item', name: 'Sugar', category: 'Raw', price: 0, wholesalePrice: 150, qty: 5, unit: 'kg', vatCategory: 'A' },
  { code: 'CAKE', type: 'item', name: 'Cake', category: 'Baked', price: 900, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'FLR', qty: 2 }, { code: 'SGR', qty: 1 }] },
  { code: 'BUN', type: 'item', name: 'Bun', category: 'Baked', price: 50, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', productionRecipe: [{ code: 'FLR', qty: 3 }] },
  { code: 'CHAI', type: 'service', name: 'Chai', category: 'Drinks', price: 60, vatCategory: 'A', recipe: [{ code: 'SGR', qtyPerUnit: 0.5 }] },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app(inv = INV()) {
  const b = await boot('production/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1200 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}; window.__init = JSON.parse(JSON.stringify(inventory.map(i => [i.code, i.qty])))");
  return b;
}
// the ledger the server rebuilds stock from must explain every quantity on the shelf
const drift = (w) => J(w, `(function () { const out = []; window.__init.forEach(([c, q0]) => { const it = inventory.find(i => i.code === c); const d = stockMovementLog.filter(m => m.code === c && m.unit !== 'pieceQty' && m.type !== 'kitchen').reduce((n, m) => n + (Number(m.delta) || 0), 0); if (Math.abs((q0 + d) - (it.qty || 0)) > 1e-6) out.push([c, q0, d, it.qty]); }); return out; })()`);
const ring = async (w, codes, cash = 100000) => {
  w.eval(`currentCart = {}; currentPaymentMethod = 'cash'; ${codes.map((c) => `addToCart('${c}')`).join('; ')}; document.getElementById('cash-tendered-input').value = '${cash}'`);
  await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
};

test('B1: a recipe service sale and its void are stock movements (the server rebuilds stock from them)', async () => {
  const b = await app(); const { w } = b;
  await ring(w, ['CHAI', 'CHAI', 'CAKE']);
  assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 5 - 1 - 1);
  assert.deepEqual(drift(w), [], 'after the sale every change is in the ledger');
  const id = J(w, 'salesLog[salesLog.length - 1].id');
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'x'; performVoidSale('${id}')`);
  assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 5);
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR').qty"), 10);
  assert.deepEqual(drift(w), [], 'after the void too');
  assert.ok(J(w, "stockMovementLog.filter(m => /^void:/.test(m.id) && m.code === 'SGR').length") >= 1, 'the give-back is keyed so a second till applies it once');
  b.close();
});

test('B2: a sale that could only take part of a short material gives back only that part on a void', async () => {
  const inv = INV(); inv.find((i) => i.code === 'FLR').qty = 1;
  const b = await app(inv); const { w } = b;
  const used = J(w, "deductStockForSaleUnit(inventory.find(i => i.code === 'CAKE'), 1, null)");
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR').qty"), 0);
  assert.equal(used.find((c) => c.name === 'Flour').qty, 1, 'what was really taken, not what the recipe asked for');
  w.eval(`restoreEntriesForVoid([{ code: 'CAKE', qty: 1, componentsUsedActual: ${JSON.stringify(used)} }])`);
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR').qty"), 1, 'flour is not invented by the void');
  assert.deepEqual(drift(w), []);
  b.close();
});

test('B3: materials with the same name go back to the right item (by code)', async () => {
  const inv = INV(); inv.find((i) => i.code === 'BUN').productionRecipe = [{ code: 'FLR2', qty: 3 }];
  const b = await app(inv); const { w } = b;
  const used = J(w, "deductStockForSaleUnit(inventory.find(i => i.code === 'BUN'), 2, null)");
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR2').qty"), 4);
  w.eval(`restoreEntriesForVoid([{ code: 'BUN', qty: 2, componentsUsedActual: ${JSON.stringify(used)} }])`);
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR2').qty"), 10, 'the second flour comes back');
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR').qty"), 10, 'the first flour is untouched');
  assert.deepEqual(drift(w), []);
  b.close();
});

test('B4: two produced items sharing a material are checked together, so the sale never floors a material at 0', async () => {
  const inv = INV(); inv.find((i) => i.code === 'FLR').qty = 4;
  const b = await app(inv); const { w } = b;
  await ring(w, ['CAKE', 'BUN']);   // 2 kg + 3 kg of flour, 4 kg on the shelf: each line alone fits
  assert.equal(J(w, 'salesLog.length'), 0, 'refused');
  assert.equal(J(w, "inventory.find(i => i.code === 'FLR').qty"), 4);
  assert.ok((w.eval('window.__toasts') || []).some((t) => /Not enough "Flour"/.test(t)));
  b.close();
});

test('B5: an assembly cannot use one material twice beyond what is on the shelf; the ledger matches', async () => {
  const inv = INV(); inv.push({ code: 'KIT', type: 'item', name: 'Kit', category: 'Baked', price: 100, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A' });
  inv.find((i) => i.code === 'SGR').qty = 3;
  const b = await app(inv); const { w, d } = b;
  w.eval("populateAssembleItemSelect(); document.getElementById('assemble-item-select').value = 'KIT'; onAssembleItemChange(); assemblyRecipeDraft = [{ code: 'SGR', qty: '2' }, { code: 'SGR', qty: '2' }]");
  d.getElementById('assemble-qty-input').value = '1';
  w.eval('runAssembly()');
  assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 3, 'refused: 4 kg needed, 3 there');
  assert.equal(J(w, "inventory.find(i => i.code === 'KIT').qty"), 0);
  w.eval("assemblyRecipeDraft = [{ code: 'SGR', qty: '0.1' }]");
  d.getElementById('assemble-qty-input').value = '3';
  w.eval('runAssembly()');
  assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 2.7, 'no 2.7000000000000002');
  assert.equal(J(w, "inventory.find(i => i.code === 'KIT').qty"), 3);
  assert.deepEqual(drift(w), []);
  b.close();
});

test('B6: voiding a sale after a partial return gives back only the un-returned share of the materials', async () => {
  const b = await app(); const { w } = b;
  const items = J(w, `(function () { returns.push({ id: 'r1', refNumber: 'R1', itemCode: 'BUN', qty: 1 }); return voidRestoreItems({ refNumber: 'R1', items: [{ code: 'BUN', qty: 2, componentsUsed: [{ code: 'FLR', name: 'Flour', qty: 6, unit: 'kg' }] }] }); })()`);
  assert.equal(items[0].qty, 1);
  assert.equal(items[0].componentsUsed[0].qty, 3);
  b.close();
});

for (const appPath of ['index.html', 'pharmacy/index.html', 'services/index.html', 'hospital/index.html', 'production/index.html']) {
  test(`B7 ${appPath}: a recipe service sale and its void leave the stock ledger explaining the shelf`, async () => {
    const inv = [
      { code: 'SGR', type: 'item', name: 'Sugar', category: 'Raw', price: 0, wholesalePrice: 150, qty: 5, unit: 'kg', vatCategory: 'A' },
      { code: 'CHAI', type: 'service', name: 'Chai', category: 'Drinks', price: 60, vatCategory: 'A', recipe: [{ code: 'SGR', qtyPerUnit: 0.1 }] },
    ];
    const b = await boot(appPath, { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1200 });
    const { w } = b;
    w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}; window.__init = [['SGR', 5]]");
    await ring(w, ['CHAI', 'CHAI', 'CHAI']);
    assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 4.7);
    assert.deepEqual(drift(w), [], 'sale in the ledger');
    const id = J(w, 'salesLog[salesLog.length - 1].id');
    w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'x'; performVoidSale('${id}')`);
    assert.equal(J(w, "inventory.find(i => i.code === 'SGR').qty"), 5);
    assert.deepEqual(drift(w), [], 'void in the ledger');
    b.close();
  });
}
