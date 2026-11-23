import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage } from './e2e-harness.mjs';

// zip 321: supplier management. Real apps in jsdom; every number checked against the records and the books (Accounts.engine.build).
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
const INV = JSON.stringify([
  { code: 'FLR', type: 'item', name: 'Flour 2kg', category: 'Groceries', price: 250, wholesalePrice: 180, qty: 5, unit: 'pcs', vatCategory: 'A' },
  { code: 'OIL', type: 'item', name: 'Cooking oil 1L', category: 'Groceries', price: 400, wholesalePrice: 300, qty: 2, unit: 'pcs', vatCategory: 'A' },
]);
const row = (code, name, qty, cost) => ({ rowId: 1 + Math.floor(Math.random() * 1e6), code, name, qty: String(qty), cost: String(cost), sellPrice: '', wholesaleSell: '', unit: 'pcs' });
const quiet = (w) => w.eval("window.__t = []; showToast = function (m) { window.__t.push(m); }; window.print = () => {}; window.confirm = () => true; window.alert = () => {}; try { triggerAutoPrintReport = function () {}; } catch (e) {}");
function addSupplier(w, name, extra = {}) { return J(w, `SupplierLedger.saveSupplier(${JSON.stringify({ name, phone: '07' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), ...extra })}).supplier.id`); }
function restock(w, rows, supId, { mode = 'full', paid = '', method = 'cash', ref = '' } = {}) {
  w.eval(`renderSupplierDropdowns(); document.getElementById('restock-supplier-select').value = ${JSON.stringify(supId || '')}; document.getElementById('restock-reference-input').value = ${JSON.stringify(ref)};
    document.querySelector('[name="sup-pay"][value="${mode}"]').checked = true; document.getElementById('sup-paid-amount').value = ${JSON.stringify(String(paid))}; document.getElementById('sup-paid-method').value = '${method}';
    restockDraft = ${JSON.stringify(rows)}; renderRestockRows(); window.__lastRestockAt = 0; completeRestock();`);
}
const qty = (w, code) => J(w, `inventory.find(p => p.code === '${code}').qty`);
const bal = (w, id) => J(w, `SupplierLedger.balanceOf('${id}')`);
const restockExpenses = (w) => J(w, "expenses.filter(e => e.category === 'Restock')");
// the books: balance per account for every entry built from the records
const books = (w) => J(w, "(function(){ const b = {}; let dr = 0, cr = 0; Accounts.engine.build({}).forEach(e => e.lines.forEach(l => { b[l.a] = Math.round(((b[l.a] || 0) + l.dr - l.cr) * 100) / 100; dr += l.dr; cr += l.cr; })); b.__dr = Math.round(dr * 100) / 100; b.__cr = Math.round(cr * 100) / 100; return b; })()");
async function shop(t, app = 'index.html', storage = {}) {
  const b = await boot(app, { storage: { pos_inventory: INV, ...storage }, wait: 1200 }); t.after(() => { try { b.close(); } catch (e) { /* closed */ } });
  quiet(b.w); return b;
}

