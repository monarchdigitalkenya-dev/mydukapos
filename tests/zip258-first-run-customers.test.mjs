// zip 258: empty-inventory cards, the one customer field at checkout, the tabbed customer profile and the token fixes - run in the REAL apps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', category: 'General', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const CUSTOMERS = [
  { id: 'c1', name: 'Jane Wanjiru', phone: '0712345678', tokens: 3, createdAt: 1000 },
  { id: 'c2', name: 'John Otieno', phone: '0722000111', tokens: 0, createdAt: 2000 },
];
const quiet = (w) => w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = (m, d) => d; window.print = () => {};");
const tick = (ms = 1100) => new Promise((r) => setTimeout(r, ms));          // the block refreshes every 0.9 s
const q = (w, sel) => w.document.querySelector(sel);

for (const app of APPS) {
  test(`${app}: an empty account sees Add your first item in Inventory and the Sales Counter, and the card goes once there is stock`, { timeout: 60000 }, async () => {
    const b = await boot(app, { wait: 900 }); const { w } = b; quiet(w);
    await tick();
    const inv = q(w, '#inventory-table tbody .fr-empty');
    assert.ok(inv, 'Inventory shows the empty-state card');
    assert.match(inv.textContent, /Add your first item/);
    assert.match(inv.textContent, /before you can record a sale/i);
    const sales = q(w, '#fr-sales-empty .fr-empty');
    assert.ok(sales, 'the Sales Counter shows it too');
    assert.ok(sales.querySelector('[data-fr="add"]'), 'with the primary button');
    sales.querySelector('[data-fr="add"]').click();
    assert.ok(q(w, '#add-item-tab').classList.contains('active'), 'the button opens Add New Items');
    // stock arrives: both cards disappear
    w.eval(`inventory.push(${JSON.stringify(ITEMS[0])}); renderInventoryTable(); renderItemImageGrid('')`);
    await tick();
    assert.equal(q(w, '#inventory-table tbody .fr-empty'), null, 'no card once an item exists');
    assert.equal(q(w, '#fr-sales-empty'), null);
    b.close();
  });

  test(`${app}: customer field finds by name or phone, never duplicates, saves a new customer only when the sale succeeds, and tokens match +254 numbers`, { timeout: 90000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS), pos_customers: JSON.stringify(CUSTOMERS) }, wait: 900 });
    const { w } = b; quiet(w);
    const problems = []; w.addEventListener('error', (e) => problems.push(String(e.message))); w.addEventListener('unhandledrejection', (e) => problems.push(String(e.reason && e.reason.message || e.reason)));
    w.eval("loyaltyEnabled = true; loyaltyTiers = [{ id: 't1', minSpend: 0, maxSpend: null, tokens: 5 }];");
    await tick();
    const d = w.document; const qi = d.getElementById('fr-cust-q');
    assert.ok(qi, 'the combined field is on the page');
    assert.equal(d.getElementById('fr-status').hidden, true, 'no wording when no customer is attached'); assert.equal(d.getElementById('fr-cust-q').placeholder, 'Search name or phone'); assert.ok([...d.querySelectorAll('label')].some((l) => /^Customer\s*\(optional\)$/.test(l.textContent.trim())), 'short label');
    const type = (v) => { qi.value = v; qi.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const orig = () => d.getElementById('sms-checkout-phone-input').value;
    const ring = async () => { w.eval("currentCart = {}; addToCart('A'); currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '100000'; await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 80)); };

    // by name
    type('jan'); let opts = [...d.querySelectorAll('#fr-cust-list .fr-opt')];
    assert.ok(opts.some((o) => /Jane Wanjiru/.test(o.textContent)), 'found by part of the name');
    // by part of the phone number
    type('712 345'); opts = [...d.querySelectorAll('#fr-cust-list .fr-opt')];
    assert.ok(opts.some((o) => /Jane Wanjiru/.test(o.textContent)), 'found by part of the phone');
    opts.find((o) => /Jane/.test(o.textContent)).click();
    assert.equal(orig(), '0712345678'); assert.match(d.getElementById('fr-status').textContent, /Attached: Jane Wanjiru/);

    // a failed sale (cash short) changes nothing: no sale, no tokens, still attached
    w.eval("currentCart = {}; addToCart('A'); currentPaymentMethod = 'cash'"); d.getElementById('cash-tendered-input').value = '1'; await w.eval('checkoutCart()'); await new Promise((r) => setTimeout(r, 60));
    assert.equal(w.eval('salesLog.length'), 0, 'no sale was recorded'); assert.equal(w.eval("customers.find(c => c.id === 'c1').tokens"), 3, 'no tokens for a sale that did not happen');
    assert.equal(orig(), '0712345678', 'the customer stays attached after a failed attempt');

    // the successful sale: tokens once, stamped on the sale, field resets
    await ring();
    assert.equal(w.eval('salesLog.length'), 1);
    const loyal = app !== 'production/index.html';          // Production has no loyalty feature: its sales never award tokens (and its profile has no Loyalty tab)
    if (loyal) {
      assert.equal(w.eval("customers.find(c => c.id === 'c1').tokens"), 8, 'exactly one award of 5');
      assert.equal(w.eval('salesLog[0].tokensEarned'), 5, 'the sale carries the tokens it earned');
    }
    await tick(); assert.equal(qi.value, ''); assert.equal(d.getElementById('fr-status').hidden, true, 'cleared for the next customer');

    // the same customer typed as +254 earns tokens and is not duplicated
    type('+254712345678'); // exact match is offered
    d.querySelector('#fr-cust-list .fr-opt').click();
    await ring();
    assert.equal(w.eval('customers.length'), 2, 'no duplicate customer');
    if (loyal) assert.equal(w.eval("customers.find(c => c.id === 'c1').tokens"), 13);
    await tick();

    // a typed phone that belongs to an existing customer offers that record instead of a duplicate
    type('Wanjiku'); d.querySelector('#fr-opt-add').click();
    assert.equal(d.getElementById('fr-newbox').hidden, false);
    d.getElementById('fr-new-phone').value = '+254 722 000 111'; d.getElementById('fr-new-ok').click();
    assert.match(d.getElementById('fr-status').textContent, /already belongs to John Otieno/);
    d.getElementById('fr-use-dup').click(); assert.match(d.getElementById('fr-status').textContent, /Attached: John Otieno/);
    resetUi(w); await tick();

    // a bad number is refused inline
    type('Wanjiku'); d.querySelector('#fr-opt-add').click(); d.getElementById('fr-new-phone').value = '12'; d.getElementById('fr-new-ok').click();
    assert.match(d.getElementById('fr-new-err').textContent, /valid phone number/);

    // a genuinely new customer: not saved when attached, saved once with the sale
    d.getElementById('fr-new-phone').value = '0799000111'; d.getElementById('fr-new-ok').click();
    assert.match(d.getElementById('fr-status').textContent, /New customer: Wanjiku/);
    assert.equal(w.eval('customers.length'), 2, 'not saved before the sale');
    await ring();
    assert.equal(w.eval('customers.length'), 3, 'saved by the successful sale');
    assert.equal(w.eval("customers.find(c => c.phone === '0799000111').name"), 'Wanjiku', 'with the name that was typed');
    if (loyal) assert.equal(w.eval("customers.find(c => c.phone === '0799000111').tokens"), 5);
    await tick();

    // a sale with nobody attached links nobody
    await ring(); assert.equal(w.eval('customers.length'), 3); assert.ok(!w.eval('salesLog[salesLog.length - 1].customerPhone'));
    assert.deepEqual(problems, [], 'no uncaught errors: ' + problems.join(' | '));
    b.close();
  });
}

