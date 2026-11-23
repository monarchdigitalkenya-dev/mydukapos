import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 156: defects found by the line-by-line audit of the client. One regression test per defect (each failed before its fix).
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const quiet = (d) => d.w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
const idle = async (d) => { for (let i = 0; i < 100; i++) { if (!d.w.eval('window.__pushQueued') && !(d.w.eval('window.__pushInFlight') > 0) && !d.w.eval('window.__pullInFlight')) return; await sleep(50); } };

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: a bill made while a pull is on its way is NOT wiped when the reply lands (it is sent first)`, async () => {
    const s = makeServer();
    let hold = null;
    const gated = { ...s, fetch: async (url, opts = {}) => {
      if ((opts.method || 'GET').toUpperCase() === 'GET' && String(url).includes('/api/pos-sync') && hold) { const h = hold; const r = await s.fetch(url, opts); await h; return r; }
      return s.fetch(url, opts);
    } };
    const a = await openDevice(app, gated, { pos_inventory: INV }, 1200); quiet(a);
    await a.w.eval('pushNow()'); await a.w.eval('pullState()'); await idle(a);
    const b = await openDevice(app, s, deviceStorage(a.w), 1200); quiet(b);
    b.w.eval("bills.push({id:'bB', items:[{code:'A1',name:'Tea',qty:1,price:100}], amountPaid:0, timestamp:new Date().toISOString(), customerName:'other', status:'unpaid', closed:false, paymentHistory:[]}); safeSetItem('pos_bills', JSON.stringify(bills)); queuePush()");
    await idle(b); await sleep(300);
    let release; hold = new Promise((r) => { release = r; });
    const pull = a.w.eval('pullState()');
    await sleep(150);
    a.w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
    const nameEl = a.w.document.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane'; { const p = a.w.document.getElementById('sms-checkout-phone-input'); if (p) p.value = '0712345678'; }
    await a.w.eval('checkoutCart()');
    release(); hold = null;
    await pull; await sleep(1500); await idle(a); await sleep(500);
    const names = () => a.w.eval('bills.map(x => x.customerName || x.id)').slice().sort();
    assert.deepEqual(names(), ['Jane', 'other'], 'both bills are on this till');
    assert.deepEqual(JSON.parse(a.w.eval("localStorage.getItem('pos_bills')")).map((x) => x.customerName || x.id).sort(), ['Jane', 'other'], 'and in its storage');
    await a.w.eval('pushNow()'); await sleep(400);
    assert.deepEqual((s.serverState().bills || []).map((x) => x.customerName || x.id).sort(), ['Jane', 'other'], 'and on the server');
    a.close(); b.close();
  });
}

import { boot } from './helpers.mjs';
for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: a bill instalment counts as ONLY the money received (revenue), and its receipt still shows original / paid to date / remaining`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 }); const { w } = b;
    w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
    w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
    const nm = w.document.getElementById('bill-customer-name-input'); if (nm) nm.value = 'Jane'; { const p = w.document.getElementById('sms-checkout-phone-input'); if (p) p.value = '0712345678'; }
    await w.eval('checkoutCart()');
    const id = w.eval('bills[0].id');
    w.eval(`openBillSettleModal('sale', '${id}')`);
    w.eval("setBillSettleType('partial')"); w.document.getElementById('bill-settle-amount-input').value = '50';
    await w.eval('confirmBillSettle(true)');
    const sale = w.eval('salesLog[salesLog.length - 1]');
    assert.equal(w.eval('salesLog.map(reportSaleTotal).reduce((a, x) => a + x, 0)'), 50, 'revenue = the KES 50 received, not 450');
    assert.deepEqual(JSON.parse(JSON.stringify(sale.installment)), { original: 200, paidToDate: 50, thisInstallment: 50, remaining: 150 });
    assert.equal(sale.items.length, 1);
    w.eval('renderReceipt(salesLog[salesLog.length - 1])');
    const text = w.eval('lastReceiptText');
    assert.match(text, /Original bill\s+KES 200\.00/); assert.match(text, /Total paid to date\s+KES 50\.00/); assert.match(text, /Remaining balance\s+KES 150\.00/);
    b.close();
  });
}

