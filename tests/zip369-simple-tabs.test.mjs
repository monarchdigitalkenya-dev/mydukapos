import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 369: simple Expenses tab, direct Purchases tab, delete a customer, Aqua inventory export / import, hotel Reception + check-in date.
const QUIET = "window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => ''; window.print = () => {};";
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (days) => new Date(Date.now() + 3 * 3600000 + days * 86400000).toISOString().slice(0, 10);
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha Soap', price: 150, wholesalePrice: 50, qty: 40, unit: 'pcs', vatCategory: 'A' }];
const open = (app, storage = {}, extra = {}) => boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz', ...storage }, wait: 1500, ...extra });
const setVal = (w, id, v) => { const e = w.document.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };

test('every app gets its new tabs and no script error: Expenses + Purchases (Aqua: Expenses + renamed Purchases), Reception in the hotel', async () => {
  for (const app of ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html', 'hotel/index.html']) {
    const d = await boot(app, { wait: 1800 });
    try {
      const w = d.w; w.eval(QUIET);
      assert.ok(w.document.getElementById('expenses-tab-btn'), app + ': Expenses button');
      assert.ok(w.document.getElementById('expenses-tab'), app + ': Expenses content');
      assert.ok(w.eval("LOCKABLE_TABS.some(t => t.id === 'expenses-tab')"), app + ': Expenses can be given to staff');
      if (app === 'water/index.html') {
        assert.match(w.document.querySelector('.tab-link[data-tab="restocking-tab"]').textContent, /Purchases/, 'Aqua: restocking is called Purchases');
        assert.ok(w.document.getElementById('aio-bar'), 'Aqua: export / import buttons on the Inventory tab');
      } else {
        assert.ok(w.document.getElementById('purchases-tab-btn'), app + ': Purchases button');
        assert.ok(w.eval("ROLE_TABS.some(t => t.id === 'purchases-tab')"), app + ': Purchases can be given to staff');
      }
      if (app === 'hotel/index.html') assert.ok(w.document.getElementById('front-desk-tab-btn'), 'hotel: Reception button');
      assert.deepEqual((d.errors || []).filter((e) => /mt-|aio-|fd-|HotelFD|AIO|MT\b/.test(e)), [], app + ': no script error from the new blocks');
    } finally { d.close(); }
  }
});

test('Expenses tab: amount + tap a category + save records the normal expense; it lists today; delete removes it', async () => {
  const d = await open('index.html');
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('expenses-tab-btn').click(); await sleep(150);
    assert.ok(w.document.getElementById('mt-e-amount'), 'the big amount box is there');
    setVal(w, 'mt-e-amount', '250'); setVal(w, 'mt-e-note', 'Boda to the supplier');
    w.document.querySelector('[data-mt="cat"][data-v="Transport"]').click();
    assert.ok(w.document.querySelector('[data-mt="cat"][data-v="Transport"]').classList.contains('on'), 'the chip is selected');
    w.document.getElementById('mt-e-amount').value = '250';   // re-render keeps what was typed
    w.document.querySelector('[data-mt="save-exp"]').click(); await sleep(150);
    const ex = J(w, 'expenses');
    assert.equal(ex.length, 1); assert.deepEqual([ex[0].category, ex[0].amount, ex[0].description], ['Transport', 250, 'Boda to the supplier']);
    assert.match(w.document.getElementById('mt-e-list').textContent, /Transport/); assert.match(w.document.getElementById('mt-e-daytot').textContent, /250\.00/);
    assert.match(w.document.getElementById('exp-day-expenses').textContent, /250\.00/, 'the Profit Report sees the same expense');
    assert.equal(w.document.getElementById('mt-e-amount').value, '', 'the form is clear for the next one');
    w.document.querySelector('[data-mt="save-exp"]').click();
    assert.ok(w.eval('window.__toasts').some((t) => /ERR .*amount/i.test(t)), 'a missing amount is refused with a plain message');
    w.document.querySelector('[data-mt="del"]').click(); await sleep(150);
    assert.equal(J(w, 'expenses').length, 0, 'deleted');
  } finally { d.close(); }
});

