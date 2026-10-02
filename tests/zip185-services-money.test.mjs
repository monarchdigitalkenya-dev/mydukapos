import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 185 (Services app, services/index.html): money / stock / sync fixes outside the shared regions. One test per defect, each with a concrete number.
const A = { code: 'A1', type: 'item', name: 'Widget', price: 33.33, wholesalePrice: 20, qty: 500, unit: 'pcs', vatCategory: 'A' };
const BIG = { code: 'B1', type: 'item', name: 'Machine', price: 1000, wholesalePrice: 600, qty: 50, unit: 'pcs', vatCategory: 'A' };
const HUN = { code: 'H1', type: 'item', name: 'Hundred', price: 100, wholesalePrice: 40, qty: 50, unit: 'pcs', vatCategory: 'A' };
const KG = { code: 'K1', type: 'item', name: 'Sugar', price: 150, wholesalePrice: 100, qty: 10, unit: 'kg', vatCategory: 'A' };
const inv = (...items) => JSON.stringify(items);
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); };";
async function open(items, extra = {}) { const b = await boot('services/index.html', { storage: { pos_inventory: inv(...items), ...extra }, wait: 900 }); b.w.eval(QUIET); return b; }
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (items) => r2(items.reduce((s, l) => s + l.price * l.qty, 0));
const OFFER10 = { id: 'o1', name: '10% off', type: 'percent', percentOff: 10, scope: 'all', targets: [], active: true };
const set = (w, id, v) => { w.document.getElementById(id).value = String(v); };
const sales = (w) => JSON.parse(w.eval('JSON.stringify(salesLog)'));
const bills = (w) => JSON.parse(w.eval('JSON.stringify(bills)'));
const toasts = (w) => (w.eval('window.__toasts') || []).join(' | ');
async function cash(w, setup) { w.eval(`currentCart = {}; ${setup}; currentPaymentMethod = 'cash'`); set(w, 'cash-tendered-input', 100000); await w.eval('checkoutCart()'); }
async function billSale(w, setup, upfront, extraSetup = '') {
  w.eval(`currentCart = {}; ${setup}; currentPaymentMethod = 'bill'; ${extraSetup}`);
  set(w, 'bill-customer-name-input', 'Wanjiru'); set(w, 'bill-upfront-amount-input', upfront);
  w.eval("billUpfrontMethod = 'cash'");
  await w.eval('checkoutCart()');
}
const settle = (w, billId, amount) => { w.eval(`openBillSettleModal('sale', '${billId}')`); set(w, 'bill-settle-amount-input', amount); w.eval('confirmBillSettleImpl(true)'); };
const costOf = (w) => w.eval('salesLog.filter(s => !s.voided).reduce((t, s) => t + reportSaleCost(s), 0)');

test('M-C: 3 x 33.33 with 10% off is charged 89.99 and the saved item lines add up to 89.99 (was 90.00)', async () => {
  const b = await open([A], { pos_offers: JSON.stringify([OFFER10]) }); const { w } = b;
  await cash(w, "addToCart('A1'); addToCart('A1'); addToCart('A1')");
  const s = sales(w);
  assert.equal(s.length, 1, toasts(w));
  assert.equal(s[0].cashAmount, 89.99);
  assert.equal(sum(s[0].items), 89.99, 'lines: ' + JSON.stringify(s[0].items.map((l) => [l.qty, l.price])));
  b.close();
});

test('M-G: a 50% offer plus a flat 60 off a KES 100 item totals 0 (was -10); a flat 30 still totals 20', async () => {
  const flat = (amt) => ({ id: 'f1', name: 'Flat', type: 'flat', flatAmount: amt, minQty: 1, scope: 'all', targets: [], active: true });
  const half = { id: 'o50', name: '50%', type: 'percent', percentOff: 50, scope: 'all', targets: [], active: true };
  const b = await open([HUN], { pos_offers: JSON.stringify([half, flat(60)]) }); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1')");
  assert.equal(w.eval('cartTotal()'), 0, 'was -10');
  w.eval(`offers = ${JSON.stringify([half, flat(30)])}`);
  assert.equal(w.eval('cartTotal()'), 20, 'a valid total is unchanged: 100 - 50 - 30');
  b.close();
});

test('M-H: Z report - a 10% offer on KES 100 shows gross 100, discounts 10, net 90', async () => {
  const b = await open([HUN], { pos_offers: JSON.stringify([OFFER10]) }); const { w } = b;
  await cash(w, "addToCart('H1')");
  const t = JSON.parse(w.eval('JSON.stringify((() => { const t = posControlReportTotals(); return { gross: t.gross, discounts: t.discounts, net: t.netSales, gp: t.grossProfit }; })())'));
  assert.deepEqual(t, { gross: 100, discounts: 10, net: 90, gp: 50 });
  b.close();
});

