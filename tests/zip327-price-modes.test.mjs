// zip 327 (issue 9): Retail / Wholesale / Measure-by-price on a measured-unit line - price, quantity, stock, sale record and void all agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
const INV = [
  { code: 'M', type: 'item', name: 'Beef (kg)', price: 800, wholesaleSellingPrice: 600, wholesalePrice: 500, qty: 10, unit: 'kg', vatCategory: 'A', openingStock: { qty: 10, costPrice: 500, date: '2026-01-01', setBy: 'x' } },
  { code: 'P', type: 'item', name: 'Pen', price: 50, wholesaleSellingPrice: 40, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'D', type: 'item', name: 'Soda Crate', price: 600, wholesaleSellingPrice: 500, qty: 5, unit: 'box', dualUnit: true, unitsPerBox: 12, pieceCode: 'DP', piecePrice: 60, pieceQty: 0, looseUnit: 'pcs', vatCategory: 'A' },
];
const setup = async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(INV) }, wait: 800 });
  b.w.eval("showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };");
  return b;
};
const line = (w, k) => JSON.parse(w.eval(`JSON.stringify(currentCart[${JSON.stringify(k)}] || null)`));
const stock = (w) => w.eval("inventory.find(p => p.code === 'M').qty");
const measure = (b, amount) => { const { d, w } = b; w.eval("__mbp.open('M')"); const inp = d.getElementById('mbp-amount'); inp.value = String(amount); inp.dispatchEvent(new w.Event('input', { bubbles: true })); return d; };

test('1-3 retail by default, wholesale switches the unit price, back to retail', async () => {
  const b = await setup(); const { w } = b;
  w.eval("addToCart('M')");
  assert.equal(line(w, 'M').price, 800, '1. retail by default');
  w.eval("selectCartPriceOption('M', 'wholesale')");
  assert.equal(line(w, 'M').price, 600, '2. wholesale selling price (not the cost price)');
  w.eval("selectCartPriceOption('M', 'retail')");
  assert.equal(line(w, 'M').price, 800, '3. back to retail');
});

test('4-5 measure by price: KES 100 at retail 800/kg = 0.125 kg; at wholesale 600/kg = 0.167 kg (rounded to 3 decimals, said before applying)', async () => {
  const b = await setup(); const { w } = b;
  w.eval("addToCart('M')");
  let d = measure(b, 100);
  assert.match(d.getElementById('mbp-out').textContent, /0\.125 kg/, '4.'); assert.equal(d.getElementById('mbp-ok').disabled, false);
  d.getElementById('mbp-ok').click();
  assert.equal(line(w, 'M').qty, 0.125);
  w.eval("selectCartPriceOption('M', 'wholesale')");
  d = measure(b, 100);
  assert.match(d.getElementById('mbp-out').textContent, /0\.167 kg/, '5.'); assert.match(d.getElementById('mbp-out').textContent, /rounded to 0\.001/);
  d.getElementById('mbp-ok').click();
  assert.equal(line(w, 'M').qty, 0.167); assert.equal(line(w, 'M').price, 600);
});

test('6-7 measure by price is only for measured units - not for pieces, and not for a box-and-piece line', async () => {
  const b = await setup(); const { w } = b;
  w.eval("addToCart('P'); addToCart('D', 'piece')");
  assert.equal(w.eval("__mbp.measured(currentCart['P'])"), false, '6. pcs');
  const k = Object.keys(JSON.parse(w.eval('JSON.stringify(currentCart)'))).find((x) => x !== 'P');
  assert.equal(w.eval(`__mbp.measured(currentCart[${JSON.stringify(k)}])`), false, '7. loose pieces of a box item');
});

test('8-9 more than the stock is refused; cancel leaves the line as it was', async () => {
  const b = await setup(); const { w, d } = b;
  w.eval("addToCart('M')");
  measure(b, 99999);
  assert.equal(d.getElementById('mbp-ok').disabled, true, '8. refused'); assert.match(d.getElementById('mbp-out').textContent, /Only 10 kg available/);
  d.querySelector('#mbp .mbp-no').click();
  assert.equal(line(w, 'M').qty, 1, '9. unchanged'); assert.equal(d.getElementById('mbp-bg'), null);
});

test('10-12 sale: quantity x price = cash taken, stock drops by exactly that quantity, void gives exactly that back', async () => {
  const b = await setup(); const { w, d } = b;
  w.eval("addToCart('M')");
  measure(b, 100).getElementById('mbp-ok').click();
  w.eval("currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '1000';
  await w.eval('checkoutCart()');
  const sale = JSON.parse(w.eval('JSON.stringify(salesLog[0])'));
  assert.equal(sale.items[0].qty, 0.125); assert.equal(sale.items[0].price, 800); assert.equal(sale.cashAmount, 100, '10. money = 0.125 x 800');
  assert.equal(stock(w), 9.875, '11. stock = 10 - 0.125');
  w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('${sale.id}')`);
  assert.equal(stock(w), 10, '12. void puts back exactly 0.125 (no float drift)');
  assert.equal(w.eval('salesLog.filter(s => !s.voided).length'), 0);
});
