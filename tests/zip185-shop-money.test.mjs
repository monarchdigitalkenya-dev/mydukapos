import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 185 (Shop app, index.html): money / stock / sync fixes outside the shared regions. One test per defect, each with a concrete before/after number.
const A = { code: 'A1', type: 'item', name: 'Widget', price: 33.33, wholesalePrice: 20, wholesaleSellingPrice: 30, qty: 500, unit: 'pcs', vatCategory: 'A' };
const BIG = { code: 'B1', type: 'item', name: 'Machine', price: 1000, wholesalePrice: 600, qty: 50, unit: 'pcs', vatCategory: 'A' };
const BIGZ = { code: 'B2', type: 'item', name: 'Maize flour', price: 500, wholesalePrice: 300, qty: 50, unit: 'pcs', vatCategory: 'Z' };
const HUN = { code: 'H1', type: 'item', name: 'Hundred', price: 100, wholesalePrice: 40, qty: 50, unit: 'pcs', vatCategory: 'A' };
const KG = { code: 'K1', type: 'item', name: 'Sugar', price: 150, wholesalePrice: 100, qty: 10, unit: 'kg', vatCategory: 'A' };
const V1 = { code: 'V1', type: 'item', name: 'Shirt', price: 100, qty: 10, unit: 'pcs', vatCategory: 'A', hasVariants: true,
  variants: [{ id: 'va', name: 'Red', code: 'V1-R', price: 100, wholesalePrice: 60, qty: 6, dualUnit: false }, { id: 'vb', name: 'Blue', code: 'V1-B', price: 110, wholesalePrice: 60, qty: 4, dualUnit: false }] };
const inv = (...items) => JSON.stringify(items);
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); };";
async function open(items, extra = {}) { const b = await boot('index.html', { storage: { pos_inventory: inv(...items), ...extra }, wait: 900 }); b.w.eval(QUIET); return b; }
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (items) => r2(items.reduce((s, l) => s + l.price * l.qty, 0));
const OFFER10 = { id: 'o1', name: '10% off', type: 'percent', percentOff: 10, scope: 'all', targets: [], active: true };
const set = (w, id, v) => { w.document.getElementById(id).value = String(v); };
const sales = (w) => JSON.parse(w.eval('JSON.stringify(salesLog)'));
const bills = (w) => JSON.parse(w.eval('JSON.stringify(bills)'));
const toasts = (w) => (w.eval('window.__toasts') || []).join(' | ');
async function cash(w, setup) { w.eval(`currentCart = {}; ${setup}; currentPaymentMethod = 'cash'`); set(w, 'cash-tendered-input', 100000); await w.eval('checkoutCart()'); }
// a Pay Later sale: cart, customer, amount paid now (cash)
async function billSale(w, setup, upfront, extraSetup = '') {
  w.eval(`currentCart = {}; ${setup}; currentPaymentMethod = 'bill'; ${extraSetup}`);
  set(w, 'bill-customer-name-input', 'Wanjiru'); set(w, 'bill-upfront-amount-input', upfront);
  w.eval("billUpfrontMethod = 'cash'");
  await w.eval('checkoutCart()');
}
const settle = (w, billId, amount) => { w.eval(`openBillSettleModal('sale', '${billId}')`); set(w, 'bill-settle-amount-input', amount); w.eval('confirmBillSettleImpl(true)'); };
const costOf = (w) => w.eval('salesLog.filter(s => !s.voided).reduce((t, s) => t + reportSaleCost(s), 0)');