test('M-A: a 1000 bill that cost 600, paid 400 now and 600 later: cost 240 + 360 = 600 reaches the sales log (profit 400, was 1000)', async () => {
  const b = await open([BIG]); const { w } = b;
  await billSale(w, "addToCart('B1')", 400);
  assert.equal(bills(w).length, 1, toasts(w));
  assert.equal(costOf(w), 240);
  settle(w, bills(w)[0].id, 600);
  const s = sales(w);
  assert.deepEqual(s.map((x) => x.items[0].costShare), [240, 360]);
  assert.equal(costOf(w), 600);
  assert.equal(s.reduce((t, x) => t + sum(x.items), 0) - costOf(w), 400);
  assert.equal(w.eval('buildProfitBreakdown(todayDateString(), todayDateString()).reduce((t, r) => t + r.revenue - r.cost, 0)'), 400, 'the profit report agrees');
  assert.equal(w.eval('salesLog.reduce((t, s) => t + saleCogs(s), 0)'), 600, 'saleCogs / itemCogs agree');
  b.close();
});

test('M-D: a bill of 1000 + 200 delivery fee with 500 paid shows 700 owed (was 500) and is not closed by paying 500', async () => {
  const b = await open([BIG]); const { w } = b;
  w.eval("currentCart = {}; addToCart('B1'); currentPaymentMethod = 'bill'; setOrderType('delivery'); setDeliveryPaymentMode('now')");
  set(w, 'delivery-address-input', 'Kilimani'); set(w, 'delivery-fee-input', 200); set(w, 'bill-customer-name-input', 'Wanjiru'); set(w, 'bill-upfront-amount-input', 500);
  w.eval("billUpfrontMethod = 'cash'");
  await w.eval('checkoutCart()');
  const bill = bills(w)[0];
  assert.equal(bill.deliveryDetails.fee, 200, toasts(w));
  assert.equal(w.eval('getOpenBillsList()[0].amount'), 700);
  settle(w, bill.id, 500);
  assert.equal(bills(w)[0].status, 'partially_paid', 'was fully_paid with the 200 fee never collected');
  settle(w, bill.id, 200);
  assert.equal(bills(w)[0].status, 'fully_paid');
  assert.equal(r2(sales(w).reduce((t, s) => t + s.cashAmount, 0)), 1200);
  assert.equal(costOf(w), 600);
  b.close();
});

test('M-F: a split of cash -100 + M-Pesa 600 is refused at checkout, in a bill part-payment, a settlement and an exchange', async () => {
  let b = await open([HUN]); let w = b.w;
  w.eval("currentCart = {}; addToCart('H1'); currentPaymentMethod = 'split'");
  set(w, 'split-cash-input', -500); set(w, 'split-mpesa-input', 600); set(w, 'split-cash-tendered-input', 0);
  await w.eval('checkoutCart()');
  assert.equal(sales(w).length, 0, 'nothing recorded'); assert.match(toasts(w), /cannot be negative/);
  w.eval("currentCart = {}; addToCart('H1'); currentPaymentMethod = 'bill'; billUpfrontMethod = 'split'");
  set(w, 'bill-customer-name-input', 'W'); set(w, 'bill-upfront-amount-input', 50);
  set(w, 'bill-upfront-split-cash-input', -100); set(w, 'bill-upfront-split-mpesa-input', 150); set(w, 'bill-upfront-split-bank-input', 0); set(w, 'bill-upfront-split-card-input', 0);
  await w.eval('checkoutCart()');
  assert.equal(bills(w).length, 0);
  b.close();
  b = await open([BIG]); w = b.w;
  await billSale(w, "addToCart('B1')", 0);
  const id = bills(w)[0].id;
  w.eval(`openBillSettleModal('sale', '${id}')`); set(w, 'bill-settle-amount-input', 500); w.eval("setBillSettlePayMethod('split')");
  set(w, 'bill-settle-split-cash-input', -100); set(w, 'bill-settle-split-mpesa-input', 600);
  w.eval('confirmBillSettleImpl(true)');
  assert.equal(sales(w).length, 0); assert.match(w.document.getElementById('bill-settle-modal-error').textContent, /negative/);
  b.close();
});