function resetUi(w) { w.document.getElementById('fr-cust-clear').click(); }

test('production/index.html: the profile has no Loyalty tab because Production has no loyalty feature', { timeout: 60000 }, async () => {
  const b = await boot('production/index.html', { storage: { pos_customers: JSON.stringify(CUSTOMERS) }, wait: 900 }); const { w } = b; quiet(w);
  w.eval("openCustomerProfileModal('c1')");
  const tabs = [...w.document.querySelectorAll('#fr-p-tabs .fr-tab')].map((t) => t.textContent);
  assert.deepEqual(tabs, ['Overview', 'Transactions', 'Bills & balances', 'Contracts', 'Statement']);
  b.close();
});

test('index.html: the customer list searches, and the profile shows purchases, bills, returns and a token ledger from saved records', { timeout: 60000 }, async () => {
  const sale = (id, ref, phone, cash, extra = {}) => ({ id, refNumber: ref, timestamp: '2026-10-01T10:00:00.000Z', paid: true, cashAmount: cash, mpesaAmount: 0, cardAmount: 0, servedBy: 'Amina', customerPhone: phone, items: [{ code: 'A', name: 'Alpha', qty: 2, price: cash / 2, unit: 'pcs' }], ...extra });
  const salesLog = [
    sale('s1', 'R-1', '+254712345678', 200, { tokensEarned: 5 }),
    sale('s2', 'R-2', '0712345678', 300, { timestamp: '2026-10-05T10:00:00.000Z' }),
    sale('s3', 'R-3', '0712345678', 50, { voided: true }),
    { id: 's4', timestamp: '2026-10-06T10:00:00.000Z', paid: true, billId: 'b1', cashAmount: 100, items: [{ code: 'BILL', name: 'Bill Payment', qty: 1, price: 100 }] },
    sale('s5', 'R-5', '0722000111', 999),
  ];
  const bills = [{ id: 'b1', refNumber: 'B-1', timestamp: '2026-10-02T10:00:00.000Z', customerPhone: '0712345678', customerName: 'Jane', amountPaid: 100, dueDate: '2026-10-09', items: [{ name: 'Sofa', qty: 1, price: 500 }], paymentHistory: [{ id: 'p1', timestamp: '2026-10-06T10:00:00.000Z', amount: 100, method: 'cash', balanceAfter: 400 }] }];
  const returns = [{ id: 'r1', timestamp: '2026-10-07T10:00:00.000Z', type: 'exchange', itemName: 'Alpha', qty: 1, reason: 'Faulty', customerPhone: '+254712345678', refNumber: 'R-2', servedBy: 'Amina' }];
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_customers: JSON.stringify([{ ...CUSTOMERS[0], tokens: 8 }, CUSTOMERS[1]]), pos_sales_log: JSON.stringify(salesLog), pos_bills: JSON.stringify(bills), pos_returns: JSON.stringify(returns) }, wait: 900 });
  const { w } = b; quiet(w); w.eval('loyaltyEnabled = true; loyaltyTiers = [{ id: "t1", minSpend: 0, maxSpend: null, tokens: 5 }];');
  const d = w.document; const q2 = (s) => d.querySelector(s);
  w.eval('renderCustomersList()');
  assert.equal(d.querySelectorAll('#customers-list .fr-crow').length, 2);
  d.getElementById('customers-search-input').value = '0722'; w.eval('renderCustomersList()');
  assert.equal(d.querySelectorAll('#customers-list .fr-crow').length, 1, 'search by phone');
  assert.match(d.getElementById('fr-ccount').textContent, /1 of 2/);
  d.getElementById('customers-search-input').value = 'otieno'; w.eval('renderCustomersList()'); assert.equal(d.querySelectorAll('#customers-list .fr-crow').length, 1, 'search by name');
  d.getElementById('customers-search-input').value = ''; w.eval('renderCustomersList()');
  const jane = [...d.querySelectorAll('#customers-list .fr-crow')].find((r) => /Jane/.test(r.textContent));
  assert.match(jane.textContent, /3 purchases/, '+254 and 0712 sales both count, the voided one does not, the bill payment does');
  assert.match(jane.textContent, /Owes KES 400\.00/);
  jane.click();
  assert.ok(q2('#fr-profile').classList.contains('fr-open'));
  const tabs = [...d.querySelectorAll('#fr-p-tabs .fr-tab')].map((t) => t.textContent); assert.deepEqual(tabs, ['Overview', 'Transactions', 'Bills & balances', 'Contracts', 'Statement', 'Loyalty']);
  assert.match(q2('#fr-p-body').textContent, /KES 600\.00/, 'lifetime spend = 200 + 300 + 100, voided excluded');
  d.getElementById('fr-tab-tx').click();
  const body = q2('#fr-p-body').textContent;
  assert.ok(body.indexOf('R-2') < body.indexOf('R-1'), 'newest first'); assert.match(body, /Voided/); assert.match(body, /Served by Amina/); assert.match(body, /Cash KES 300\.00/); assert.match(body, /Exchange: Alpha/); assert.match(body, /Reason: Faulty/);
  d.getElementById('fr-tab-bills').click();
  const bills2 = q2('#fr-p-body').textContent; assert.match(bills2, /KES 500\.00 bill/); assert.match(bills2, /Balance KES 400\.00/); assert.match(bills2, /Overdue/); assert.match(bills2, /Payments \(1\)/);
  d.getElementById('fr-tab-loyalty').click();
  const loy = q2('#fr-p-body').textContent; assert.match(loy, /Token balance/); assert.match(loy, /\+5/, 'the stamped award is a ledger row'); assert.match(loy, /before itemised history[\s\S]*\+3/, 'the rest is shown as carried balance, not invented');
  // Escape closes
  q2('#fr-profile').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!q2('#fr-profile').classList.contains('fr-open'));
  // empty customers
  w.eval('customers = []; renderCustomersList()');
  assert.match(d.getElementById('customers-list').textContent, /No customers yet/); assert.ok(d.querySelector('#customers-list [data-fr="addc"]'));
  b.close();
});