// ---------- M-C: item lines add up to the charged total ----------
test('M-C: 3 x 33.33 with 10% off is charged 89.99 and the saved item lines add up to 89.99 (was 90.00)', async () => {
  const b = await open([A], { pos_offers: JSON.stringify([OFFER10]) }); const { w } = b;
  await cash(w, "addToCart('A1'); addToCart('A1'); addToCart('A1')");
  const s = sales(w);
  assert.equal(s.length, 1, toasts(w));
  assert.equal(s[0].cashAmount, 89.99);
  assert.equal(sum(s[0].items), 89.99, 'lines: ' + JSON.stringify(s[0].items.map((l) => [l.qty, l.price])));
  assert.ok(s[0].items.some((l) => l.offerApplied && l.offerApplied.amount === 10), 'the offer label is kept on a line');
  b.close();
});
test('M-C: 100 x 3.33 with 10% off is charged 299.70 and the item lines add up to 299.70 (was 300.00)', async () => {
  const b = await open([{ ...A, price: 3.33 }], { pos_offers: JSON.stringify([OFFER10]) }); const { w } = b;
  await cash(w, "addToCart('A1'); currentCart['A1'].qty = 100");
  const s = sales(w);
  assert.equal(s[0].cashAmount, 299.7);
  assert.equal(sum(s[0].items), 299.7, JSON.stringify(s[0].items.map((l) => [l.qty, l.price])));
  b.close();
});
test('M-C: a cart without offers saves exactly the lines it always did', async () => {
  const b = await open([HUN]); const { w } = b;
  await cash(w, "addToCart('H1'); addToCart('H1')");
  const s = sales(w);
  assert.equal(s[0].items.length, 1); assert.equal(s[0].items[0].qty, 2); assert.equal(s[0].items[0].price, 100);
  assert.equal(s[0].items[0].offerApplied, undefined);
  b.close();
});

// ---------- M-G: the total never goes negative ----------
test('M-G: a 50% offer plus a flat 60 off a KES 100 item totals 0 (was -10); a flat 30 still totals 20', async () => {
  const flat = (amt) => ({ id: 'f1', name: 'Flat', type: 'flat', flatAmount: amt, minQty: 1, scope: 'all', targets: [], active: true });
  const half = { id: 'o50', name: '50%', type: 'percent', percentOff: 50, scope: 'all', targets: [], active: true };
  const b = await open([HUN], { pos_offers: JSON.stringify([half, flat(60)]) }); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1')");
  assert.equal(w.eval('cartTotal()'), 0, 'was -10');
  w.eval(`offers = ${JSON.stringify([half, flat(30)])}`);
  assert.equal(w.eval('cartTotal()'), 20, 'a valid total is unchanged: 100 - 50 - 30');
  await cash(w, "addToCart('H1')");
  const s = sales(w);
  assert.equal(s[s.length - 1].cashAmount, 20);
  assert.equal(sum(s[s.length - 1].items), 20, 'the lines add up to what was charged');
  b.close();
});

// ---------- M-H: X / Z report gross, discounts, net ----------
test('M-H: Z report - a 10% offer on KES 100 shows gross 100, discounts 10, net 90 (was gross 90 = net 90, discounts 10 not subtracted)', async () => {
  const b = await open([HUN], { pos_offers: JSON.stringify([OFFER10]) }); const { w } = b;
  await cash(w, "addToCart('H1')");
  const t = JSON.parse(w.eval('JSON.stringify((() => { const t = posControlReportTotals(); return { gross: t.gross, discounts: t.discounts, net: t.netSales, gp: t.grossProfit }; })())'));
  assert.deepEqual(t, { gross: 100, discounts: 10, net: 90, gp: 50 });                        // 90 net - 40 cost
  b.close();
});
test('M-H: a flat offer baked into the lines is counted as a discount too (flat 20 off 3 x 100: gross 300, discounts 20, net 280)', async () => {
  const flat = { id: 'f1', name: 'Flat', type: 'flat', flatAmount: 20, minQty: 1, scope: 'all', targets: [], active: true };
  const b = await open([HUN], { pos_offers: JSON.stringify([flat]) }); const { w } = b;
  await cash(w, "addToCart('H1'); addToCart('H1'); addToCart('H1')");
  const t = JSON.parse(w.eval('JSON.stringify((() => { const t = posControlReportTotals(); return { gross: t.gross, discounts: t.discounts, net: t.netSales }; })())'));
  assert.deepEqual(t, { gross: 300, discounts: 20, net: 280 });
  b.close();
});

