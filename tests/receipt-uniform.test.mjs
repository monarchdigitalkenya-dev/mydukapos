import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE, decodeEscPos } from './helpers.mjs';

const STORE = {
  pos_biz_name: 'Mama Njeri Hardware', aqua_biz_name: 'Mama Njeri Hardware',
  pos_payment_details: 'Till 123456\nPaybill 400200 Acc 77', aqua_bill_payment_details: 'Till 123456\nPaybill 400200 Acc 77',
  pos_receipt_contact: '0700 111 222', aqua_receipt_contact: '0700 111 222',
  pos_receipt_footer_notes: 'Goods once sold not returnable', aqua_receipt_footer_notes: 'Goods once sold not returnable',
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const bill = () => Object.assign(clone(SAMPLE_SALE), { paymentMethod: 'bill', paid: false, amountPaid: 0, customerName: 'John' });
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
// What a person reads on screen: line breaks and table cells become spaces.
const previewText = (d) => collapse(d.getElementById('receipt-body').innerHTML
  .replace(/<(br|hr|\/td|\/tr|\/div)[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

// 1. Payment details print on EVERY receipt and bill, in the preview AND the printed text.
for (const app of APPS) {
  test(`${app}: payment details on a paid receipt and on a bill, preview and print`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: STORE });
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    let raw = w.eval('lastReceiptText'), preview = previewText(d);
    assert.match(raw, /Payment details:\nTill 123456\nPaybill 400200 Acc 77/, 'paid receipt (print)');
    assert.ok(preview.includes('Payment details: Till 123456 Paybill 400200 Acc 77'), 'paid receipt (preview)');
    w.eval('renderReceipt(' + JSON.stringify(bill()) + ')');
    raw = w.eval('lastReceiptText'); preview = previewText(d);
    assert.match(raw, /BILL \/ INVOICE/);
    assert.match(raw, /Please settle via:\nTill 123456\nPaybill 400200 Acc 77/, 'bill (print)');
    assert.ok(preview.includes('Please settle via: Till 123456 Paybill 400200 Acc 77'), 'bill (preview)');
    assert.deepEqual(errors, []);
    close();
  });
}

// 2. Same sale => the same receipt in every app (Shop's layout). Only Aqua POS prints a bare quantity ("2", not "2pcs").
test('every app prints the same receipt for the same sale', async () => {
  const outs = {};
  for (const app of APPS) {
    const { w, close } = await boot(app, { storage: STORE, wait: 700 });
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    outs[app] = w.eval('lastReceiptText').replace(/(\d)pcs/g, '$1').replace(/ +/g, ' ').replace(/Time: [\d:]+/, 'Time: T');
    close();
  }
  const ref = outs['index.html'];
  for (const app of APPS) assert.equal(outs[app], ref, `${app} differs from Shop's receipt`);
});

// Everything after the TOTAL row (payments, VAT, eTIMS): item rows are a table on screen, so they are compared separately.
const itemSummary = (t) => { const a = t.split('\n'); return a.slice(Math.max(0, a.findIndex((l) => /^(TOTAL|DUE NOW)\s+KES/.test(l)))).join('\n'); };

// 3. The preview and the printed text carry the same content (header, totals, payment, footer).
for (const app of APPS) {
  test(`${app}: preview shows every header/summary/footer line that is printed`, async () => {
    const { w, d, close } = await boot(app, { storage: STORE });
    for (const sale of [SAMPLE_SALE, bill()]) {
      w.eval('renderReceipt(' + JSON.stringify(sale) + ')');
      const preview = previewText(d);
      const sections = [w.eval('lastReceiptHeader'), w.eval('lastReceiptFooter'), itemSummary(w.eval('lastReceiptItemSection'))].join('\n');
      for (const line of sections.split('\n')) {
        if (!line.trim() || /^-+$/.test(line.trim())) continue;
        assert.ok(preview.includes(collapse(line)), `${app}: printed line missing from preview: "${line}"`);
      }
    }
    close();
  });
}

// 4. Aqua POS specifics: delivery / pay-on-delivery / instalment records use the same layout.
test('water: delivery + pay-on-delivery lines are in the preview and the print', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { storage: STORE });
  const sale = Object.assign(clone(SAMPLE_SALE), { orderType: 'delivery', paymentMethod: 'pod', paid: false, total: 2500,
    deliveryDetails: { address: 'Ruaka', phone: '0711 000 111', fee: 200, clientName: 'Ann', pod: true, freeDelivery: false } });
  w.eval('renderReceipt(' + JSON.stringify(sale) + ')');
  const raw = w.eval('lastReceiptText'), preview = previewText(d);
  for (const t of ['Deliver to: Ruaka', 'Delivery Fee: KES 200.00', '*** UNPAID — PAY ON DELIVERY ***', 'KES 2500.00']) {
    assert.ok(raw.includes(t), 'print: ' + t);
    assert.ok(preview.includes(t), 'preview: ' + t);
  }
  assert.deepEqual(errors, []);
  close();
});

test('water: prints on the configured paper width, with the configured copies, and USB gets a centred header', async () => {
  const seen = [];
  const { w, d, close } = await boot('water/index.html', { storage: STORE });
  w.print = () => {
    seen.push({ mm: d.body.style.getPropertyValue('--receipt-print-width'), page: d.getElementById('print-page-style').textContent,
      copies: d.querySelectorAll('#receipt-modal .receipt-paper').length });
    setTimeout(() => w.dispatchEvent(new w.Event('afterprint')), 0);
  };
  w.eval("receiptWidth='58'; receiptCopies=2; printerMode='system';");
  w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
  await w.eval('printReceipt()');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mm, '58mm', 'paper width setting is used (was hard-coded to 80mm)');
  assert.match(seen[0].page, /58mm/);
  assert.equal(seen[0].copies, 2, 'copies setting is honoured');
  assert.equal(d.querySelectorAll('#receipt-modal .receipt-paper').length, 1, 'copies cleaned up after printing');
  w.eval('receiptWidth=\'80\'; renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
  const r = decodeEscPos(w.eval('buildEscPosBytes(lastReceiptText)'));
  assert.ok(r.centred && r.bold, 'header centred, business name bold on raw printers');
  assert.match(r.text, /ITEM\s+QTY\s+PRICE\s+AMOUNT/);
  close();
});

// 5. Production: the hire lines that used to be print-only now show in the preview too.
test('production: hire details appear in the preview as well as the print', async () => {
  const { w, d, errors, close } = await boot('production/index.html', { storage: STORE });
  const sale = { id: 'h1', timestamp: Date.now(), paymentMethod: 'cash', amountTendered: 1000, change: 0, refNumber: 'R-1', servedBy: 'Jo',
    hireBillingType: 'open', hireDepositAmount: 500,
    items: [{ code: 'T1', name: 'Table (Hire)', qty: 2, price: 500, pricePerDay: 250, unit: 'pcs', isHire: true, vatCategory: 'A' }] };
  w.eval('renderReceipt(' + JSON.stringify(sale) + ')');
  const raw = w.eval('lastReceiptText'), preview = previewText(d);
  assert.match(raw, /Rental Receipt/);
  for (const t of ['Hire Type: Count as you go', 'Rate: KES 500.00/day', 'Deposit Paid: KES 500.00', 'DUE NOW']) {
    assert.ok(raw.includes(t), 'print: ' + t);
    assert.ok(preview.includes(t), 'preview: ' + t);
  }
  assert.deepEqual(errors, []);
  close();
});