test('1-4: KSh 20,000 on credit; then 5,000 paid at the restock; 10,000 later; the last 5,000 - stock, payable, cash, expenses and books all exact', async (t) => {
  const { w } = await shop(t);
  const s = addSupplier(w, 'Bidco Kenya', { terms: '30' });
  const b0 = books(w);
  // 1) fully on credit
  restock(w, [row('FLR', 'Flour 2kg', 100, 200)], s, { mode: 'credit', ref: 'INV-1' });
  assert.equal(qty(w, 'FLR'), 105, 'stock in at once');
  assert.equal(bal(w, s), 20000, 'KSh 20,000 owed');
  assert.equal(restockExpenses(w).length, 0, 'no expense: no money left the shop');
  let b = books(w);
  assert.equal(b['1200'] - (b0['1200'] || 0), 20000, 'stock value up 20,000'); assert.equal(b['2000'], -20000, 'payable 20,000');
  assert.equal((b['1010'] || 0) - (b0['1010'] || 0), 0, 'cash unchanged'); assert.equal((b['1020'] || 0) - (b0['1020'] || 0), 0, 'M-Pesa unchanged');
  const doc = J(w, "SupplierLedger.docs().find(d => d.reference === 'INV-1')");
  assert.equal(doc.amount, 20000); assert.equal(doc.lines[0].qty, 100); assert.ok(doc.dueDate, 'due date from the 30-day terms');
  // 2) a second supplier: 20,000 with 5,000 paid now by M-Pesa
  const s2 = addSupplier(w, 'Mill Ltd');
  restock(w, [row('OIL', 'Cooking oil 1L', 50, 400)], s2, { mode: 'part', paid: 5000, method: 'mpesa', ref: 'INV-2' });
  assert.equal(qty(w, 'OIL'), 52);
  assert.equal(bal(w, s2), 15000, '15,000 still owed');
  let ex = restockExpenses(w);
  assert.equal(ex.length, 1, 'one record of the 5,000 paid'); assert.equal(ex[0].amount, 5000); assert.equal(ex[0].paymentMethod, 'mpesa'); assert.equal(ex[0].supplierPay, true);
  b = books(w);
  assert.equal((b['1020'] || 0) - (b0['1020'] || 0), -5000, 'M-Pesa down exactly 5,000');
  assert.equal(b['2000'], -35000, 'payables: 20,000 + 15,000');
  // 3) 10,000 later (cash)
  const r3 = J(w, `SupplierLedger.recordPayment({ supplierId: '${s2}', amount: 10000, method: 'cash', reference: 'C-1', key: 'k3' })`);
  assert.equal(r3.ok, true);
  assert.equal(bal(w, s2), 5000, '5,000 left');
  assert.equal(qty(w, 'OIL'), 52, 'no stock added');
  assert.equal(J(w, "SupplierLedger.docs().filter(d => d.kind === 'supplier_restock').length"), 2, 'no new purchase');
  assert.equal(restockExpenses(w).length, 2, 'the payment is one record, nothing else');
  // 4) the last 5,000
  J(w, `SupplierLedger.recordPayment({ supplierId: '${s2}', amount: 5000, method: 'bank', key: 'k4' })`);
  const inv2 = J(w, "SupplierLedger.docs().find(d => d.reference === 'INV-2')");
  assert.equal(J(w, `SupplierLedger.outstanding(SupplierLedger.docs().find(d => d.reference === 'INV-2'))`), 0); assert.equal(inv2.status, 'settled');
  assert.equal(J(w, `SupplierLedger.allPayments('${s2}').length`), 3, 'all three payments kept');
  assert.equal(bal(w, s2), 0);
  b = books(w);
  assert.equal(b.__dr, b.__cr, 'the books balance');
  assert.equal(b['2000'], -20000, 'only Bidco is owed now');
  assert.equal((b['1010'] || 0) - (b0['1010'] || 0), -10000); assert.equal((b['1030'] || 0) - (b0['1030'] || 0), -5000);
  assert.equal(b['1200'] - (b0['1200'] || 0), 40000, 'stock value: both deliveries, once each');
  // more than owed is refused (no silent advance)
  const over = J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 25000, key: 'k5' })`);
  assert.equal(over.ok, false); assert.match(over.error, /more than what is owed/);
});

test('5: several invoices - a payment to chosen invoices, and oldest-first when none is chosen', async (t) => {
  const { w } = await shop(t);
  const s = addSupplier(w, 'Unga Ltd');
  restock(w, [row('FLR', 'Flour 2kg', 10, 300)], s, { mode: 'credit', ref: 'A' });   // 3,000
  restock(w, [row('OIL', 'Cooking oil 1L', 5, 400)], s, { mode: 'credit', ref: 'B' }); // 2,000
  const id = (ref) => J(w, `SupplierLedger.docs().find(d => d.reference === '${ref}').id`);
  const out = (ref) => J(w, `SupplierLedger.outstanding(SupplierLedger.docs().find(d => d.reference === '${ref}'))`);
  const r = J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 2500, allocations: [{ id: '${id('B')}', amount: 2000 }, { id: '${id('A')}', amount: 500 }], key: 'p1' })`);
  assert.equal(r.ok, true);
  assert.equal(out('A'), 2500); assert.equal(out('B'), 0); assert.equal(bal(w, s), 2500);
  // allocations must add up, and never more than an invoice's balance
  assert.equal(J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 100, allocations: [{ id: '${id('A')}', amount: 50 }], key: 'p2' }).ok`), false);
  assert.equal(J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 3000, allocations: [{ id: '${id('A')}', amount: 3000 }], key: 'p3' }).ok`), false);
  // a third invoice; 1,000 with no choice goes to the OLDEST outstanding (A)
  restock(w, [row('FLR', 'Flour 2kg', 1, 700)], s, { mode: 'credit', ref: 'C' });
  J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 1000, key: 'p4' })`);
  assert.equal(out('A'), 1500); assert.equal(out('C'), 700); assert.equal(bal(w, s), 2200);
});

test('6: returning KSh 2,000 of goods - stock off, owed less, once only; never more than bought or in stock; on a paid invoice it is a credit', async (t) => {
  const { w } = await shop(t);
  const s = addSupplier(w, 'Kapa Oil');
  restock(w, [row('OIL', 'Cooking oil 1L', 20, 200)], s, { mode: 'credit', ref: 'R1' });   // 4,000
  const inv = J(w, "SupplierLedger.docs().find(d => d.reference === 'R1').id");
  assert.equal(qty(w, 'OIL'), 22);
  const r = J(w, `SupplierLedger.recordReturn({ invoiceId: '${inv}', lines: [{ code: 'OIL', qty: 10 }], reason: 'damaged', creditNote: 'CN-9', key: 'rt1' })`);
  assert.equal(r.ok, true); assert.equal(r.amount, 2000);
  assert.equal(qty(w, 'OIL'), 12, '10 off the stock');
  assert.equal(bal(w, s), 2000); assert.equal(J(w, `SupplierLedger.outstanding(SupplierLedger.docs().find(d => d.id === '${inv}'))`), 2000);
  const mv = J(w, "stockMovementLog.filter(m => m.code === 'OIL' && m.delta < 0)"); assert.equal(mv.length, 1); assert.match(mv[0].reason, /Returned to supplier Kapa Oil/);
  // the same return again (retry): nothing more
  J(w, `SupplierLedger.recordReturn({ invoiceId: '${inv}', lines: [{ code: 'OIL', qty: 10 }], reason: 'damaged', key: 'rt1' })`);
  assert.equal(qty(w, 'OIL'), 12); assert.equal(bal(w, s), 2000);
  // more than is left to return from that restock
  assert.match(J(w, `SupplierLedger.recordReturn({ invoiceId: '${inv}', lines: [{ code: 'OIL', qty: 11 }], reason: 'x', key: 'rt2' }).error`), /Only 10/);
  // more than is in stock (sold already)
  w.eval("inventory.find(p => p.code === 'OIL').qty = 3");
  assert.match(J(w, `SupplierLedger.recordReturn({ invoiceId: '${inv}', lines: [{ code: 'OIL', qty: 5 }], reason: 'x', key: 'rt3' }).error`), /Only 3/);
  // pay it off, then return 1 more: a credit with the supplier
  J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 2000, key: 'pp' })`);
  J(w, `SupplierLedger.recordReturn({ invoiceId: '${inv}', lines: [{ code: 'OIL', qty: 1 }], reason: 'leaking', key: 'rt4' })`);
  assert.equal(bal(w, s), -200, 'a 200 credit with the supplier');
  const b = books(w); assert.equal(b.__dr, b.__cr);
  assert.equal(b['2000'], 200, 'accounts payable shows the credit (debit balance)');
});

