import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Reported: "in aqua i notice that even if i set the cost price for items,
// sealed bottles or bales its not used to calculate profit." Root cause:
// itemCogs() only ever priced a sale line from its BOM (materialsUsed) or
// the water-litre rate for refills — a plain bottled item or a bale with
// no production recipe (i.e. exactly the case where the cost price is set
// directly, not derived from materials) fell through with zero cost every
// time, so gross profit was overstated by the item's full cost on every
// such sale.
const PRODUCTS = JSON.stringify([
  { code: 'B500', category: 'bottled', name: 'Sealed Bottle 500ml', sizeML: 500, price: 50, wholesalePrice: 30, qty: 100, priceTiers: [], bom: [], vatCategory: 'A', customQuote: false },
  { code: 'BALE1', category: 'bale', name: 'Branded Bale 12x500ml', sizeML: 500, price: 600, wholesalePrice: 400, qty: 20, priceTiers: [], bom: [], vatCategory: 'A', customQuote: false, bottlesPerBale: 12 },
]);

async function session() {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
  const { w } = b;
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }");
  return b;
}

test('water/index.html: a sealed bottle with no BOM sells with its real Cost Price counted as COGS, not zero', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addBottledToCart('B500', null, 3)");
  w.eval("currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '150';
  w.eval('checkoutCart()');
  const sale = w.eval('salesLog[salesLog.length - 1]');
  assert.equal(sale.items[0].costAtSale, 30, 'the cost price is snapshotted onto the sale line');
  const cogs = w.eval(`saleCogs(salesLog[salesLog.length - 1])`);
  assert.equal(cogs, 90, '3 bottles x 30 cost = 90 COGS, not 0');
  b.close();
});

test('water/index.html: a bale with no BOM sells with its real Cost Price counted as COGS, and gross profit reflects it', async () => {
  const b = await session();
  const { w } = b;
  w.eval("addBottledToCart('BALE1', null, 2)");
  w.eval("currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '1200';
  w.eval('checkoutCart()');
  const sale = w.eval('salesLog[salesLog.length - 1]');
  const cogs = w.eval(`saleCogs(salesLog[salesLog.length - 1])`);
  const revenue = sale.items.reduce((s, it) => s + it.price * it.qty, 0);
  assert.equal(cogs, 800, '2 bales x 400 cost = 800 COGS');
  assert.equal(revenue - cogs, 400, 'gross profit is revenue minus the real cost, not the full sale price');
  b.close();
});

test('water/index.html: a bottle sold via BOM (materialsUsed present) is unaffected — still costed from materials, not double-counted against its own wholesalePrice', async () => {
  const b = await session();
  const { w } = b;
  // Simulate a BOM-produced line (as if deductBomForLine had run) directly
  // through saleCogs/itemCogs rather than the full production UI.
  const sale = { items: [{ type: 'bottled', code: 'B500', qty: 3, price: 50, materialsUsed: [{ qty: 3, unitCost: 5 }] }] };
  const cogs = w.eval(`saleCogs(${JSON.stringify(sale)})`);
  assert.equal(cogs, 15, 'materials cost (already totalled for the line, 3 x 5) is used, not the item wholesalePrice (30) added on top of it');
  b.close();
});