test('sales saved with the OLD four-line instalment shape are reshaped once, and the reshaped sale is sent to the server', async () => {
  const old = { id: 'S-old', timestamp: new Date().toISOString(), paid: true, customerName: 'Jane', paymentMethod: 'cash', cashAmount: 50,
    items: [{ name: 'Original Bill Amount', price: 200, qty: 1, unit: 'payment' }, { name: 'Total Paid To Date', price: 50, qty: 1, unit: 'payment' }, { name: 'This Installment', price: 50, qty: 1, unit: 'payment' }, { name: 'Remaining Outstanding Balance', price: 150, qty: 1, unit: 'payment' }] };
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: INV, pos_sales_log: JSON.stringify([old]) }, 900); quiet(a);
  assert.equal(a.w.eval('salesLog.map(reportSaleTotal)[0]'), 450, 'before: counted 200 + 50 + 50 + 150');
  assert.equal(a.w.eval('repairInstallmentSales()'), 1);
  assert.equal(a.w.eval('repairInstallmentSales()'), 0, 'a second run changes nothing');
  assert.equal(a.w.eval('salesLog.map(reportSaleTotal)[0]'), 50);
  assert.deepEqual(JSON.parse(a.w.eval("localStorage.getItem('pos_sales_log')"))[0].installment.remaining, 150, 'saved');
  await idle(a);
  const onServer = (s.serverState().salesLog || []).find((x) => x.id === 'S-old');
  assert.equal(onServer.items.length, 1, 'and the server has the reshaped sale'); 
  a.close();
});

