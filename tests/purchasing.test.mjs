import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Restock and Orders: low-stock items as tappable buttons that add themselves to the form (quantity box ready); send the order to the supplier
// on WhatsApp.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Alpha Tin', price: 100, wholesalePrice: 60, qty: 1, unit: 'pcs', vatCategory: 'A' },
  { code: 'B2', type: 'item', name: 'Beta Pack', price: 50, wholesalePrice: 30, qty: 3, unit: 'pcs', vatCategory: 'A' },
  { code: 'C3', type: 'item', name: 'Gamma Bag', price: 80, wholesalePrice: 40, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: 'S1', type: 'service', name: 'Fitting', price: 500, unit: 'use', vatCategory: 'A' },
]);
const SUP = JSON.stringify([{ id: 's1', name: 'EABL', phone: '0712345678' }]);
async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: INV, pos_suppliers: SUP }, wait: 1500 });
  b.w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true; window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }");
  return b;
}
const chipNames = (d, id) => [...d.querySelectorAll(`#${id} .lowstock-chip`)].map((c) => c.textContent.replace(/\s+/g, ' ').trim());

for (const app of APPS) {
  test(`${app}: low-stock items show as buttons on Restock; a tap puts the item on the form with its quantity box ready; "add all" adds the rest`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    w.eval('renderRestockRows()');
    let chips = chipNames(d, 'restock-lowstock-strip');
    assert.equal(chips.length, 2, 'only the two low items — not the well-stocked one, not the service');
    assert.match(chips[0], /Alpha Tin.*1/); assert.match(chips[1], /Beta Pack.*3/);
    assert.match(d.querySelector('#restock-lowstock-strip .settings-small-btn').textContent, /Add all \(2\)/, '"Add all" when there are several');
    const chip = d.querySelector('#restock-lowstock-strip .lowstock-chip');
    chip.click();
    assert.equal(w.eval('restockDraft.filter(r => r.code === "A1").length'), 1, 'on the form');
    const row = JSON.parse(w.eval('JSON.stringify(restockDraft.find(r => r.code === "A1"))'));
    assert.equal(row.name, 'Alpha Tin'); assert.equal(row.cost, '60', 'the last cost is filled in');
    assert.equal(row.qty, '', 'the quantity is left for you');
    assert.equal(d.activeElement && d.activeElement.getAttribute('inputmode'), 'decimal', 'the quantity box has the cursor');
    assert.match(d.querySelector('#restock-lowstock-strip .lowstock-chip.added').textContent, /✓/, 'the tapped chip shows it is added');
    w.eval("updateRestockRowField(" + row.rowId + ", 'qty', '12')");
    assert.equal(w.eval('restockRowLineTotal(restockDraft.find(r => r.code === "A1"))'), 720, '12 x 60');
    assert.equal(w.eval('restockDraft.length'), 1, 'the spare blank row was used, not left behind');
    assert.equal(d.querySelector('#restock-lowstock-strip .settings-small-btn'), null, 'with one left there is no "Add all"');
    w.eval("lowStockAddAll('restock')");
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(restockDraft.map(r => r.code))')), ['A1', 'B2']);
    w.eval("lowStockAdd('restock', 'A1')");
    assert.equal(w.eval('restockDraft.length'), 2, 'the same item is never added twice');
    assert.deepEqual(errors, []);
    b.close();
  });

  test(`${app}: on the Orders tab a low-stock tap opens the order form with that item; the order can be saved and sent to the supplier on WhatsApp`, async () => {
    const b = await session(app);
    const { w, d, errors } = b;
    w.eval("renderOrdersTab()");
    assert.equal(d.getElementById('po-lowstock-panel').style.display, '', 'the low-stock panel is shown');
    assert.equal(chipNames(d, 'po-lowstock-chips').length, 2);
    d.querySelector('#po-lowstock-chips .lowstock-chip').click();
    assert.notEqual(d.getElementById('po-form-panel').style.display, 'none', 'the order form opened by itself');
    const rows = JSON.parse(w.eval('JSON.stringify(poState().draft)'));
    assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Alpha Tin'); assert.equal(rows[0].code, 'A1'); assert.equal(rows[0].cost, '60');
    assert.equal(d.activeElement && d.activeElement.id, `po-row-${rows[0].rowId}-qty`, 'cursor in the quantity box');
    w.eval("lowStockAdd('po', 'B2')");
    assert.equal(w.eval('poState().draft.length'), 2);
    assert.equal(chipNames(d, 'po-lowstock-chips').every((c) => /✓/.test(c)), true, 'both are marked added');
    // enter quantities and save
    for (const r of JSON.parse(w.eval('JSON.stringify(poState().draft)'))) w.eval(`poUpdateRowField(${r.rowId}, 'qty', '10')`);
    d.getElementById('po-supplier-input').value = 'EABL';
    w.eval('poSaveOrder()');
    const o = JSON.parse(w.eval('JSON.stringify(purchaseOrders[0])'));
    assert.equal(o.items.length, 2); assert.equal(o.items[0].qty, 10); assert.equal(o.supplierName, 'EABL');
    // send on WhatsApp
    w.eval(`poSendOrder('${o.id}')`);
    const url = w.eval('window.__opened[0]');
    assert.match(url, /^https:\/\/wa\.me\/254712345678\?text=/);
    const text = decodeURIComponent(url.split('text=')[1]);
    assert.match(text, new RegExp(o.orderNo.replace(/[-]/g, '\\-'))); assert.match(text, /Alpha Tin × 10 pcs @ KES 60/); assert.match(text, /Total: KES 900/);
    assert.ok(w.eval(`purchaseOrders[0].sentToSupplierAt`), 'remembered that it was sent');
    // the order list has a WhatsApp button (and no M-Pesa one)
    w.eval("poState().expanded['" + o.id + "'] = true; renderOrdersList()");
    const html = d.getElementById('po-orders-table').innerHTML;
    assert.match(html, /poSendOrder/); assert.match(d.getElementById('po-orders-table').textContent, /WhatsApp/); assert.doesNotMatch(html, /Mpesa|M-Pesa/i);
    assert.match(d.getElementById('po-orders-table').textContent, /Sent to supplier/);
    // "Save & send on WhatsApp" from the form does both in one tap
    w.eval("window.__opened.length = 0; lowStockAdd('po', 'B2')");
    for (const r of JSON.parse(w.eval('JSON.stringify(poState().draft)'))) w.eval(`poUpdateRowField(${r.rowId}, 'qty', '4')`);
    d.getElementById('po-supplier-input').value = 'EABL';
    assert.match(d.getElementById('po-form-panel').innerHTML, /Save &amp; send on WhatsApp/);
    w.eval('poSaveOrder(true)');
    assert.equal(w.eval('purchaseOrders.length'), 2, 'saved');
    assert.match(w.eval('window.__opened[0]'), /^https:\/\/wa\.me\/254712345678\?text=/, 'and sent');
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('sending an order to a supplier with no phone number asks for it once and remembers it', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: INV }, wait: 1500 });
  b.w.eval("showToast = function () {}; window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; window.prompt = () => '0722000111'");
  b.w.eval("purchaseOrders.push({ id: 'po-1', orderNo: 'PO-0001', supplierName: 'New Supplier', items: [{ id: 'l1', name: 'Alpha Tin', qty: 2, cost: 60, unit: 'pcs' }], status: 'pending', statusHistory: [] }); suppliers.push({ id: 's9', name: 'New Supplier', phone: '' })");
  b.w.eval("poSendOrder('po-1')");
  assert.match(b.w.eval('window.__opened[0]'), /wa\.me\/254722000111/);
  assert.equal(b.w.eval("suppliers.find(s => s.id === 's9').phone"), '0722000111');
  b.close();
});
