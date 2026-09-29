import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 156, second audit pass. One regression test per defect, in every module that has it (each failed before its fix).
const SHOP_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const VARIANT_APPS = ['index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const A1 = { code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, wholesaleSellingPrice: 80, qty: 5, unit: 'pcs', vatCategory: 'A' };
const D1 = { code: 'D1', type: 'item', name: 'Cola', price: 100, wholesalePrice: 60, qty: 5, unit: 'pcs', dualUnit: true, unitsPerBox: 10, pieceQty: 0, piecePrice: 12, looseUnit: 'pcs', vatCategory: 'A' };
const V1 = { code: 'V1', type: 'item', name: 'Shirt', price: 100, qty: 10, unit: 'pcs', vatCategory: 'A', hasVariants: true,
  variants: [{ id: 'va', name: 'Red', code: 'V1-R', price: 100, wholesalePrice: 60, qty: 6, dualUnit: false }, { id: 'vb', name: 'Blue', code: 'V1-B', price: 110, wholesalePrice: 60, qty: 4, dualUnit: false }] };
const inv = (...items) => JSON.stringify(items);
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }";
async function open(app, items) { const b = await boot(app, { storage: { pos_inventory: inv(...items) }, wait: 900 }); b.w.eval(QUIET); return b; }
const cash = async (w, setup) => { w.eval(`currentCart = {}; ${setup}; currentPaymentMethod = 'cash'`); w.document.getElementById('cash-tendered-input').value = '100000'; await w.eval('checkoutCart()'); };
const doReturn = (w, saleId, qty) => {
  w.eval(`selectReturnRefItem('${saleId}', 0)`);
  w.document.getElementById('return-qty-input').value = String(qty);
  w.document.getElementById('return-condition-select').value = 'good';
  const r = w.document.getElementById('return-reason-select'); r.value = r.options[0].value;
};
const sum = (items) => Math.round(items.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;

// ---------- 1. a return puts back the unit / variant that was sold, with a movement ----------
for (const app of SHOP_APPS) {
  test(`${app}: returning loose pieces puts them back as loose pieces (not whole boxes), with a stock movement`, async () => {
    const b = await open(app, [D1]); const { w } = b;
    await cash(w, "addToCart('D1', 'piece'); addToCart('D1', 'piece'); addToCart('D1', 'piece')");
    assert.equal(w.eval('inventory[0].qty'), 4, 'a box was opened for the 3 pieces');
    assert.equal(w.eval('inventory[0].pieceQty'), 7);
    doReturn(w, w.eval('salesLog[0].id'), 2);
    w.eval('saveSimpleReturn()');
    assert.equal(w.eval('inventory[0].pieceQty'), 9, 'the 2 pieces are back as pieces');
    assert.equal(w.eval('inventory[0].qty'), 4, 'and no whole box was added');
    const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => /Returned Goods/.test(m.reason)))"));
    assert.equal(mv.length, 1); assert.equal(mv[0].delta, 2); assert.equal(mv[0].unit, 'pieceQty');
    b.close();
  });
}
for (const app of VARIANT_APPS) {
  test(`${app}: returning a variant puts it back on THAT variant, with a stock movement`, async () => {
    const b = await open(app, [V1]); const { w } = b;
    await cash(w, "addToCart('V1', undefined, undefined, 'vb'); addToCart('V1', undefined, undefined, 'vb'); addToCart('V1', undefined, undefined, 'vb')");
    assert.equal(w.eval("inventory[0].variants.find(v => v.id === 'vb').qty"), 1);
    assert.equal(w.eval('salesLog[0].items[0].variantId'), 'vb');
    doReturn(w, w.eval('salesLog[0].id'), 2);
    w.eval('saveSimpleReturn()');
    assert.equal(w.eval("inventory[0].variants.find(v => v.id === 'vb').qty"), 3, 'the 2 come back to Blue');
    assert.equal(w.eval("inventory[0].variants.find(v => v.id === 'va').qty"), 6, 'Red is untouched');
    assert.equal(w.eval('inventory[0].qty'), 9, 'the parent total is the sum of its variants (was 10 + 2 = 12 on the parent)');
    const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => /Returned Goods/.test(m.reason)))"));
    assert.equal(mv.length, 1); assert.equal(mv[0].delta, 2);
    b.close();
  });
}