import { IDBFactory } from '../node_modules/fake-indexeddb/build/esm/index.js';
test('an edit to an already-synced sale that the journal signature does not cover (delivery status) is still sent, and a later pull does not put the old value back', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: INV }, 1200, { indexedDB: new IDBFactory() }); quiet(a);
  await a.w.eval('salesJournalReady');
  a.w.eval("addToCart('A1'); currentPaymentMethod = 'cash'"); a.w.document.getElementById('cash-tendered-input').value = '1000';
  a.w.eval("setOrderType('delivery')"); a.w.document.getElementById('delivery-address-input').value = 'Nairobi';
  await a.w.eval('checkoutCart()');
  await idle(a); await a.w.eval('pushNow()'); await idle(a); await sleep(1500);
  a.w.eval("salesLog[0].deliveryAgentId = 'ag1'; salesLog[0].deliveryStatus = 'assigned'; advanceDeliveryStatus(salesLog[0].id, 'salesLog')");
  await idle(a); await sleep(500); await a.w.eval('pushNow()'); await idle(a); await sleep(500);
  const local = a.w.eval('salesLog[0].deliveryStatus');
  assert.ok(local && local !== 'new', 'the status moved on this till: ' + local);
  assert.equal(s.serverState().salesLog[0].deliveryStatus, local, 'and the server has it');
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1200);
  b.w.eval("expenses.push({id:'e1', timestamp:new Date().toISOString(), category:'x', description:'d', amount:5}); safeSetItem('pos_expenses', JSON.stringify(expenses)); queuePush()");
  await idle(b); await sleep(400);
  await a.w.eval('pullState()'); await sleep(800);
  assert.equal(a.w.eval('salesLog[0].deliveryStatus'), local, 'a later pull does not revert it');
  a.close(); b.close();
});

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: when a step AFTER the sale was saved fails, the cart is cleared, so a second tap cannot sell it again`, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]) }, wait: 900 });
    const { w } = b;
    w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
    w.eval("currentCart = {}; addToCart('A'); currentCart['A'].qty = 2; currentPaymentMethod = 'cash'"); w.document.getElementById('cash-tendered-input').value = '1000';
    w.eval("window.__realMK = maybePrintKitchenTicket; maybePrintKitchenTicket = function () { throw new Error('kitchen ticket boom'); }");
    await w.eval('checkoutCart()');
    assert.equal(w.eval('salesLog.length'), 1, 'the sale is saved');
    assert.equal(w.eval('Object.keys(currentCart).length'), 0, 'and the cart is empty');
    w.eval('maybePrintKitchenTicket = window.__realMK');
    w.document.getElementById('cash-tendered-input').value = '1000';
    await w.eval('checkoutCart()');                                       // the cashier taps Complete Sale again
    assert.equal(w.eval('salesLog.length'), 1, 'nothing was sold twice');
    assert.equal(w.eval('inventory[0].qty'), 48);
    b.close();
  });
}

const voidIt = (dev, id) => { dev.w.eval(`pendingVoidSaleSource = 'salesLog'; pendingVoidReason = 'test'; performVoidSale('${id}')`); };
const unvoidIt = (dev, id) => { dev.w.eval(`pendingVoidSaleSource = 'salesLog'; performUnvoidSale('${id}')`); };
const sellCash = async (dev, n) => {
  dev.w.eval(`currentPaymentMethod = 'cash'; ${'addToCart(\'A1\'); '.repeat(n)} document.getElementById('cash-tendered-input').value = '100000'`);
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].id');
};
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'hospital/index.html']) {
  test(`${app}: void, unvoid, void again puts the stock back BOTH times (on this till and on the server); a second unvoid tap takes nothing more out`, async () => {
    const s = makeServer();
    const a = await openDevice(app, s, { pos_inventory: INV }, 1200); quiet(a);
    await a.w.eval('pushNow()'); await a.w.eval('pullState()');
    const id = await sellCash(a, 3); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 47);
    voidIt(a, id); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 50, 'void 1');
    unvoidIt(a, id); unvoidIt(a, id); await idle(a);                                  // (the second tap must be a no-op)
    assert.equal(a.w.eval('inventory[0].qty'), 47, 'unvoid: 3 taken out ONCE');
    voidIt(a, id); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 50, 'void 2');
    await a.w.eval('pushNow()'); await idle(a); await sleep(300);
    assert.equal(s.serverState().inventory[0].qty, 50, 'the server agrees');
    a.close();
  });
}

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'hospital/index.html']) {
  test(`${app}: voiding a sale that already had a return only puts back what was NOT returned (sell 3, return 2, void = 50, not 52)`, async () => {
    const s = makeServer();
    const a = await openDevice(app, s, { pos_inventory: INV }, 1200); quiet(a);
    await a.w.eval('pushNow()'); await a.w.eval('pullState()');
    const id = await sellCash(a, 3); await idle(a);
    const ref = a.w.eval('salesLog[salesLog.length - 1].refNumber');
    a.w.eval(`selectedReturnItem = { code: 'A1', name: 'Tea', sourceRefNumber: '${ref}' }`);
    a.w.document.getElementById('return-qty-input').value = '2';
    a.w.document.getElementById('return-condition-select').value = 'good';
    a.w.document.getElementById('return-reason-select').value = a.w.document.getElementById('return-reason-select').options[0].value;
    a.w.eval('saveSimpleReturn()'); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 49, 'sold 3, 2 came back');
    voidIt(a, id); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 50, 'void puts back only the 1 that was not returned');
    unvoidIt(a, id); await idle(a);
    assert.equal(a.w.eval('inventory[0].qty'), 49, 'and unvoid takes back exactly that 1');
    a.close();
  });
}

const FILL = `(function(){ var s=''; for (var i=0;i<11000;i++) s+=String.fromCharCode(0x4e00+Math.floor(Math.random()*20000));
  var n=0; [10000,1000,100,10,1].forEach(function(sz){ try { for(;;){ localStorage.setItem('pos_photo_'+n, s.slice(0,sz)); n++; } } catch(e) {} }); return n; })()`;
test('a bill made while the device storage is full is kept, the cashier is told, and it is written as soon as there is room (with the LATEST bills list)', async () => {
  const t = await boot('index.html', { storage: { pos_inventory: INV }, wait: 900, indexedDB: new IDBFactory() });
  const w = t.w;
  w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
  await w.eval('salesJournalReady');
  const filled = w.eval(FILL);
  assert.ok(filled > 0);
  w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'"); w.document.getElementById('bill-customer-name-input').value = 'Jane'; w.document.getElementById('sms-checkout-phone-input').value = '0712345678';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('bills.length'), 1, 'the bill exists on screen');
  assert.equal(w.eval("localStorage.getItem('pos_bills')"), null, 'but could not be stored');
  // a second bill is made while it is still full: the LATEST list (both bills) is what must be written later
  w.eval("addToCart('A1'); currentPaymentMethod = 'bill'"); w.document.getElementById('bill-customer-name-input').value = 'Joe'; w.document.getElementById('sms-checkout-phone-input').value = '0722333444';   // a different person must have a different phone (a shared phone asks the cashier, by design)
  await w.eval('checkoutCart()');
  await until(() => !!w.document.getElementById('storage-full-bar'), 12000);
  assert.ok(w.document.getElementById('storage-full-bar'), 'the red bar says the storage is full');
  w.eval("Object.keys(localStorage).filter(k => k.startsWith('pos_photo_')).forEach(k => localStorage.removeItem(k))");   // room again
  await until(() => !!w.eval("localStorage.getItem('pos_bills')"), 12000);
  assert.equal(JSON.parse(w.eval("localStorage.getItem('pos_bills')")).length, 2, 'both bills are stored');
  await until(() => !w.document.getElementById('storage-full-bar'), 8000);
  assert.equal(w.document.getElementById('storage-full-bar'), null, 'and the bar goes away');
  t.close();
});

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: voiding a bill also voids the payments taken on it (no revenue left for goods that went back on the shelf); restoring the bill restores them`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 }); const { w } = b;
    w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
    w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
    const nm = w.document.getElementById('bill-customer-name-input'); if (nm) nm.value = 'Jane'; { const p = w.document.getElementById('sms-checkout-phone-input'); if (p) p.value = '0712345678'; }
    w.document.getElementById('bill-upfront-amount-input').value = '60';
    await w.eval('checkoutCart()');
    const id = w.eval('bills[0].id');
    w.eval(`openBillSettleModal('sale', '${id}')`);
    w.eval("setBillSettleType('partial')"); w.document.getElementById('bill-settle-amount-input').value = '40';
    await w.eval('confirmBillSettle(true)');
    const revenue = () => w.eval('salesLog.filter(x => !x.voided).map(reportSaleTotal).reduce((a, x) => a + x, 0)');
    assert.equal(revenue(), 100, 'KES 60 + KES 40 received so far');
    w.eval(`pendingVoidSaleSource = 'bills'; pendingVoidReason = 'mistake'; performVoidSale('${id}')`);
    assert.equal(revenue(), 0, 'voided with the bill');
    assert.equal(w.eval('inventory[0].qty'), 50, 'and the goods are back on the shelf');
    w.eval(`pendingVoidSaleSource = 'bills'; performUnvoidSale('${id}')`);
    assert.equal(revenue(), 100, 'restored with the bill');
    b.close();
  });
}

