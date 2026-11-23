import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 262: the customer ledger / statement / invoice. One derived ledger feeds the screen, the print, the PDF text and the invoice.
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'hospital/index.html', 'water/index.html'];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* closed */ } } });
const PH = '0712345678';
const day = (n) => new Date(Date.UTC(2026, 5, n, 9, 0, 0)).toISOString();

for (const app of APPS) {
  test(`${app}: ledger covers purchases, bills, payments, debts, refunds, voids; no double counting; screen = print = invoice`, async () => {
    const b = await boot(app, { wait: 400 }); opened.push(b); const { w } = b; const d = w.document;
    w.eval(`
      customers = [{ id: 'c1', name: 'Jane Wanjiru', phone: '${PH}', tokens: 0, createdAt: 1 }];
      var item = (n, p, q) => ({ code: 'X', name: n, price: p, qty: q || 1, unit: 'pcs' });
      salesLog = [
        { id: 's1', refNumber: 'R-1', timestamp: '${day(1)}', paid: true, customerPhone: '${PH}', cashAmount: 500, mpesaAmount: 0, cardAmount: 0, items: [item('Sugar', 250, 2)] },          // purchase paid in full
        { id: 's2', refNumber: 'R-2', timestamp: '${day(2)}', paid: true, voided: true, customerPhone: '${PH}', cashAmount: 90, mpesaAmount: 0, cardAmount: 0, items: [item('Voided thing', 90)] },
        { id: 'm1', billId: 'B1', timestamp: '${day(4)}', paid: true, customerPhone: '${PH}', cashAmount: 300, mpesaAmount: 0, cardAmount: 0, items: [item('Bill Payment', 300)] },   // MIRROR of a bill payment: must not count again
        { id: 'B3', refNumber: 'R-B3', timestamp: '${day(6)}', paid: true, customerPhone: '${PH}', cashAmount: 400, mpesaAmount: 0, cardAmount: 0, items: [item('Converted bill', 400)] }, // same id as a bill
        { id: 's9', refNumber: 'R-9', timestamp: '${day(3)}', paid: true, customerPhone: '0799999999', cashAmount: 77, mpesaAmount: 0, cardAmount: 0, items: [item('Someone else', 77)] },
      ];
      bills = [
        { id: 'B1', refNumber: 'BL-1', timestamp: '${day(3)}', customerPhone: '${PH}', customerName: 'Jane Wanjiru', items: [item('Rice', 1000)], amountPaid: 300, paymentHistory: [{ id: 'p1', timestamp: '${day(4)}', amount: 300, method: 'cash', reference: '', balanceAfter: 700 }] },   // partially paid
        { id: 'B2', refNumber: 'BL-2', timestamp: '${day(5)}', customerPhone: '${PH}', customerName: 'Jane Wanjiru', items: [item('Flour', 200)], amountPaid: 0, paymentHistory: [] },                                                              // unpaid
        { id: 'B3', refNumber: 'BL-3', timestamp: '${day(5)}', customerPhone: '${PH}', customerName: 'Jane Wanjiru', items: [item('Converted bill', 400)], amountPaid: 400, closed: true, paymentHistory: [{ id: 'p3', timestamp: '${day(6)}', amount: 400, method: 'mpesa', reference: 'QX1', balanceAfter: 0 }] },
        { id: 'B4', refNumber: 'BL-4', timestamp: '${day(7)}', customerPhone: '${PH}', customerName: 'Jane Wanjiru', items: [item('Voided goods', 700)], amountPaid: 0, voided: true, paymentHistory: [] },
        { id: 'B5', refNumber: 'BL-5', timestamp: '${day(7)}', customerPhone: '', customerName: 'Jane Wanjiru', items: [item('No phone', 50)], amountPaid: 0, paymentHistory: [] },   // name only: reported, never assigned
      ];
      debts = [{ id: 'dddd111111', customerName: 'Jane Wanjiru', phone: '${PH}', amount: 600, notes: 'Old tab', createdAt: '${day(1)}', payments: [{ id: 'dp', amount: 100, method: 'cash', timestamp: '${day(8)}' }] }];
      returns = [
        { id: 'r1', type: 'return', refNumber: 'R-1', itemCode: 'X', itemName: 'Sugar', qty: 1, timestamp: '${day(9)}' },                       // refund 250 of a paid purchase
        { id: 'r2', type: 'exchange', customerPhone: '${PH}', storeCreditIssued: 50, timestamp: '${day(10)}', refNumber: 'R-X' },             // 50 store credit
      ];
    `);
    const L = w.eval(`customerLedgerBuild(customers[0], 'full')`);
    const T = L.totals;
    // charges: purchase 500 + bills 1000+200+400 (voided 0) + debt 600 + converted-bill sale counted ONCE (via the bill)
    assert.equal(T.purchases, 500, 'only the real purchase (voided + mirrors + converted bill excluded)');
    assert.equal(T.bills, 1600);
    assert.equal(T.debts, 600);
    assert.equal(T.received, 500 + 300 + 400 + 100, 'purchase 500 + bill payments 300 & 400 + debt payment 100');
    assert.equal(T.refundedOut, 250); assert.equal(T.credits, 250 + 50);
    // balance = 0 owed on purchase + (1000-300) + 200 + 0 + (600-100) - 50 credit = 1350
    assert.equal(L.closing, 1350); assert.equal(L.reconciles, true);
    assert.equal(L.outstandingTotal, 1400, 'open bills 700 + 200 + debt 500');
    assert.equal(L.creditOnAccount, 0);
    assert.ok(L.notes.some((n) => /bill BL-5/.test(n)), 'name-only bill is reported, not assigned');
    const status = Object.fromEntries(L.rows.filter((x) => x.type === 'Bill').map((x) => [x.ref, x.status]));
    assert.deepEqual(status, { 'BL-1': 'Partially paid', 'BL-2': 'Unpaid', 'BL-3': 'Paid', 'BL-4': 'Voided' });
    assert.ok(L.rows.every((x, i, a) => i === 0 || a[i - 1].t <= x.t), 'chronological');
    // the running balance on screen/print is the ledger's own
    assert.equal(L.rows[L.rows.length - 1].balance, L.closing);
    // screen, print, text and invoice all agree
    w.eval(`currentCustomerProfileId = 'c1'; currentCustomerStatementPeriod = 'full'; renderCustomerProfileBody()`);
    const screen = d.getElementById('customer-profile-history').textContent;
    assert.match(screen, /1,350\.00/); assert.match(screen, /Partially paid/); assert.match(screen, /Voided/);
    w.eval('printCustomerStatement()');
    const printed = d.getElementById('sales-report-body').textContent;
    assert.match(printed, /customer statement/i); assert.match(printed, /1,350\.00/); assert.match(printed, /Opening balance/);
    const txt = w.eval('buildCustomerStatementText().text'); assert.match(txt, /Closing balance: KES 1,350\.00 owed/);
    w.eval('printCustomerInvoice()');
    const inv = d.getElementById('sales-report-body').textContent;
    assert.match(inv, /INVOICE/); assert.match(inv, /Total outstanding:?\s*KES 1,400\.00/i);   // zip 356: the new invoice look (amount-due box)
    assert.match(inv, /BL-1/); assert.match(inv, /BL-2/); assert.doesNotMatch(inv, /BL-3/, 'settled bill is not on the invoice'); assert.doesNotMatch(inv, /BL-4/, 'voided bill is not on the invoice');
    // closing 1350 = outstanding 1400 - 50 store credit: the two views reconcile
    assert.equal(L.outstandingTotal - 50, L.closing);
  });

  test(`${app}: a period statement carries the opening balance and its totals reconcile`, async () => {
    const b = await boot(app, { wait: 400 }); opened.push(b); const { w } = b;
    w.eval(`
      customers = [{ id: 'c1', name: 'Jane', phone: '${PH}', tokens: 0, createdAt: 1 }];
      var old = new Date(Date.now() - 400 * 864e5).toISOString(), recent = new Date(Date.now() - 5 * 864e5).toISOString(), recent2 = new Date(Date.now() - 3 * 864e5).toISOString();
      salesLog = []; returns = [];
      bills = [{ id: 'B1', refNumber: 'BL-1', timestamp: old, customerPhone: '${PH}', items: [{ name: 'Old goods', price: 800, qty: 1 }], amountPaid: 0, paymentHistory: [] }];
      debts = [{ id: 'dx0000', phone: '${PH}', amount: 100, createdAt: recent, payments: [{ amount: 40, timestamp: recent2, method: 'cash' }] }];
    `);
    const L = w.eval(`customerLedgerBuild(customers[0], 'month1')`);
    assert.equal(L.opening, 800, 'older unpaid bill is carried as the opening balance');
    assert.equal(L.closing, 860); assert.equal(L.reconciles, true); assert.equal(L.allHistory, false);
    assert.equal(L.rows.length, 2);
  });
}