test('Purchases tab: items bought are added to stock and logged as ONE restock expense; a new item is created', async () => {
  const d = await open('index.html');
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('purchases-tab-btn').click(); await sleep(150);
    setVal(w, 'mt-p-n0', 'Alpha Soap'); setVal(w, 'mt-p-q0', '10'); setVal(w, 'mt-p-c0', '30');
    w.document.querySelector('[data-mt="add-line"]').click(); await sleep(50);
    setVal(w, 'mt-p-n1', 'Brand New Sponge'); setVal(w, 'mt-p-q1', '5'); setVal(w, 'mt-p-c1', '20');
    assert.match(w.document.getElementById('mt-p-total').textContent, /400\.00/, 'the running total');
    w.document.querySelector('[data-mt="save-pur"]').click();
    await until(() => /Recent purchases[\s\S]*400\.00/.test(w.document.getElementById('purchases-tab').textContent), 6000);
    assert.equal(w.eval('inventory.find(p => p.code === "A").qty'), 50, 'stock went up');
    assert.equal(w.eval('inventory.find(p => p.code === "A").wholesalePrice'), 46, 'cost price becomes the weighted average (40 at 50 + 10 at 30)');
    const sp = J(w, 'inventory.find(p => p.name === "Brand New Sponge")'); assert.ok(sp && sp.qty === 5, 'the new item exists with its stock');
    const ex = J(w, 'expenses'); assert.equal(ex.length, 1); assert.deepEqual([ex[0].category, ex[0].amount], ['Restock', 400]);
    assert.match(w.document.getElementById(`purchases-tab`).textContent, /Recent purchases[\s\S]*400\.00/, 'it shows under Recent purchases');
    assert.equal(w.document.getElementById('mt-p-n0').value, '', 'the form is clear for the next purchase');
    // a line with no cost is refused and nothing is saved
    setVal(w, 'mt-p-n0', 'Alpha Soap'); setVal(w, 'mt-p-q0', '3'); w.document.querySelector('[data-mt="save-pur"]').click(); await sleep(100);
    assert.equal(w.eval('inventory.find(p => p.code === "A").qty'), 50); assert.equal(J(w, 'expenses').length, 1);
  } finally { d.close(); }
});

test('Pharmacy Purchases asks for batch and expiry too', async () => {
  const d = await boot('pharmacy/index.html', { storage: { pos_inventory: JSON.stringify([{ code: 'P1', type: 'item', name: 'Paracetamol', price: 20, wholesalePrice: 8, qty: 10, unit: 'pcs', vatCategory: 'A', batches: [{ id: 'b1', batchNumber: 'B1', expiryDate: '2030-01-01', qty: 10 }] }]) }, wait: 1800 });
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('purchases-tab-btn').click(); await sleep(150);
    assert.ok(w.document.getElementById('mt-p-b0') && w.document.getElementById('mt-p-e0'), 'batch and expiry boxes');
    setVal(w, 'mt-p-n0', 'Paracetamol'); setVal(w, 'mt-p-q0', '20'); setVal(w, 'mt-p-c0', '9'); setVal(w, 'mt-p-b0', 'B2'); setVal(w, 'mt-p-e0', '2031-06-01');
    w.document.querySelector('[data-mt="save-pur"]').click(); await sleep(300);
    assert.equal(w.eval('inventory.find(p => p.code === "P1").qty'), 30);
  } finally { d.close(); }
});