// ---------- 2. retail + wholesale lines of one product together may not exceed its stock ----------
for (const app of SHOP_APPS) {
  test(`${app}: a retail line and a wholesale line of the same item are added up at checkout (3 + 3 of 5 is refused, nothing is sold)`, async () => {
    const b = await open(app, [A1]); const { w } = b;
    w.eval("currentCart = {}; addToCart('A1'); addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'cash'");
    w.eval("currentCart['A1-w'] = Object.assign({}, currentCart['A1'], { cartKey: 'A1-w', key: 'A1-w', price: 80, qty: 3 })");
    w.document.getElementById('cash-tendered-input').value = '100000';
    await w.eval('checkoutCart()');
    assert.equal(w.eval('salesLog.length'), 0, 'nothing was sold');
    assert.equal(w.eval('inventory[0].qty'), 5, 'and the stock is untouched');
    assert.ok(w.eval('window.__toasts').some((t) => /^ERR Not enough/.test(t) && /Tea/.test(t)), w.eval('window.__toasts').join(' | '));
    w.eval("currentCart['A1-w'].qty = 2");                                    // 3 + 2 = 5: exactly what there is
    w.document.getElementById('cash-tendered-input').value = '100000';
    await w.eval('checkoutCart()');
    assert.equal(w.eval('salesLog.length'), 1, 'within stock it sells');
    assert.equal(w.eval('inventory[0].qty'), 0);
    b.close();
  });
}

// ---------- 3. a flat offer is inside the sale's item lines ----------
for (const app of ['index.html', 'hotel/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: a flat offer (KES 50 off) is baked into the item lines, so they add up to what was charged (250, not 300)`, async () => {
    const b = await open(app, [{ ...A1, qty: 50 }]); const { w } = b;
    w.eval("offers = [{ id: 'o1', name: 'Deal', type: 'flat', scope: 'all', targets: [], active: true, flatAmount: 50, minQty: 2 }]");
    await cash(w, "addToCart('A1'); addToCart('A1'); addToCart('A1')");
    const sale = JSON.parse(w.eval('JSON.stringify(salesLog[0])'));
    assert.equal(sale.cashAmount, 250, 'the customer is charged 250 (unchanged)');
    assert.equal(sum(sale.items), 250, 'and the item lines add up to 250');
    assert.equal(w.eval('reportSaleTotal(salesLog[0])'), 250);
    assert.equal(sale.items.reduce((n, l) => n + l.qty, 0), 3, 'still 3 units');
    assert.equal(w.eval('inventory[0].qty'), 47);
    b.close();
  });
}

