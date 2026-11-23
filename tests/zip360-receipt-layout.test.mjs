import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 360 — Settings > Receipts > Receipt layout: "Standard" (unchanged) or "Detailed" (boxed document like a printed quotation / invoice).
// The Detailed layout is built from the same facts as the Standard one, for screen, system print, PDF, USB and Bluetooth.
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html'];
const SHOP = "businessName = 'Kawsar Auto Spares Ltd.'; receiptEmail = 'sales@example.com'; receiptContact = '0722 000111'; receiptExtraInfo = 'P.O BOX 83208-80100 Mombasa'; etimsPin = 'P051139232W'; "
  + "if (typeof paymentDetails !== 'undefined') paymentDetails = 'MPESA PAYBILL: 899600\\nAccount Number: Your Name'; if (typeof billPaymentDetails !== 'undefined') billPaymentDetails = 'MPESA PAYBILL: 899600\\nAccount Number: Your Name'; receiptFooterNotes = 'Nyali branch - Petrocity Links Road';";
const ITEMS = [
  { code: 'TSMTG0127', name: 'Support mount front', price: 1040, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'TCOSR0031', name: 'Dust cover front shock absorber with a very long name that must wrap', price: 800, qty: 2, unit: 'pcs', vatCategory: 'A' },
];
const T = '2026-11-07T07:42:16.000Z';

for (const app of APPS) {
  test(`${app}: Detailed layout - every section, correct totals, nothing wider than the paper; Standard unchanged when switched back`, { timeout: 240000 }, async () => {
    const b = await boot(app, { storage: { pos_receipt_print_vat: 'true' }, wait: 900 });
    const { w } = b; w.eval(SHOP);
    const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    w.__s = { id: 's1', refNumber: 'R-000123', timestamp: T, paid: true, paymentMethod: 'cash', amountTendered: 4000, change: 320, servedBy: 'Zulfikar', customerName: 'Kashif Auto Spares', remarks: 'NCP160 0015956', items: ITEMS };
    const std = w.eval('buildReceiptDoc(__s, {}).text');
    assert.equal(w.eval('receiptLayoutNow()'), 'standard', 'Standard by default');
    // switch to Detailed (as the settings radio does) and fill the layout texts
    w.eval(`rxSettings.layout = 'detailed'; rxSettings.detailed = rxDetailedClean({ branch: 'SHOP (MAIN)', notice: 'PLEASE NOTE: Goods once sold cannot be returned.', thanks: 'Thank you! We look forward to serving you again.' });`);
    const doc = JSON.parse(w.eval('JSON.stringify(buildReceiptDoc(__s, {}))'));
    assert.equal(doc.layout, 'detailed', 'the detailed builder ran (no fall-back)');
    const text = doc.text;
    for (const want of ['KAWSAR AUTO SPARES LTD.', 'P.O BOX 83208-80100 Mombasa', 'TEL: 0722 000111', 'Email: sales@example.com', 'PIN No: P051139232W', 'Branch:', 'SHOP (MAIN)', 'Doc No:', 'R-000123',
      'Date & Time:', 'Served By:', 'Zulfikar', 'Customer:', 'Kashif Auto Spares', 'Remarks:', 'NCP160 0015956', '1. TSMTG0127', 'SUPPORT MOUNT FRONT', '2. TCOSR0031', 'Total Breakdown:',
      'Amount (excl. VAT):', 'VAT:', 'Prepared By: Zulfikar', 'PLEASE NOTE: Goods once sold', 'MPESA PAYBILL: 899600', 'Thank you! We look forward', 'NOTES: Nyali branch', 'Ref: R-000123', 'XX - END - XX', 'Payment Method: CASH']) {
      assert.ok(text.includes(want), `${app}: missing "${want}"\n${text}`);
    }
    assert.match(text, /16% {2}1,040\.00 x 2\s+2,080\.00/, 'item line: VAT %, price x qty, total');
    assert.match(text, /TOTAL\s+KES 3680\.00/, 'grand total');
    assert.match(text, /Amount \(excl\. VAT\):\s+3,172\.41/); assert.match(text, /VAT:\s+507\.59/);
    const cols = w.eval('getPaperCols()');
    const tooWide = [...doc.headerLines, ...doc.lines, ...doc.footerLines].filter((l) => String(l).length > cols);
    assert.deepEqual(tooWide, [], `lines wider than ${cols} columns`);
    assert.ok(w.eval('receiptBigTotalFlags(' + JSON.stringify(doc.lines) + ').some(Boolean)'), 'the total prints big and bold on thermal printers too');
    assert.match(doc.html, /class="rcd"/); assert.match(doc.html, /rcd-det/); assert.match(doc.html, /KES 3,680\.00/); assert.match(doc.html, /XX - END - XX/);
    // the on-screen receipt uses it, and the PDF / printer text matches it
    w.eval("var rb = document.getElementById('receipt-body'); if (!rb) { rb = document.createElement('div'); rb.id = 'receipt-body'; document.body.appendChild(rb); }");
    if (typeof w.renderSharedReceipt === 'function') { w.eval('renderSharedReceipt(__s, {})'); assert.match(w.document.getElementById('receipt-body').innerHTML, /class="rcd"/); assert.equal(w.eval('lastReceiptText'), text); }
    // a bill (part paid) and a split payment build too
    w.__b = { ...w.__s, id: 's2', paid: false, paymentMethod: 'bill', amountPaid: 500, tableOrRoom: 'Table 5' };
    const bill = w.eval('buildReceiptDoc(__b, {}).text');
    assert.match(bill, /BALANCE/); assert.match(bill, /Please settle via:/); assert.match(bill, /Order:\s+Table 5|Order:\s+5/);
    // 58 mm paper: still nothing too wide
    w.eval("try { receiptWidth = '58'; } catch (e) {} try { localStorage.setItem('pos_receipt_device_width', '58'); } catch (e) {}");
    const cols58 = w.eval('getPaperCols()');
    const d58 = JSON.parse(w.eval('JSON.stringify(buildReceiptDoc(__s, {}))'));
    assert.deepEqual([...d58.headerLines, ...d58.lines, ...d58.footerLines].filter((l) => String(l).length > cols58), [], `58 mm: lines wider than ${cols58}`);
    // back to Standard: byte-identical to before
    w.eval("try { receiptWidth = '80'; } catch (e) {} try { localStorage.removeItem('pos_receipt_device_width'); } catch (e) {} rxSettings.layout = 'standard';");
    assert.equal(w.eval('buildReceiptDoc(__s, {}).text'), std, 'Standard layout is unchanged');
    assert.deepEqual(errs, []);
    b.close();
  });
}