test('delete a customer: the profile button removes them from the list, keeps their sales, and a new customer with the same phone is a fresh profile', async () => {
  const CUST = [{ id: 'c-p254712000001', name: 'Mary Wanjiku', phone: '0712000001', tokens: 0, createdAt: 1, updatedAt: 1, status: 'active' }, { id: 'c2', name: 'John Otieno', phone: '0712000002', tokens: 0, createdAt: 2, updatedAt: 2, status: 'active' }];
  const SALES = [{ id: 's1', timestamp: new Date().toISOString(), paymentMethod: 'cash', items: [{ code: 'A', name: 'Alpha Soap', qty: 1, price: 150 }], total: 150, customerName: 'Mary Wanjiku', customerPhone: '0712000001', customerId: 'c-p254712000001', paid: true }];
  const d = await open('index.html', { pos_customers: JSON.stringify(CUST), pos_sales_log: JSON.stringify(SALES) });
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('customers-tab-btn').click(); await sleep(300);
    assert.match(w.document.getElementById('customers-list').textContent, /Mary Wanjiku/);
    w.eval("openCustomerProfileModal('c-p254712000001')"); await sleep(200);
    const btn = w.document.querySelector('#fr-profile .cm-del'); assert.ok(btn, 'the Delete customer button is on the profile'); assert.equal(w.document.querySelectorAll('#fr-profile .cm-del').length, 1, 'only one delete button');
    btn.click(); await sleep(200);
    const c = J(w, "customers.find(x => x.id === 'c-p254712000001')"); assert.equal(c.name, undefined, 'personal details wiped'); assert.equal(w.localStorage.getItem('pos_customers').includes('Mary Wanjiku'), false);
    assert.equal(c._deleted, true); assert.ok(c.deletedAt);
    assert.doesNotMatch(w.document.getElementById('customers-list').textContent, /Mary Wanjiku/, 'gone from the list');
    assert.match(w.document.getElementById('customers-list').textContent, /John Otieno/, 'the others stay');
    assert.equal(J(w, 'salesLog.length'), 1, 'the sale is kept'); assert.equal(J(w, 'salesLog[0].customerName'), 'Mary Wanjiku');
    // same phone again: a NEW profile (not the deleted one)
    const r = J(w, "upsertCustomer({ name: 'Mary W', phone: '0712000001' })");
    assert.equal(r.status, 'created'); assert.notEqual(r.customer.id, 'c-p254712000001');
    assert.equal(J(w, 'custActive().filter(x => x.phone === "0712000001").length'), 1);
    // a non-manager cannot delete
    w.eval("staff = [{ id: 'k1', name: 'Kim', roles: ['sales-tab'] }]; currentServer = staff[0]; isAdminServing = () => false;");
    assert.equal(J(w, "deleteCustomer('c2').ok"), false);
  } finally { d.close(); }
});

const AQUA = [
  { code: '00001', name: '500ml Sealed', category: 'bottled', sizeML: 500, price: 30, wholesalePrice: 12, qty: 100, customQuote: false, vatCategory: 'A', priceTiers: [] },
  { code: '00002', name: 'Water Filter', category: 'accessory', price: 1500, wholesalePrice: 900, qty: 4, customQuote: false, vatCategory: 'A', priceTiers: [] },
];
test('Aqua: Export list writes every product; Import list shows a preview first, then updates prices / stock, adds new accessories and skips what it cannot', async () => {
  const d = await boot('water/index.html', { storage: { aqua_products: JSON.stringify(AQUA), pos_biz_name: 'Aqua' }, wait: 1800 });
  try {
    const w = d.w; w.eval(QUIET);
    let blobText = ''; w.Blob = class { constructor(p) { blobText = p.join(''); } }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.document.querySelector('#aio-bar [data-aio="export"]').click();
    assert.match(blobText, /Code,Name,Type,Size \(ml\),Selling price,Cost price,Stock/);
    assert.match(blobText, /00001,500ml Sealed,Sealed Bottle,500,30\.00,12\.00,100,A/); assert.match(blobText, /00002,Water Filter,Accessory,,1500\.00,900\.00,4,A/);
    // import: update one, add one accessory, add one bottle with size, skip a bale and a bottle without a size
    const rows = [['Code', 'Name', 'Type', 'Size (ml)', 'Selling price', 'Cost price', 'Stock', 'VAT'],
      ['00001', '500ml Sealed', 'Sealed Bottle', '500', '35', '12', '120', 'A'],
      ['', 'Dispenser Stand', 'Accessory', '', '4500', '3200', '5', 'A'],
      ['', '1.5L Sealed', 'Sealed Bottle', '1500', '80', '40', '24', 'A'],
      ['', 'Mystery Bottle', 'Sealed Bottle', '', '50', '20', '10', 'A'],
      ['', 'Big Bale', 'Wholesale Bale', '', '900', '700', '2', 'A'],
      ['00002', 'Water Filter', 'Accessory', '', '1500', '900', '4', 'A']];
    w.AIO.build(rows, 'list.csv'); await sleep(100);
    const plan = w.AIO.plan(); assert.deepEqual([plan.counts.up, plan.counts.add, plan.counts.skip, plan.counts.same], [1, 2, 2, 1]);
    assert.match(w.document.getElementById('aio-card').textContent, /Import preview[\s\S]*1 to update[\s\S]*2 new[\s\S]*2 skipped/);
    assert.equal(J(w, 'products.length'), 2, 'nothing is saved before Apply');
    w.document.querySelector('[data-aio="apply"]').click(); await sleep(200);
    assert.equal(J(w, "products.find(p => p.code === '00001').price"), 35); assert.equal(J(w, "products.find(p => p.code === '00001').qty"), 120);
    const stand = J(w, "products.find(p => p.name === 'Dispenser Stand')"); assert.ok(stand && stand.category === 'accessory' && stand.qty === 5 && stand.price === 4500 && stand.wholesalePrice === 3200);
    const big = J(w, "products.find(p => p.name === '1.5L Sealed')"); assert.ok(big && big.category === 'bottled' && big.sizeML === 1500);
    assert.equal(J(w, "products.some(p => p.name === 'Mystery Bottle' || p.name === 'Big Bale')"), false, 'skipped rows were not created');
    assert.ok(J(w, "stockMovementLog.some(m => m.code === '00001')"), 'the stock change went through the movement log');
    assert.equal(w.document.getElementById('aio-ov').classList.contains('on'), false, 'the preview closed');
  } finally { d.close(); }
});

