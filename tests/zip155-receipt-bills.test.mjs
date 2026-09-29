import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE, decodeEscPos } from './helpers.mjs';

const DELIVERY = () => Object.assign({}, SAMPLE_SALE, {
  orderType: 'delivery', deliveryAgentId: null,
  deliveryDetails: { address: 'Kilimani, Argwings Kodhek Rd, Blue gate', phone: '0712345678', fee: 200, clientName: 'John Mwangi', idNumber: '12345678', notes: 'Call on arrival', pod: false },
});
const STAMP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

for (const app of APPS) {
  test(`${app}: a delivery order prints the details + a signed confirmation, labelled for the client, and needs 2 copies`, async () => {
    const { w, d, errors, close } = await boot(app);
    w.eval('renderReceipt(' + JSON.stringify(DELIVERY()) + ')');
    const text = w.eval('lastReceiptText');
    for (const s of ['CLIENT COPY', 'DELIVERY DETAILS', 'Client: John Mwangi', 'Deliver to:', 'Phone: 0712345678', 'ID No: 12345678', 'Directions: Call on arrival', 'DELIVERY CONFIRMATION', 'Client signature:', 'Delivery person signature:']) assert.ok(text.includes(s), `${app}: has "${s}"`);
    assert.ok(/_{12,}/.test(text), 'blank lines to sign on');
    assert.ok(d.getElementById('receipt-body').textContent.includes('DELIVERY CONFIRMATION'), 'the preview shows it too');
    assert.equal(w.eval('receiptCopiesFor()'), 2, 'a delivery prints two copies even when the setting is 1');
    // the second copy is labelled for the delivery person
    w.eval('receiptCopyPrep(1)');
    assert.ok(w.eval('lastReceiptText').includes('DELIVERY PERSON COPY') && !w.eval('lastReceiptText').includes('CLIENT COPY'));
    assert.ok(w.eval('lastReceiptHeader').includes('DELIVERY PERSON COPY'));
    w.eval('receiptCopyPrep(0)');
    assert.ok(w.eval('lastReceiptText').includes('CLIENT COPY'));
    // an ordinary sale is untouched
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    const plain = w.eval('lastReceiptText');
    assert.ok(!/CLIENT COPY|DELIVERY CONFIRMATION/.test(plain), 'a walk-in receipt has no delivery block');
    assert.equal(w.eval('receiptCopiesFor()'), 1);
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: the delivery ID is optional (no ID -> a blank line to write it on) and the form has the two extra fields`, async () => {
    const { w, d, close } = await boot(app);
    assert.ok(d.getElementById('delivery-id-input') && d.getElementById('delivery-notes-input'), 'extra fields on the delivery form');
    const sale = DELIVERY(); delete sale.deliveryDetails.idNumber; delete sale.deliveryDetails.notes;
    w.eval('renderReceipt(' + JSON.stringify(sale) + ')');
    const text = w.eval('lastReceiptText');
    assert.ok(!/Directions:/.test(text), 'no directions line when none given');
    assert.ok(/ID No:\n_{12,}/.test(text), 'a blank line for the ID');
    d.getElementById('delivery-id-input').value = ' 999 '; d.getElementById('delivery-notes-input').value = 'gate';
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(deliveryExtraFieldsRead())')), { idNumber: '999', notes: 'gate' });
    w.eval('deliveryExtraFieldsClear()');
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(deliveryExtraFieldsRead())')), {});
    close();
  });

  test(`${app}: the stamp prints between the header and the item lines (screen) and as dots on a thermal printer`, async () => {
    const { w, d, errors, close } = await boot(app);
    assert.ok(d.getElementById('receipt-stamp-card'), 'the stamp card is in Settings > Receipts');
    assert.equal(w.eval('receiptStampBlockHtml()'), '', 'nothing without a stamp');
    w.eval(`extraSettingsApply({ receiptStampSrc: ${JSON.stringify(STAMP)}, receiptShowStamp: true, receiptStampAngle: -9, receiptStampSize: 60 })`);
    const html = w.eval('receiptStampBlockHtml()');
    assert.ok(html.includes('rotate(-9deg)') && html.includes('width:60%'), 'tilted and sized as chosen');
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    const rows = [...d.querySelectorAll('#receipt-body .receipt-grid > *')];
    const iStamp = rows.findIndex((e) => e.classList.contains('rg-stamp'));
    const iHead = rows.findIndex((e) => /^ITEM\s+QTY/.test(e.textContent.trim()));
    const iName = rows.findIndex((e) => /Served by/.test(e.textContent));
    assert.ok(iStamp > iName && iStamp < iHead, `stamp sits after the header (${iName}) and before the item lines (${iHead}), was ${iStamp}`);
    // switched off -> gone
    w.eval("extraSettingsApply({ receiptShowStamp: false })");
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    assert.ok(!d.querySelector('#receipt-body .rg-stamp'));
    // it travels with the shop's settings
    const c = w.eval('extraSettingsCollect()');
    assert.equal(c.receiptStampSrc, STAMP); assert.equal(c.receiptShowStamp, false); assert.equal(c.billsLocked, false);
    assert.equal(w.eval('collectSyncPayload().receiptStampSrc'), STAMP, 'in the sync payload');
    // a thermal printer: with a prepared raster the stamp bytes sit between the header and the items
    w.eval('extraSettingsApply({ receiptShowStamp: true })');
    const marker = new Uint8Array([0x1D, 0x76, 0x30, 0, 1, 0, 1, 0, 0xAA]);
    w.eval(`window.__stampRaster = { key: receiptStampRasterKey(), bytes: new Uint8Array([29,118,48,0,1,0,1,0,170]) }`);
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    const sectioned = w.eval("typeof buildReceiptEscPosBytes==='function'");
    const bytes = Array.from(sectioned ? w.eval('buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)') : w.eval('buildSectionedReceiptBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)'));
    const at = bytes.findIndex((b, i) => marker.every((m, j) => bytes[i + j] === m));
    assert.ok(at > 0, `${app}: the stamp raster is in the thermal bytes`);
    const before = String.fromCharCode(...bytes.slice(0, at).filter((b) => b >= 32 && b < 127)), after = String.fromCharCode(...bytes.slice(at).filter((b) => b >= 32 && b < 127));
    assert.ok(/Served by/.test(before) && /ITEM\s+QTY/.test(after), `${app}: after the header, before the items`);
    assert.deepEqual(errors, []);
    close();
  });
}

// ---------------------------------------------------------------- BILLS LOCK
const BILL = (id, siteId) => ({ id, siteId, total: 100, timestamp: new Date().toISOString(), customerName: 'Ann', paymentMethod: 'bill', paid: false, amountPaid: 0, servedBy: 'Jane',
  items: [{ code: '1', name: 'Thing', qty: 1, price: 100, unit: 'pcs', vatCategory: 'A' }] });
for (const app of APPS) {
  test(`${app}: bills lock — off by default; on: staff only view, the admin needs the admin password to settle`, async () => {
    const { w, d, errors, close } = await boot(app);
    const site = w.eval("typeof activeSiteId !== 'undefined' ? activeSiteId : null");
    w.eval(`bills.push(${JSON.stringify(BILL('b1', site))}); renderBillsTab();`);
    const has = (re) => [...d.querySelectorAll('#bills-tab button')].some((b) => re.test(b.getAttribute('onclick') || '') && b.style.display !== 'none');
    // default: off, the admin sees the switch, nothing is blocked
    assert.equal(w.eval('billsLockActive()'), false);
    assert.ok(d.getElementById('bills-lock-toggle'), 'the admin sees the lock switch');
    assert.ok(has(/openBillSettleModal/), 'Settle is there');
    let ran = 0;
    w.eval('window.__probe = 0');
    assert.equal(w.eval('billsLockGate("settle", function () { window.__probe++; return 7; })'), 7);
    assert.equal(w.eval('window.__probe'), 1, 'not locked: runs at once');
    // lock it (as the admin): now even the admin is asked for the password, nothing runs without it
    w.eval('rxSettings.billsLocked = true; window.__billsLockPassUntil = 0;');
    w.eval('window.__probe = 0; billsLockGate("settle", function () { window.__probe++; })');
    assert.equal(w.eval('window.__probe'), 0, 'locked: the admin password is asked first');
    const modalShown = w.eval("(document.getElementById('admin-pw-modal') || {style:{}}).style.display") !== 'none';
    assert.ok(modalShown, 'the admin password box is open');
    w.eval("var cb = window.__adminPwCallback; if (typeof cb === 'function') cb();");   // what the password box does after a correct password
    assert.equal(w.eval('window.__probe'), 1, 'after the password it runs');
    w.eval('window.__probe = 0; billsLockGate("settle", function () { window.__probe++; })');
    assert.equal(w.eval('window.__probe'), 1, 'the approval covers the next moments (Settle -> Confirm asks once)');
    // staff: cannot, and do not even see the buttons
    w.eval("try { currentServer = { id: 'st1', name: 'Jane' }; } catch (e) {}");
    w.eval('window.__billsLockPassUntil = 0; window.__probe = 0; billsLockGate("settle", function () { window.__probe++; }); renderBillsTab();');
    assert.equal(w.eval('window.__probe'), 0, 'staff are refused');
    assert.ok(!has(/openBillSettleModal|requestVoidSale|editBillDueDate|markBillCarried/), 'staff see no Settle / Void / Edit buttons');
    assert.ok(!d.getElementById('bills-lock-toggle'), 'staff never see the switch');
    assert.ok(/locked by the admin/.test(d.getElementById('bills-lock-bar').textContent), 'staff are told why');
    // the real settle path is guarded too
    w.eval('openBillSettleModal && openBillSettleModal(' + (app === 'water/index.html' ? "'b1'" : "'bill','b1'") + ')');
    assert.notEqual(w.eval("(document.getElementById('bill-settle-modal') || {style:{display:'none'}}).style.display"), 'flex', 'the settle window did not open for staff');
    // the lock reaches other devices through the shop settings
    assert.equal(w.eval('collectSyncPayload().billsLocked'), true);
    w.eval("extraSettingsApply({ billsLocked: false })");
    assert.equal(w.eval('billsLockActive()'), false);
    assert.deepEqual(errors, []);
    close();
  });
}