for (const app of APPS.filter((a) => a !== 'water/index.html')) {
  for (const mm of [58, 80]) {
    test(`${app}: statement and invoice fit a ${mm} mm roll (no line wider than the paper)`, async () => {
      const b = await boot(app, { wait: 400 }); opened.push(b); const { w } = b; const d = w.document;
      w.localStorage.setItem('pos_device_paper_mm', String(mm));
      w.eval(`
        customers = [{ id: 'c1', name: 'Wanjiru Muthoni Kamau-Otieno', phone: '${PH}', tokens: 0, createdAt: 1 }];
        salesLog = []; returns = []; debts = [];
        bills = [{ id: 'B1', refNumber: 'BL-LONG-REFERENCE-12345', timestamp: '${day(3)}', customerPhone: '${PH}', items: [{ name: 'Portland cement 50kg extra long product name', price: 1234567.5, qty: 3 }], amountPaid: 1000, paymentHistory: [{ id: 'p', timestamp: '${day(4)}', amount: 1000, method: 'mpesa', reference: 'QXA12345' }] }];
        currentCustomerProfileId = 'c1'; currentCustomerStatementPeriod = 'full';
      `);
      const cols = w.eval('getPaperCols()');
      assert.ok(cols >= 30 && cols <= 50, 'cols for ' + mm + ' mm = ' + cols);
      for (const fn of ['printCustomerStatement', 'printCustomerInvoice']) {
        w.eval(fn + '()');
        const pre = d.querySelector('#sales-report-body pre.cl-thermal'); assert.ok(pre, fn + ': narrow layout used');
        const lines = pre.textContent.split('\n');
        assert.ok(lines.every((l) => l.length <= cols), fn + ': longest line ' + Math.max(...lines.map((l) => l.length)) + ' > ' + cols);
        assert.match(pre.textContent, /3,703,702\.50|3,702,701\.50/);
      }
    });
  }
}
