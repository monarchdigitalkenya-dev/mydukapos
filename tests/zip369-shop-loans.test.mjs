import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 369: Borrow & Lend - items between shops, settled by the same items, other items, money, or written off.
const QUIET = "window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => ''; window.print = () => {};";
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INV = [
  { code: 'S1', type: 'item', name: 'Sugar 1kg', price: 130, wholesalePrice: 100, qty: 20, unit: 'pcs', vatCategory: 'A' },
  { code: 'O1', type: 'item', name: 'Cooking Oil 1L', price: 350, wholesalePrice: 300, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'R1', type: 'item', name: 'Rice 2kg', price: 300, wholesalePrice: 250, qty: 0, unit: 'pcs', vatCategory: 'A' },
];
const open = (storage = {}, app = 'index.html') => boot(app, { storage: { pos_inventory: JSON.stringify(INV), pos_biz_name: 'My Duka', ...storage }, wait: 1500 });
const stock = (w, code) => w.eval(`inventory.find(p => p.code === ${JSON.stringify(code)}).qty`);
const toasts = (w) => w.eval('window.__toasts');
const input = (w, id, v) => { const e = w.document.getElementById(id); assert.ok(e, 'missing #' + id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
const click = (w, sel) => { const e = w.document.querySelector(sel); assert.ok(e, 'missing ' + sel); e.click(); };
const goTab = async (w) => { w.document.getElementById('shop-loans-tab-btn').click(); await sleep(120); };
// helper: record a loan through the real form
async function newLoan(w, dir, party, lines, extra = {}) {
  { const b = w.document.querySelector('[data-sl="back"]'); if (b) { b.click(); await sleep(40); } }
  click(w, `[data-sl="new"][data-v="${dir}"]`); await sleep(40);
  input(w, 'sl-party', party); if (extra.phone) input(w, 'sl-phone', extra.phone); if (extra.due) input(w, 'sl-due', extra.due);
  lines.forEach((l, i) => { if (i > 0) { click(w, '[data-sl="add"]'); } input(w, 'sl-n' + i, l[0]); input(w, 'sl-q' + i, String(l[1])); if (l[2] != null) input(w, 'sl-v' + i, String(l[2])); });
  if (extra.noAdd) { const c = w.document.getElementById('sl-addnew'); c.checked = false; c.dispatchEvent(new w.Event('change', { bubbles: true })); }
  click(w, '[data-sl="save-new"]'); await sleep(80);
}
const loan = (w, i = 0) => J(w, `tradeCredits.filter(t => t.kind === 'goods')[${i}]`);
const openLoan = async (w, i = 0) => { { const b = w.document.querySelector('[data-sl="back"]'); if (b) { b.click(); await sleep(40); } } click(w, `[data-sl="open"][data-id="${loan(w, i).id}"]`); await sleep(60); };

test('the tab is in every app that has Trade Credits, can be given to staff, and the old totals include it', async () => {
  for (const app of ['index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html', 'hotel/index.html']) {
    const d = await boot(app, { wait: 1800 });
    try { const w = d.w; assert.ok(w.document.getElementById('shop-loans-tab-btn'), app + ': button'); assert.ok(w.eval("LOCKABLE_TABS.some(t => t.id === 'shop-loans-tab')"), app + ': can be given to staff'); assert.deepEqual((d.errors || []).filter((e) => /sl-|SL\b|shop-loans/.test(e)), [], app + ': no script error'); }
    finally { d.close(); }
  }
});

test('I borrow items: stock goes up now, the loan is open for the full value, the other shop is listed, and it shows on the Trade Credits totals', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Mama Mboga Shop', [['Sugar 1kg', 10]], { phone: '0712345678', due: '2099-01-01' });   // value defaults to the cost price 100
    assert.equal(stock(w, 'S1'), 30);
    const t = loan(w); assert.deepEqual([t.partyName, t.direction, t.amount, t.status], ['Mama Mboga Shop', 'i_owe', 1000, 'open']);
    assert.ok(J(w, "stockMovementLog.some(m => m.code === 'S1' && m.delta === 10 && /Borrowed/.test(m.reason))"), 'in the stock log');
    assert.match(w.document.getElementById('shop-loans-tab').textContent, /Mama Mboga Shop[\s\S]*you owe KES 1,000\.00/);
    assert.match(w.localStorage.getItem('pos_trade_credits'), /Mama Mboga Shop/, 'saved');
    w.eval('renderTradeCreditsTab()'); assert.match(w.document.getElementById('tc-total-i-owe').textContent, /1000\.00/, 'the old totals count it');
  } finally { d.close(); }
});