// ---------- 5. movement gaps ----------
for (const app of SHOP_APPS) {
  test(`${app}: an inline edit of the loose-piece stock is written to the stock ledger`, async () => {
    const b = await open(app, [{ ...D1, pieceQty: 4 }]); const { w } = b;
    w.eval("updateInventoryField('D1', 'pieceQty', '25')");
    assert.equal(w.eval('inventory[0].pieceQty'), 25);
    const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => m.code === 'D1'))"));
    assert.equal(mv.length, 1); assert.equal(mv[0].delta, 21); assert.equal(mv[0].unit, 'pieceQty');
    b.close();
  });
}
for (const app of VARIANT_APPS) {
  test(`${app}: an inline edit of a variant's stock is written to the stock ledger`, async () => {
    const b = await open(app, [V1]); const { w } = b;
    w.eval("updateVariantField('V1', 'va', 'qty', '9')");
    assert.equal(w.eval("inventory[0].variants[0].qty"), 9);
    const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => m.code === 'V1'))"));
    assert.equal(mv.length, 1); assert.equal(mv[0].delta, 3);
    b.close();
  });
}
for (const app of ['index.html', 'hotel/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: a Restock that creates a brand-new item writes its opening stock to the ledger`, async () => {
    const b = await open(app, [A1]); const { w } = b;
    w.eval("restockDraft = [{ name: 'Brand New Thing', code: '', qty: '12', cost: '40', sellPrice: '', wholesaleSell: '', unit: 'pcs' }]");
    w.eval('completeRestock()');
    const item = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Brand New Thing'))"));
    assert.equal(item.qty, 12);
    const mv = JSON.parse(w.eval(`JSON.stringify(stockMovementLog.filter(m => m.code === ${JSON.stringify(item.code)}))`));
    assert.equal(mv.length, 1, 'one movement for the new item'); assert.equal(mv[0].delta, 12);
    b.close();
  });
}
for (const app of SHOP_APPS) {
  test(`${app}: a Store to Branch transfer is written to the stock ledger (existing and new items), and applies once`, async () => {
    const b = await open(app, [A1]); const { w } = b;
    w.eval("storeApplyWithdrawn({ movementId: 'mv1', code: 'A1', name: 'Tea', qty: 4, price: 100, unit: 'pcs' })");
    w.eval("storeApplyWithdrawn({ movementId: 'mv2', code: 'N9', name: 'Newcomer', qty: 7, price: 10, unit: 'pcs' })");
    assert.equal(w.eval('storeApplyWithdrawn({ movementId: \'mv1\', code: \'A1\', name: \'Tea\', qty: 4, price: 100, unit: \'pcs\' })'), false, 'the same transfer is not applied twice');
    assert.equal(w.eval("inventory.find(p => p.code === 'A1').qty"), 9);
    const mvs = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => /Store/.test(m.reason)))"));
    assert.equal(mvs.length, 2, JSON.stringify(mvs));
    assert.deepEqual(mvs.map((m) => m.delta).sort(), [4, 7]);
    b.close();
  });
}
for (const app of SHOP_APPS) {
  test(`${app}: an exchange counts only the price difference as revenue (and restocks the returned pieces as pieces)`, async () => {
    const b = await open(app, [D1, { ...A1, qty: 50 }]); const { w } = b;
    await cash(w, "addToCart('D1', 'piece'); addToCart('D1', 'piece'); addToCart('D1', 'piece')");        // 3 pieces @ 12 = 36
    doReturn(w, w.eval('salesLog[0].id'), 2);
    w.eval("returnMode = 'exchange'; exchangeTopupMethod = 'cash'; addExchangeReplacementItem('A1')");     // replacement 100
    w.document.getElementById('exchange-credit-value-input').value = '24';                                 // the 2 returned pieces are worth 24
    w.eval('saveExchange()');
    assert.equal(w.eval('salesLog.length'), 2, w.eval('window.__toasts').join(' | ') + ' ' + w.document.getElementById('return-save-error').textContent);
    const ex = JSON.parse(w.eval('JSON.stringify(salesLog[1])'));
    assert.equal(ex.isExchange, true);
    assert.equal(ex.cashAmount, 76, 'the customer paid the 76 difference');
    assert.equal(sum(ex.items), 76, 'and that is all the exchange counts as revenue (was 100)');
    assert.equal(w.eval('salesLog.map(reportSaleTotal).reduce((a, x) => a + x, 0)'), 36 + 76);
    assert.equal(ex.items[0].wholesalePrice, 50, 'cost is untouched, so profit stays right');
    assert.equal(w.eval("inventory.find(p => p.code === 'D1').pieceQty"), 9, 'the returned pieces went back as pieces');
    b.close();
  });
}
for (const app of SHOP_APPS) {
  test(`${app}: marking a sale Paid / Unpaid needs the management password and leaves an audit entry`, async () => {
    const b = await open(app, [A1]); const { w } = b;
    await cash(w, "addToCart('A1')");
    const id = w.eval('salesLog[0].id');
    w.eval("window.__asked = []; requireManagementApproval = function (m, then) { window.__asked.push(m); window.__then = then; }");
    w.eval(`togglePaidStatus('${id}')`);
    assert.equal(w.eval('salesLog[0].paid'), true, 'nothing changes before the password is given');
    assert.equal(w.eval('window.__asked.length'), 1);
    w.eval('window.__then()');
    assert.equal(w.eval('salesLog[0].paid'), false, 'and it flips once it is');
    const ch = JSON.parse(w.eval('JSON.stringify(salesLog[0].paidStatusChanges)'));
    assert.equal(ch.length, 1); assert.equal(ch[0].from, 'paid'); assert.equal(ch[0].to, 'unpaid');
    assert.ok(w.eval("buildAuditEvents().some(e => e.action === 'Paid status changed')"), 'it shows in the Audit tab');
    b.close();
  });
}