// ---------- M-A / M-D / M-E: Pay Later sales ----------
test('M-A: a 1000 bill that cost 600, paid 400 now and 600 later: cost 240 + 360 = 600 reaches the sales log (profit 400, was 1000)', async () => {
  const b = await open([BIG]); const { w } = b;
  await billSale(w, "addToCart('B1')", 400);
  assert.equal(bills(w).length, 1, toasts(w));
  assert.equal(costOf(w), 240, 'the upfront payment carries 600 x 400 / 1000');
  settle(w, bills(w)[0].id, 600);
  const s = sales(w);
  assert.deepEqual(s.map((x) => x.items[0].costShare), [240, 360]);
  assert.equal(costOf(w), 600, 'the whole cost is in once the bill is settled');
  const revenue = s.reduce((t, x) => t + sum(x.items), 0);
  assert.equal(revenue - costOf(w), 400, 'profit 400, not 1000');
  assert.equal(w.eval('buildProfitBreakdown(todayDateString(), todayDateString()).reduce((t, r) => t + r.revenue - r.cost, 0)'), 400, 'the profit report agrees');
  b.close();
});
test('M-A: three instalments of 333.33 / 333.33 / 333.34 on a 1000 bill of cost 600 add up to exactly 600 (the last takes the remainder)', async () => {
  const b = await open([BIG]); const { w } = b;
  await billSale(w, "addToCart('B1')", 333.33);
  const id = bills(w)[0].id;
  settle(w, id, 333.33); settle(w, id, 333.34);
  const shares = sales(w).map((x) => x.items[0].costShare);
  assert.equal(r2(shares.reduce((t, v) => t + v, 0)), 600, JSON.stringify(shares));
  assert.equal(bills(w)[0].status, 'fully_paid');
  b.close();
});
test('M-A: a bill payment on OLD data (no costShare) still counts no cost', () => {
  return open([BIG]).then((b) => {
    const cost = b.w.eval("reportSaleCost({ items: [{ name: 'Bill Payment', price: 500, qty: 1, unit: 'payment', wholesalePrice: 0 }] })");
    assert.equal(cost, 0); b.close();
  });
});
test('M-D: a bill of 1000 + 200 delivery fee with 500 paid shows 700 owed (was 500) and is not closed by paying 500', async () => {
  const b = await open([BIG]); const { w } = b;
  w.eval("currentCart = {}; addToCart('B1'); currentPaymentMethod = 'bill'; setOrderType('delivery'); setDeliveryPaymentMode('now')");
  set(w, 'delivery-address-input', 'Kilimani'); set(w, 'delivery-fee-input', 200); set(w, 'bill-customer-name-input', 'Wanjiru'); set(w, 'bill-upfront-amount-input', 500);
  w.eval("billUpfrontMethod = 'cash'");
  await w.eval('checkoutCart()');
  const bill = bills(w)[0];
  assert.equal(bill.deliveryDetails.fee, 200, toasts(w));
  assert.equal(w.eval('getOpenBillsList()[0].amount'), 700, 'items 1000 + fee 200 - 500 paid');
  assert.equal(bill.status, 'partially_paid');
  settle(w, bill.id, 500);
  assert.equal(bills(w)[0].status, 'partially_paid', 'was fully_paid with the 200 fee never collected');
  assert.equal(w.eval('getOpenBillsList()[0].amount'), 200);
  settle(w, bill.id, 200);
  assert.equal(bills(w)[0].status, 'fully_paid');
  assert.equal(r2(sales(w).reduce((t, s) => t + s.cashAmount, 0)), 1200, 'every shilling of 1200 was collected');
  assert.equal(costOf(w), 600, 'and the whole cost of goods is in');
  b.close();
});
test('M-E: a bill of 500 standard + 500 zero-rated, settled with 400, sends payment lines split by category (was one category-A line)', async () => {
  const b = await open([BIG, BIGZ]); const { w } = b;
  w.eval("currentCart = {}; addToCart('B2'); addToCart('B2'); currentPaymentMethod = 'bill'");
  // 2 x 500 zero-rated = 1000 Z; add 1 x 1000 standard
  w.eval("addToCart('B1')");
  set(w, 'bill-customer-name-input', 'Wanjiru'); set(w, 'bill-upfront-amount-input', 0);
  await w.eval('checkoutCart()');
  const id = bills(w)[0].id;
  settle(w, id, 400);
  const pay = sales(w).filter((s) => s.billId === id).pop();
  assert.deepEqual(pay.items.map((l) => [l.vatCategory, l.price]).sort(), [['A', 200], ['Z', 200]], JSON.stringify(pay.items));
  assert.equal(sum(pay.items), 400);
  assert.ok(pay.items.every((l) => l.unit === 'payment'));
  b.close();
});