test('I borrow something I do not stock: it is added to my stock (so I can sell it), unless I untick that', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Shop A', [['Bread Loaf', 6, 55]]);
    const p = J(w, "inventory.find(x => x.name === 'Bread Loaf')"); assert.ok(p && p.qty === 6 && p.price === 55, 'new item with the borrowed quantity');
    assert.equal(loan(w).amount, 330);
    await newLoan(w, 'i_owe', 'Shop A', [['Cake Slice', 4, 40]], { noAdd: true });
    assert.equal(J(w, "inventory.some(x => x.name === 'Cake Slice')"), false, 'not added when I untick it');
    assert.equal(loan(w, 1).lines[0].tracked, false);
  } finally { d.close(); }
});

test('I lend items: stock goes down, and I cannot lend more than I have', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Shop B', [['Cooking Oil 1L', 99]]);
    assert.equal(J(w, 'tradeCredits.filter(t => t.kind === "goods").length'), 0, 'refused');
    assert.ok(toasts(w).some((t) => /ERR Only 10 of "Cooking Oil 1L" in stock/.test(t)));
    assert.equal(stock(w, 'O1'), 10);
    await newLoan(w, 'they_owe', 'Shop B', [['Cooking Oil 1L', 4]]);
    assert.equal(stock(w, 'O1'), 6); assert.equal(loan(w).amount, 1200); assert.equal(loan(w).direction, 'they_owe');
    // the same item on two lines is counted together against the stock
    await newLoan(w, 'they_owe', 'Shop B', [['Cooking Oil 1L', 4], ['Cooking Oil 1L', 3]]);
    assert.equal(J(w, 'tradeCredits.filter(t => t.kind === "goods").length'), 1, 'two lines of the same item cannot beat the stock (7 > 6)');
    assert.equal(stock(w, 'O1'), 6);
  } finally { d.close(); }
});

test('I lent 5, they bring back 3 now and 2 later instead of money: stock comes back, the balance falls, then it closes', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Shop B', [['Sugar 1kg', 5]]);               // 500
    assert.equal(stock(w, 'S1'), 15);
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40);
    const lid = loan(w).lines[0].lid;
    input(w, 'sl-r' + lid, '9'); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.ok(toasts(w).some((t) => /ERR "Sugar 1kg": only 5 left/.test(t)), 'cannot return more than was lent'); assert.equal(stock(w, 'S1'), 15);
    input(w, 'sl-r' + lid, '3'); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.equal(stock(w, 'S1'), 18); assert.equal(loan(w).amount, 200); assert.equal(loan(w).lines[0].out, 2); assert.equal(loan(w).status, 'open');
    assert.match(w.document.getElementById('shop-loans-tab').textContent, /2 still to come back|KES 200\.00/);
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40); click(w, '[data-sl="all"]'); await sleep(40); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.equal(stock(w, 'S1'), 20); assert.equal(loan(w).status, 'settled'); assert.equal(loan(w).amount, 0);
    assert.equal(loan(w).events.length, 3, 'create + 2 returns in the history');
    assert.match(w.document.getElementById('shop-loans-tab').textContent, /Finished \(1\)/);
  } finally { d.close(); }
});

test('I borrowed 10 and give them back instead of money: stock goes down again, and I cannot give back what I no longer have', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 10]]);      // stock 30, owe 1000
    w.eval("inventory.find(p => p.code === 'S1').qty = 4");          // I sold most of it in the meantime
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40); click(w, '[data-sl="all"]'); await sleep(40); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.ok(toasts(w).some((t) => /ERR Only 4 of "Sugar 1kg"/.test(t)), 'refused: only 4 left in stock'); assert.equal(loan(w).amount, 1000);
    const lid = loan(w).lines[0].lid; input(w, 'sl-r' + lid, '4'); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.equal(stock(w, 'S1'), 0); assert.equal(loan(w).amount, 600); assert.equal(loan(w).lines[0].out, 6);
    // the other 6 are paid with money
    await openLoan(w); click(w, '[data-sl="mode"][data-v="money"]'); await sleep(40); input(w, 'sl-amt', '600'); click(w, '[data-sl="do-money"]'); await sleep(60);
    assert.equal(loan(w).status, 'settled'); assert.equal(stock(w, 'S1'), 0, 'money does not touch stock');
  } finally { d.close(); }
});

