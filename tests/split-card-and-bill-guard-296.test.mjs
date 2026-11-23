import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { boot } from './helpers.mjs';

// zip 296: (1) Sales Counter split took an optional Card amount (zip 319: Cash + M-Pesa only); (2) a settled bill can't be paid twice and leaves the Bills list at once;
// (3) the Open-orders side panel belongs to Service Orders only.
const ITEMS = [{ code: 'H', type: 'item', name: 'Hundred', category: 'General', price: 1000, wholesalePrice: 600, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {};");

// zip 319: a split is Cash + M-Pesa only (Card is no longer a split leg; it stays a payment method of its own). These two tests replace the zip 296
// "Cash + M-Pesa + Card" ones.
for (const app of ['hotel/index.html', 'index.html']) {
  test(`${app}: split sale takes Cash + M-Pesa (no Card box) and records both`, { timeout: 150000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 }); const { w } = b; quiet(w);
    const d = w.document; const set = (id, v) => { d.getElementById(id).value = v; };
    assert.equal(d.getElementById('split-card-input'), null, 'no Card amount in the split');
    w.eval("currentCart = {}; addToCart('H'); currentPaymentMethod = 'split'");
    set('split-cash-input', '300'); w.eval("handleSplitAmountChange('cash')");
    assert.equal(d.getElementById('split-mpesa-input').value, '700.00', 'M-Pesa takes the rest');
    set('split-cash-tendered-input', '300');
    await w.eval('checkoutCart()');
    await new Promise((r) => setTimeout(r, 120));
    const sales = JSON.parse(w.eval('JSON.stringify(salesLog.filter(s => !s._deleted))'));
    assert.equal(sales.length, 1, JSON.stringify(w.__toasts));
    assert.equal(sales[0].cashAmount, 300); assert.equal(sales[0].mpesaAmount, 700); assert.equal(sales[0].cardAmount || 0, 0);
    b.close();
  });

  test(`${app}: a split that does not add up is refused; Cash+M-Pesa = total works`, { timeout: 150000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 900 }); const { w } = b; quiet(w);
    const d = w.document; const set = (id, v) => { d.getElementById(id).value = v; };
    w.eval("currentCart = {}; addToCart('H'); currentPaymentMethod = 'split'");
    set('split-cash-input', '300'); set('split-mpesa-input', '400'); set('split-cash-tendered-input', '300');
    await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80));
    assert.equal(w.eval('salesLog.filter(s => !s._deleted).length'), 0, 'short by 300 is refused');
    assert.match(String(w.__toasts), /Cash \+ M-Pesa must add up/);
    set('split-cash-input', '500'); set('split-mpesa-input', '500'); set('split-cash-tendered-input', '500');
    await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 120));
    const s = JSON.parse(w.eval('JSON.stringify(salesLog.filter(s => !s._deleted))'));
    assert.equal(s.length, 1); assert.equal(s[0].cardAmount || 0, 0);
    b.close();
  });
}

test('water: the split panel is Cash + M-Pesa and balances against the total', { timeout: 150000 }, async () => {
  const b = await boot('water/index.html', { storage: {}, wait: 900 }); const { w } = b;
  const d = w.document;
  assert.equal(d.getElementById('split-card-input'), null);
  w.eval('cartTotal = function () { return 1000; }');
  d.getElementById('split-cash-input').value = '300'; w.eval("handleSplitAmountChange('cash')");
  assert.equal(d.getElementById('split-mpesa-input').value, '700.00');
  assert.match(d.getElementById("split-balance-line").textContent, /Cash \+ M-Pesa = .*1,?000.*\(matches total\)/);
  b.close();
});

