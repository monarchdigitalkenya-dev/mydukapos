import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE } from './helpers.mjs';

// zip 253: Receipt Settings (barcode, VAT, inline PAID/UNPAID) and the pack-price cost calculator, in every POS app.
const REF = 'ref-00000042';
const hasRaster = (w) => {
  const b = Array.from(w.eval("(typeof buildReceiptEscPosBytes === 'function') ? buildReceiptEscPosBytes(lastReceiptHeader, lastReceiptItemSection, lastReceiptFooter) : buildEscPosBytes(lastReceiptText)"));
  for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x1D && b[i + 1] === 0x76 && b[i + 2] === 0x30 && b[i + 3] === 0x00) return true;
  return false;
};
const render = (w, sale) => { w.eval(`renderReceipt(${JSON.stringify({ ...SAMPLE_SALE, refNumber: REF, ...sale })});`); return w.eval('lastReceiptText'); };

for (const app of APPS) {
  test(`${app}: defaults - Ref number prints, but no barcode, no VAT table`, async () => {
    const { w, errors, close } = await boot(app);
    const t = render(w, {});
    assert.match(t, new RegExp('Ref: ' + REF));
    assert.equal(hasRaster(w), false, 'barcode is off by default');
    assert.doesNotMatch(t, /VAT/i, 'VAT is off by default');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: switches on - barcode and VAT print; setting persists and syncs`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_receipt_show_barcode: 'true', pos_receipt_print_vat: 'true' } });
    const t = render(w, {});
    assert.equal(hasRaster(w), true, 'barcode printed');
    assert.match(t, /VAT/i, 'VAT printed');
    const c = w.eval('extraSettingsCollect()');
    assert.equal(c.receiptShowBarcode, true);
    assert.equal(c.receiptPrintVat, true);
    w.eval("extraSettingsApply({ receiptShowBarcode: false, receiptPrintVat: false })");
    assert.equal(w.localStorage.getItem('pos_receipt_show_barcode'), 'false');
    assert.equal(w.localStorage.getItem('pos_receipt_print_vat'), 'false');
    render(w, {});
    assert.equal(hasRaster(w), false);
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: PAID / UNPAID sit on the TOTAL line, with no stamp image`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_receipt_stamp_paid: 'true' } });
    let t = render(w, {});
    assert.match(t, /TOTAL - PAID/);
    t = render(w, { paymentMethod: 'bill' });
    assert.match(t, /TOTAL - UNPAID/);
    t = render(w, { paymentMethod: 'cash', paid: false });
    assert.match(t, /UNPAID/);
    w.eval('rxSettings.paidMark = false');
    t = render(w, {});
    assert.doesNotMatch(t, /PAID/);
    w.eval('rxSettings.paidMark = true');
    const html = w.eval("receiptStampBlockHtml({ paymentMethod: 'cash' })");
    assert.doesNotMatch(String(html || ''), /<img[^>]*paid/i, 'no separate paid image');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: Receipt Settings card has the print options`, async () => {
    const { w, d, errors, close } = await boot(app);
    w.eval('if (typeof rxStampInstallUI === "function") rxStampInstallUI()');
    for (const id of ['rx-print-ref', 'rx-print-barcode', 'rx-print-vat', 'rx-stamp-paid']) assert.ok(d.getElementById(id), id + ' exists');
    assert.equal(d.getElementById('rx-print-barcode').checked, false);
    assert.equal(d.getElementById('rx-print-vat').checked, false);
    assert.deepEqual(errors, []);
    close();
  });
}

const ITEM_APPS = APPS.filter((a) => a !== 'water/index.html');
for (const app of ITEM_APPS) {
  test(`${app}: pack price / pieces gives the per-piece cost and is saved`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 900 });
    w.eval('showToast = function () {};');
    assert.ok(d.getElementById('inv-pack-card'), 'pack card exists');
    d.getElementById('inv-name').value = 'Soda Crate';
    d.getElementById('inv-price').value = '80'; d.getElementById('inv-qty').value = '10';
    d.getElementById('inv-pack-price').value = '1200';
    d.getElementById('inv-pack-pieces').value = '24';
    d.getElementById('inv-pack-pieces').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(Number(d.getElementById('inv-wholesale-price').value), 50);
    assert.match(d.getElementById('inv-pack-result').textContent, /50/);
    d.getElementById('inv-pack-price').value = '1440';
    d.getElementById('inv-pack-price').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(Number(d.getElementById('inv-wholesale-price').value), 60, 'recalculates on change');
    w.eval('saveInventoryItem()');
    const it = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Soda Crate'))"));
    assert.ok(it, 'saved');
    assert.equal(it.wholesalePrice, 60);
    assert.equal(it.packPrice, 1440);
    assert.equal(it.packPieces, 24);
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: invalid or partial pack values block the save; unused pack leaves item unchanged`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 900 });
    w.eval('showToast = function () {};');
    const fire = (id) => d.getElementById(id).dispatchEvent(new w.Event('input', { bubbles: true }));
    d.getElementById('inv-name').value = 'Bad Pack';
    d.getElementById('inv-price').value = '80'; d.getElementById('inv-qty').value = '10';
    d.getElementById('inv-pack-price').value = '1200'; fire('inv-pack-price');
    w.eval('saveInventoryItem()');
    assert.equal(w.eval("inventory.some(p => p.name === 'Bad Pack')"), false, 'price without pieces blocked');
    d.getElementById('inv-pack-pieces').value = '0'; fire('inv-pack-pieces');
    w.eval('saveInventoryItem()');
    assert.equal(w.eval("inventory.some(p => p.name === 'Bad Pack')"), false, 'zero pieces blocked');
    d.getElementById('inv-pack-pieces').value = '2.5'; fire('inv-pack-pieces');
    w.eval('saveInventoryItem()');
    assert.equal(w.eval("inventory.some(p => p.name === 'Bad Pack')"), false, 'fractional pieces blocked');
    d.getElementById('inv-pack-price').value = '-5'; d.getElementById('inv-pack-pieces').value = '4'; fire('inv-pack-price');
    w.eval('saveInventoryItem()');
    assert.equal(w.eval("inventory.some(p => p.name === 'Bad Pack')"), false, 'negative price blocked');
    // individually purchased item: untouched workflow
    d.getElementById('inv-pack-price').value = ''; d.getElementById('inv-pack-pieces').value = ''; fire('inv-pack-price');
    d.getElementById('inv-wholesale-price').value = '30';
    w.eval('saveInventoryItem()');
    const it = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Bad Pack'))"));
    assert.ok(it, 'saved when pack unused');
    assert.equal(it.wholesalePrice, 30);
    assert.equal(it.packPrice, undefined);
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: with "also sold individually" the box cost and pieces-per-box are kept and piece cost derives`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 900 });
    w.eval('showToast = function () {};');
    const dual = d.getElementById('inv-has-dual-unit');
    assert.ok(dual, 'dual-unit option present');
    d.getElementById('inv-name').value = 'Biscuit Box';
    d.getElementById('inv-price').value = '1500'; d.getElementById('inv-qty').value = '10';
    dual.checked = true; w.eval('toggleDualUnitBuilder()');
    d.getElementById('inv-piece-price').value = '70';
    d.getElementById('inv-pack-price').value = '1200';
    d.getElementById('inv-pack-pieces').value = '24';
    d.getElementById('inv-pack-pieces').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(Number(d.getElementById('inv-wholesale-price').value), 1200, 'box cost stays the pack price');
    assert.equal(Number(d.getElementById('inv-units-per-box').value), 24);
    w.eval('saveInventoryItem()');
    const it = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Biscuit Box'))"));
    assert.ok(it, 'saved');
    assert.equal(it.wholesalePrice, 1200);
    assert.equal(it.unitsPerBox, 24);
    assert.equal(it.pieceWholesalePrice, 50);
    assert.deepEqual(errors, []);
    close();
  });
}

test('water/index.html: Add Product accepts pack price and pieces', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { wait: 900 });
  assert.ok(d.getElementById('inv-pack-card'), 'pack card exists');
  assert.ok(d.getElementById('product-cost-input'));
  d.getElementById('inv-pack-price').value = '1200';
  d.getElementById('inv-pack-pieces').value = '24';
  d.getElementById('inv-pack-pieces').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(Number(d.getElementById('product-cost-input').value), 50);
  assert.deepEqual(errors, []);
  close();
});