test('part payments in money: partial first, never more than what is owed; a mix of items and money closes it', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Shop B', [['Cooking Oil 1L', 2]]);   // 600
    await openLoan(w); click(w, '[data-sl="mode"][data-v="money"]'); await sleep(40);
    input(w, 'sl-amt', '700'); click(w, '[data-sl="do-money"]'); await sleep(40); assert.ok(toasts(w).some((t) => /ERR Only KES 600\.00 is still open/.test(t)));
    input(w, 'sl-amt', '250'); input(w, 'sl-how', 'M-Pesa'); click(w, '[data-sl="do-money"]'); await sleep(60);
    assert.equal(loan(w).amount, 350); assert.equal(loan(w).status, 'open');
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40); input(w, 'sl-r' + loan(w).lines[0].lid, '1'); click(w, '[data-sl="do-return"]'); await sleep(60);   // one oil back = 300
    assert.equal(loan(w).amount, 50); assert.equal(stock(w, 'O1'), 9);
    // the rest is more than the one oil still outstanding is worth: returning it is refused (it would overpay), money closes it
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40); input(w, 'sl-r' + loan(w).lines[0].lid, '1'); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.ok(toasts(w).some((t) => /ERR Those items are worth KES 300\.00 but only KES 50\.00/.test(t)), 'overpaying with items is refused'); assert.equal(stock(w, 'O1'), 9);
    await openLoan(w); click(w, '[data-sl="mode"][data-v="money"]'); await sleep(40); input(w, 'sl-amt', '50'); click(w, '[data-sl="do-money"]'); await sleep(60);
    assert.equal(loan(w).status, 'settled'); assert.deepEqual(loan(w).events.map((e) => e.type), ['create', 'money', 'return', 'money']);
  } finally { d.close(); }
});

test('paying with OTHER items: I borrowed sugar, I pay with oil worth more - the extra becomes a new amount they owe me; they pay with their rice when I lent', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 10]]);   // I owe 1000
    await openLoan(w); click(w, '[data-sl="mode"][data-v="swap"]'); await sleep(40);
    input(w, 'sl-sn0', 'Cooking Oil 1L'); input(w, 'sl-sq0', '4');   // value fills from the cost price 300 -> 1200
    assert.equal(w.document.getElementById('sl-sv0').value, '300'); assert.match(w.document.getElementById('sl-swtot').textContent, /1,200\.00/);
    click(w, '[data-sl="do-swap"]'); await sleep(80);
    assert.equal(stock(w, 'O1'), 6, 'my oil went out'); const t = loan(w, 0); assert.equal(t.status, 'settled');
    const x = loan(w, 1); assert.deepEqual([x.direction, x.amount, x.status], ['they_owe', 200, 'open'], 'the extra 200 is now owed to me');
    // an item I do not have cannot be given
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 1]]); const idx = J(w, 'tradeCredits.filter(t => t.kind === "goods").length') - 1;
    await openLoan(w, idx); click(w, '[data-sl="mode"][data-v="swap"]'); await sleep(40); input(w, 'sl-sn0', 'Mystery Thing'); input(w, 'sl-sq0', '1'); input(w, 'sl-sv0', '50'); click(w, '[data-sl="do-swap"]'); await sleep(60);
    assert.ok(toasts(w).some((t) => /ERR "Mystery Thing" is not in your stock/.test(t)));
    // I lent oil; they pay me with rice (an item I stock at 0)
    await newLoan(w, 'they_owe', 'Shop C', [['Cooking Oil 1L', 2]]);   // 600, oil 6 -> 4
    const k = J(w, 'tradeCredits.filter(t => t.kind === "goods").length') - 1; await openLoan(w, k);
    click(w, '[data-sl="mode"][data-v="swap"]'); await sleep(40); input(w, 'sl-sn0', 'Rice 2kg'); input(w, 'sl-sq0', '2'); input(w, 'sl-sv0', '300'); click(w, '[data-sl="do-swap"]'); await sleep(80);
    assert.equal(stock(w, 'R1'), 2, 'their rice came in'); assert.equal(loan(w, k).status, 'settled');
  } finally { d.close(); }
});