test('M-B: a cross-branch cart line does not also take stock from a same-coded item of THIS branch', async () => {
  const b = await open([HUN]); const { w } = b;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  w.eval("currentCart = { 'xb:H1': { code: 'H1', cartKey: 'xb:H1', name: 'Far Hundred', qty: 5, price: 100, wholesalePrice: 0, unit: 'pcs', isCrossBranch: true, crossBranchClientId: 'B2', crossBranchLabel: 'Branch Two' } }; currentPaymentMethod = 'cash'");
  set(w, 'cash-tendered-input', 1000);
  await w.eval('checkoutCart()');
  assert.equal(w.eval("inventory.find(p => p.code === 'H1').qty"), 50, 'this branch\'s stock is untouched (was 45)');
  b.close();
});

test('M-K: an exchange for 3 when 1 is in stock is refused up front (it used to ask "continue anyway?" and then take 1, recording 3)', async () => {
  const b = await open([{ ...HUN, qty: 5 }, { code: 'S1', type: 'item', name: 'Spare', price: 50, wholesalePrice: 20, qty: 1, unit: 'pcs', vatCategory: 'A' }]); const { w } = b;
  await cash(w, "addToCart('H1')");
  w.eval(`selectReturnRefItem('${w.eval('salesLog[0].id')}', 0)`);
  set(w, 'return-qty-input', 1); set(w, 'return-condition-select', 'good');
  const r = w.document.getElementById('return-reason-select'); r.value = r.options[0].value;
  w.eval("setReturnMode('exchange'); addExchangeReplacementItem('S1'); exchangeReplacementItems[0].qty = 3");
  set(w, 'exchange-credit-value-input', 50);
  w.eval('saveExchange()');
  assert.equal(w.eval("inventory.find(p => p.code === 'S1').qty"), 1, 'stock untouched');
  assert.equal(w.eval('returns.length'), 0);
  assert.match(w.document.getElementById('return-save-error').textContent, /Only 1/);
  w.eval('exchangeReplacementItems[0].qty = 1'); set(w, 'exchange-credit-value-input', 50);
  w.eval('saveExchange()');
  assert.equal(w.eval("inventory.find(p => p.code === 'S1').qty"), 0, 'within stock it goes through');
  b.close();
});

test('M-L: returning 0.5 kg restocks 0.5; an exchange credit above what was paid or below 0 is refused; the credit fills from the receipt price', async () => {
  const b = await open([KG, { code: 'S1', type: 'item', name: 'Spare', price: 500, wholesalePrice: 20, qty: 5, unit: 'pcs', vatCategory: 'A' }]); const { w } = b;
  await cash(w, "addToCart('K1'); currentCart['K1'].qty = 2");
  w.eval(`selectReturnRefItem('${w.eval('salesLog[0].id')}', 0)`);
  set(w, 'return-qty-input', 0.5); set(w, 'return-condition-select', 'good');
  const r = w.document.getElementById('return-reason-select'); r.value = r.options[0].value;
  w.eval("setReturnMode('simple')");
  const before = w.eval("inventory[0].qty");
  w.eval('saveSimpleReturn()');
  assert.equal(w.eval('inventory[0].qty'), before + 0.5);
  assert.equal(w.eval('returns[0].qty'), 0.5);
  // exchange credit
  w.eval(`selectReturnRefItem('${w.eval('salesLog[0].id')}', 0)`);
  set(w, 'return-qty-input', 1); set(w, 'return-condition-select', 'good');
  w.eval("inventory.find(p => p.code === 'K1').price = 400; setReturnMode('exchange'); addExchangeReplacementItem('S1'); exchangeCreditValueDirty = false; autofillExchangeCreditValue()");
  assert.equal(w.document.getElementById('exchange-credit-value-input').value, '150.00', 'the price PAID (150), not today\'s 400');
  set(w, 'exchange-credit-value-input', 400);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 1, 'only the simple return exists: the 400 credit was refused');
  set(w, 'exchange-credit-value-input', -20);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 1);
  set(w, 'exchange-credit-value-input', 150);
  w.eval('saveExchange()');
  assert.equal(w.eval('returns.length'), 2, w.document.getElementById('return-save-error').textContent);
  b.close();
});