test('7: a double tap, a retried payment or a retried return records ONE thing', async (t) => {
  const { w, d } = await shop(t);
  const s = addSupplier(w, 'Brookside');
  // the confirmation window: two taps on Confirm
  w.eval(`renderSupplierDropdowns(); document.getElementById('restock-supplier-select').value = '${s}'; document.querySelector('[name="sup-pay"][value="credit"]').checked = true; restockDraft = ${JSON.stringify([row('FLR', 'Flour 2kg', 10, 100)])}; renderRestockRows(); window.__lastRestockAt = 0; supConfirmRestock();`);
  assert.match(d.getElementById('sup-modal').textContent, /Confirm the restock/); assert.match(d.getElementById('sup-modal').textContent, /Owed to the supplier\s*KES 1,000\.00/);
  const go = d.getElementById('cr-go'); go.click(); go.click();
  w.eval('completeRestock(); completeRestock();');                          // and two more calls in the same instant
  assert.equal(qty(w, 'FLR'), 15, 'stocked once');
  assert.equal(J(w, "SupplierLedger.docs().filter(d => d.kind === 'supplier_restock').length"), 1, 'one invoice');
  assert.equal(bal(w, s), 1000);
  for (let i = 0; i < 3; i++) J(w, `SupplierLedger.recordPayment({ supplierId: '${s}', amount: 400, key: 'same-key' })`);
  assert.equal(restockExpenses(w).length, 1, 'one payment'); assert.equal(bal(w, s), 600);
});