// ---------- M-F: split legs can never be negative ----------
test('M-F: a bill part-payment split of cash -100 + M-Pesa 600 (= 500) is refused', async () => {
  const b = await open([BIG]); const { w } = b;
  w.eval("currentCart = {}; addToCart('B1'); currentPaymentMethod = 'bill'; billUpfrontMethod = 'split'");
  set(w, 'bill-customer-name-input', 'W'); set(w, 'bill-upfront-amount-input', 500);
  set(w, 'bill-upfront-split-cash-input', -100); set(w, 'bill-upfront-split-mpesa-input', 600); set(w, 'bill-upfront-split-bank-input', 0); set(w, 'bill-upfront-split-card-input', 0);
  await w.eval('checkoutCart()');
  assert.equal(bills(w).length, 0, 'nothing was recorded'); assert.match(toasts(w), /cannot be negative/);
  b.close();
});
test('M-F: a bill settlement split of cash -100 + M-Pesa 600 is refused', async () => {
  const b = await open([BIG]); const { w } = b;
  await billSale(w, "addToCart('B1')", 0);
  const id = bills(w)[0].id;
  w.eval(`openBillSettleModal('sale', '${id}')`); set(w, 'bill-settle-amount-input', 500); w.eval("setBillSettlePayMethod('split')");
  set(w, 'bill-settle-split-cash-input', -100); set(w, 'bill-settle-split-mpesa-input', 600);
  const before = sales(w).length;
  w.eval('confirmBillSettleImpl(true)');
  assert.equal(sales(w).length, before); assert.match(w.document.getElementById('bill-settle-modal-error').textContent, /negative/);
  b.close();
});
test('M-F: a delivery balance split of cash -100 + M-Pesa 600 is refused', async () => {
  const b = await open([BIG]); const { w } = b;
  w.eval("bills.push({ id: 'BD1', timestamp: new Date().toISOString(), items: [{ code: 'B1', name: 'Machine', qty: 1, price: 500, unit: 'pcs', wholesalePrice: 0 }], amountPaid: 0, orderType: 'delivery', deliveryDetails: { fee: 0, pod: true } })");
  w.eval("pendingDeliveryPaymentSaleId = 'BD1'; deliveryPaymentCaptureMethod = 'split'");
  set(w, 'delivery-payment-split-cash-input', -100); set(w, 'delivery-payment-split-mpesa-input', 600);
  w.eval('confirmDeliveryPaymentCapture()');
  assert.equal(sales(w).length, 0); assert.match(w.document.getElementById('delivery-payment-error').textContent, /negative/);
  b.close();
});

// ---------- M-I: daily sales revenue includes the delivery fee ----------
test('M-I: a delivery sale of 100 + fee 50 paid in cash shows revenue 150 (was 100) = the cash column', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1'); currentPaymentMethod = 'cash'; setOrderType('delivery'); setDeliveryPaymentMode('now')");
  set(w, 'delivery-address-input', 'Kilimani'); set(w, 'delivery-fee-input', 50); set(w, 'delivery-client-name-input', 'A'); set(w, 'cash-tendered-input', 1000);
  await w.eval('checkoutCart()');
  assert.equal(sales(w).length, 1, toasts(w));
  w.eval('renderDailySales()');
  const rev = w.document.getElementById('daily-revenue-total').textContent, cashT = w.document.getElementById('daily-cash-total').textContent;
  assert.equal(cashT, 'KES 150.00'); assert.equal(rev, 'KES 150.00');
  b.close();
});

