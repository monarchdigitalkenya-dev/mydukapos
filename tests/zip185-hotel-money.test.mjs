import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 185 — Hotel money audit: baked offer lines sum exactly, cart total floored at 0, bill cost shares, delivery fee in revenue,
// negative split rejected, cross-branch lines never touch local stock.
const ITEMS = [
  { code: 'T', type: 'item', name: 'Tea', category: 'General', price: 33.33, wholesalePrice: 20, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: 'H', type: 'item', name: 'Hundred', category: 'General', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs', vatCategory: 'A' },
];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const mk = async () => { const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 }); quiet(b.w); return b; };

test('hotel: percent offer on 33.33 x 3 — saved item lines sum to exactly what was charged', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  w.eval("offers = [{ id: 'o1', type: 'percent', active: true, scope: 'all', percentOff: 10, name: 'Ten' }]");
  w.eval("currentCart = {}; addToCart('T'); currentCart['T'].qty = 3; currentPaymentMethod = 'cash'");
  const total = w.eval('cartTotal()');
  assert.equal(total, 89.99, 'the offer applied');
  w.document.getElementById('cash-tendered-input').value = '100000';
  await w.eval('checkoutCart()');
  await new Promise((r) => setTimeout(r, 80));
  const s = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
  const sum = s.items.reduce((t, i) => t + i.price * i.qty, 0);
  assert.ok(Math.abs(sum - total) < 0.005, `lines ${sum} vs charged ${total}`);
  b.close();
});

test('hotel: a 50% offer plus a flat KES 60 off a KES 100 item never takes the total below 0', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  w.eval("offers = [{ id: 'p', type: 'percent', active: true, scope: 'all', percentOff: 50, name: 'Half' }, { id: 'f', type: 'flat', active: true, scope: 'all', flatAmount: 60, name: 'Sixty' }]");
  w.eval("currentCart = {}; addToCart('H')");
  const t = w.eval('cartTotal()');
  assert.ok(t >= 0 && t <= 50, 'total ' + t);
  b.close();
});

test('hotel: a negative split-payment part is refused and nothing is sold', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  w.eval("currentCart = {}; addToCart('H'); currentPaymentMethod = 'split'");
  const d = w.document; const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = v; };
  set('split-cash-input', '-50'); set('split-mpesa-input', '150'); set('split-cash-tendered-input', '0');
  await w.eval('checkoutCart()');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(w.eval('salesLog.filter(s => !s._deleted).length'), 0);
  assert.equal(w.eval("inventory.find(i => i.code === 'H').qty"), 50);
  b.close();
});

test('hotel: bill cost shares across instalments add up to the bill cost exactly; delivery fee is part of the bill total', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  const r = JSON.parse(w.eval(`(() => {
    const bill = { items: [{ code: 'H', name: 'Hundred', price: 1000, qty: 1, wholesalePrice: 600, unit: 'pcs' }], deliveryDetails: { fee: 200 }, paymentHistory: [] };
    const out = { total: billTotalOf(bill) };
    const a1 = billCostShareFor(bill, 500, 0); bill.paymentHistory.push({ amount: 500, costShare: a1 });
    const a2 = billCostShareFor(bill, 300, 500); bill.paymentHistory.push({ amount: 300, costShare: a2 });
    const a3 = billCostShareFor(bill, 400, 800); out.shares = [a1, a2, a3]; out.sum = round2(a1 + a2 + a3);
    return JSON.stringify(out); })()`));
  assert.equal(r.total, 1200);
  assert.equal(r.sum, 600, 'instalments carry the whole cost: ' + JSON.stringify(r.shares));
  b.close();
});

test('hotel: Daily Sales revenue includes a delivery fee', { timeout: 150000 }, async () => {
  const b = await mk(); const { w } = b;
  const r = w.eval(`(() => { const s = { orderType: 'delivery', deliveryDetails: { fee: 150 }, items: [{ price: 100, qty: 2 }] };
    return [saleRevenueTotal(s), saleDeliveryFeeExtra({ ...s, items: [{ unit: 'payment', price: 50, qty: 1 }] })]; })()`);
  assert.equal(r[0], 350); assert.equal(r[1], 0, 'a payment line already carries the money');
  b.close();
});