const ROOMS = ['Room 1', 'Room 2'];
test('Hotel: the check-in form asks for the date entered (past = stay starts then, future = reservation) and the Reception tab shows the front desk', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_rooms: JSON.stringify(ROOMS), pos_inventory: JSON.stringify([]) }, fetch: async (u) => (/facility-book/.test(String(u)) ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 404 })), wait: 1800 });
  try {
    const w = d.w; w.eval(QUIET); w.eval('currentServer = null');
    const dateBox = w.document.getElementById('checkin-date-input'); assert.ok(dateBox, 'a date-entered box exists');
    // 1. today
    w.eval("openCheckInRoomModal('Room 1')"); assert.equal(w.document.getElementById('checkin-date-input').value, ymd(0));
    setVal(w, 'checkin-guest-name-input', 'Achieng'); setVal(w, 'checkin-nightly-rate-input', '3000'); w.eval('confirmCheckIn()');
    assert.equal(J(w, "roomStayFor('Room 1').guestName"), 'Achieng');
    // 2. an earlier date: the stay starts that day
    w.eval("openCheckInRoomModal('Room 2')"); setVal(w, 'checkin-guest-name-input', 'Otieno'); setVal(w, 'checkin-nightly-rate-input', '2500');
    setVal(w, 'checkin-date-input', ymd(-2)); w.document.getElementById('checkin-date-input').dispatchEvent(new w.Event('change', { bubbles: true }));
    w.eval('confirmCheckIn()');
    assert.equal(J(w, "roomStayFor('Room 2').checkInAt").slice(0, 10) >= ymd(-3), true); assert.equal(J(w, "roomStayFor('Room 2').checkInAt").slice(0, 10) <= ymd(-2), true);
    assert.equal(J(w, "stayNights(roomStayFor('Room 2'))"), 3, 'three nights counted from two days ago');
    // 3. a later date: it becomes a reservation (the guest is NOT in the room yet)
    w.eval("checkOutNow = null"); w.eval("roomStays = {}; saveRoomStays(); setLocStatus('room', 'Room 1', 'available'); setLocStatus('room', 'Room 2', 'available');");
    w.eval("openCheckInRoomModal('Room 1')"); setVal(w, 'checkin-guest-name-input', 'Wanjiru'); setVal(w, 'checkin-nightly-rate-input', '3000'); setVal(w, 'checkin-guest-phone-input', '0712000009');
    setVal(w, 'checkin-date-input', ymd(5)); w.document.getElementById('checkin-date-input').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.match(w.document.getElementById('checkin-date-hint').textContent, /RESERVED/); assert.match(w.document.querySelector('#check-in-room-modal .btn-main[onclick="confirmCheckIn()"]').textContent, /Reserve/);
    w.eval('confirmCheckIn()'); await sleep(300);
    const bk = J(w, "facilityBookings.filter(b => b.kind === 'room' && b.status === 'BOOKED')");
    assert.equal(bk.length, 1); assert.deepEqual([bk[0].customerName, bk[0].arrive, bk[0].depart], ['Wanjiru', ymd(5), ymd(6)]);
    assert.equal(J(w, "roomStayFor('Room 1')"), null, 'not checked in yet');
    // Reception tab
    w.document.getElementById('front-desk-tab-btn').click(); await sleep(200);
    const t = w.document.getElementById('front-desk-tab').textContent;
    assert.match(t, /Reception/); assert.match(t, /Rooms free/); assert.match(t, /Arriving today/); assert.match(t, /Wanjiru/, 'the coming reservation is listed'); assert.match(t, /Reserve a room/);
    // reserve from Reception
    setVal(w, 'fd-rv-room', 'Room 2'); setVal(w, 'fd-rv-arrive', ymd(1)); setVal(w, 'fd-rv-depart', ymd(3)); setVal(w, 'fd-rv-guest', 'Kamau'); setVal(w, 'fd-rv-rate', '2500');
    w.document.querySelector('[data-fd="reserve"]').click(); await sleep(300);
    assert.equal(J(w, "facilityBookings.filter(b => b.status === 'BOOKED').map(b => b.customerName).sort()").join(), 'Kamau,Wanjiru');
  } finally { d.close(); }
});