// ---------- M-K / M-L: exchange and returns ----------
async function sellThenSelect(w, setup, qtyInput) {
  await cash(w, setup);
  w.eval(`selectReturnRefItem('${w.eval('salesLog[0].id')}', 0)`);
  set(w, 'return-qty-input', qtyInput); set(w, 'return-condition-select', 'good');
  const r = w.document.getElementById('return-reason-select'); r.value = r.options[0].value;
}
test('M-K: an exchange for 3 when 1 is in stock is refused up front (it used to ask "continue anyway?" and then take 1, recording 3)', async () => {
  const b = await open([{ ...HUN, qty: 5 }, { code: 'S1', type: 'item', name: 'Spare', price: 50, wholesalePrice: 20, qty: 1, unit: 'pcs', vatCategory: 'A' }]); const { w } = b;
  await sellThenSelect(w, "addToCart('H1')", 1);
  w.eval("setReturnMode('exchange'); addExchangeReplacementItem('S1'); exchangeReplacementItems[0].qty = 3");
  set(w, 'exchange-credit-value-input', 50);
  w.eval('saveExchange()');
  assert.equal(w.eval("inventory.find(p => p.code === 'S1').qty"), 1, 'stock untouched');
  assert.equal(w.eval('returns.length'), 0);
  assert.match(w.document.getElementById('return-save-error').textContent, /Not enough "Spare"/);
  w.eval('exchangeReplacementItems[0].qty = 1'); set(w, 'exchange-credit-value-input', 50);
  w.eval('saveExchange()');
  assert.equal(w.eval("inventory.find(p => p.code === 'S1').qty"), 0, 'within stock it goes through');
  b.close();
});
test('M-L: returning 0.5 kg of a weighed item restocks 0.5 (was refused / became 0)', async () => {
  const b = await open([KG]); const { w } = b;
  await sellThenSelect(w, "addToCart('K1'); currentCart['K1'].qty = 2", 0.5);
  w.eval("setReturnMode('simple')");
  const before = w.eval("inventory[0].qty");
  w.eval('saveSimpleReturn()');
  assert.equal(w.eval("inventory[0].qty"), before + 0.5);
  assert.equal(w.eval('returns[0].qty'), 0.5);
  b.close();
});
test('M-L: an exchange credit above what was paid is refused (KES 500 on a 100 item); within it, or the item price paid, it goes through', async () => {
  const b = await open([{ ...HUN, qty: 5 }, { code: 'S1', type: 'item', name: 'Spare', price: 500, wholesalePrice: 20, qty: 5, unit: 'pcs', vatCategory: 'A' }]); const { w } = b;
  await sellThenSelect(w, "addToCart('H1')", 1);
  w.eval("setReturnMode('exchange'); addExchangeReplacementItem('S1')");
  w.eval('window.requireManagementApproval = function () { window.__asked = true; }');
  set(w, 'exchange-credit-value-input', 500);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 0, 'refused'); assert.ok(w.eval('window.__asked'), 'management approval is asked for');
  set(w, 'exchange-credit-value-input', -20);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 0, 'negative credit refused');
  set(w, 'exchange-credit-value-input', 100);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 1, w.document.getElementById('return-save-error').textContent);
  assert.equal(w.eval('returns[0].netPayable'), 400);
  b.close();
});
test('M-L: the credit value is filled from the price PAID on the receipt, not today\'s price', async () => {
  const b = await open([{ ...HUN, qty: 5 }]); const { w } = b;
  await sellThenSelect(w, "addToCart('H1')", 1);
  w.eval("inventory[0].price = 150; setReturnMode('exchange'); exchangeCreditValueDirty = false; autofillExchangeCreditValue()");
  assert.equal(w.document.getElementById('exchange-credit-value-input').value, '100.00', 'was 150.00 (today\'s price)');
  b.close();
});