test('S-C: Reset Inventory / delete voided / demo purge announce the bulk delete to the sync safety net (only when something is really removed)', async () => {
  const b = await open([HUN, A]); const { w } = b;
  w.eval('performResetInventory()');
  assert.equal(w.eval('window.__bulkDelete && window.__bulkDelete.inventory'), true);
  w.eval("window.__bulkDelete = {}; performDeleteVoidedSales()");
  assert.equal(w.eval('!!(window.__bulkDelete && window.__bulkDelete.bills)'), false, 'no voided bills: nothing marked (a stale mark would turn a later bad load into deletions)');
  w.eval("bills.push({ id: 'v1', items: [], voided: true, timestamp: new Date().toISOString() }); performDeleteVoidedSales()");
  assert.equal(w.eval('window.__bulkDelete.bills'), true);
  b.close();
});

test('P-A: ringing up a sale rebuilds the trends chart / inventory table / daily sales only when that tab is showing', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("window.__r = { t: 0, i: 0, d: 0 }; const a = renderTrendsChart, c = renderInventoryTable, d = renderDailySales; renderTrendsChart = function () { __r.t++; return a.apply(this, arguments); }; renderInventoryTable = function () { __r.i++; return c.apply(this, arguments); }; renderDailySales = function () { __r.d++; return d.apply(this, arguments); };");
  await cash(w, "addToCart('H1')");
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__r)')), { t: 0, i: 0, d: 0 }, 'none of them is on screen');
  w.eval("document.getElementById('daily-sales-tab').classList.add('active'); window.__r = { t: 0, i: 0, d: 0 }");
  await cash(w, "addToCart('H1')");
  assert.equal(w.eval('window.__r.d'), 1, 'the open Daily Sales tab is refreshed');
  b.close();
});

test('P-B: typing "abc" fast rebuilds the photo grid once, after 120 ms; an empty box shows it at once', async () => {
  const b = await open([HUN, A]); const { w } = b;
  w.eval("window.__g = []; renderItemImageGrid = function (q) { __g.push(q); };");
  w.eval("liveSearch('a'); liveSearch('ab'); liveSearch('abc')");
  assert.equal(w.eval('window.__g.length'), 0, 'nothing yet (was 3 rebuilds)');
  assert.ok(w.document.getElementById('search-results').innerHTML.length > 0, 'the dropdown is immediate');
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__g)')), ['abc']);
  w.eval("window.__g = []; liveSearch('')");
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__g)')), ['']);
  b.close();
});

test('P-D: one renderCart evaluates the offers once; a total outside a render is still computed fresh', async () => {
  const b = await open([HUN], { pos_offers: JSON.stringify([OFFER10, { id: 'f1', name: 'Flat', type: 'flat', flatAmount: 5, minQty: 1, scope: 'all', targets: [], active: true }]) }); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1'); const o = computeFlatOfferResults; computeFlatOfferResults = function () { __n++; return o.apply(this, arguments); }; window.__n = 0;");
  w.eval('renderCart()');
  assert.equal(w.eval('window.__n'), 1, 'it was evaluated three times');
  assert.equal(w.eval('cartTotal()'), 85);
  assert.equal(w.eval('window.__n'), 2);
  w.eval("currentCart['H1'].qty = 2; renderCart()");
  assert.match(w.document.getElementById('cart-grand-total').textContent, /175\.00/, 'the next render sees the new cart: 200 - 20 - 5');
  b.close();
});

test('P-E: the customer display is not rewritten when nothing it shows changed, and a "change due" screen is always replaced', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval("currentCart = {}; addToCart('H1'); window.__w = 0; const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k) { if (k === 'pos_customer_display_state') __w++; return o.apply(this, arguments); }; window.__w = 0;");
  w.eval('renderCart(); renderCart(); renderCart()');
  assert.equal(w.eval('window.__w'), 0, 'same content: no write (was one per render)');
  w.eval("localStorage.setItem('pos_customer_display_state', JSON.stringify({ mode: 'change', change: 40, ts: 1 })); window.__w = 0; renderCart()");
  assert.equal(w.eval('window.__w'), 1, 'the stored "change due" screen is replaced by the cart');
  b.close();
});