test('8: recorded offline, sent when back online, sent again by a retry: the server holds exactly one invoice, one payment, one stock movement; the other till agrees', async (t) => {
  const s = makeServer();
  let online = false;
  const net = (url, o) => (online ? s.fetch(url, o) : Promise.reject(new Error('offline')));
  const a = await openDevice('index.html', { ...s, fetch: net }, { pos_inventory: INV }, 1200); quiet(a.w);
  t.after(() => { try { a.close(); } catch (e) { /* closed */ } });
  const sup = addSupplier(a.w, 'Offline Supplies');
  restock(a.w, [row('FLR', 'Flour 2kg', 40, 500)], sup, { mode: 'part', paid: 6000, method: 'mpesa', ref: 'OFF-1' });   // 20,000, 6,000 paid
  J(a.w, `SupplierLedger.recordPayment({ supplierId: '${sup}', amount: 4000, key: 'off-pay' })`);
  assert.equal(bal(a.w, sup), 10000);
  online = true;
  await a.w.eval('pushNow()'); await a.w.eval('pushNow()');                     // sent, then sent again
  const st = s.serverState();
  assert.equal((st.tradeCredits || []).filter((x) => x.kind === 'supplier_restock').length, 1, 'one invoice on the server');
  assert.equal((st.expenses || []).filter((x) => x.supplierPay).length, 2, 'the two payments, once each');
  assert.equal((st.stockMovementLog || []).filter((m) => m.code === 'FLR' && m.delta === 40).length, 1, 'one stock movement');
  assert.equal((st.suppliers || []).filter((x) => x.name === 'Offline Supplies').length, 1);
  // another till of the same shop
  const st2 = deviceStorage(a.w); delete st2.pos_device_id; delete st2.pos_till_no;
  const b = await openDevice('index.html', s, { pos_inventory: INV }, 1500); quiet(b.w);
  t.after(() => { try { b.close(); } catch (e) { /* closed */ } });
  await b.w.eval('pullState()');
  assert.equal(bal(b.w, sup), 10000, 'the other till sees the same balance');
  assert.equal(qty(b.w, 'FLR'), 45);
});

