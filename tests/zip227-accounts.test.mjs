import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';
// zip 227 — the Accounts books: built from sales / bills / expenses / trade credits, always balanced, correct statements, ageing, bank rec, depreciation.
const it = (price, qty, w, extra = {}) => ({ code: 'X', name: 'Thing', price, qty, wholesalePrice: w, unit: 'pcs', ...extra });
const SALES = [
  { id: 's1', timestamp: '2026-09-01T08:00:00+03:00', paymentMethod: 'cash', cashAmount: 200, mpesaAmount: 0, cardAmount: 0, items: [it(100, 2, 60)] },
  { id: 's2', timestamp: '2026-09-02T09:00:00+03:00', paymentMethod: 'mpesa', cashAmount: 0, mpesaAmount: 300, cardAmount: 0, items: [it(300, 1, 200)] },
  { id: 's3', timestamp: '2026-09-03T09:00:00+03:00', paymentMethod: 'cash', cashAmount: 999, items: [it(999, 1, 1)], voided: true },
  { id: 'p1', billId: 'b1', timestamp: '2026-09-01T10:00:00+03:00', paymentMethod: 'cash', cashAmount: 400, items: [it(400, 1, 0, { unit: 'payment', isPayment: true })] },
  { id: 'p2', billId: 'b1', timestamp: '2026-09-20T10:00:00+03:00', paymentMethod: 'mpesa', mpesaAmount: 300, items: [it(300, 1, 0, { unit: 'payment', isPayment: true })] },
];
const BILLS = [{ id: 'b1', customerName: 'Jane', timestamp: '2026-09-01T10:00:00+03:00', amountPaid: 700, items: [it(1000, 1, 600)] }];
const EXP = [
  { id: 'e1', timestamp: '2026-09-05T10:00:00+03:00', category: 'Rent', amount: 500, description: 'Shop rent' },
  { id: 'e2', timestamp: '2026-09-06T10:00:00+03:00', category: 'Restock', amount: 800, paymentMethod: 'mpesa' },
];
const TC = [
  { id: 't1', timestamp: '2026-09-02T10:00:00+03:00', partyName: 'Acme Supplies', direction: 'i_owe', amount: 1000, status: 'open' },
  { id: 't2', timestamp: '2026-09-02T10:00:00+03:00', partyName: 'Bob', direction: 'owed_to_me', amount: 200, status: 'settled', settledAt: '2026-09-10T10:00:00+03:00' },
];
const storage = { pos_biz_name: 'Duka', pos_sales_log: JSON.stringify(SALES), pos_bills: JSON.stringify(BILLS), pos_expenses: JSON.stringify(EXP), pos_trade_credits: JSON.stringify(TC) };
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));

test('K1: every posting balances; trial balance and balance sheet agree; statements add up', async () => {
  const { w, errors, close } = await boot('index.html', { storage, wait: 3500 });
  w.eval("Accounts.engine.store().assets.push({ id: 'fa1', name: 'Freezer', date: '2026-01-15', cost: 12000, lifeYears: 5, salvage: 0, paidFrom: '3000' })");
  const L = J(w, "Accounts.engine.build({ upto: '2026-09-30' })");
  L.forEach((e) => assert.equal(Math.round(e.lines.reduce((s, l) => s + l.dr - l.cr, 0) * 100), 0, 'balanced: ' + e.id));
  assert.ok(!L.some((e) => e.id === 'S:s3'), 'voided sale is not in the books');
  const tb = J(w, "Accounts.engine.trialBalance(Accounts.engine.build({ upto: '2026-09-30' }), '2026-09-30')");
  assert.equal(tb.balanced, true); assert.equal(tb.dr, tb.cr);
  const is = J(w, "Accounts.engine.incomeStatement(Accounts.engine.build({ upto: '2026-09-30' }), '2026-01-01', '2026-09-30')");
  assert.equal(is.income.total, 200 + 300 + 1000 + 200, 'sales + bill + bob owes');                    // 1700
  assert.equal(is.cogs.total, 120 + 200 + 600 + 1000, 'cogs incl. purchases on credit');               // 1920
  const dep = J(w, "Accounts.engine.depUpTo(Accounts.engine.store().assets[0], '2026-09-30')");
  assert.equal(dep.length, 8); assert.equal(dep[0].amount, 200);
  assert.equal(is.expenses.total, 500 + 1600, 'rent + 8 months depreciation');
  assert.equal(is.net, 1700 - 1920 - 2100);
  const bs = J(w, "Accounts.engine.balanceSheet(Accounts.engine.build({ upto: '2026-09-30' }), '2026-09-30')");
  assert.equal(bs.check, 0, 'assets = liabilities + equity');
  assert.deepEqual(errors, []); close();
});