// ---------- M-M: variant manual adjustment is logged under the variant's code ----------
test('M-M: editing a variant\'s stock logs the movement under the VARIANT code (was the parent code)', async () => {
  const b = await open([V1]); const { w } = b;
  w.eval("updateVariantField('V1', 'vb', 'qty', '9')");
  const mv = JSON.parse(w.eval("JSON.stringify(stockMovementLog.filter(m => /Manual inventory adjustment/.test(m.reason)))"));
  assert.equal(mv.length, 1); assert.equal(mv[0].code, 'V1-B'); assert.equal(mv[0].delta, 5);
  b.close();
});

// ---------- S-A: cross-branch checkout cannot hang the till ----------
test('S-A: a cross-branch checkout whose request never answers stops after 20 s with a message and frees the till; a tap meanwhile gets a toast', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("const _st = window.setTimeout; window.setTimeout = function (f, ms, ...r) { return _st(f, ms === 20000 ? 60 : ms, ...r); }");
  w.fetch = (url, opts) => new Promise((_, rej) => { if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  w.eval("currentCart = { 'xb:X1': { code: 'X1', cartKey: 'xb:X1', name: 'Far item', qty: 1, price: 100, wholesalePrice: 0, unit: 'pcs', isCrossBranch: true, crossBranchClientId: 'B2', crossBranchLabel: 'Branch Two' } }; currentPaymentMethod = 'cash'");
  set(w, 'cash-tendered-input', 1000);
  const first = w.eval('checkoutCart()');
  await new Promise((r) => setTimeout(r, 10));
  await w.eval('checkoutCart()');
  assert.match(toasts(w), /Still completing the sale/, 'a blocked tap says why');
  await first;
  assert.match(toasts(w), /Could not reach Branch Two within 20 seconds/);
  assert.equal(w.eval('window.__checkoutBusy'), false, 'the till is free again');
  assert.equal(sales(w).length, 0, 'nothing was recorded');
  b.close();
});

// ---------- S-B: websocket open does not flush on every open ----------
test('S-B: a socket that opens twice within 15 s flushes once; the reconnect delay is not reset by an open that does not last', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("window.__flushes = 0; flushThenPull = function () { window.__flushes++; return Promise.resolve(); }; window.__socks = []; window.WebSocket = class { constructor(u) { this.readyState = 1; window.__socks.push(this); } close() { this.readyState = 3; } }; WebSocket.OPEN = 1; WebSocket.CONNECTING = 0; syncSocket = null; wsReconnectDelay = 12345; delete window.__wsOpenFlushAt;");
  w.eval('connectSyncSocket()'); w.eval('window.__socks[0].onopen()');
  w.eval('syncSocket = null; connectSyncSocket()'); w.eval('window.__socks[1].onopen()');
  assert.equal(w.eval('window.__flushes'), 1, 'the second open inside 15 s does not flush again');
  assert.equal(w.eval('wsReconnectDelay'), 12345, 'the delay is only reset after the socket stays open for 10 s');
  b.close();
});

// ---------- S-C: bulk deletes are announced to the sync safety net ----------
test('S-C: Reset Inventory marks the inventory list as a deliberate bulk delete', async () => {
  const b = await open([HUN, A]); const { w } = b;
  w.eval('performResetInventory()');
  assert.equal(w.eval('window.__bulkDelete && window.__bulkDelete.inventory'), true);
  b.close();
});
test('S-C: Delete voided sales / demo purge mark bills (and customers) as deliberate bulk deletes', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("bills.push({ id: 'v1', items: [], voided: true, timestamp: new Date().toISOString() }); performDeleteVoidedSales()");
  assert.equal(w.eval('window.__bulkDelete && window.__bulkDelete.bills'), true);
  w.eval("window.__bulkDelete = {}; pendingDemoPurgeOptions = { clearCustomers: true }; performPurgeDemoData()");
  assert.equal(w.eval('window.__bulkDelete.bills && window.__bulkDelete.customers'), true);
  b.close();
});