test('9, 14: the statement, restock, outstanding and payment reports agree with the ledger and the books', async (t) => {
  const { w, d } = await shop(t);
  const a = addSupplier(w, 'Alpha Wholesalers', { terms: '7' }), bb = addSupplier(w, 'Beta Distributors');
  J(w, `SupplierLedger.recordOpening({ supplierId: '${a}', amount: 1500, date: '2026-01-05', key: 'op1' })`);
  restock(w, [row('FLR', 'Flour 2kg', 10, 200)], a, { mode: 'credit', ref: 'A-1' });            // 2,000
  restock(w, [row('OIL', 'Cooking oil 1L', 10, 300)], bb, { mode: 'part', paid: 1000, ref: 'B-1' }); // 3,000, 1,000 paid
  restock(w, [row('FLR', 'Flour 2kg', 5, 100)], a, { mode: 'full', ref: 'A-2' });                // 500 paid
  J(w, `SupplierLedger.recordPayment({ supplierId: '${a}', amount: 2000, key: 'pa' })`);         // opening 1,500 first, then 500 of A-1
  J(w, `SupplierLedger.recordAdjust({ supplierId: '${bb}', sign: -1, amount: 250, reason: 'discount given later', key: 'adj' })`);
  const balA = bal(w, a), balB = bal(w, bb);
  assert.equal(balA, 1500); assert.equal(balB, 1750);
  const stA = J(w, `SupplierReports.statement({ supplierId: '${a}' }).totals`);
  assert.equal(stA.closing, balA, 'statement closing = balance'); assert.equal(stA.opening, 0);
  assert.equal(Math.round((stA.opening + stA.owed - stA.paid) * 100) / 100, stA.closing, 'opening + owed - paid = closing');
  const stA2 = J(w, `SupplierReports.statement({ supplierId: '${a}', from: '2026-02-01' }).totals`);
  assert.equal(stA2.opening, 1500, 'a period starts with the balance brought forward'); assert.equal(stA2.closing, balA);
  const ou = J(w, 'SupplierReports.outstanding().totals'); assert.equal(ou.total, Math.round((balA + balB) * 100) / 100, 'outstanding report = sum of balances');
  const rs = J(w, 'SupplierReports.restocks({}).totals');
  assert.equal(rs.total, 5500); assert.equal(rs.paidNow, 1500); assert.equal(rs.outstanding, 1500 + 2000, 'A-1 1,500 + B-1 2,000 (the 250 correction is supplier-level)');
  const py = J(w, 'SupplierReports.payments({}).totals'); assert.equal(py.total, 1000 + 500 + 2000);
  // CSV totals match the screen
  const csv = J(w, 'SupplierReports.outstanding().csv').trim().split('\n').pop().split(',');
  assert.equal(Number(csv[csv.length - 1]), ou.total);
  // the books: payables = sum of balances; debits = credits
  const b = books(w); assert.equal(b.__dr, b.__cr); assert.equal(-b['2000'], Math.round((balA + balB) * 100) / 100);
  // the report window prints the business name, the period and the table
  w.eval("businessName = 'Mama Mboga Stores'; supOpenReport('outstanding')");
  assert.match(d.getElementById('sup-print').textContent, /Mama Mboga Stores[\s\S]*Outstanding supplier debt[\s\S]*Total payables/);
});

test('10: existing behaviour - a restock with no supplier is an expense as before; profit takes stock off once (cost of goods), other expenses still count; customer debts apart', async (t) => {
  const { w, d } = await shop(t);
  restock(w, [row('FLR', 'Flour 2kg', 10, 100)], '', { mode: 'full' });
  assert.equal(restockExpenses(w).length, 1); assert.equal(restockExpenses(w)[0].amount, 1000);
  assert.equal(qty(w, 'FLR'), 15);
  // on credit / part paid without a supplier: refused, nothing stocked
  restock(w, [row('FLR', 'Flour 2kg', 10, 100)], '', { mode: 'credit' });
  assert.equal(qty(w, 'FLR'), 15); assert.match(J(w, 'window.__t').pop(), /Choose the supplier/);
  // profit: a rent expense counts, the restock does not count again
  w.eval("expenses.push({ id: 'rent1', timestamp: new Date().toISOString(), category: 'Rent', description: 'rent', amount: 700 }); salesLog.push({ id: 'S1', refNumber: 'R1', timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 250, paid: true, items: [{ code: 'FLR', name: 'Flour 2kg', qty: 1, price: 250, wholesalePrice: 100 }] }); try { document.querySelector('.tab-link[data-tab=\"profits-tab\"]').click(); } catch (e) {} renderProfitReport();");
  assert.equal(String(d.getElementById('profit-expenses-total').innerText).replace(/[^0-9.]/g, ''), '700.00', 'only the rent (the page writes innerText)');
  assert.match(d.querySelector('#profits-tab, body').textContent, /excl\. stock bought/);
  const rep = J(w, "reportBuildExpenses({ from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) }).html");
  assert.match(rep, /Stock bought/);
  // customer debts and supplier debts stay apart
  w.eval("debts.push({ id: 'cd1', customerName: 'Otieno', amount: 900, createdAt: new Date().toISOString(), payments: [] })");
  const s = addSupplier(w, 'Gamma'); restock(w, [row('OIL', 'Cooking oil 1L', 1, 600)], s, { mode: 'credit' });
  w.eval('renderDebtsTab()');
  assert.match(d.getElementById('debts-open-total').textContent, /900/); assert.match(d.getElementById('sup-debts-total').textContent, /600\.00/);
});

