import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 371: the numbers agree with each other - stock, stock value, sales, revenue, cost, profit, the restock expense.
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 499.9, wholesalePrice: 299.95, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'K', type: 'item', name: 'Sugar', price: 17.9, wholesalePrice: 12.35, qty: 10, unit: 'kg', vatCategory: 'A' },
  { code: 'SOCK', type: 'item', name: 'Cotton Socks', price: 200, wholesalePrice: 80, qty: 30, unit: 'pcs', hasVariants: true, vatCategory: 'A',
    variants: [{ id: 'v1', name: 'Large', code: 'SOCK-L', price: 220, wholesalePrice: 90, qty: 10 }, { id: 'v2', name: 'Small', code: 'SOCK-S', price: 200, wholesalePrice: 80, qty: 20 }] },
];
const PRINTER = "showToast = function () {}; window.confirm = () => true; window.prompt = (m, d) => d; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const money = (t) => Number(String(t).replace(/[^0-9.\-]/g, ''));

test('restock + sell + void + expense: stock, value, revenue, cost, profit and the expense all agree', async () => {
  const d = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, wait: 1500 });
  try {
    const w = d.w; w.eval(PRINTER);
    const sell = async (setup, method = 'cash') => { w.eval(setup); w.eval(`currentPaymentMethod = '${method}'`); const t = w.document.getElementById('cash-tendered-input'); if (t) t.value = '99999'; await w.eval('checkoutCart()'); await sleep(50); };
    // 1. a restock: a plain item (decimals), a variant by code, a brand-new item
    w.eval("restockDraft = [{ rowId: 1, code: 'A', name: 'Alpha', unit: 'pcs', qty: '3', cost: '310.10', wholesaleSell: '', sellPrice: '' }, { rowId: 2, code: 'SOCK-S', name: '', unit: 'pcs', qty: '7', cost: '85.55', wholesaleSell: '', sellPrice: '' }, { rowId: 3, code: '', name: 'Brand New Thing', unit: 'pcs', qty: '2.5', cost: '33.33', wholesaleSell: '', sellPrice: '60' }]; renderRestockRows(); completeRestock();");
    await sleep(200);
    const exp = J(w, "expenses.filter(e => e.category === 'Restock')");
    assert.equal(exp.length, 1);
    assert.equal(exp[0].amount, r2(3 * 310.10 + 7 * 85.55 + 2.5 * 33.33), 'the restock expense is exactly what was bought, to the cent');
    // 2. sales: decimals, variants, a second payment method
    await sell("addToCart('A'); addToCart('A'); addToCart('K')");
    await sell("addToCart('SOCK','box',undefined,'v1'); addToCart('SOCK','box',undefined,'v2'); addToCart('SOCK','box',undefined,'v2')");
    await sell("addToCart('A')", 'mpesa').catch(() => {});
    const logs = J(w, 'salesLog');
    assert.ok(logs.length >= 2);
    logs.forEach((s) => {
      const lines = s.items.reduce((t, i) => t + i.price * i.qty, 0);
      const paid = (s.cashAmount || 0) + (s.mpesaAmount || 0) + (s.cardAmount || 0) + (s.creditAmount || 0);
      assert.equal(r2(paid), r2(lines - (s.totalDiscount || 0)), `sale ${s.refNumber}: what was paid equals its lines`);
    });
    // 3. void the first sale: stock back, revenue gone
    const first = logs[logs.length - 1];
    w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('${first.id}')`); await sleep(100);
    // ---- the cross-checks ----
    const inv = J(w, 'inventory'); const live = J(w, 'salesLog').filter((s) => !s.voided);
    const qty = (c) => inv.find((p) => p.code === c);
    const soldOf = (name) => live.reduce((t, s) => t + s.items.filter((i) => i.name === name).reduce((a, i) => a + i.qty, 0), 0);
    assert.equal(qty('A').qty, r2(20 + 3 - soldOf('Alpha')), 'Alpha: opening + restocked - sold');
    const sock = qty('SOCK');
    assert.equal(sock.qty, sock.variants.reduce((a, v) => a + v.qty, 0), 'parent quantity = the sum of its variants');
    assert.equal(sock.variants.find((v) => v.id === 'v2').qty, 20 + 7 - soldOf('Cotton Socks (Small)'));
    assert.equal(sock.variants.find((v) => v.id === 'v1').qty, 10 - soldOf('Cotton Socks (Large)'));
    // stock value on the dashboard = every unit at its own cost (variants at their own cost)
    const expectValue = r2(inv.filter((p) => p.type !== 'service').reduce((t, p) => t + (p.hasVariants ? p.variants.reduce((a, v) => a + v.qty * v.wholesalePrice, 0) : p.qty * p.wholesalePrice), 0));
    w.eval('renderShopDashboard()');
    assert.equal(money(w.document.getElementById('dash-stock-value').textContent), expectValue, 'dashboard stock value');
    assert.equal(r2(J(w, "currentStockValueTotals().cost")), expectValue, 'stock valuation report (cost) agrees with the dashboard');
    // revenue / cost / profit
    const rev = live.reduce((t, s) => t + s.items.reduce((a, i) => a + i.price * i.qty, 0), 0);
    const cost = live.reduce((t, s) => t + s.items.reduce((a, i) => a + (i.wholesalePrice || 0) * i.qty, 0), 0);
    const rows = J(w, "buildProfitBreakdown('2000-01-01', '2999-12-31')");
    assert.equal(r2(rows.reduce((t, r) => t + r.revenue, 0)), r2(rev), 'profit report revenue = the sales');
    assert.equal(r2(rows.reduce((t, r) => t + r.cost, 0)), r2(cost), 'profit report cost = what the sold goods cost');
    w.eval('renderShopDashboard()');
    assert.equal(money(w.document.getElementById('dash-today-revenue').textContent), r2(rev), 'dashboard revenue = the sales that are not voided');
  } finally { d.close(); }
});