// ---------- services counter ----------
test('services counter: a deposit job logs its parts / recipe as stock movements and its deposit carries cost, VAT mix and the bill link', async () => {
  const part = { code: 'P1', type: 'item', name: 'Spare part', price: 800, wholesalePrice: 500, qty: 10, unit: 'pcs', vatCategory: 'A' };
  const b = await open([part]); const { w } = b;
  w.eval("serviceCounterDraft = { jobId: null, serviceCode: '', components: [{ code: 'P1', name: 'Spare part', qty: 2, price: 800, unit: 'pcs' }] }");
  set(w, 'services-counter-client-name', 'Juma'); set(w, 'services-counter-client-phone', '0711000111');
  set(w, 'services-counter-labor-fee', 400); set(w, 'services-counter-amount-paid', 500);
  w.eval("serviceCounterPaymentMethod = 'cash'");
  await w.eval('completeServiceJob()');
  assert.equal(w.eval("inventory[0].qty"), 8);
  const mv = JSON.parse(w.eval('JSON.stringify(stockMovementLog.filter(m => m.code === "P1"))'));
  assert.equal(mv.length, 1, 'the part left stock as a MOVEMENT too'); assert.equal(mv[0].delta, -2);
  const bl = bills(w);
  assert.equal(bl.length, 1, toasts(w));
  const dep = sales(w)[0];
  assert.equal(dep.billId, bl[0].id, 'voiding the job bill voids the deposit');
  // job: labour 400 (cost 0) + 2 parts 1600 (cost 1000) = 2000; deposit 500 covers 500/2000 of the 1000 cost = 250
  assert.equal(dep.items[0].costShare, 250);
  assert.equal(costOf(w), 250);
  b.close();
});

test('client registry: a job whose bill was settled (the bill is kept, closed) flips to Collected; a voided bill frees the job instead', async () => {
  const b = await open([HUN]); const { w } = b;
  w.eval(`serviceJobs = [{ id: 'J1', clientName: 'A', clientPhone: '1', status: 'ready', billId: 'BX1' }, { id: 'J2', clientName: 'B', clientPhone: '2', status: 'ready', billId: 'BX2' }, { id: 'J3', clientName: 'C', clientPhone: '3', status: 'ready', billId: 'BX3' }];
    bills = [{ id: 'BX1', items: [{ price: 100, qty: 1 }], amountPaid: 100, closed: true, status: 'fully_paid' }, { id: 'BX2', items: [{ price: 100, qty: 1 }], amountPaid: 0, voided: true }, { id: 'BX3', items: [{ price: 100, qty: 1 }], amountPaid: 50 }]; resolveJobBillStatuses()`);
  const j = JSON.parse(w.eval('JSON.stringify(serviceJobs)'));
  assert.equal(j[0].status, 'collected', 'was stuck on ready for ever'); assert.equal(j[0].billId, null);
  assert.equal(j[1].status, 'ready'); assert.equal(j[1].billId, null, 'voided bill: the job can be billed again');
  assert.equal(j[2].status, 'ready'); assert.equal(j[2].billId, 'BX3', 'a bill still open stays linked');
  b.close();
});

test('customer profile: a completed booking that was charged is not counted twice in Total Spent or in the statement', async () => {
  const svc = { code: 'SV1', type: 'service', name: 'Haircut', price: 500, unit: 'service', vatCategory: 'A' };
  const b = await open([svc]); const { w } = b;
  w.eval(`bookings = [{ id: 'BK1', customerName: 'Ann', customerPhone: '0722', serviceCode: 'SV1', staffId: 's', date: '2026-10-01', startTime: '10:00', endTime: '10:30', status: 'completed' }];
    salesLog = [{ id: 'S1', timestamp: new Date().toISOString(), customerPhone: '0722', customerName: 'Ann', cashAmount: 500, mpesaAmount: 0, items: [{ name: 'Haircut', price: 500, qty: 1 }] }];
    currentCustomerStatementPeriod = 'all'; currentCustomerProfileKey = '0722';`);
  const built = JSON.parse(w.eval('JSON.stringify((() => { const t = buildCustomerStatementText(); return { running: t.running }; })())'));
  assert.equal(built.running, 500, 'was 1000 (booking price + the receipt)');
  b.close();
});

test('booking: completing a booking whose service cannot be added to the cart (no ingredient stock) leaves it open instead of marking it done', async () => {
  const ing = { code: 'I1', type: 'ingredient', name: 'Oil', price: 0, wholesalePrice: 10, qty: 0, unit: 'l', vatCategory: 'A' };
  const svc = { code: 'SV2', type: 'service', name: 'Treatment', price: 900, unit: 'service', vatCategory: 'A', recipe: [{ code: 'I1', qtyPerUnit: 1 }] };
  const b = await open([ing, svc]); const { w } = b;
  w.eval("bookings = [{ id: 'BK2', customerName: 'Ann', customerPhone: '0722', serviceCode: 'SV2', staffId: 's', date: '2026-10-01', startTime: '10:00', endTime: '10:30', status: 'confirmed' }]; currentCart = {}; completeBooking('BK2')");
  assert.equal(w.eval("bookings[0].status"), 'confirmed', 'was completed with nothing in the cart');
  assert.match(toasts(w), /stays open/);
  b.close();
});
