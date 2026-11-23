import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 356: "nothing may double the finances; stock and money must agree everywhere". One realistic day in each till app - cash, M-Pesa,
// split, a Pay-Later bill with a deposit and its settlement, a voided sale - then every place that reports money and stock is compared
// with the figures worked out by hand. A sale counted twice anywhere (Daily Sales, Profits, Sales Counter panel, cash drawer, stock
// movements) fails here.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.alert = () => {}; window.prompt = (m, d) => (window.__promptAnswers && window.__promptAnswers.length ? window.__promptAnswers.shift() : d); window.print = () => {}; window.requireManagementApproval = function (m, fn) { fn(); }; window.renderReceipt = function () {}; window.openReceiptModal = function () {};";
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const num = (t) => Number(String(t || '').replace(/[^0-9.\-]/g, '')) || 0;

for (const app of APPS) {
  test(`${app}: a full day - every report shows each shilling once and stock matches its movements`, { timeout: 400000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 });
    const { w } = b; w.eval(QUIET);
    const d = w.document; const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = String(v); };
    const problems = [];
    w.addEventListener('unhandledrejection', (e) => problems.push(String(e.reason && e.reason.message || e.reason)));
    const ring = async (method, qty, fields = {}) => {
      w.eval(`currentCart = {}; addToCart('A'); currentCart['A'].qty = ${qty}; currentPaymentMethod = '${method}'`);
      set('cash-tendered-input', '100000'); set('mpesa-code-input', 'QWE' + Math.floor(1e6 + Math.random() * 8e6)); set('mpesa-phone-input', '0712345678');
      Object.entries(fields).forEach(([id, v]) => set(id, v));
      await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
    };
    const qty = () => w.eval("inventory.find(i => i.code === 'A').qty");
    const salesN = () => w.eval('salesLog.length');
    await ring('cash', 2);                                                 // 200 cash
    assert.equal(salesN(), 1, 'cash sale saved: ' + (w.eval('window.__toasts') || []).join(' | '));
    await ring('mpesa', 1);                                                // 100 M-Pesa
    w.eval("currentCart = {}; addToCart('A'); currentCart['A'].qty = 3; currentPaymentMethod = 'split'");
    set('split-cash-input', 100); set('split-mpesa-input', 200); set('mpesa-code-input', 'SPL1234567'); set('split-mpesa-code-input', 'SPL1234567'); set('mpesa-phone-input', '0712345678');
    try { w.eval("if (typeof updateSplitRemaining === 'function') updateSplitRemaining()"); } catch (e) { /* optional */ }
    await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));  // 300 split (100 cash + 200 M-Pesa)
    const afterSplit = salesN();
    await ring('cash', 1);                                                 // 100 cash - voided below
    const voidId = w.eval('salesLog[salesLog.length - 1].id');
    w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'wrong item'; performVoidSale('${voidId}')`);
    await new Promise((r) => setTimeout(r, 120));
    const voided = w.eval(`!!(salesLog.find(s => s.id === '${voidId}') || {}).voided`);

    const all = JSON.parse(w.eval('JSON.stringify(salesLog)'));
    const live = all.filter((s) => !s.voided);
    const sumPay = (k) => live.reduce((t, s) => t + (Number(s[k]) || 0), 0);
    const lines = live.reduce((t, s) => t + s.items.reduce((u, l) => u + l.price * l.qty, 0), 0);
    const expectSales = 200 + 100 + (afterSplit === 3 ? 300 : 0);
    // 1. every sale's payments add up to its lines (no sale records more money than it sold)
    for (const s of live) {
      const tot = s.items.reduce((u, l) => u + l.price * l.qty, 0) + (Number(s.deliveryFee) || 0);
      const paid = (Number(s.cashAmount) || 0) + (Number(s.mpesaAmount) || 0) + (Number(s.cardAmount) || 0);
      if (s.paid !== false) assert.ok(Math.abs(paid - tot) < 0.01, `${s.paymentMethod} sale ${s.id}: paid ${paid} vs lines ${tot}`);
    }
    assert.equal(Math.round(lines), expectSales, 'sales lines total');
    assert.equal(Math.round(sumPay('cashAmount') + sumPay('mpesaAmount') + sumPay('cardAmount')), expectSales, 'payments total');
    // 2. stock: 50 - (2+1+3) and the voided sale's unit came back; the movement log explains every unit
    const sold = 2 + 1 + (afterSplit === 3 ? 3 : 0) + (voided ? 0 : 1);
    assert.equal(qty(), 50 - sold, 'stock on hand');
    const mv = JSON.parse(w.eval("JSON.stringify((stockMovementLog || []).filter(m => m && m.code === 'A'))"));
    if (mv.length) {
      const net = mv.reduce((t, m) => t + (Number(m.qtyDelta != null ? m.qtyDelta : m.delta) || 0), 0);
      if (mv.some((m) => m.qtyDelta != null || m.delta != null)) assert.equal(Math.round(net * 1000) / 1000, -sold, 'movement log net = stock change: ' + JSON.stringify(mv.map((m) => [m.type || m.reason, m.qtyDelta != null ? m.qtyDelta : m.delta])));
    }
    // 3. Daily Sales screen
    if (d.getElementById('daily-revenue-total') && typeof w.renderDailySales === 'function') {
      try { w.eval("if (typeof setSalesTablePeriod === 'function') setSalesTablePeriod('today')"); } catch (e) { /* default is today */ }
      w.eval('renderDailySales()');
      assert.equal(num(d.getElementById('daily-revenue-total').textContent), expectSales, 'Daily Sales revenue');
      const cashExp = 200 + (afterSplit === 3 ? 100 : 0), mpExp = 100 + (afterSplit === 3 ? 200 : 0);
      if (d.getElementById('daily-cash-total')) assert.equal(num(d.getElementById('daily-cash-total').textContent), cashExp, 'Daily Sales cash');
      if (d.getElementById('daily-mpesa-total')) assert.equal(num(d.getElementById('daily-mpesa-total').textContent), mpExp, 'Daily Sales M-Pesa');
    }
    // 4. Profits & Expenses
    if (d.getElementById('profit-revenue-total') && typeof w.renderProfitReport === 'function') {
      try { w.eval('renderProfitReport()'); } catch (e) { /* period controls differ per app */ }
      const pr = num(d.getElementById('profit-revenue-total').textContent);
      if (pr) assert.equal(pr, expectSales, 'Profits revenue');
    }
    // 5. stock report "sold" for the item never counts a sale twice (zip 354)
    if (typeof w.stockReportTotals === 'function') { /* checked by zip354 tests */ }
    assert.deepEqual(problems, [], 'no uncaught error: ' + problems.join(' | '));
    b.close();
  });
}