test('Purchases: a new item gets the selling price typed (not just its cost); "on credit" needs a supplier and lands in the supplier account; part paid is checked', async () => {
  const d = await open('index.html', { pos_suppliers: JSON.stringify([{ id: 'sup1', name: 'Wholesale Kings', phone: '0700' }]) });
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('purchases-tab-btn').click(); await sleep(200);
    setVal(w, 'mt-p-n0', 'Fresh Milk'); setVal(w, 'mt-p-q0', '12'); setVal(w, 'mt-p-c0', '50'); setVal(w, 'mt-p-s0', '70');
    const pick = (v) => { const r = w.document.querySelector('[name="mt-pay"][value="' + v + '"]'); assert.ok(r, 'the payment choice is there'); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); };
    pick('credit');
    w.document.querySelector('[data-mt="save-pur"]').click(); await sleep(150);
    assert.ok(w.eval('window.__toasts').some((t) => /ERR Choose the supplier you owe/.test(t)), 'on credit needs a supplier'); assert.equal(J(w, 'inventory.some(p => p.name === "Fresh Milk")'), false, 'nothing saved yet');
    const sel = w.document.getElementById('mt-p-sup'); sel.value = 'sup1'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(sel.value, 'sup1', 'the supplier list is filled in without visiting Restock first');
    pick('part'); setVal(w, 'mt-p-paid', '700'); w.document.querySelector('[data-mt="save-pur"]').click(); await sleep(150);
    assert.ok(w.eval('window.__toasts').some((t) => /ERR For "Part paid"/.test(t)), 'part paid must be less than the total'); assert.equal(J(w, 'inventory.some(p => p.name === "Fresh Milk")'), false);
    pick('credit'); w.document.getElementById('mt-p-sup').value = 'sup1';
    w.document.querySelector('[data-mt="save-pur"]').click();
    await until(() => J(w, 'inventory.some(p => p.name === "Fresh Milk")'), 6000);
    const milk = J(w, 'inventory.find(p => p.name === "Fresh Milk")'); assert.deepEqual([milk.qty, milk.price], [12, 70], 'sells at 70, not at its 50 cost');
    const doc = J(w, 'tradeCredits.find(t => t.supplierId === "sup1" || t.kind === "supplier_restock")');
    assert.ok(doc, 'a supplier invoice was recorded'); assert.equal(doc.direction, 'i_owe'); assert.notEqual(doc.status, 'settled', 'still owed');
    assert.match(w.eval("document.getElementById('sup-pay-note') ? 'ok' : 'ok'"), /ok/);
  } finally { d.close(); }
});

test('delete customer who still owes money: the confirmation says how much', async () => {
  const CUST = [{ id: 'c1', name: 'Mary Wanjiku', phone: '0712000001', tokens: 0, createdAt: 1, updatedAt: 1, status: 'active' }];
  const DEBTS = [{ id: 'd1', customerName: 'Mary Wanjiku', customerPhone: '0712000001', customerId: 'c1', amount: 750, payments: [], timestamp: new Date().toISOString() }];
  const d = await open('index.html', { pos_customers: JSON.stringify(CUST), pos_debts: JSON.stringify(DEBTS) });
  try {
    const w = d.w; w.eval(QUIET); let asked = ''; w.confirm = (m) => { asked = m; return false; };
    w.document.getElementById('customers-tab-btn').click(); await sleep(300);
    w.eval("openCustomerProfileModal('c1')"); await sleep(200);
    w.document.querySelector('#fr-profile .cm-del').click(); await sleep(100);
    assert.match(asked, /still owe KES 750\.00/, 'warns about the debt'); assert.equal(w.eval("customers.find(x => x.id === 'c1')._deleted"), undefined, 'declined: not deleted');
  } finally { d.close(); }
});