test('K2: ageing, cash flow and the ledger', async () => {
  const { w, errors, close } = await boot('index.html', { storage, wait: 3500 });
  const ar = J(w, "Accounts.engine.ageing('ar', '2026-10-31')");
  assert.equal(ar.total, 300, 'Jane still owes 1000 - 400 - 300'); assert.equal(ar.rows[0].name, 'Jane'); assert.equal(ar.rows[0].b[1], 300, '60 days old -> 31-60 bucket');
  const ap = J(w, "Accounts.engine.ageing('ap', '2026-10-31')"); assert.equal(ap.total, 1000);
  const cf = J(w, "Accounts.engine.cashFlow(Accounts.engine.build({ upto: '2026-09-30' }), '2026-09-01', '2026-09-30')");
  // cash in: 200 + 300 + 400 + 300 + 200(bob) ; out: rent 500 + restock 800 -> 1400 - 1300 = +100
  assert.equal(cf.net, 200 + 300 + 400 + 300 + 200 - 500 - 800); assert.equal(cf.close, cf.open + cf.net);
  const led = J(w, "Accounts.engine.accountLedger(Accounts.engine.build({ upto: '2026-09-30' }), '1100', '2026-09-01', '2026-09-30')");
  assert.equal(led.close, 300, 'receivable control account = open bills');
  assert.deepEqual(errors, []); close();
});

test('K3: bank / M-Pesa reconciliation matches statement lines and reaches a zero difference', async () => {
  const { w, errors, close } = await boot('index.html', { storage, wait: 3500 });
  w.eval("(function () { var bd = Accounts.engine.store(); bd.bank = { '1020': { cleared: {}, stmt: [{ id: 'x1', date: '2026-09-02', desc: 'Pay', amount: 300 }, { id: 'x2', date: '2026-09-21', desc: 'Pay', amount: 300 }], balance: 600, asAt: '' } }; })()");
  const n = w.eval("Accounts.engine.autoMatch(Accounts.engine.build({ upto: '2026-09-30' }), '1020', '2026-09-30')");
  assert.equal(n, 2);
  const rec = J(w, "Accounts.engine.reconcile(Accounts.engine.build({ upto: '2026-09-30' }), '1020', '2026-09-30')");
  assert.equal(rec.cleared, 600); assert.equal(rec.diff, 0); assert.equal(rec.book, 300 + 300 - 800, 'two receipts less the restock paid by M-Pesa');
  assert.deepEqual(errors, []); close();
});

test('K4: the Accounts tab is in the shop apps, opens, and every report renders and prints', async () => {
  for (const app of APPS.filter((a) => !['water/index.html', 'owner/index.html'].includes(a))) {
    const { w, d, errors, close } = await boot(app, { storage: { pos_biz_name: 'Duka' }, wait: 4000 });
    assert.ok(d.getElementById('accounts-tab-btn'), app + ' has the Accounts button');
    for (const v of ['overview', 'ledger', 'tb', 'is', 'bs', 'cf', 'ar', 'ap', 'bank', 'fa', 'jr']) { w.eval(`Accounts.go('${v}')`); assert.ok(d.getElementById('acc-body').innerHTML.length > 50, app + ' ' + v); assert.doesNotMatch(d.getElementById('acc-body').textContent, /Could not build/, app + ' ' + v); }
    assert.deepEqual(errors, []); close();
  }
});