test('the layout and its texts travel with the shop settings (another till picks them up); a fresh till never resets them', { timeout: 120000 }, async () => {
  const a = await boot('index.html', { wait: 900 });
  a.w.eval("localStorage.setItem('pos_receipt_layout', 'detailed'); rxSettings.layout = 'detailed'; rxSettings.detailed = rxDetailedClean({ branch: 'NYALI', notice: 'Terms here' }); localStorage.setItem('pos_receipt_detailed', JSON.stringify(rxSettings.detailed));");
  const sent = JSON.parse(a.w.eval('JSON.stringify(extraSettingsCollect())'));
  assert.equal(sent.receiptLayout, 'detailed'); assert.equal(sent.receiptDetailed.branch, 'NYALI');
  const b = await boot('index.html', { wait: 900 });
  const fresh = JSON.parse(b.w.eval('JSON.stringify(extraSettingsCollect())'));
  assert.equal(fresh.receiptLayout, undefined, 'a fresh till sends no layout of its own'); assert.equal(fresh.receiptDetailed, undefined);
  b.w.__d = sent; b.w.eval('extraSettingsApply(__d)');
  assert.equal(b.w.eval('receiptLayoutNow()'), 'detailed'); assert.equal(b.w.eval('rxDetailedOpts().notice'), 'Terms here');
  assert.equal(b.w.eval("localStorage.getItem('pos_receipt_layout')"), 'detailed', 'kept on the other till');
  a.close(); b.close();
});

test('Settings > Receipts: the layout picker switches the layout, saves the texts and shows a preview', { timeout: 120000 }, async () => {
  const b = await boot('index.html', { wait: 900 });
  const { w } = b; const d = w.document; w.eval(SHOP);
  w.eval("showToast = function () {}; rxStampInstallUI && rxStampInstallUI()");
  assert.ok(d.getElementById('rx-layout-card'), 'the card is in Receipt Settings');
  assert.ok(d.querySelector('#rx-layout-card input[value="standard"]').checked);
  const det = d.querySelector('#rx-layout-card input[value="detailed"]'); det.checked = true; det.dispatchEvent(new w.Event('change'));
  assert.equal(w.eval('receiptLayoutNow()'), 'detailed'); assert.equal(w.eval("localStorage.getItem('pos_receipt_layout')"), 'detailed');
  assert.ok(d.getElementById('rxl-dt').classList.contains('on'), 'the Detailed texts appear');
  d.getElementById('rxl-branch').value = 'SHOP (MAIN)'; d.getElementById('rxl-notice').value = 'PLEASE NOTE: test';
  d.getElementById('rxl-save').click();
  assert.equal(JSON.parse(w.eval("localStorage.getItem('pos_receipt_detailed')")).branch, 'SHOP (MAIN)');
  d.getElementById('rxl-preview-btn').click();
  const prev = d.getElementById('rxl-prev');
  assert.match(prev.innerHTML, /class="rcd"/); assert.match(prev.textContent, /SHOP \(MAIN\)/); assert.match(prev.textContent, /PLEASE NOTE: test/);
  const std = d.querySelector('#rx-layout-card input[value="standard"]'); std.checked = true; std.dispatchEvent(new w.Event('change'));
  assert.equal(w.eval('receiptLayoutNow()'), 'standard');
  b.close();
});

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'water/index.html']) {
  test(`${app}: 💰 Sales is back on the counter, the ↓ Sort button sits right after it, and a tap changes the order`, { timeout: 120000 }, async () => {
    const b = await boot(app, { storage: { pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', category: 'G', price: 100, qty: 9, unit: 'pcs' }]) }, wait: 900 });
    const { w } = b; const d = w.document;
    for (let i = 0; i < 30 && !d.getElementById('grid-sort-btn'); i++) await new Promise((r) => setTimeout(r, 200));
    const s = d.getElementById('my-sales-toggle-btn'), g = d.getElementById('grid-sort-btn');
    assert.ok(s && g, 'both buttons exist');
    assert.equal(s.nextElementSibling, g, 'Sort is right after Sales');
    assert.notEqual(w.getComputedStyle(s).display, 'none', 'the Sales button is shown');
    assert.equal(g.textContent.trim(), '↓', 'Sort is just a down arrow');
    assert.match(g.title, /Product order:/);
    const before = w.eval('posGridMode()');
    w.eval('showToast = function () {}'); g.click();
    assert.notEqual(w.eval('posGridMode()'), before, 'a tap switches the order');
    b.close();
  });
}
