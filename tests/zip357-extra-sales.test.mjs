import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 357: Unrecorded / Extra Sales. A product sale plus an extra-sales entry of 10,000 at 20 % margin:
// Daily Sales, cash / M-Pesa totals and Profits must count each shilling once, profit = 2,000 and cost recovery = 8,000, stock untouched,
// and a void takes the entry out everywhere.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.alert = () => {}; window.print = () => {}; window.requireManagementApproval = function (m, fn) { fn(); }; window.renderReceipt = function () {}; window.openReceiptModal = function () {};";
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html', 'owner/index.html'];
const num = (t) => Number(String(t || '').replace(/[^0-9.\-]/g, '')) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const app of APPS) {
  test(`${app}: extra sales are counted once in Daily Sales, cash, M-Pesa and Profits`, { timeout: 300000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS), pos_extra_margin: '20' }, wait: 900 });
    const { w } = b; w.eval(QUIET); const d = w.document;
    const problems = []; w.addEventListener('error', (e) => problems.push(String(e.message)));
    for (let i = 0; i < 20 && !d.getElementById('xs-card'); i++) await sleep(200);
    assert.ok(d.getElementById('xs-card'), 'the Extra Sales card sits in Daily Sales');
    assert.equal(d.getElementById('xs-margin').value, '20', 'remembered margin');

    // live preview
    d.getElementById('xs-amount').value = '10,000'; d.getElementById('xs-amount').dispatchEvent(new w.Event('input'));
    assert.equal(num(d.getElementById('xs-c-profit').textContent), 2000);
    assert.equal(num(d.getElementById('xs-c-cost').textContent), 8000);

    // validation
    assert.equal(w.eval("xsRecord({ amount: 0, margin: 20 }).ok"), false);
    assert.equal(w.eval("xsRecord({ amount: 500, margin: 120 }).ok"), false);

    // one product sale (200 cash) when the app has a product cart
    let prod = 0;
    if (app !== 'water/index.html' && app !== 'owner/index.html') {   // Owner Console has no Sales Counter screen
      w.eval("currentCart = {}; addToCart('A'); currentCart['A'].qty = 2; currentPaymentMethod = 'cash'");
      const ct = d.getElementById('cash-tendered-input'); if (ct) ct.value = '1000';
      await w.eval('checkoutCart()'); await sleep(100);
      prod = w.eval('salesLog.length') ? 200 : 0;
    }
    const stockBefore = (app === 'water/index.html' || app === 'owner/index.html') ? null : w.eval("inventory.find(i => i.code === 'A').qty");

    // the form: 10,000 cash at 20 %
    d.getElementById('xs-method').value = 'cash';
    d.getElementById('xs-save').click(); await sleep(50);
    assert.equal(d.getElementById('xs-err').textContent, '', 'saved without error');
    // and 5,000 by M-Pesa at 30 %
    const r2 = JSON.parse(w.eval("JSON.stringify(xsRecord({ amount: 5000, margin: 30, method: 'mpesa', ref: 'qwe123abc' }))"));
    assert.equal(r2.ok, true); assert.equal(r2.profit, 1500); assert.equal(r2.cost, 3500);
    assert.equal(r2.sale.mpesaAmount, 5000); assert.equal(r2.sale.cashAmount, 0);

    const xs = JSON.parse(w.eval('JSON.stringify(salesLog.filter(s => s.extraSale))'));
    assert.equal(xs.length, 2, 'two extra entries, saved once each');
    assert.equal(xs[0].items[0].wholesalePrice, 8000); assert.equal(xs[0].cashAmount, 10000);
    if (stockBefore != null) assert.equal(w.eval("inventory.find(i => i.code === 'A').qty"), stockBefore, 'stock untouched');

    const S = JSON.parse(w.eval('JSON.stringify(xsDaySummary())'));
    assert.equal(S.xs.rev, 15000); assert.equal(S.xs.profit, 3500); assert.equal(S.xs.cost, 11500);
    assert.equal(S.rec.rev, prod); assert.equal(S.total.rev, prod + 15000);
    if (prod) assert.equal(S.rec.profit, 80);

    // Daily Sales screen
    const total = prod + 15000;
    if (d.getElementById('daily-revenue-total') && typeof w.renderDailySales === 'function') {
      w.eval('renderDailySales()');
      assert.equal(num(d.getElementById('daily-revenue-total').textContent), total, 'Daily Sales revenue');
      if (d.getElementById('daily-cash-total')) assert.equal(num(d.getElementById('daily-cash-total').textContent), prod + 10000, 'Daily Sales cash');
      if (d.getElementById('daily-mpesa-total')) assert.equal(num(d.getElementById('daily-mpesa-total').textContent), 5000, 'Daily Sales M-Pesa');
    }
    if (app === 'water/index.html' && d.getElementById('daily-sales-total')) {
      try { w.eval("if (typeof renderDailySales === 'function') renderDailySales()"); } catch (e) { /* period */ }
      assert.equal(num(d.getElementById('daily-sales-total').textContent), total, 'Aqua Daily Sales total');
    }
    // Profits
    let profitChecked = false;
    if (d.getElementById('profit-revenue-total') && typeof w.renderProfitReport === 'function') {
      try { w.eval("var _p = document.getElementById('profit-date-picker'); if (_p) _p.value = (typeof todayDateString === 'function' ? todayDateString() : new Date().toISOString().slice(0, 10)); renderProfitReport()"); } catch (e) { /* period controls differ */ }
      const pr = num(d.getElementById('profit-revenue-total').innerText || d.getElementById('profit-revenue-total').textContent);
      profitChecked = pr > 0;
      if (pr) {
        assert.equal(pr, total, 'Profits revenue');
        assert.equal(num(d.getElementById('profit-cost-total').innerText || d.getElementById('profit-cost-total').textContent), (prod ? 120 : 0) + 11500, 'Profits cost = item cost + cost recovery');
      }
    }
    // the summary table is on screen
    assert.match(d.getElementById('xs-sum-body').textContent, /Unrecorded \/ extra sales/);

    // the printed Sales Report carries the split
    if (typeof w.previewSalesReport === 'function' && d.getElementById('sales-report-body') && d.getElementById('report-from-date')) {   // Owner Console has no Sales Report screen
      try { w.eval("(function(){ var t = new Date(), k = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); ['report-from-date', 'report-to-date'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = k; }); })(); previewSalesReport()"); } catch (e) { /* printer paths differ */ }
      const rep = d.querySelector('#sales-report-body .xs-report');
      assert.ok(rep, 'Sales Report shows the extra sales split');
      assert.match(rep.textContent, /KES 15000\.00/); assert.match(rep.textContent, /KES 3500\.00/); assert.match(rep.textContent, /KES 11500\.00/);
    }
    // void the 10,000 entry: gone from the summary and from Daily Sales
    w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'entered twice'; performVoidSale('${xs[0].id}')`); await sleep(150);
    if (w.eval(`!!salesLog.find(s => s.id === '${xs[0].id}').voided`)) {
      const S2 = JSON.parse(w.eval('JSON.stringify(xsDaySummary())'));
      assert.equal(S2.xs.rev, 5000); assert.equal(S2.xs.n, 1);
      if (d.getElementById('daily-revenue-total')) { w.eval('renderDailySales()'); assert.equal(num(d.getElementById('daily-revenue-total').textContent), prod + 5000, 'after void'); }
      if (stockBefore != null) assert.equal(w.eval("inventory.find(i => i.code === 'A').qty"), stockBefore, 'void touches no stock');
    }
    if (d.getElementById('profit-revenue-total') && typeof w.renderProfitReport === 'function') assert.ok(profitChecked, 'Profits report was checked');
    assert.deepEqual(problems, []);
    b.close();
  });
}
