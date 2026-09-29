import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 152 — checkout is all-or-nothing. On the zip-151 code a Hotel sale that hit an error after the stock was taken off left the stock
// down by one with NO sale recorded (reproduced: sales=0, qty=49) and said nothing. Now: an error before the sale is saved puts the stock back
// (exactly, and in the append-only ledger by an opposite movement) and tells the cashier; an error AFTER the sale is saved keeps the sale.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'services/index.html', 'production/index.html'];

for (const app of APPS) {
  test(`${app}: an error before the sale is saved puts the stock back, says so, and the retry sells exactly once`, { timeout: 60000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 });
    const { w } = b; quiet(w);
    const cart = () => { w.eval("currentCart = {}; addToCart('A'); currentCart['A'].qty = 2; currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '100000'; };
    const state = () => JSON.parse(w.eval("JSON.stringify({ qty: inventory.find(i => i.code === 'A').qty, sales: salesLog.length, net: stockMovementLog.filter(m => m.code === 'A').reduce((s, m) => s + m.delta, 0), toasts: window.__toasts || [] })"));
    w.eval("window.__realRef = generateReceiptRef; generateReceiptRef = function () { throw new Error('boom before the sale is saved'); }");
    cart();
    await w.eval('checkoutCart()');
    let s = state();
    assert.equal(s.sales, 0, 'no half sale');
    assert.equal(s.qty, 50, 'the stock is exactly as it was');
    assert.equal(s.net, 0, 'the ledger nets to zero: what the failed try took, an opposite movement gave back');
    assert.ok(s.toasts.some((t) => /NOT completed/.test(t) && /boom/.test(t)), 'the cashier is told, with the reason: ' + s.toasts.join(' | '));
    assert.ok(w.eval('window.__lastCheckoutError && window.__lastCheckoutError.message').includes('boom'));
    w.eval('generateReceiptRef = window.__realRef; window.__toasts = []');
    cart();
    await w.eval('checkoutCart()');
    await new Promise((r) => setTimeout(r, 60));
    s = state();
    assert.equal(s.sales, 1, 'the retry records the sale once'); assert.equal(s.qty, 48); assert.equal(s.net, -2, 'ledger: exactly one sale of 2');
    b.close();
  });

  test(`${app}: an error AFTER the sale is saved keeps the sale and its stock, and says the sale is safe`, { timeout: 60000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 });
    const { w } = b; quiet(w);
    w.eval("currentCart = {}; addToCart('A'); currentCart['A'].qty = 3; currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '100000';
    // a step that runs after the sale is in the log
    w.eval("window.__realSave = safeSetItem; safeSetItem = function (k, v) { if (k === 'pos_sales_log') { window.__realSave(k, v); throw new Error('boom after the sale is saved'); } return window.__realSave(k, v); }");
    await w.eval('checkoutCart()');
    w.eval('safeSetItem = window.__realSave');
    const s = JSON.parse(w.eval("JSON.stringify({ qty: inventory.find(i => i.code === 'A').qty, sales: salesLog.length, toasts: window.__toasts || [] })"));
    assert.equal(s.sales, 1, 'the sale stays'); assert.equal(s.qty, 47, 'and so does its stock');
    assert.ok(s.toasts.some((t) => /sale is saved/i.test(t)), 'told the sale is safe: ' + s.toasts.join(' | '));
    b.close();
  });
}
