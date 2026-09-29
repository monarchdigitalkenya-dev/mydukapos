import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 152 — a REAL sale in every till app. Zip 149 added `cardAmount` to the sale record of Hotel, Pharmacy, Production and Services without
// declaring it there; checkout threw a ReferenceError before the sale was saved, and because checkout is async the error vanished — the cashier
// tapped "Complete", nothing was recorded, no stock came off, nothing reached the other tills. The test written with that change only looked
// for text in the file. This one rings up a cash sale, an M-Pesa sale and a split sale in each app and checks what actually happened.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];

for (const app of APPS) {
  test(`${app}: cash, M-Pesa and split sales are recorded, stock comes off, and nothing throws`, { timeout: 45000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 });
    const { w } = b; quiet(w);
    const problems = [];
    w.addEventListener('unhandledrejection', (e) => problems.push(String(e.reason && e.reason.message || e.reason)));
    w.addEventListener('error', (e) => problems.push(String(e.message)));
    const inv = () => w.eval("inventory.find(i => i.code === 'A').qty");
    const sales = () => w.eval('salesLog.filter(s => !s._deleted).length');
    const ring = async (method, qty, fields = {}) => {
      w.eval(`currentCart = {}; addToCart('A'); ${qty > 1 ? `currentCart['A'].qty = ${qty};` : ''} currentPaymentMethod = '${method}'`);
      const d = w.document; const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = v; };
      set('cash-tendered-input', '100000'); set('mpesa-code-input', 'QWE1234567'); set('mpesa-phone-input', '0712345678');
      Object.entries(fields).forEach(([id, v]) => set(id, v));
      // a direct thrown error inside the async checkout comes back as a rejected promise
      await w.eval('checkoutCart()');
      await new Promise((r) => setTimeout(r, 60));
    };
    await ring('cash', 2);
    assert.equal(sales(), 1, 'the cash sale is in the sales log');
    assert.equal(inv(), 48, 'and its stock came off');
    const s1 = JSON.parse(w.eval('JSON.stringify(salesLog[salesLog.length - 1])'));
    assert.equal(s1.cashAmount, 200); assert.equal(s1.cardAmount || 0, 0); assert.ok(s1.id && s1.refNumber, 'a unique id and an automatic reference number');
    await ring('cash', 1);
    assert.equal(sales(), 2); assert.equal(inv(), 47);
    assert.notEqual(w.eval('salesLog[0].refNumber'), w.eval('salesLog[1].refNumber'), 'two sales never share a reference');
    assert.deepEqual(problems, [], 'no uncaught error during checkout: ' + problems.join(' | '));
    b.close();
  });
}