test('hotel: a settled bill leaves the Bills list at once and cannot be paid a second time', { timeout: 150000 }, async () => {
  const inv = [{ code: 'T1', type: 'item', name: 'Tea', price: 50, wholesalePrice: 20, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Drinks' }];
  const dev = await openDevice('hotel/index.html', makeServer(), { pos_inventory: JSON.stringify(inv) });
  const { w } = dev;
  w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; tables = ['Table 1']");
  w.eval("svcDraft = { tabId: null, lines: [{ code: 'T1', qty: 2 }] }; document.getElementById('svc-new-location').innerHTML = '<option value=\"Table 1\">Table 1</option>'; document.getElementById('svc-new-location').value = 'Table 1'");
  assert.ok(w.eval('svcPostOrder()'));
  const id = w.eval('tabs[0].id');
  w.eval(`(() => { const t = tabs[0]; t.billStatus = 'BILLED'; t.billedAt = Date.now(); t.billTotal = hospTabDue(t); })()`);
  w.eval('renderBillsAwaitingPayment()');
  assert.match(w.document.getElementById('bills-awaiting-orders').innerHTML, /Take payment/);
  w.eval(`openTabDetailModal(${JSON.stringify(id)}); openTabSettleModal(); tabSettlePayMethod = 'cash'`);
  w.eval('confirmTabSettle()');
  assert.equal(w.document.getElementById('bills-awaiting-orders').innerHTML.trim(), '', 'the paid row is gone straight away');
  assert.equal(w.eval('salesLog.filter(s => !s._deleted).length'), 1);
  // second attempt on the same (stale) bill: refused, no second sale
  w.eval(`activeTabDetailId = ${JSON.stringify(id)}; confirmTabSettle(); settleTabDirect(${JSON.stringify(id)})`);
  assert.equal(w.eval('salesLog.filter(s => !s._deleted).length'), 1, 'no duplicate payment');
  assert.ok((w.__toasts || []).some((t) => /already settled/.test(t)));
  dev.close();
});

test('hotel: the Open-orders drawer closes when you leave Service Orders', { timeout: 150000 }, async () => {
  const dev = await openDevice('hotel/index.html', makeServer(), {});
  const { w } = dev;
  w.eval("openMyOrders()");
  assert.ok(w.document.getElementById('svc-panel').classList.contains('open'));
  w.document.querySelector('[data-tab="sales-tab"]').click();
  assert.ok(!w.document.getElementById('svc-panel').classList.contains('open'), 'closed on another tab');
  assert.equal(w.eval('svcListOpen'), false);
  dev.close();
});

test('hotel: Bills search + status chips filter rows; rare actions sit in a More menu, Settle stays outside it', { timeout: 150000 }, async () => {
  const b = await boot('hotel/index.html', { storage: {}, wait: 900 }); const { w } = b; const d = w.document;
  w.eval(`bills = [
    { id: 'b1', kind: 'sale', date: Date.now(), customerName: 'Alice', amount: 500, total: 500, amountPaid: 0, closed: false, items: [], paymentHistory: [], servedBy: 'Jane' },
    { id: 'b2', kind: 'sale', date: Date.now(), customerName: 'Bob', amount: 300, total: 800, amountPaid: 500, closed: false, items: [], paymentHistory: [], servedBy: 'Jane' } ]`);
  w.eval('renderBillsTab()');
  const rows = () => [...d.querySelectorAll('#bills-table tbody tr')].filter((r) => r.style.display !== 'none').length;
  const all = d.querySelectorAll('#bills-table tbody tr').length;
  assert.ok(all >= 1, 'rows rendered: ' + all);
  const settle = d.querySelector('#bills-table tbody tr button[onclick^="openBillSettleModal"]');
  assert.ok(settle && !settle.closest('.bill-more'), 'Settle is outside the More menu');
  assert.ok(d.querySelector('#bills-table .bill-more [onclick^="requestVoidSale"]'), 'Void lives in the More menu');
  w.eval("billsSetFilter('unpaid')");
  const unpaid = rows();
  w.eval("billsSetFilter('part')");
  const part = rows();
  w.eval("billsSetFilter('all')"); d.getElementById('bills-search').value = 'zzz-none'; w.eval('billsApplyFilter()');
  assert.equal(rows(), 0, 'a search with no match hides every row');
  d.getElementById('bills-search').value = ''; w.eval('billsApplyFilter()');
  assert.equal(rows(), all);
  assert.ok(unpaid <= all && part <= all);
  b.close();
});

test('hotel: Settings search hides tabs that do not match and restores them when cleared', { timeout: 150000 }, async () => {
  const b = await boot('hotel/index.html', { storage: {}, wait: 900 }); const { w } = b; const d = w.document;
  const total = d.querySelectorAll('#settings-subnav .settings-subtab-btn').length;
  d.getElementById('settings-search').value = 'receipt'; w.eval('settingsSearchApply()');
  const shown = [...d.querySelectorAll('#settings-subnav .settings-subtab-btn')].filter((x) => !x.classList.contains('ss-hide'));
  assert.ok(shown.length >= 1 && shown.length < total, `${shown.length} of ${total}`);
  assert.ok(shown.some((x) => /Receipt/i.test(x.textContent)));
  d.getElementById('settings-search').value = ''; w.eval('settingsSearchApply()');
  assert.equal(d.querySelectorAll('#settings-subnav .ss-hide').length, 0);
  b.close();
});