test('mistakes: cancelling an entry puts every stock change back; write-off needs a reason; a read-only branch view is blocked', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Shop B', [['Sugar 1kg', 5]]); assert.equal(stock(w, 'S1'), 15);
    await openLoan(w); click(w, '[data-sl="mode"][data-v="return"]'); await sleep(40); input(w, 'sl-r' + loan(w).lines[0].lid, '2'); click(w, '[data-sl="do-return"]'); await sleep(60);
    assert.equal(stock(w, 'S1'), 17);
    await openLoan(w); click(w, '[data-sl="cancel"]'); await sleep(80);
    assert.equal(stock(w, 'S1'), 20, 'back to where it started'); assert.equal(loan(w).cancelled, true); assert.equal(loan(w).status, 'settled'); assert.equal(loan(w).amount, 0);
    w.eval('renderTradeCreditsTab()'); assert.match(w.document.getElementById('tc-total-they-owe').textContent, /0\.00/);
    // write-off needs a reason and leaves stock alone
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 3]]); const k = J(w, 'tradeCredits.filter(t => t.kind === "goods").length') - 1;
    await openLoan(w, k); click(w, '[data-sl="mode"][data-v="off"]'); await sleep(40); click(w, '[data-sl="do-off"]'); await sleep(40);
    assert.ok(toasts(w).some((t) => /ERR Type why/.test(t))); input(w, 'sl-why', 'damaged'); click(w, '[data-sl="do-off"]'); await sleep(60);
    assert.equal(loan(w, k).status, 'settled'); assert.equal(stock(w, 'S1'), 23);
    // a plain staff member cannot cancel or write off
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 1]]); const m = J(w, 'tradeCredits.filter(t => t.kind === "goods").length') - 1;
    w.eval("custIsManager = () => false"); await openLoan(w, m);
    assert.equal(w.document.querySelector('[data-sl="cancel"]'), null, 'no cancel button for staff'); assert.equal(w.document.querySelector('[data-sl="mode"][data-v="off"]'), null);
    w.eval("custIsManager = () => true; custReadOnlyView = () => true"); click(w, '[data-sl="mode"][data-v="money"]'); await sleep(40); input(w, 'sl-amt', '10'); click(w, '[data-sl="do-money"]'); await sleep(40);
    assert.equal(loan(w, m).amount, 100, 'nothing changed in a read-only view');
  } finally { d.close(); }
});

test('the old Trade Credits Settle / delete buttons do not silently close an items loan; money entries still settle as before', async () => {
  const d = await open({ pos_trade_credits: JSON.stringify([{ id: 'm1', timestamp: new Date().toISOString(), partyName: 'Old Pal', direction: 'i_owe', description: 'Borrowed cash', amount: 500, status: 'open', settledAt: null, linkedSaleId: null }]) });
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Shop A', [['Sugar 1kg', 2]]); const id = loan(w).id;
    w.eval(`settleTradeCredit(${JSON.stringify(id)})`); await sleep(120);
    assert.equal(loan(w).status, 'open', 'still open'); assert.match(w.document.getElementById('shop-loans-tab').textContent, /I give the items back/, 'took me to the loan screen');
    w.eval(`deleteTradeCredit(${JSON.stringify(id)})`); assert.equal(J(w, 'tradeCredits.filter(t => t.kind === "goods").length'), 1, 'not deleted');
    assert.equal(stock(w, 'S1'), 22);
    w.eval("settleTradeCredit('m1')"); assert.equal(J(w, "tradeCredits.find(t => t.id === 'm1').status"), 'settled', 'money entries behave as before');
  } finally { d.close(); }
});