// ---------- P-A: a sale does not rebuild hidden tabs ----------
test('P-A: ringing up a sale rebuilds the trends chart / inventory table / daily sales only when that tab is the one showing', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("window.__r = { t: 0, i: 0, d: 0 }; const a = renderTrendsChart, c = renderInventoryTable, d = renderDailySales; renderTrendsChart = function () { __r.t++; return a.apply(this, arguments); }; renderInventoryTable = function () { __r.i++; return c.apply(this, arguments); }; renderDailySales = function () { __r.d++; return d.apply(this, arguments); };");
  await cash(w, "addToCart('H1')");
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__r)')), { t: 0, i: 0, d: 0 }, 'none of them is on screen');
  w.eval("document.getElementById('daily-sales-tab').classList.add('active'); window.__r = { t: 0, i: 0, d: 0 }");
  await cash(w, "addToCart('H1')");
  assert.equal(w.eval('window.__r.d'), 1, 'the open Daily Sales tab is refreshed');
  b.close();
});

// ---------- P-B: the photo grid waits for a pause in typing ----------
test('P-B: typing "abc" fast rebuilds the photo grid once, after 120 ms; an empty box and Enter show it at once', async () => {
  const b = await open([HUN, A]); const { w } = b;
  w.eval("window.__g = []; const o = renderItemImageGrid; renderItemImageGrid = function (q) { __g.push(q); };");
  w.eval("liveSearch('a'); liveSearch('ab'); liveSearch('abc')");
  assert.equal(w.eval('window.__g.length'), 0, 'nothing yet (was 3 rebuilds)');
  assert.ok(w.document.getElementById('search-results').innerHTML.length > 0, 'the dropdown is immediate');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__g)')), ['abc']);
  w.eval("window.__g = []; liveSearch('')");
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__g)')), [''], 'clearing is immediate');
  w.eval("window.__g = []; document.getElementById('sales-search').value = 'wid'; liveSearch('wid'); flushItemGridNow()");
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__g)')), ['wid'], 'flushNow shows it at once');
  b.close();
});

// ---------- P-D: offers are worked out once per cart render ----------
test('P-D: one renderCart evaluates the offers once (it was three times, each scanning the inventory per line per offer)', async () => {
  const b = await open([HUN], { pos_offers: JSON.stringify([OFFER10, { id: 'f1', name: 'Flat', type: 'flat', flatAmount: 5, minQty: 1, scope: 'all', targets: [], active: true }]) }); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1'); window.__n = 0; const o = computeFlatOfferResults; computeFlatOfferResults = function () { __n++; return o.apply(this, arguments); }; window.__n = 0;");
  w.eval('renderCart()');
  assert.equal(w.eval('window.__n'), 1);
  assert.equal(w.eval('cartTotal()'), 85, 'and a total outside a render is still computed fresh: 100 - 10 - 5');
  assert.equal(w.eval('window.__n'), 2);
  w.eval("currentCart['H1'].qty = 2; renderCart()");
  assert.match(w.document.getElementById('cart-grand-total').textContent, /175\.00/, 'the next render sees the new cart: 200 - 20 - 5');
  b.close();
});

// ---------- P-C: the global click handler only reacts to the controls that change the workspace height ----------
import fs from 'node:fs';
test('P-C: receipt-extras no longer schedules a layout pass on EVERY click, and coalesces the cart-table observer into one frame', () => {
  const src = fs.readFileSync(new URL('../src/shared/blocks/receipt-extras.html', import.meta.url), 'utf8');
  assert.ok(!/document\.addEventListener\('click', function \(\) \{ setTimeout\(posSyncCartBarOffset, 60\)/.test(src), 'the unconditional handler is gone');
  assert.match(src, /closest\('#hdr-hide-btn, #hdr-show-btn, \.tab-link, \[data-tab\]'\)/);
  assert.match(src, /new MutationObserver\(updSoon\)/);
});