const PH = JSON.stringify([{ code: 'A1', type: 'item', name: 'Paracetamol', price: 100, wholesalePrice: 50, qty: 10, unit: 'pcs', vatCategory: 'A', expiryDate: '2027-01-01',
  batches: [{ id: 'b1', batchNumber: 'B1', expiryDate: '2027-01-01', qty: 4 }, { id: 'b2', batchNumber: 'B2', expiryDate: '2028-01-01', qty: 6 }] }]);
test('pharmacy: batch stock and quantity stay together - a void and an inline quantity edit no longer make units vanish on the next sale', async () => {
  const s = makeServer();
  const a = await openDevice('pharmacy/index.html', s, { pos_inventory: PH }, 1200); quiet(a);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const id = await sellCash(a, 3); await idle(a);
  assert.equal(a.w.eval('inventory[0].qty'), 7);
  voidIt(a, id); await idle(a);
  assert.equal(a.w.eval('inventory[0].qty'), 10, 'void puts the 3 back');
  await sellCash(a, 1); await idle(a);
  assert.equal(a.w.eval('inventory[0].qty'), 9, 'the next sale takes 1 (was 6: the void was forgotten by the batches)');
  assert.equal(a.w.eval('inventory[0].batches.reduce((n, b) => n + b.qty, 0)'), 9, 'batches add up to the quantity');
  a.w.eval("updateInventoryField('A1', 'qty', '20')"); await idle(a);
  await sellCash(a, 1); await idle(a);
  assert.equal(a.w.eval('inventory[0].qty'), 19, 'after an inline edit to 20, one sale leaves 19 (was 9: ten units vanished)');
  assert.equal(a.w.eval('inventory[0].batches.reduce((n, b) => n + b.qty, 0)'), 19);
  a.close();
});

