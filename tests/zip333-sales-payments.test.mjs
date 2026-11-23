import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// zip 333: the Payments collected panel on Daily Sales, in every app. Numbers come from the real sale records.
const today = () => new Date().toISOString();
const item = (price, qty = 1) => [{ code: 'A1', name: 'Thing', qty, price, unit: 'pcs', vatCategory: 'A' }];
const SALES = (pre) => [
  { id: pre + '1', refNumber: 'R1', timestamp: today(), paymentMethod: 'cash', paid: true, cashAmount: 1000, mpesaAmount: 0, cardAmount: 0, items: item(1000), servedBy: 'A', total: 1000 },
  { id: pre + '2', refNumber: 'R2', timestamp: today(), paymentMethod: 'split', paid: true, cashAmount: 600, mpesaAmount: 400, cardAmount: 0, items: item(1000), servedBy: 'A', total: 1000 },
  { id: pre + '3', refNumber: 'R3', timestamp: today(), paymentMethod: 'card', paid: true, cashAmount: 0, mpesaAmount: 0, cardAmount: 300, items: item(300), servedBy: 'A', total: 300 },
  { id: pre + '4', refNumber: 'R4', timestamp: today(), paymentMethod: 'mpesa', paid: true, cashAmount: 0, mpesaAmount: 500, cardAmount: 0, items: item(500), servedBy: 'A', total: 500 },
  { id: pre + '5', refNumber: 'R5', timestamp: today(), paymentMethod: 'cash', paid: false, cashAmount: 0, mpesaAmount: 0, cardAmount: 0, items: item(700), servedBy: 'A', total: 700 },
  { id: pre + '6', refNumber: 'R6', timestamp: today(), paymentMethod: 'cash', paid: true, voided: true, cashAmount: 250, mpesaAmount: 0, cardAmount: 0, items: item(250), servedBy: 'A', total: 250 },
];

test('P1 totals(): split counted once, unpaid and voided separate, legacy method fallback', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: '[]' }, wait: 600 });
  try {
    const t = JSON.parse(w.eval(`JSON.stringify(SalesPay.totals(${JSON.stringify(SALES('x'))}))`));
    assert.deepEqual([t.cash, t.mpesa, t.card, t.other], [1600, 900, 300, 0]);
    assert.equal(t.collected, 2800); assert.equal(t.value, 2800, 'KES 1,000 split sale is 1,000 of value, never 2,000');
    assert.equal(t.unpaid, 700); assert.equal(t.voided, 250); assert.equal(t.count, 5); assert.equal(t.voidedCount, 1);
    const legacy = JSON.parse(w.eval(`JSON.stringify(SalesPay.totals([{ timestamp: 1, paymentMethod: 'mpesa', paid: true, items: [{ price: 100, qty: 2 }] }, { timestamp: 1, paymentMethod: 'bank', paid: true, items: [{ price: 50, qty: 1 }] }]))`));
    assert.deepEqual([legacy.mpesa, legacy.other, legacy.collected], [200, 50, 250]);
  } finally { close(); }
});

for (const app of APPS) {
  const pre = app === 'water/index.html' ? 'aqua_' : 'pos_';
  test(`${app}: Daily Sales shows the Payments collected panel with the right numbers`, async () => {
    const { w, d, close } = await boot(app, { storage: { [pre + 'sales_log']: JSON.stringify(SALES('s')), pos_inventory: '[]' }, wait: 900 });
    try {
      w.eval("var _d = document.getElementById('daily-sales-tab'); if (_d) { document.querySelectorAll('.tab-content').forEach(function (x) { x.classList.remove('active'); }); _d.classList.add('active'); }");
      w.eval('renderDailySales()');
      const panel = d.getElementById('spc-panel');
      assert.ok(panel, 'the panel is on the screen');
      const txt = panel.textContent.replace(/\s+/g, ' ');
      assert.match(txt, /Total collected[^K]*KES 2,800\.00/);
      assert.match(txt, /Cash\s*KES 1,600\.00/); assert.match(txt, /M-Pesa\s*KES 900\.00/); assert.match(txt, /Card\s*KES 300\.00/); assert.match(txt, /Other\s*KES 0\.00/);
      // the shop apps keep unpaid bills out of the sales list when the app starts (they wait in the Bills tab); Aqua keeps them in it
      if (app === 'water/index.html') assert.match(txt, /Unpaid \/ on credit \(1\)\s*KES 700\.00/); else assert.match(txt, /Unpaid \/ on credit \(0\)\s*KES 0\.00/); assert.match(txt, /Voided, not counted \(1\)\s*KES 250\.00/);
      assert.equal(d.querySelectorAll('#spc-panel').length, 1, 'one panel, not one per redraw');
      w.eval('renderDailySales(); renderDailySales()'); assert.equal(d.querySelectorAll('#spc-panel').length, 1);
    } finally { close(); }
  });
}