test('13: an existing shop upgraded - suppliers saved as {id, name, phone} and zip 319 credit restocks / payments keep their balances; nothing is lost', async (t) => {
  const now = Date.now();
  const legacy = {
    pos_suppliers: JSON.stringify([{ id: 's1', name: 'Old Supplier', phone: '0700000001' }, { id: 's2', name: 'Never Used', phone: '' }]),
    pos_trade_credits: JSON.stringify([
      { id: 'rc-OLD1', kind: 'supplier_restock', direction: 'i_owe', supplierId: 's1', partyName: 'Old Supplier', amount: 3000, timestamp: new Date(now - 86400000 * 3).toISOString(), status: 'open', settledAt: null, payments: [{ id: 'PAY1', at: new Date(now - 86400000).toISOString(), amount: 1000, method: 'cash' }] },
      { id: 'T-OTHER', partyName: 'Neighbour', direction: 'i_owe', description: 'borrowed', amount: 500, status: 'open', timestamp: new Date().toISOString() }]),
    pos_expenses: JSON.stringify([{ id: 'PAY1', timestamp: new Date(now - 86400000).toISOString(), category: 'Restock', amount: 1000, paymentMethod: 'cash', supplierDebtId: 'rc-OLD1' }, { id: 'E-OLD', timestamp: new Date(now - 86400000 * 9).toISOString(), category: 'Restock', amount: 4000, auto: true }]),
  };
  const { w, d } = await shop(t, 'index.html', legacy);
  assert.equal(bal(w, 's1'), 2000, 'the zip 319 balance');
  assert.equal(J(w, 'expenses.length'), 2, 'old expenses untouched'); assert.equal(J(w, 'suppliers.length'), 2);
  w.eval("document.querySelector('.tab-link[data-tab=\"suppliers-tab\"]').click(); renderSuppliersTab()");
  assert.match(d.getElementById('sup-table').textContent, /Old Supplier[\s\S]*2,000\.00/);
  // the other trade credit stays in Trade Credits; the supplier invoice is in Suppliers
  w.eval('renderTradeCreditsTab()');
  assert.match(d.getElementById('trade-credits-open-table').textContent, /Neighbour/); assert.doesNotMatch(d.getElementById('trade-credits-open-table').textContent, /Old Supplier/);
  // removing a supplier with history makes it inactive; one with none is removed as before
  w.eval("removeSupplier('s1'); removeSupplier('s2')");
  assert.equal(J(w, "suppliers.find(s => s.id === 's1').active"), false); assert.equal(J(w, "suppliers.some(s => s.id === 's2')"), false);
  assert.equal(bal(w, 's1'), 2000, 'an inactive supplier keeps its history and balance');
  assert.doesNotMatch(J(w, 'supplierOptionsHtml("")'), /Old Supplier/, 'hidden from the restock picker');
});

