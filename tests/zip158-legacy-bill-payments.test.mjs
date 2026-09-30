import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 158 item 4 - payments taken on a bill before zip 156 carry no `billId`, so voiding the bill could not void them (it only warned).
// A one-time repair links such a payment to its bill when - and only when - exactly one bill fits (same customer, a bill payment line, a payment of the
// same amount on that bill's own history within a minute). Nothing is guessed.
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const T0 = Date.parse('2026-06-10T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const bill = (id, name, payments, extra = {}) => ({ id, timestamp: iso(T0), customerName: name, customerPhone: null, items: [{ code: 'A1', name: 'Tea', qty: 2, price: 100 }], amountPaid: payments.reduce((n, p) => n + p.amount, 0),
  status: 'partial', closed: false, fulfillmentType: 'carried_immediately', inventoryDeducted: true,
  paymentHistory: payments.map((p, i) => ({ id: id + '-p' + i, timestamp: iso(p.at), amount: p.amount, method: 'cash', reference: '', balanceAfter: 200 - p.amount })), ...extra });
const paySale = (id, name, amount, at, extra = {}) => ({ id, timestamp: iso(at), paid: true, paymentMethod: 'cash', cashAmount: amount, servedBy: 'Admin', customerName: name,
  items: [{ name: 'Bill Payment — This Installment', price: amount, qty: 1, unit: 'payment', wholesalePrice: 0, isService: true, vatCategory: 'A' }],
  installment: { original: 200, paidToDate: amount, thisInstallment: amount, remaining: 200 - amount }, ...extra });
const open = (bills, sales, wait = 250) => boot('index.html', { storage: { pos_inventory: INV, pos_bills: JSON.stringify(bills), pos_sales_log: JSON.stringify(sales) }, wait });
const linked = (w) => JSON.parse(w.eval('JSON.stringify(salesLog.map(s => [s.id, s.billId || null]))'));
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");

test('a legacy instalment (no billId) is linked to the one bill it belongs to, and voiding that bill now voids it', async () => {
  const bills = [bill('B1', 'Jane', [{ at: T0 + 1000, amount: 60 }, { at: T0 + 3600000, amount: 40 }]), bill('B2', 'Peter', [{ at: T0 + 1000, amount: 60 }])];
  const sales = [paySale('P1', 'Jane', 60, T0 + 1300), paySale('P2', 'Jane', 40, T0 + 3600200), paySale('P3', 'Peter', 60, T0 + 1500)];
  const { w, close } = await open(bills, sales); quiet(w);
  assert.equal(w.eval('repairLegacyBillPayments()'), 3);
  assert.deepEqual(linked(w), [['P1', 'B1'], ['P2', 'B1'], ['P3', 'B2']]);
  assert.equal(w.eval('repairLegacyBillPayments()'), 0, 'safe to repeat');
  assert.equal(JSON.parse(w.localStorage.getItem('pos_sales_log'))[0].billId, 'B1', 'saved on the device');
  assert.ok(w.eval('salesLog[0].updatedAt') > 0, 'stamped so it reaches the server');
  const revenue = () => w.eval('salesLog.filter(x => !x.voided).map(reportSaleTotal).reduce((a, x) => a + x, 0)');
  assert.equal(revenue(), 160);
  w.eval("pendingVoidSaleSource = 'bills'; pendingVoidReason = 'mistake'; performVoidSale('B1')");
  assert.equal(revenue(), 60, 'Jane\'s two payments were voided with her bill; Peter\'s stays');
  close();
});

test('it runs by itself at start-up (no button, no message)', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_inventory: INV, pos_bills: JSON.stringify([bill('B1', 'Jane', [{ at: T0, amount: 60 }])]), pos_sales_log: JSON.stringify([paySale('P1', 'Jane', 60, T0 + 500)]) },
    beforeParse: (win) => { win.__legacyBillRepairDelayMs = 50; }, wait: 900 });
  assert.deepEqual(linked(w), [['P1', 'B1']]);
  close();
});

test('never guessed: two bills that fit, a different amount, a different customer, a phone that differs, a payment far from the sale, an already voided payment, a bill with no such payment', async () => {
  const bills = [
    bill('A1', 'Twin', [{ at: T0, amount: 50 }]), bill('A2', 'Twin', [{ at: T0 + 20000, amount: 50 }]),          // both fit P-twin
    bill('C1', 'Solo', [{ at: T0, amount: 70 }]),
    bill('D1', 'Phoned', [{ at: T0, amount: 30 }], { customerPhone: '254711111111' }),
    bill('E1', 'Late', [{ at: T0, amount: 25 }]),
    bill('F1', 'Voided', [{ at: T0, amount: 15 }]),
    bill('G1', 'Nobody', []),
  ];
  const sales = [
    paySale('P-twin', 'Twin', 50, T0 + 10000),
    paySale('P-amount', 'Solo', 71, T0 + 100),
    paySale('P-name', 'Someone else', 70, T0 + 100),
    paySale('P-phone', 'Phoned', 30, T0 + 100, { customerPhone: '254722222222' }),
    paySale('P-late', 'Late', 25, T0 + 10 * 60000),
    paySale('P-voided', 'Voided', 15, T0 + 100, { voided: true }),
    paySale('P-none', 'Nobody', 10, T0),
  ];
  const { w, close } = await open(bills, sales);
  assert.equal(w.eval('repairLegacyBillPayments()'), 0);
  assert.ok(linked(w).every(([, b]) => b === null), JSON.stringify(linked(w)));
  // ...but the same customer with a phone that agrees is linked
  w.eval("salesLog.push(" + JSON.stringify(paySale('P-ok', 'Phoned', 30, T0 + 100, { customerPhone: '0711111111' })) + ")");
  assert.equal(w.eval('repairLegacyBillPayments()'), 1);
  assert.equal(linked(w).find(([id]) => id === 'P-ok')[1], 'D1');
  close();
});