// ---------- 4. Aqua POS: void gives the stock back, and a failed checkout rolls back tanks / materials / products ----------
const AQ_PRODUCTS = JSON.stringify([{ code: 'B500', category: 'bottled', name: 'Sealed Bottle 500ml', sizeML: 500, price: 50, wholesalePrice: 30, qty: 100, priceTiers: [], bom: [{ materialId: 'm1', qty: 2 }], vatCategory: 'A', customQuote: false }]);
const AQ_MATS = JSON.stringify([{ id: 'm1', name: 'Caps', unitCost: 1, stockQty: 500 }]);
const AQ_SIZES = JSON.stringify([{ id: 'rs1', label: '1L', sizeML: 1000, price: 20, siteId: 'site-shop-1' }]);
async function aqua() {
  const b = await boot('water/index.html', { storage: { aqua_products: AQ_PRODUCTS, aqua_raw_materials: AQ_MATS, aqua_refill_sizes: AQ_SIZES }, wait: 1000 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}");
  return b;
}
const aqState = (w) => JSON.parse(w.eval("JSON.stringify({ qty: products[0].qty, stock: products[0].stock['site-shop-1'], tank: tanks.find(t => t.siteId === 'site-shop-1').currentVolumeLiters, mat: rawMaterials[0].stockQty })"));
const aqSell = (w) => { w.eval("currentCart = {}; addBottledToCart('B500', null, 3); addRefillToCart('rs1'); currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '1000'; w.eval('checkoutCart()'); };

test('water/index.html: voiding a sale puts back the bottles, the tank litres and the BOM materials - once per void; unvoid takes them again once', async () => {
  const b = await aqua(); const { w } = b;
  aqSell(w);
  assert.equal(w.eval('salesLog.length'), 1);
  assert.deepEqual(aqState(w), { qty: 97, stock: 97, tank: 4999, mat: 494 });
  const id = w.eval('salesLog[0].id');
  const voidIt = () => w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('${id}')`);
  const unvoidIt = () => w.eval(`pendingVoidSaleSource = 'salesLog'; performUnvoidSale('${id}')`);
  voidIt(); voidIt();                                                     // (a double tap must not give it back twice)
  assert.deepEqual(aqState(w), { qty: 100, stock: 100, tank: 5000, mat: 500 }, 'void puts everything back, once');
  unvoidIt(); unvoidIt();
  assert.deepEqual(aqState(w), { qty: 97, stock: 97, tank: 4999, mat: 494 }, 'unvoid takes it again, once');
  voidIt();
  assert.deepEqual(aqState(w), { qty: 100, stock: 100, tank: 5000, mat: 500 }, 'and a second void puts it back again');
  const keys = JSON.parse(w.eval("JSON.stringify(stockMovementLog.map(m => m.id))"));
  assert.ok(keys.some((k) => /^void:/.test(k)) && new Set(keys).size === keys.length, 'the void movements carry the sale in their id');
  b.close();
});

test('water/index.html: voiding a sale that had a return only puts back what was NOT returned', async () => {
  const b = await aqua(); const { w } = b;
  w.eval("currentCart = {}; addBottledToCart('B500', null, 3); currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '1000'; w.eval('checkoutCart()');
  assert.equal(aqState(w).qty, 97);
  const sale = JSON.parse(w.eval('JSON.stringify(salesLog[0])'));
  w.eval(`returns.push({ id: 'r1', type: 'return', itemCode: 'B500', qty: 2, refNumber: '${sale.refNumber}', condition: 'good', restocked: true })`);
  w.eval("adjustProductStock(products[0], 2, 'Returned Goods (restock)')");
  assert.equal(aqState(w).qty, 99);
  w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('${sale.id}')`);
  assert.equal(aqState(w).qty, 100, 'sold 3, 2 came back, the void puts back the 1 that did not (100, not 102)');
  assert.equal(aqState(w).mat, 496, 'and only the caps of the 1 unit put back (6 used for 3 units, 2 of them back: 494 + 2)');
  b.close();
});

test('water/index.html: a checkout that fails before the sale is saved puts the tank litres, the materials and the bottles back', async () => {
  const b = await aqua(); const { w } = b;
  w.eval("window.__realRef = generateReceiptRef; generateReceiptRef = function () { throw new Error('boom before the sale is saved'); }");
  aqSell(w);
  assert.equal(w.eval('salesLog.length'), 0, 'no half sale');
  assert.deepEqual(aqState(w), { qty: 100, stock: 100, tank: 5000, mat: 500 }, 'the bottles, the litres and the caps are exactly as they were');
  assert.ok(w.eval('window.__toasts').some((t) => /NOT completed/.test(t) && /boom/.test(t)), 'the cashier is told');
  w.eval('generateReceiptRef = window.__realRef');
  aqSell(w);                                                              // the retry
  assert.equal(w.eval('salesLog.length'), 1);
  assert.deepEqual(aqState(w), { qty: 97, stock: 97, tank: 4999, mat: 494 }, 'and sells exactly once');
  b.close();
});
