import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPS, boot, ROOT } from './helpers.mjs';

// The Orders tab (purchase orders) exists in every app that has the shared Restock-style tab.
// Aqua POS (water) has a different Restocking design and is deliberately excluded.
const ORDER_APPS = APPS.filter((a) => a !== 'water/index.html');

const CAM = { type: 'item', code: 'CAM1', name: 'Hikvision 2MP Bullet', price: 9000, wholesaleSellingPrice: 8000, wholesalePrice: 6500, qty: 3, unit: 'pcs', location: '', vatCategory: 'A', expiryDate: null, image: null };

function type(w, el, value, evt = 'input') {
  el.value = value;
  el.dispatchEvent(new w.Event(evt, { bubbles: true }));
}
const byId = (d, id) => d.getElementById(id);

// Creates an order through the real form (typing into inputs, pressing Save), one line per spec.
function makeOrder(w, d, { supplier = '', note = '', lines }) {
  w.eval('poOpenForm()');
  type(w, byId(d, 'po-supplier-input'), supplier);
  type(w, byId(d, 'po-note-input'), note);
  lines.forEach((ln, i) => {
    if (i > 0) w.eval('poAddRow()');
    const row = w.eval('poState().draft')[i];
    const id = row.rowId;
    if (ln.name != null) { type(w, byId(d, `po-row-${id}-name`), ln.name); byId(d, `po-row-${id}-name`).dispatchEvent(new w.Event('change', { bubbles: true })); }
    if (ln.code != null) type(w, byId(d, `po-row-${id}-code`), ln.code);
    if (ln.qty != null) type(w, byId(d, `po-row-${id}-qty`), ln.qty);
    if (ln.cost != null) type(w, byId(d, `po-row-${id}-cost`), ln.cost);
    if (ln.retail != null) type(w, byId(d, `po-row-${id}-retail`), ln.retail);
    if (ln.wholesale != null) type(w, byId(d, `po-row-${id}-wholesale`), ln.wholesale);
  });
  const before = w.eval('purchaseOrders.length');
  d.querySelector('#po-form-panel .po-form-actions .btn-main').click();   // 💾 Save Order
  return { saved: w.eval('purchaseOrders.length') > before, msg: byId(d, 'po-form-msg').textContent };
}
const lastOrder = (w) => w.eval('purchaseOrders[purchaseOrders.length - 1]');
const inv = (w, code) => w.eval(`inventory.find(p => p.code === ${JSON.stringify(code)})`);
const invByName = (w, name) => w.eval(`inventory.filter(p => p.name === ${JSON.stringify(name)})`);

function openArrive(w, d, orderId) {
  w.eval(`poOpenArriveModal(${JSON.stringify(orderId)})`);
  return byId(d, 'orders-arrive-modal');
}

