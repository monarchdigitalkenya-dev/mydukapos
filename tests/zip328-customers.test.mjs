// zip 328 (prompt 8): one customer = one profile; receipts + bills carry the customer's details; contracts issue stock exactly once.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot, until } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, openingStock: { qty: 100, costPrice: 50, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 40, wholesalePrice: 20, qty: 5, unit: 'pcs', vatCategory: 'A' },
  { code: 'D', type: 'item', name: 'Soda crate', price: 600, wholesalePrice: 500, qty: 10, pieceQty: 4, dualUnit: true, unitsPerBox: 24, pieceCode: 'D-P', piecePrice: 30, unit: 'pcs', vatCategory: 'A' },
];
const PRINTER = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* closed */ } } });
const settled = (d) => until(() => !d.w.eval('window.__pushQueued') && !(d.w.eval('window.__pushInFlight') > 0));
const one = async (extra = {}) => { const b = await boot('index.html', { wait: 400, storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz', ...extra } }); opened.push(b); b.w.eval(PRINTER); return b; };
const ev = (b, code) => b.w.eval(code);
const J = (b, code) => JSON.parse(b.w.eval(`JSON.stringify(${code})`));
const qty = (b, c = 'A') => b.w.eval(`inventory.find(p => p.code === '${c}').qty`);
const pieces = (b, c = 'D') => b.w.eval(`inventory.find(p => p.code === '${c}').pieceQty`);
async function sale(b, phone, name, idn) {
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  b.d.getElementById('cash-tendered-input').value = '1000';
  b.d.getElementById('sms-checkout-phone-input').value = phone || '';
  const nm = b.d.getElementById('cp-co-name'); if (nm) nm.value = name || '';
  const id = b.d.getElementById('cp-co-id'); if (id) id.value = idn || '';
  await b.w.eval('checkoutCart()');
}

// ------------------------------------------------------------------------------------------------ customers
test('1. a customer with five sales has ONE profile; every sale is linked to it', async () => {
  const b = await one();
  for (let i = 0; i < 5; i++) await sale(b, '0712 345 678', 'Jane Wanjiru');
  assert.equal(J(b, 'customers.filter(c => !c._deleted)').length, 1, 'one profile');
  const c = J(b, 'customers[0]');
  assert.ok(c.id, 'stable id');
  const sales = J(b, 'salesLog');
  assert.equal(sales.length, 5);
  assert.ok(sales.every((s) => s.customerId === c.id), 'all five linked to the one profile');
  const h = J(b, `customerTransactions(customers[0], { limit: 50 })`);
  assert.equal(h.total, 5);
});

test('2. search finds a customer by name, normalized phone and ID number', async () => {
  const b = await one();
  ev(b, `upsertCustomer({ name: 'Peter Otieno', phone: '0722000111', idNumber: '23456789' }, {})`);
  ev(b, `upsertCustomer({ name: 'Mary Atieno', phone: '+254733000222' }, {})`);
  const find = (q) => J(b, `findCustomerMatches({ ${q} })`);
  assert.equal(find(`phone: '+254 722 000 111'`).byPhone.length, 1, '07.. = +254..');
  assert.equal(find(`phone: '254733000222'`).byPhone[0].name, 'Mary Atieno');
  assert.equal(find(`idNumber: '23 456 789'`).byId[0].name, 'Peter Otieno');
  assert.equal(find(`name: 'peter otieno'`).byName.length, 1);
});

test('3. an existing customer picked on a bill sale is not duplicated (phone given in another format)', async () => {
  const b = await one();
  ev(b, `upsertCustomer({ name: 'Jane Wanjiru', phone: '0712345678' }, {})`);
  b.w.eval("addToCart('A'); currentPaymentMethod = 'bill'");
  b.d.getElementById('bill-customer-name-input').value = 'Jane Wanjiru';
  b.d.getElementById('sms-checkout-phone-input').value = '+254712345678';
  await b.w.eval('checkoutCart()');
  assert.equal(J(b, 'customers.filter(c => !c._deleted)').length, 1);
  assert.equal(J(b, 'bills').length, 1);
  assert.equal(J(b, 'bills[0]').customerId, J(b, 'customers[0]').id);
});

test('4. ambiguous matches are reported, never merged: a shared phone with another name, and the same ID with another phone', async () => {
  const b = await one();
  ev(b, `upsertCustomer({ name: 'Jane Wanjiru', phone: '0712345678', idNumber: '11111111' }, {})`);
  const r = J(b, `upsertCustomer({ name: 'Brian Kiprop', phone: '0712345678' }, {})`);
  assert.equal(r.status, 'ambiguous'); assert.equal(J(b, 'customers').length, 1, 'nothing was created or merged');
  const r2 = J(b, `upsertCustomer({ name: 'Brian Kiprop', phone: '0799999999', idNumber: '11111111' }, {})`);
  assert.equal(r2.status, 'ambiguous');
  const other = J(b, `upsertCustomer({ name: 'Brian Kiprop', phone: '0712345678' }, { choice: 'new' })`);
  assert.equal(other.status, 'created'); assert.equal(J(b, 'customers.filter(c => !c._deleted)').length, 2, 'the cashier said: a different person');
  const same = J(b, `upsertCustomer({ name: 'Jane W', phone: '0712345678' }, { choice: 'use:' + customers[0].id })`);
  assert.equal(same.status, 'matched');
});

test('5. the profile shows every sale, bill and contract of the customer, newest first', async () => {
  const b = await one();
  await sale(b, '0712345678', 'Jane Wanjiru');
  b.w.eval("addToCart('A'); currentPaymentMethod = 'bill'");
  b.d.getElementById('bill-customer-name-input').value = 'Jane Wanjiru'; b.d.getElementById('sms-checkout-phone-input').value = '0712345678';
  await b.w.eval('checkoutCart()');
  const r = J(b, `contractIssue({ opId: 'o1', type: 'retail', recipient: { name: 'Jane Wanjiru', phone: '0712345678' }, items: [{ name: 'Beta', qty: 1 }] })`);
  assert.ok(r.ok, r.error);
  const h = J(b, `customerTransactions(customers[0], { limit: 50 })`);
  assert.deepEqual(h.items.map((x) => x.kind).sort(), ['bill', 'contract', 'sale']);
  assert.equal(h.total, 3);
});

test('6. merging duplicates keeps every transaction and its reference number intact (manager only, repeat-safe)', async () => {
  const b = await one();
  ev(b, `
    customers = [{ id: 'c1', name: 'Jane W', phone: '0712345678', updatedAt: 1 }, { id: 'c2', name: 'Jane Wanjiru', phone: '0712 345 678', updatedAt: 2 }];
    salesLog = [{ id: 's1', refNumber: 'R-1', customerId: 'c1', timestamp: new Date().toISOString(), paid: true, cashAmount: 100, items: [{ name: 'x', price: 100, qty: 1 }] }, { id: 's2', refNumber: 'R-2', customerId: 'c2', timestamp: new Date().toISOString(), paid: true, cashAmount: 50, items: [{ name: 'y', price: 50, qty: 1 }] }];
    bills = [{ id: 'b1', refNumber: 'BL-1', customerId: 'c2', customerPhone: '0712345678', items: [{ name: 'z', price: 10, qty: 1 }], timestamp: new Date().toISOString() }];
  `);
  assert.equal(J(b, 'findDuplicateCustomerGroups()').length, 1);
  ev(b, `isAdmin = true`);
  const r = J(b, `mergeCustomers('c1', ['c2'])`);
  assert.ok(r.ok, r.error);
  assert.equal(J(b, 'salesLog.map(s => s.customerId + ":" + s.refNumber)').join(), 'c1:R-1,c1:R-2');
  assert.equal(J(b, 'bills[0].customerId'), 'c1'); assert.equal(J(b, 'bills[0].refNumber'), 'BL-1');
  assert.equal(J(b, 'custActive().length'), 1);
  assert.equal(J(b, 'customers.find(c => c.id === "c2").mergedInto'), 'c1', 'the duplicate is kept as a pointer to the survivor, not erased');
  assert.equal(J(b, `mergeCustomers('c1', ['c2'])`).ok, true, 'running it again changes nothing');
  assert.equal(J(b, 'customerTransactions(customers[0], { limit: 50 }).total'), 3);
});

test('6b. a non-manager cannot merge', async () => {
  const b = await one();
  ev(b, `customers = [{ id: 'c1', name: 'A', phone: '0712345678' }, { id: 'c2', name: 'A', phone: '0712345678' }]; isAdmin = false; currentServer = { id: 's', name: 'Cashier', roles: ['sales'], isManager: false }`);
  const r = J(b, `mergeCustomers('c1', ['c2'])`);
  assert.equal(r.ok, false);
  assert.equal(J(b, 'custActive().length'), 2);
});

test('7. tenant and branch limits: another business never sees these customers; another branch\'s view is read-only', async () => {
  // tenant: the customer list is synced state keyed by the shop's code - business C2 has none of C1's customers
  const { pathToFileURL } = await import('node:url'); const path = await import('node:path');
  const { makeKV, seedShop } = await import('./kv-fake.mjs'); const { ROOT } = await import('./helpers.mjs');
  const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2'); const env = { mydukapos_kv: kv };
  const req = (c, m, body) => new Request('https://x.pages.dev/api/pos-sync?c=' + c, { method: m, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  await sync.onRequestPost({ request: req('C1', 'POST', { businessName: 'Biz1', updatedAt: Date.now(), customers: [{ id: 'c-p254712345678', name: 'Jane', phone: '0712345678', updatedAt: Date.now() }] }), env, waitUntil() {} });
  const c1 = await (await sync.onRequestGet({ request: req('C1', 'GET'), env })).json();
  const c2 = await (await sync.onRequestGet({ request: req('C2', 'GET'), env })).json();
  assert.equal((c1.customers || []).length, 1); assert.equal((c2.customers || []).length, 0, 'the other business has no customers');
  // branch: while another branch's data is on screen nothing can be merged, issued or cancelled
  const b = await one();
  ev(b, `customers = [{ id: 'c1', name: 'A', phone: '0712345678' }, { id: 'c2', name: 'A', phone: '0712345678' }]; isAdmin = true; viewedBranchId = 'branch-2'`);
  assert.equal(J(b, `mergeCustomers('c1', ['c2'])`).ok, false);
  assert.equal(J(b, `contractIssue({ opId: 'x', type: 'retail', recipient: { name: 'A', phone: '0712345678' }, items: [{ name: 'Beta', qty: 1 }] })`).ok, false);
  assert.equal(qty(b, 'B'), 5, 'no stock moved');
});

// ------------------------------------------------------------------------------------------------ receipts and bills
const RX = (b, sale, kind) => b.w.eval(`(function(){ var s = ${JSON.stringify(sale)}; s.timestamp = s.timestamp || new Date().toISOString(); return buildReceiptDoc(s, {}).text; })()`);
const baseSale = { id: 's1', refNumber: 'R-1', paid: true, paymentMethod: 'cash', cashAmount: 200, amountTendered: 200, change: 0, servedBy: 'Cashier', items: [{ code: 'A', name: 'Alpha', price: 100, qty: 2, unit: 'pcs' }] };

test('8. an ordinary receipt prints the customer name, phone and ID number', async () => {
  const b = await one();
  const t = RX(b, { ...baseSale, customerName: 'Jane Wanjiru', customerPhone: '0712345678', customerIdNumber: '12345678' });
  assert.match(t, /Customer: Jane Wanjiru/); assert.match(t, /Phone: 0712345678/); assert.match(t, /ID Number: 12345678/);
});

test('9. a receipt with only a name prints the name and nothing like "undefined"', async () => {
  const b = await one();
  const t = RX(b, { ...baseSale, customerName: 'Jane Wanjiru', customerPhone: undefined, customerIdNumber: null });
  assert.match(t, /Customer: Jane Wanjiru/); assert.doesNotMatch(t, /Phone:|ID Number:|undefined|null|NaN/);
});

test('10. a receipt without customer details has no customer lines and no placeholders', async () => {
  const b = await one();
  const t = RX(b, { ...baseSale, customerName: 'undefined', customerPhone: 'null', customerIdNumber: '  ' });
  assert.doesNotMatch(t, /Customer:|Phone:|ID Number:|undefined|null/);
});

test('11. optional ID fields never block an ordinary sale (blank ID, bad-looking ID is only refused when typed)', async () => {
  const b = await one();
  await sale(b, '', '', '');                                     // nothing at all
  await sale(b, '0712345678', 'Jane', '');                       // phone + name, no ID
  await sale(b, '12345', '', '');                                // a mistyped phone: the sale still goes through
  assert.equal(J(b, 'salesLog').length, 3);
  assert.equal(qty(b), 97);
});

test('12. a bill needs name + phone; the ID number may stay blank; it is saved on the one customer profile', async () => {
  const b = await one();
  b.w.eval("addToCart('A'); currentPaymentMethod = 'bill'");
  b.d.getElementById('bill-customer-name-input').value = 'Jane Wanjiru';
  b.d.getElementById('sms-checkout-phone-input').value = '';
  await b.w.eval('checkoutCart()');
  assert.equal(J(b, 'bills').length, 0, 'no phone: no bill');
  b.d.getElementById('sms-checkout-phone-input').value = '0712345678';
  await b.w.eval('checkoutCart()');
  assert.equal(J(b, 'bills').length, 1);
  const bill = J(b, 'bills[0]');
  assert.equal(bill.customerName, 'Jane Wanjiru'); assert.ok(bill.customerPhone); assert.ok(bill.customerId);
  assert.ok(!bill.customerIdNumber, 'ID left blank');
  assert.equal(J(b, 'custActive().length'), 1);
});

test('13. the bill receipt shows the correct status (unpaid / part paid / paid) and the signature field', async () => {
  const b = await one();
  ev(b, `rxSettings.sigBill = true`);
  const bill = { id: 'b1', refNumber: 'BL-1', paymentMethod: 'bill', paid: false, customerName: 'Jane', customerPhone: '0712345678', servedBy: 'C', items: [{ name: 'Rice', price: 1000, qty: 1, unit: 'pcs' }] };
  const unpaid = RX(b, { ...bill, amountPaid: 0 });
  const part = RX(b, { ...bill, amountPaid: 300 });
  const full = RX(b, { ...bill, amountPaid: 1000 });
  assert.match(unpaid, /STATUS: UNPAID/); assert.match(part, /STATUS: PART PAID/); assert.match(part, /BALANCE\s+KES 700\.00/); assert.match(full, /STATUS: PAID IN FULL/);
  for (const t of [unpaid, part, full]) { assert.match(t, /Customer Signature:/); assert.match(t, /Date:/); }
});

test('13b. the signature area fits every paper width (32 / 42 / 48 / 58 columns)', async () => {
  const b = await one();
  ev(b, `rxSettings.sigBill = true; rxSettings.sigSale = true; rxSettings.sigContract = true`);
  for (const cols of [32, 42, 48, 58]) {
    for (const kind of ['sale', 'bill', 'contract']) {
      const lines = J(b, `receiptSignatureLines({ customerName: 'A very long customer name that goes on', customerPhone: '0712345678', customerIdNumber: '12345678', servedBy: 'Cashier with a long name', approvedBy: 'Manager' }, ${cols}, '${kind}')`);
      assert.ok(lines.length > 4, kind);
      assert.ok(lines.every((l) => l.length <= cols), `${kind}@${cols}: a line is wider than the paper: ` + lines.find((l) => l.length > cols));
      assert.ok(lines.some((l) => /Signature/.test(l)), 'signature line');
    }
  }
});

test('14. reprinting a bill creates no new sale, no new bill and moves no stock', async () => {
  const b = await one();
  b.w.eval("addToCart('A'); currentPaymentMethod = 'bill'");
  b.d.getElementById('bill-customer-name-input').value = 'Jane Wanjiru'; b.d.getElementById('sms-checkout-phone-input').value = '0712345678';
  await b.w.eval('checkoutCart()');
  const before = { sales: J(b, 'salesLog.length'), bills: J(b, 'bills.length'), stock: qty(b), moves: J(b, 'stockMovementLog.length') };
  for (let i = 0; i < 3; i++) b.w.eval(`printOpenBillInvoice('bill', bills[0].id)`);
  assert.deepEqual({ sales: J(b, 'salesLog.length'), bills: J(b, 'bills.length'), stock: qty(b), moves: J(b, 'stockMovementLog.length') }, before);
  assert.match(b.d.getElementById('receipt-body').textContent, /Jane Wanjiru/);
});

// ------------------------------------------------------------------------------------------------ contracts
const issue = (b, extra = '', items = `[{ name: 'Alpha', qty: 3 }]`, op = 'op-1') => J(b, `contractIssue({ opId: '${op}', type: 'retail', recipient: { name: 'Peter Otieno', phone: '0722000111', idNumber: '23456789', address: 'Nakuru' }, approvedBy: 'Mrs Njeri', terms: 'Return in 7 days', expectedReturn: '2026-11-01'${extra ? ', ' + extra : ''}, items: ${items} })`);
const moves = (b, op) => J(b, `stockMovementLog.filter(m => m.contractOp === '${op}')`);

test('15. issuing items under a contract deducts the stock exactly once (and writes one stock movement)', async () => {
  const b = await one();
  const r = issue(b); assert.ok(r.ok, r.error);
  assert.equal(qty(b), 97);
  assert.equal(moves(b, 'op-1').length, 1); assert.equal(moves(b, 'op-1')[0].delta, -3);
  assert.match(moves(b, 'op-1')[0].id, /^ctr:op-1:issue:A:qty$/);
});

test('16. the contract holds the right recipient, items, terms, approver and links to the one customer profile', async () => {
  const b = await one();
  issue(b, '', `[{ name: 'Alpha', qty: 3 }, { name: 'Beta', qty: 2 }]`);
  const c = J(b, 'contracts[0]'), v = c.visits[0];
  assert.equal(c.name, 'Peter Otieno'); assert.equal(v.recipient.phone, '0722000111'); assert.equal(v.recipient.idNumber, '23456789'); assert.equal(v.recipient.address, 'Nakuru');
  assert.equal(v.approvedBy, 'Mrs Njeri'); assert.equal(v.terms, 'Return in 7 days'); assert.equal(v.expectedReturn, '2026-11-01');
  assert.deepEqual(v.items.map((i) => i.name + ':' + i.qty), ['Alpha:3', 'Beta:2']);
  assert.equal(v.total, 3 * 100 + 2 * 40); assert.equal(v.status, 'issued'); assert.match(v.no, /^CT-\d{4}-0001$/);
  assert.equal(c.customerId, J(b, 'customers[0].id')); assert.equal(J(b, 'custActive().length'), 1);
  assert.equal(c.items.A.qtyCarried, 3);
});

test('17. a successful issue produces a printable contract receipt (thermal + A4) with signature fields', async () => {
  const b = await one();
  const r = issue(b);
  const t = b.w.eval(`contractReceiptDoc(contracts[0], contracts[0].visits[0]).text`);
  assert.match(t, /CONTRACT ISSUE NOTE/); assert.match(t, /Customer: Peter Otieno/); assert.match(t, /Alpha/); assert.match(t, /NOT A SALE/); assert.match(t, /Contract No: CT-/);
  assert.match(t, /Recipient Signature:/); assert.match(t, /Staff Signature:/); assert.match(t, /Authorized Approval: Mrs Njeri/);
  assert.doesNotMatch(t, /PAID|Payment Method|undefined|null/);
  assert.ok(b.w.eval(`contractPrintIssue(contracts[0].id, contracts[0].visits[0].id, 'thermal')`)); assert.match(b.d.getElementById('receipt-body').textContent, /CONTRACT ISSUE NOTE/);
  assert.ok(b.w.eval(`contractPrintIssue(contracts[0].id, contracts[0].visits[0].id, 'a4')`)); assert.match(b.d.getElementById('sales-report-body').textContent, /Recipient Signature/);
  for (const mm of [58, 72, 80]) {
    b.w.eval(`window.__receiptTrial = { mm: ${mm} }`);
    const cols = b.w.eval('getPaperCols()'); const text = b.w.eval(`contractReceiptDoc(contracts[0], contracts[0].visits[0]).text`);
    assert.ok(text.split('\n').every((l) => l.length <= cols), `${mm} mm (${cols} cols): ` + text.split('\n').find((l) => l.length > cols));
  }
});

test('18. retrying after a timeout (same operation) and a double click never deduct twice', async () => {
  const b = await one();
  issue(b); const again = issue(b); const third = issue(b);
  assert.ok(again.ok && again.duplicate && third.duplicate);
  assert.equal(qty(b), 97); assert.equal(J(b, 'contracts[0].visits.length'), 1); assert.equal(moves(b, 'op-1').length, 1);
  // the real button, pressed twice at once
  ev(b, `contractDraft = [{ rowId: 1, name: 'Beta', qty: '1', price: '' }]; document.getElementById('contract-name-input').value = 'Sam Mwangi'; document.getElementById('contract-phone-input').value = '0733111222'`);
  await Promise.all([b.w.eval('saveContract()'), b.w.eval('saveContract()')]);
  assert.equal(qty(b, 'B'), 4, 'one unit, not two'); assert.equal(J(b, 'contracts.length'), 2);
});

test('19. printing the same contract again and again changes no stock and does not re-issue it', async () => {
  const b = await one();
  issue(b);
  const snap = () => ({ stock: qty(b), moves: J(b, 'stockMovementLog.length'), visits: J(b, 'contracts[0].visits.length'), sales: J(b, 'salesLog.length'), carried: J(b, 'contracts[0].items.A.qtyCarried') });
  const before = snap();
  for (let i = 0; i < 4; i++) b.w.eval(`contractPrintIssue(contracts[0].id, contracts[0].visits[0].id, '${i % 2 ? 'a4' : 'thermal'}')`);
  assert.deepEqual(snap(), before);
  const v = J(b, 'contracts[0].visits[0]'); assert.equal(v.printCount, 4); assert.equal(v.printStatus, 'printed'); assert.equal(v.status, 'issued', 'print status is separate from the issue status');
});

test('20. not enough stock: nothing is issued, nothing is deducted, no contract, no movement, no "success"', async () => {
  const b = await one();
  const r = issue(b, '', `[{ name: 'Alpha', qty: 3 }, { name: 'Beta', qty: 6 }]`, 'op-x');
  assert.equal(r.ok, false); assert.match(r.error, /Only .*Beta/);
  assert.equal(qty(b), 100, 'the first line was NOT deducted'); assert.equal(qty(b, 'B'), 5);
  assert.equal(J(b, 'contracts.length'), 0); assert.equal(moves(b, 'op-x').length, 0); assert.equal(J(b, 'custActive().length'), 0, 'no customer profile for a refused issue');
  assert.equal(issue(b, '', `[{ name: 'Nope', qty: 1 }]`, 'op-y').ok, false);
  assert.equal(issue(b, '', `[{ name: 'Alpha', qty: 0 }]`, 'op-z').ok, false);
  // the recipient policy
  assert.match(J(b, `contractIssue({ opId: 'p', type: 'retail', recipient: { name: 'X' }, items: [{ name: 'Alpha', qty: 1 }] })`).error, /phone number or ID/);
  ev(b, `rxSettings.contractReq = 'both'`);
  assert.match(J(b, `contractIssue({ opId: 'p2', type: 'retail', recipient: { name: 'X', phone: '0722000111' }, items: [{ name: 'Alpha', qty: 1 }] })`).error, /ID number/);
  assert.equal(qty(b), 100);
});

test('20b. dual-unit items: loose pieces open a box when needed, and a failure puts everything back', async () => {
  const b = await one();
  const r = issue(b, '', `[{ name: 'Soda crate', qty: 30, mode: 'piece' }]`, 'op-d');   // 4 loose + needs 26 more = 2 boxes of 24 (48): leaves 22 loose
  assert.ok(r.ok, r.error);
  assert.equal(qty(b, 'D'), 8); assert.equal(pieces(b), 4 + 48 - 30);
  const ms = moves(b, 'op-d'); assert.deepEqual(ms.map((m) => m.unit + ':' + m.delta).sort(), ['pieceQty:18', 'qty:-2']);
  const bad = issue(b, '', `[{ name: 'Alpha', qty: 1 }, { name: 'Soda crate', qty: 999, mode: 'piece' }]`, 'op-e');
  assert.equal(bad.ok, false); assert.equal(qty(b, 'D'), 8); assert.equal(pieces(b), 22); assert.equal(qty(b), 100);
});

test('21. only a manager can cancel an issue; the stock goes back exactly, once; a returned issue cannot be cancelled', async () => {
  const b = await one();
  issue(b); assert.equal(qty(b), 97);
  ev(b, `isAdmin = false; currentServer = { id: 's', name: 'Cashier', roles: ['sales'], isManager: false }`);
  assert.equal(J(b, `contractCancelIssue(contracts[0].id, contracts[0].visits[0].id, { reason: 'mistake' })`).ok, false); assert.equal(qty(b), 97);
  ev(b, `currentServer = null`);        // the Admin is serving
  assert.equal(J(b, `contractCancelIssue(contracts[0].id, contracts[0].visits[0].id, {})`).ok, false, 'a reason is required');
  const r = J(b, `contractCancelIssue(contracts[0].id, contracts[0].visits[0].id, { reason: 'wrong customer' })`); assert.ok(r.ok, r.error);
  assert.equal(qty(b), 100); assert.equal(J(b, 'contracts[0].visits[0].status'), 'cancelled'); assert.equal(J(b, 'contracts[0].status'), 'cancelled'); assert.equal(J(b, 'contracts[0].items.A.qtyCarried'), 0);
  const again = J(b, `contractCancelIssue(contracts[0].id, contracts[0].visits[0].id, { reason: 'again' })`); assert.ok(again.ok && again.duplicate); assert.equal(qty(b), 100, 'the second cancel changes nothing');
  assert.equal(J(b, `stockMovementLog.filter(m => m.contractOp === 'op-1')`).map((m) => m.delta).join(), '-3,3');
  // part of a second issue comes back through the return form: cancelling it is refused
  issue(b, '', `[{ name: 'Alpha', qty: 5 }]`, 'op-2');
  ev(b, `openContractReturnModal(contracts[1] ? contracts[1].id : contracts[0].id)`);
  const cid = J(b, `contracts.find(c => c.visits.some(v => v.opId === 'op-2')).id`);
  ev(b, `openContractReturnModal('${cid}'); document.getElementById('return-qty-A').value = '2'; confirmContractReturn()`);
  assert.equal(J(b, `contractCancelIssue('${cid}', contracts.find(c => c.id === '${cid}').visits.find(v => v.opId === 'op-2').id, { reason: 'x' })`).ok, false);
});

test('21b. a return through the existing form restores the stock and writes the stock movements (box and loose-piece items)', async () => {
  const b = await one();
  issue(b, '', `[{ name: 'Alpha', qty: 5 }, { name: 'Soda crate', qty: 6, mode: 'piece' }]`, 'op-r');
  assert.equal(qty(b), 95); assert.equal(pieces(b), 22, '4 loose + one opened box (24) - 6');
  const cid = J(b, 'contracts[0].id'); const piecesBefore = pieces(b);
  ev(b, `openContractReturnModal('${cid}'); document.getElementById('return-qty-A').value = '2'; document.getElementById('return-qty-D#piece').value = '4'; confirmContractReturn()`);
  assert.equal(qty(b), 97); assert.equal(pieces(b), piecesBefore + 4, 'loose pieces went back to the loose-piece shelf');
  const ret = J(b, `stockMovementLog.filter(m => /^ctr:ret-/.test(m.id))`);
  assert.deepEqual(ret.map((m) => m.code + ':' + m.unit + ':' + m.delta).sort(), ['A:qty:2', 'D:pieceQty:4']);
});

test('22. issued stock is not sales revenue: no sale is created; revenue appears only when a retail recipient keeps items', async () => {
  const b = await one();
  issue(b); assert.equal(J(b, 'salesLog.length'), 0); assert.equal(J(b, 'bills.length'), 0);
  assert.equal(b.w.eval(`salesLog.reduce((n, s) => n + (s.cashAmount || 0), 0)`), 0);
  const cid = J(b, 'contracts[0].id');
  ev(b, `openContractReturnModal('${cid}'); document.getElementById('return-qty-A').value = '1'; confirmContractReturn()`);   // 3 issued, 1 back, 2 kept
  assert.equal(J(b, 'salesLog.length'), 1); assert.equal(J(b, 'salesLog[0].paymentMethod'), 'contract');
  assert.equal(J(b, 'salesLog[0].items[0].qty'), 2); assert.equal(qty(b), 98);
});