test('profiles: required name, duplicate warning by name or phone, opening balance is not stock or a purchase', async (t) => {
  const { w, d } = await shop(t);
  addSupplier(w, 'Bidco Kenya Ltd', { phone: '0711222333' });
  assert.equal(J(w, "SupplierLedger.saveSupplier({ name: '  ' }).ok"), false);
  assert.equal(J(w, "SupplierLedger.similar({ name: 'bidco kenya ltd' }).length"), 1);
  assert.equal(J(w, "SupplierLedger.similar({ name: 'Other', phone: '+254 711 222 333' }).length"), 1, 'same phone, other format');
  // through the form: first Save warns, the second Save adds
  w.eval("supOpenProfile(null)");
  d.getElementById('sp-name').value = 'Bidco Kenya'; d.getElementById('sp-name').dispatchEvent(new w.Event('input'));
  d.getElementById('sp-open').value = '2500'; d.getElementById('sp-save').click();
  assert.match(d.getElementById('sp-dup').textContent, /Similar supplier/); assert.equal(J(w, 'suppliers.length'), 1);
  d.getElementById('sp-save').click();
  assert.equal(J(w, 'suppliers.length'), 2);
  const id = J(w, "suppliers.find(s => s.name === 'Bidco Kenya').id");
  assert.equal(bal(w, id), 2500, 'the opening balance is owed');
  assert.equal(J(w, "inventory.reduce((s, p) => s + p.qty, 0)"), 7, 'no stock'); assert.equal(restockExpenses(w).length, 0, 'no expense');
  assert.equal(J(w, "SupplierLedger.docs().filter(d => d.kind === 'supplier_restock').length"), 0, 'no purchase');
  const b = books(w); assert.equal(b['3050'], 2500); assert.equal(b['2000'], -2500);
});

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: the Suppliers tab is there (button, permission, side menu) and a part-paid restock records once`, async (t) => {
    const { w, d } = await shop(t, app);
    assert.ok(d.querySelector('.tab-link[data-tab="suppliers-tab"]'), 'tab button');
    assert.ok(J(w, "LOCKABLE_TABS.some(x => x.id === 'suppliers-tab')"), 'can be given to staff');
    const s = addSupplier(w, 'Supplier ' + app);
    restock(w, [row('FLR', 'Flour 2kg', 10, 100)], s, { mode: 'part', paid: 400 });
    assert.equal(bal(w, s), 600); assert.equal(restockExpenses(w).length, 1); assert.equal(restockExpenses(w)[0].amount, 400);
    w.eval("document.querySelector('.tab-link[data-tab=\"suppliers-tab\"]').click()");
    assert.match(d.getElementById('sup-root').textContent, /Owed to suppliers now[\s\S]*600\.00/);
    w.eval(`supOpenSupplier('${s}')`);
    assert.match(d.getElementById('sup-root').textContent, /Owed now[\s\S]*600\.00/);
  });
}

test('11: one shop never sees another shop’s suppliers, invoices or payments (each shop is its own database)', { skip: !(await import('./do-fake.mjs')).hasSqlite }, async () => {
  const { makeLiveServer } = await import('./live-sync-harness.mjs');
  const s = await makeLiveServer();
  const push = (shop, body) => s.env.SHOP_STORE.get(shop).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body, serverNow: Date.now(), _shop: shop }) });
  await push('C1', { suppliers: [{ id: 'sup-A', name: 'Shop One Supplier', updatedAt: Date.now() }], tradeCredits: [{ id: 'rc-1', kind: 'supplier_restock', direction: 'i_owe', supplierId: 'sup-A', amount: 9000, timestamp: new Date().toISOString(), status: 'open' }], expenses: [{ id: 'sp-1', category: 'Restock', amount: 1000, supplierPay: true, supplierId: 'sup-A', allocations: [{ id: 'rc-1', amount: 1000 }], timestamp: new Date().toISOString() }] });
  await push('C2', { suppliers: [{ id: 'sup-B', name: 'Shop Two Supplier', updatedAt: Date.now() }] });
  const state = async (shop) => JSON.parse(await (await s.env.SHOP_STORE.get(shop).fetch('https://shop-store/state', { method: 'POST', body: '{}' })).text());
  const one = await state('C1'), two = await state('C2');
  assert.deepEqual((one.suppliers || []).map((x) => x.name), ['Shop One Supplier']);
  assert.deepEqual((two.suppliers || []).map((x) => x.name), ['Shop Two Supplier'], 'shop two sees only its own supplier');
  assert.equal((two.tradeCredits || []).length, 0); assert.equal((two.expenses || []).filter((x) => x.supplierPay).length, 0);
});