for (const app of ORDER_APPS) {
  test(`${app}: Orders tab sits right after Restock, is permission-gated, and order → in transit → arrived updates inventory`, async () => {
    const { w, d, errors, close } = await boot(app);
    w.confirm = () => true;

    // --- placement + permissions ---
    const restockBtn = d.querySelector('.tab-link[data-tab="restock-tab"]');
    assert.equal(restockBtn.nextElementSibling.dataset.tab, 'orders-tab', 'Orders button is immediately after Restock');
    assert.match(restockBtn.nextElementSibling.textContent, /Orders/);
    assert.ok(w.eval("LOCKABLE_TABS.some((t) => t.id === 'orders-tab')"), 'can be locked');
    assert.ok(w.eval("ROLE_TABS.some((t) => t.id === 'orders-tab')"), 'can be granted to a staff role');
    assert.ok(d.querySelector('#orders-tab.tab-content'), 'tab panel exists');

    // --- open the tab ---
    w.eval('inventory.length = 0'); w.eval(`inventory.push(${JSON.stringify(CAM)})`);
    d.querySelector('.tab-link[data-tab="orders-tab"]').click();
    assert.ok(byId(d, 'orders-tab').classList.contains('active'));
    assert.match(byId(d, 'po-orders-tbody').textContent, /No active orders/);

    // --- create: existing product (blank wholesale) + brand-new product ---
    const r = makeOrder(w, d, {
      supplier: 'Hikvision Kenya', note: 'For Mr. Otieno',
      lines: [
        { name: 'Hikvision 2MP Bullet', qty: '4', cost: '6800', retail: '9500' },
        { name: 'Dahua 8CH NVR', qty: '2', cost: '12000', retail: '16000', wholesale: '14500' },
      ],
    });
    assert.ok(r.saved, 'order saved: ' + r.msg);
    const order = lastOrder(w);
    assert.equal(order.orderNo, 'PO-0001');
    assert.equal(order.status, 'pending');
    assert.ok(Math.abs(Date.now() - Date.parse(order.createdAt)) < 60000, 'timestamped automatically');
    assert.equal(order.supplierName, 'Hikvision Kenya');
    assert.equal(order.items.length, 2);
    assert.equal(order.items[0].code, 'CAM1', 'picking an existing product links its code');
    assert.equal(order.items[0].retailPrice, 9500);
    assert.equal(order.items[0].wholesalePrice, null, 'optional wholesale price left blank stays null');
    assert.equal(order.items[1].wholesalePrice, 14500);
    assert.ok(w.eval("suppliers.some((s) => s.name === 'Hikvision Kenya')"), 'a newly typed origin joins the suppliers list');
    assert.ok(JSON.parse(w.localStorage.getItem('pos_purchase_orders')).length === 1, 'persisted');
    assert.equal(byId(d, 'po-form-panel').style.display, 'none', 'form closes after saving');

    // list shows the required columns
    const heads = [...d.querySelectorAll('#po-orders-table thead th')].map((th) => th.textContent.trim());
    for (const h of ['Date & Time', 'Supplier', 'Total Items', 'Status', 'Actions']) assert.ok(heads.includes(h), `column ${h}`);
    const rowText = d.querySelector('#po-orders-tbody tr').textContent;
    assert.match(rowText, /PO-0001/); assert.match(rowText, /Hikvision Kenya/); assert.match(rowText, /2 items/); assert.match(rowText, /Pending/);

    // nothing touches stock before arrival
    assert.equal(inv(w, 'CAM1').qty, 3);
    assert.equal(w.eval('inventory.length'), 1);

    // --- pending -> in transit ---
    d.querySelector('#po-orders-tbody .po-btn-transit').click();
    assert.equal(lastOrder(w).status, 'in_transit');
    assert.match(d.querySelector('#po-orders-tbody tr').textContent, /In Transit/);
    assert.equal(d.querySelectorAll('#po-orders-tbody .po-btn-transit').length, 0, 'no In Transit button once in transit');

    // --- arrived: confirmation dialog lists items, then commits ---
    const expensesBefore = w.eval('expenses.length'), movesBefore = w.eval('stockMovementLog.length');
    d.querySelector('#po-orders-tbody .po-btn-arrived').click();
    const modal = byId(d, 'orders-arrive-modal');
    assert.equal(modal.style.display, 'flex');
    const arriveRows = [...d.querySelectorAll('#po-arrive-table tbody tr')];
    assert.equal(arriveRows.length, 2, 'dialog lists the ordered items');
    assert.match(arriveRows[0].textContent, /Hikvision 2MP Bullet/);
    assert.match(byId(d, `po-arrive-stock-${order.items[0].id}`).textContent, /3\s*→\s*7/, 'shows stock before → after');
    assert.match(byId(d, `po-arrive-stock-${order.items[1].id}`).textContent, /New product/);
    assert.equal(byId(d, 'po-arrive-expense-amount').textContent, 'KES 51200.00');

    byId(d, 'po-arrive-confirm-btn').click();
    assert.equal(modal.style.display, 'none');

    const cam = inv(w, 'CAM1');
    assert.equal(cam.qty, 7, 'existing stock increased by the ordered quantity');
    assert.equal(cam.wholesalePrice, 6800, 'cost price updated');
    assert.equal(cam.price, 9500, 'retail price updated');
    assert.equal(cam.wholesaleSellingPrice, 8000, 'wholesale price left blank → unchanged');
    const nvr = invByName(w, 'Dahua 8CH NVR');
    assert.equal(nvr.length, 1, 'unknown product was created');
    assert.equal(nvr[0].qty, 2); assert.equal(nvr[0].price, 16000); assert.equal(nvr[0].wholesaleSellingPrice, 14500); assert.equal(nvr[0].wholesalePrice, 12000);
    assert.ok(nvr[0].code, 'new product got a code');
    assert.equal(w.eval('purchaseOrders[0].status'), 'received');
    assert.ok(w.eval('purchaseOrders[0].receivedAt'));
    assert.equal(w.eval('stockMovementLog.length') - movesBefore, 2, 'both lines logged (server reconciles quantities from this log)');
    const moves = w.eval('stockMovementLog.slice(-2)');
    assert.deepEqual([...moves].map((m) => m.delta).sort(), [2, 4]);
    assert.ok(moves.every((m) => /^Order PO-0001 received/.test(m.reason)));
    assert.equal(w.eval('expenses.length') - expensesBefore, 1);
    const exp = w.eval('expenses[expenses.length - 1]');
    assert.equal(exp.category, 'Restock'); assert.equal(exp.amount, 51200); assert.match(exp.description, /PO-0001/);
    assert.ok(JSON.parse(w.localStorage.getItem('pos_inventory')).some((p) => p.name === 'Dahua 8CH NVR'), 'inventory persisted');

    // confirming again (double tap / stale dialog) must never add the stock twice
    w.eval('poConfirmArrival()');
    assert.equal(inv(w, 'CAM1').qty, 7);
    assert.equal(w.eval('expenses.length') - expensesBefore, 1);

    // active list is now empty, received list has it
    assert.match(byId(d, 'po-orders-tbody').textContent, /No active orders/);
    w.eval("poSetFilter('received')");
    assert.match(d.querySelector('#po-orders-tbody tr').textContent, /Received/);

    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: partial arrivals, edit/cancel rules, validation, injection safety and sync behaviour`, async () => {
    const { w, d, errors, close } = await boot(app);
    w.confirm = () => true;
    w.eval('inventory.length = 0'); w.eval(`inventory.push(${JSON.stringify(CAM)})`);
    d.querySelector('.tab-link[data-tab="orders-tab"]').click();

    // --- validation ---
    let r = makeOrder(w, d, { lines: [{ name: 'Thing', qty: '', cost: '10' }] });
    assert.equal(r.saved, false); assert.match(r.msg, /quantity/i);
    w.eval('poCloseForm()');
    r = makeOrder(w, d, { lines: [{ name: 'Thing', qty: '2', cost: '10', retail: '-5' }] });
    assert.equal(r.saved, false); assert.match(r.msg, /Retail price/);
    w.eval('poCloseForm()');
    r = makeOrder(w, d, { lines: [{ name: '', qty: '', cost: '' }] });
    assert.equal(r.saved, false); assert.match(r.msg, /at least one item/i);
    w.eval('poCloseForm()');
    assert.equal(w.eval('purchaseOrders.length'), 0);

    // --- injection safety: hostile supplier / item / note render as text everywhere ---
    const evil = '<img src=x onerror="window.__pwn=1">';
    r = makeOrder(w, d, { supplier: evil, note: '"><b id="pwnb">x</b>', lines: [
      { name: 'Alpha "quoted" \' item', qty: '5', cost: '10' },
      { name: 'Beta' + evil, qty: '3', cost: '20' },
      { name: 'Gamma', qty: '1', cost: '30' },
    ] });
    assert.ok(r.saved, r.msg);
    const o1 = lastOrder(w);
    d.querySelector('#po-orders-tbody .po-btn-details').click();
    openArrive(w, d, o1.id);
    assert.equal(d.querySelectorAll('#orders-tab img, #orders-arrive-modal img').length, 0, 'no injected <img>');
    assert.equal(byId(d, 'pwnb'), null); assert.equal(w.__pwn, undefined);
    assert.match(d.querySelector('#po-arrive-table tbody').textContent, /Alpha "quoted" ' item/);
    w.eval('poCloseArriveModal()');

    // --- partial arrival: untick Gamma, short-receive Beta (2 of 3) ---
    const [a, b, c] = o1.items;
    w.eval('poMarkInTransit(' + JSON.stringify(o1.id) + ')');
    openArrive(w, d, o1.id);
    w.eval(`poArriveToggleLine(${JSON.stringify(c.id)}, false)`);
    type(w, byId(d, `po-arrive-qty-${b.id}`), '2');
    assert.match(byId(d, `po-arrive-stock-${c.id}`).textContent, /Not arrived/);
    assert.equal(byId(d, 'po-arrive-expense-amount').textContent, 'KES 90.00', 'expense covers only what arrived (5×10 + 2×20)');
    byId(d, 'po-arrive-confirm-btn').click();
    let o = w.eval('purchaseOrders[0]');
    assert.equal(o.status, 'in_transit', 'order stays open while items are outstanding');
    assert.deepEqual([...o.items].map((i) => i.receivedQty), [5, 2, 0]);
    assert.equal(invByName(w, 'Alpha "quoted" \' item')[0].qty, 5);
    assert.equal(invByName(w, 'Gamma').length, 0, 'unticked item not added');
    d.querySelector('.po-chip[data-filter="active"]').click();
    assert.match(d.querySelector('#po-orders-tbody tr').textContent, /2 of 3 items received/);

    // committed lines are history: no edit, no cancel; can close short
    w.eval('poOpenForm(' + JSON.stringify(o1.id) + ')');
    assert.equal(byId(d, 'po-form-panel').style.display, 'none', 'cannot edit an order once stock was received');
    w.eval('poCancelOrder(' + JSON.stringify(o1.id) + ')');
    assert.equal(w.eval('purchaseOrders[0].status'), 'in_transit');
    assert.ok(d.querySelector('#po-orders-tbody .po-btn-edit'), 'Close order button offered');

    // second arrival: only the outstanding remainder is offered; completes the order
    openArrive(w, d, o1.id);
    const rows = [...d.querySelectorAll('#po-arrive-table tbody tr')];
    assert.match(rows[0].textContent, /Already received/);
    assert.equal(byId(d, `po-arrive-qty-${b.id}`).value, '1', 'defaults to the outstanding remainder');
    byId(d, 'po-arrive-confirm-btn').click();
    o = w.eval('purchaseOrders[0]');
    assert.equal(o.status, 'received');
    assert.equal(invByName(w, 'Beta' + evil).length, 1, 'no duplicate product created');
    assert.equal(invByName(w, 'Beta' + evil)[0].qty, 3);
    assert.equal(invByName(w, 'Gamma')[0].qty, 1);
    assert.equal(w.eval("expenses.filter((e) => e.category === 'Restock').length"), 2);

    // --- edit an untouched order, then cancel it, then remove it ---
    r = makeOrder(w, d, { supplier: 'Sup B', lines: [{ name: 'Delta', qty: '1', cost: '5' }] });
    assert.ok(r.saved, r.msg);
    const o2 = lastOrder(w);
    assert.equal(o2.orderNo, 'PO-0002');
    w.eval('poOpenForm(' + JSON.stringify(o2.id) + ')');
    assert.equal(byId(d, 'po-form-panel').style.display, '');
    assert.equal(byId(d, 'po-supplier-input').value, 'Sup B');
    const row = w.eval('poState().draft')[0];
    type(w, byId(d, `po-row-${row.rowId}-qty`), '7');
    d.querySelector('#po-form-panel .po-form-actions .btn-main').click();
    assert.equal(w.eval('purchaseOrders.length'), 2, 'editing does not create a new order');
    assert.equal(lastOrder(w).items[0].qty, 7);
    assert.equal(lastOrder(w).orderNo, 'PO-0002');
    const invBefore = w.eval('inventory.length');
    w.eval('poCancelOrder(' + JSON.stringify(o2.id) + ')');
    assert.equal(lastOrder(w).status, 'cancelled');
    assert.equal(w.eval('inventory.length'), invBefore, 'cancelling never touches stock');
    w.eval("poSetFilter('cancelled')");
    assert.match(d.querySelector('#po-orders-tbody tr').textContent, /PO-0002/);
    w.eval('poRemoveOrder(' + JSON.stringify(o2.id) + ')');
    assert.equal(lastOrder(w).removed, true, 'removal is a tombstone so sync cannot resurrect it');
    w.eval("poSetFilter('all')");
    assert.doesNotMatch(byId(d, 'po-orders-tbody').textContent, /PO-0002/);

    // --- sync: payload carries orders, stamps updatedAt, and an older payload never wipes them ---
    const payload = w.eval('collectSyncPayload()');
    assert.ok(Array.isArray(payload.purchaseOrders) && payload.purchaseOrders.length === 2);
    assert.ok(payload.purchaseOrders.every((p) => typeof p.updatedAt === 'number'), 'every order is stamped for per-record merging');
    const legacy = JSON.parse(JSON.stringify(payload)); delete legacy.purchaseOrders;
    w.eval(`applyRemotePayload(${JSON.stringify(legacy)})`);
    assert.equal(w.eval('purchaseOrders.length'), 2, 'payload from an older build (no field) leaves local orders alone');
    const remote = JSON.parse(JSON.stringify(payload)); remote.purchaseOrders = [{ ...payload.purchaseOrders[0], supplierName: 'Renamed remotely' }];
    w.eval(`applyRemotePayload(${JSON.stringify(remote)})`);
    assert.equal(w.eval('purchaseOrders.length'), 1);
    assert.equal(w.eval('purchaseOrders[0].supplierName'), 'Renamed remotely');
    assert.equal(JSON.parse(w.localStorage.getItem('pos_purchase_orders'))[0].supplierName, 'Renamed remotely');

    assert.deepEqual(errors, []);
    close();
  });
}

test('pharmacy: an arrived order becomes a new batch on batch-tracked items; hospital keeps plain qty', async () => {
  for (const [app, expectBatch] of [['pharmacy/index.html', true], ['hospital/index.html', false]]) {
    const { w, d, errors, close } = await boot(app);
    const item = { ...CAM, code: 'MED1', name: 'Amoxicillin 500mg', qty: 10, expiryDate: '2027-01-01', batches: [{ id: 'b1', batchNumber: 'A', batchNo: 'A', expiryDate: '2027-01-01', qty: 4 }] };
    if (!expectBatch) item.qty = 10;   // hospital: qty is the real stock figure, batches are only cosmetic FEFO hints
    w.eval('inventory.length = 0'); w.eval(`inventory.push(${JSON.stringify(item)})`);
    if (expectBatch) w.eval("inventory[0].qty = 4");
    d.querySelector('.tab-link[data-tab="orders-tab"]').click();
    const r = makeOrder(w, d, { lines: [{ name: 'Amoxicillin 500mg', qty: '6', cost: '30' }] });
    assert.ok(r.saved, r.msg);
    w.eval('poMarkInTransit(purchaseOrders[0].id)');
    openArrive(w, d, w.eval('purchaseOrders[0].id'));
    byId(d, 'po-arrive-confirm-btn').click();
    const p = inv(w, 'MED1');
    if (expectBatch) {
      assert.equal(p.batches.length, 2, 'new stock is its own batch');
      assert.equal(p.qty, 10, 'qty stays the sum of its batches');
      assert.equal(p.expiryDate, '2027-01-01', 'nearest expiry unchanged');
    } else {
      assert.equal(p.qty, 16); assert.equal(p.batches.length, 1);
    }
    assert.deepEqual(errors, []);
    close();
  }
});

test('pos-sync server merges purchase orders per record (newer wins, never dropped by a stale device)', async () => {
  const { onRequestPost } = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const store = new Map();
  const kv = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
  store.set('license:C1', JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop' }));
  store.set('license-index:v1', JSON.stringify([{ id: 'C1', slug: 'shop', type: 'permanent', businessName: 'Shop A' }]));
  const env = { mydukapos_kv: kv };
  const post = (body) => onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const t = Date.now();
  await post({ updatedAt: t, businessName: 'Shop A', purchaseOrders: [{ id: 'po1', orderNo: 'PO-0001', status: 'pending', updatedAt: t - 3000 }] });
  // device B marks it received (newer) and adds a second order
  await post({ updatedAt: t + 1, businessName: 'Shop A', purchaseOrders: [{ id: 'po1', orderNo: 'PO-0001', status: 'received', updatedAt: t - 2000 }, { id: 'po2', orderNo: 'PO-0002', status: 'pending', updatedAt: t - 1500 }] });
  // device A, offline until now, pushes its OLD copy of po1 and knows nothing of po2
  await post({ updatedAt: t + 2, businessName: 'Shop A', purchaseOrders: [{ id: 'po1', orderNo: 'PO-0001', status: 'pending', updatedAt: t - 3000 }] });
  const saved = JSON.parse(store.get('pos-data:state:C1'));
  const byId2 = Object.fromEntries(saved.purchaseOrders.map((o) => [o.id, o]));
  assert.equal(byId2.po1.status, 'received', 'stale push cannot revert a newer status');
  assert.ok(byId2.po2, 'an order the stale device did not know about is kept');
});
