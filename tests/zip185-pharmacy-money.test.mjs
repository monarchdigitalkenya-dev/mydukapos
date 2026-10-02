import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 185 - Pharmacy money / stock fixes: cost of goods on credit-bill payment lines, the delivery fee on a bill, negative split amounts, the exchange
// credit cap, fractional returns, the one-shot bulk-delete mark, and a line from another branch not taking this branch's stock.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const open = async () => { const b = await boot('pharmacy/index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 }); quiet(b.w); return b; };

test('pharmacy: a credit-bill payment carries its share of the cost, the last one takes the remainder', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  w.eval("window.__bill = { id: 'B1', items: [{ code: 'X', name: 'X', qty: 1, price: 1000, wholesalePrice: 600, unit: 'pcs', vatCategory: 'A' }] }");
  const first = w.eval('billCostShareFor(__bill, 333.33, 1000)');
  assert.equal(first, 200);   // 600 * 333.33 / 1000 = 199.998 -> 200.00
  w.eval("salesLog.push({ id: 'p1', billId: 'B1', items: [{ unit: 'payment', price: 333.33, qty: 1, costShare: 200 }] })");
  const second = w.eval('billCostShareFor(__bill, 333.33, 666.67)');
  assert.equal(second, 200);
  w.eval("salesLog.push({ id: 'p2', billId: 'B1', items: [{ unit: 'payment', price: 333.33, qty: 1, costShare: 200 }] })");
  const last = w.eval('billCostShareFor(__bill, 333.34, 333.34)');
  assert.equal(last, 200);    // the remainder: 600 - 200 - 200, so the shares add up to the bill cost exactly
  assert.equal(w.eval('reportSaleCost({ items: [{ unit: "payment", price: 500, qty: 1, costShare: 300 }] })'), 300);
  close();
});

test('pharmacy: a delivery fee on a credit bill is part of what is owed', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  const r = JSON.parse(w.eval(`(() => {
    const b = { id: 'B2', items: [{ code: 'A', name: 'A', qty: 1, price: 1000, unit: 'pcs' }], deliveryDetails: { fee: 200 }, amountPaid: 500, timestamp: new Date().toISOString() };
    recomputeBillStatus(b); const s1 = b.status;
    bills.push(b); const row = getOpenBillsList().find(x => x.id === 'B2');
    b.amountPaid = 1000; recomputeBillStatus(b); const s2 = b.status;
    b.amountPaid = 1200; recomputeBillStatus(b);
    return JSON.stringify({ s1, owed: row && row.amount, s2, s3: b.status });
  })()`));
  assert.equal(r.s1, 'partially_paid'); assert.equal(r.owed, 700); assert.equal(r.s2, 'partially_paid'); assert.equal(r.s3, 'fully_paid');
  assert.equal(w.eval("saleDeliveryFeeOf({ deliveryDetails: { fee: 200 }, items: [{ price: 100, qty: 1 }] })"), 200);
  assert.equal(w.eval("saleDeliveryFeeOf({ deliveryDetails: { fee: 200 }, items: [{ unit: 'payment', price: 100, qty: 1 }] })"), 0);
  close();
});

test('pharmacy: a negative cash / M-Pesa split is refused at checkout', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  w.eval("currentCart = {}; addToCart('A'); currentPaymentMethod = 'split'");
  const d = w.document; const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = v; };
  set('split-cash-input', '-50'); set('split-mpesa-input', '150'); set('mpesa-code-input', 'QWE1234567'); set('mpesa-phone-input', '0712345678');
  await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
  assert.equal(w.eval('salesLog.length'), 0, 'no sale was recorded');
  assert.equal(w.eval("inventory.find(i => i.code === 'A').qty"), 50, 'and no stock came off');
  assert.ok((w.__toasts || []).some((t) => /negative/i.test(t)), 'the cashier is told why');
  close();
});

test('pharmacy: exchange credit is capped at what was paid; returns accept fractions of a weighed unit', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  w.eval("salesLog.push({ id: 's1', refNumber: 'R-1', timestamp: new Date().toISOString(), items: [{ code: 'A', name: 'Alpha', qty: 2, price: 90, unit: 'pcs' }] })");
  assert.equal(w.eval("exchangeCreditCap({ code: 'A', sourceRefNumber: 'R-1' }, 1)"), 90);
  assert.equal(w.eval("exchangeCreditCap({ code: 'A' }, 3)"), 300, 'no receipt: the item price');
  w.eval("window.__sel = { code: 'K', unit: 'kg' }; selectedReturnItem = __sel; document.getElementById('return-qty-input').value = '0.5'");
  assert.equal(w.eval('returnQtyValue()'), 0.5);
  w.eval("selectedReturnItem = { code: 'A', unit: 'pcs' }; document.getElementById('return-qty-input').value = '2'");
  assert.equal(w.eval('returnQtyValue()'), 2);
  close();
});

test('pharmacy: a deliberate inventory reset marks the bulk delete so the tombstones are sent', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  w.eval("window.__bulkDelete = {}; performResetInventory()");
  assert.equal(w.eval('!!(window.__bulkDelete && window.__bulkDelete.inventory)'), true);
  close();
});

test('pharmacy: a variant line is limited by its own variant stock', { timeout: 45000 }, async () => {
  const { w, close } = await open();
  const n = w.eval("cartLineAvailable({ variantId: 'v1', saleMode: 'box' }, { qty: 15, variants: [{ id: 'v1', qty: 3 }, { id: 'v2', qty: 12 }] })");
  assert.equal(n, 3);
  close();
});