for (const app of ['hotel/index.html', 'hospital/index.html']) {
  test(`${app}: lowering stock by hand asks for the management password; raising it does not`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 }); const { w } = b;
    w.eval("showToast = function () {}; window.confirm = () => true; window.__asked = []; requireManagementApproval = function (m, then) { window.__asked.push(m); window.__then = then; };");
    w.eval("updateInventoryField('A1', 'qty', '60')");
    assert.equal(w.eval('inventory[0].qty'), 60, 'a restock goes straight through');
    assert.equal(w.eval('window.__asked.length'), 0);
    w.eval("updateInventoryField('A1', 'qty', '10')");
    assert.equal(w.eval('inventory[0].qty'), 60, 'a reduction waits for the password');
    assert.equal(w.eval('window.__asked.length'), 1);
    w.eval('window.__then()');
    assert.equal(w.eval('inventory[0].qty'), 10, 'and is applied once it is given');
    b.close();
  });
}

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: Pay-on-Delivery collects the real amount, records it once, saves it and keeps the bill closed`, async () => {
    const t = await boot(app, { storage: { pos_inventory: INV }, wait: 900 }); const w = t.w;
    w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}; if (typeof queuePrintJob === 'function') queuePrintJob = function () { return Promise.resolve(); }");
    w.eval("addToCart('A1'); addToCart('A1'); setOrderType('delivery'); setDeliveryPaymentMode('pod')");
    w.document.getElementById('delivery-address-input').value = 'Nairobi'; w.document.getElementById('delivery-client-name-input').value = 'Cust';
    await w.eval('checkoutCart()');
    const id = w.eval('bills[0].id');
    w.eval(`openDeliveryPaymentModal('${id}')`);
    assert.match(w.document.getElementById('delivery-payment-summary').textContent, /200\.00 due/);
    w.eval('confirmDeliveryPaymentCapture()');
    assert.equal(w.eval('salesLog.length'), 1);
    assert.equal(w.eval('salesLog[0].total'), 200);
    assert.equal(w.eval('salesLog[0].cashAmount'), 200);
    assert.equal(w.eval('bills[0].closed'), true);
    assert.equal(w.eval('getAssignedDeliveryOrders().filter(o=>o.source==="bills").length'), 0);
    assert.match(w.eval("localStorage.getItem('pos_sales_log')"), /"total":200/);
    assert.match(w.eval("localStorage.getItem('pos_bills')"), /podSettled/);
    t.close();
  });
}