test('the old four-line instalment shape and the "Partial payment - Bill" line taken with the bill are recognised too; a walk-in customer needs the same name on both', async () => {
  const bills = [bill('B1', 'Jane', [{ at: T0, amount: 60 }, { at: T0 + 5000000, amount: 50 }]), bill('W1', '', [{ at: T0 + 9000000, amount: 20 }])];
  const fourLine = { id: 'P-old', timestamp: iso(T0 + 5000100), paid: true, customerName: 'Jane', paymentMethod: 'cash', cashAmount: 50,
    items: [{ name: 'Original Bill Amount', price: 200, qty: 1, unit: 'payment' }, { name: 'Total Paid To Date', price: 110, qty: 1, unit: 'payment' }, { name: 'This Installment', price: 50, qty: 1, unit: 'payment' }, { name: 'Remaining Outstanding Balance', price: 90, qty: 1, unit: 'payment' }] };
  const upfront = { id: 'P-up', timestamp: iso(T0 + 300), paid: true, customerName: 'Jane', paymentMethod: 'cash', cashAmount: 60, items: [{ name: 'Partial payment — Bill (Jane)', price: 60, qty: 1, unit: 'payment' }] };
  const walkin = { id: 'P-walk', timestamp: iso(T0 + 9000100), paid: true, customerName: 'Walk-in customer', paymentMethod: 'cash', cashAmount: 20, items: [{ name: 'Partial payment — Bill (Walk-in customer)', price: 20, qty: 1, unit: 'payment' }] };
  const { w, close } = await open(bills, [fourLine, upfront, walkin]);
  assert.equal(w.eval('repairInstallmentSales()'), 1, 'the four lines become one, as before');
  assert.equal(w.eval('repairLegacyBillPayments()'), 3);
  assert.deepEqual(linked(w), [['P-old', 'B1'], ['P-up', 'B1'], ['P-walk', 'W1']]);
  close();
});

test('in every app that has bills and a sales list: the link is made, and it is saved under THAT app\'s own keys (Aqua keeps aqua_*, not pos_*)', async () => {
  for (const app of ['hotel/index.html', 'pharmacy/index.html', 'water/index.html', 'services/index.html']) {
    const pre = app.startsWith('water') ? 'aqua' : 'pos';
    const { w, close } = await boot(app, { storage: { [pre + '_bills']: JSON.stringify([bill('B1', 'Jane', [{ at: T0, amount: 60 }])]), [pre + '_sales_log']: JSON.stringify([paySale('P1', 'Jane', 60, T0 + 500)]) }, wait: 300 });
    assert.equal(typeof w.eval('repairLegacyBillPayments'), 'function', app);
    assert.equal(w.eval('repairLegacyBillPayments()'), 1, app);
    assert.equal(JSON.parse(w.localStorage.getItem(pre + '_sales_log'))[0].billId, 'B1', app + ': saved under ' + pre + '_sales_log');
    if (pre === 'aqua') assert.equal(w.localStorage.getItem('pos_sales_log'), null, 'no stray pos_sales_log copy in Aqua');
    close();
  }
});

test('Aqua: shared code that saves the sales / bills / movement lists writes them under the aqua_* keys (a receipt marked printed, a customer number, keyed movements survive a reload)', async () => {
  const sale = { id: 'S1', timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', cashAmount: 100, refNumber: 'R-1', items: [{ code: 'A', name: 'Water', price: 100, qty: 1 }] };
  const { w, close } = await boot('water/index.html', { storage: { aqua_sales_log: JSON.stringify([sale]) }, wait: 300 });
  quiet(w);
  assert.equal(w.eval("appStoreKey('pos_sales_log')"), 'aqua_sales_log');
  assert.equal(w.eval("appStoreKey('pos_bills')"), 'aqua_bills');
  w.eval("markReceiptPrinted(salesLog[0])");
  assert.equal(JSON.parse(w.localStorage.getItem('aqua_sales_log'))[0].printCount, 1, 'printed marker saved where Aqua reads it');
  assert.equal(w.localStorage.getItem('pos_sales_log'), null, 'no stray pos_sales_log');
  w.eval("stockMovementLog.push({ id: 'tmp', code: 'A', delta: -1, type: 'removed', timestamp: new Date().toISOString() }); stockKeyMoves(stockMovementLog.length - 1, 'void:S1')");
  assert.equal(JSON.parse(w.localStorage.getItem('aqua_stock_movement_log')).pop().id.startsWith('void:S1:'), true, 'keyed movement saved where Aqua reads it');
  assert.equal(w.localStorage.getItem('pos_stock_movement_log'), null);
  close();
  const shop = await boot('index.html', { wait: 300 });
  assert.equal(shop.w.eval("appStoreKey('pos_sales_log')"), 'pos_sales_log', 'the shop app is unchanged');
  shop.close();
});