test('overdue loans are flagged, the WhatsApp statement lists what is open with the net, and the phone is remembered for that shop', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Shop B', [['Sugar 1kg', 5]], { phone: '0712345678', due: '2020-01-01' });
    await newLoan(w, 'i_owe', 'Shop B', [['Cooking Oil 1L', 1]]);
    assert.match(w.document.getElementById('shop-loans-tab').textContent, /overdue 2020-01-01/);
    const st = w.SL.statement(w.SL.parties()[0]);
    assert.match(st, /Shop B/); assert.match(st, /You owe us: 5× Sugar 1kg = KES 500\.00 \(due 2020-01-01\)/); assert.match(st, /We owe you: 1× Cooking Oil 1L = KES 300\.00/); assert.match(st, /Net: you owe us KES 200\.00/);
    click(w, '[data-sl="new"][data-v="i_owe"]'); await sleep(40); input(w, 'sl-party', 'shop b'); assert.equal(w.document.getElementById('sl-phone').value, '0712345678', 'phone filled in from the earlier entry (any capital letters)');
  } finally { d.close(); }
});

test('a pharmacy batch item: lending takes it off the soonest-expiring batch; the batches still add up to the stock', async () => {
  const inv = [{ code: 'P1', type: 'item', name: 'Paracetamol', price: 20, wholesalePrice: 8, qty: 30, unit: 'pcs', vatCategory: 'A', batches: [{ id: 'b1', batchNumber: 'B1', expiryDate: '2027-01-01', qty: 10 }, { id: 'b2', batchNumber: 'B2', expiryDate: '2028-01-01', qty: 20 }] }];
  const d = await boot('pharmacy/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 1800 });
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'they_owe', 'Clinic X', [['Paracetamol', 12]]);
    const p = J(w, "inventory.find(x => x.code === 'P1')"); assert.equal(p.qty, 18); assert.equal(p.batches.reduce((s, b) => s + b.qty, 0), 18, 'batches add up'); assert.equal(p.batches.find((b) => b.id === 'b2').qty, 18, 'soonest-expiring batch used up first');
  } finally { d.close(); }
});

test('staff who had Trade Credits get Borrow & Lend; the loan survives a reload', async () => {
  const d = await open({ pos_staff: JSON.stringify([{ id: 'st1', name: 'Kim', roles: ['trade-credits-tab', 'sales-tab'], lockedDates: [], updatedAt: 1 }]) });
  let saved;
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await until(() => J(w, "staff[0].roles.includes('shop-loans-tab')"), 8000);
    assert.equal(J(w, "staff[0].roles.includes('shop-loans-tab')"), true);
    await newLoan(w, 'they_owe', 'Shop B', [['Sugar 1kg', 2]]); saved = { pos_trade_credits: w.localStorage.getItem('pos_trade_credits'), pos_inventory: w.localStorage.getItem('pos_inventory') };
  } finally { d.close(); }
  const d2 = await boot('index.html', { storage: { ...saved, pos_biz_name: 'My Duka' }, wait: 1500 });
  try { const w = d2.w; w.eval(QUIET); await goTab(w); assert.match(w.document.getElementById('shop-loans-tab').textContent, /Shop B[\s\S]*owes you KES 200\.00/); assert.equal(stock(w, 'S1'), 18); }
  finally { d2.close(); }
});

test('I borrowed from a shop AND lent to the same shop: "cancel out" nets them, oldest first, with no stock or money moving', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET); await goTab(w);
    await newLoan(w, 'i_owe', 'Shop B', [['Cooking Oil 1L', 1]]);       // I owe 300
    await newLoan(w, 'they_owe', 'Shop B', [['Sugar 1kg', 5]]);          // they owe 500
    const before = { s: stock(w, 'S1'), o: stock(w, 'O1') };
    click(w, '[data-sl="offset"]'); await sleep(80);
    assert.equal(loan(w, 0).status, 'settled'); assert.deepEqual([loan(w, 1).status, loan(w, 1).amount], ['open', 200]);
    assert.deepEqual({ s: stock(w, 'S1'), o: stock(w, 'O1') }, before, 'stock untouched');
    assert.equal(w.document.querySelector('[data-sl="offset"]'), null, 'no button once only one direction is left');
    assert.match(w.document.getElementById('shop-loans-tab').textContent, /owes you KES 200\.00/);
    assert.equal(loan(w, 1).events.at(-1).type, 'offset');
  } finally { d.close(); }
});
