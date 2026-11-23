import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, decodeEscPos } from './helpers.mjs';

// Zip 144 — one printing engine: every document is laid out ONCE on a character grid that fits the paper of THIS device's printer,
// and the preview, the system print dialog, the PDF and the USB / Bluetooth bytes are all that same grid.
const STORE = {
  pos_biz_name: 'NILE SPORTS WEAR AND GENERAL OUTFITTERS OF MAMA NGINA STREET', aqua_biz_name: 'NILE SPORTS WEAR AND GENERAL OUTFITTERS OF MAMA NGINA STREET',
  pos_receipt_contact: '0704472629, 0725533442', aqua_receipt_contact: '0704472629, 0725533442',
  pos_receipt_extra_info: 'NORWICH UNION BUILDING, GROUND FLOOR SHOP NUMBER 14\nMAMA NGINA STREET', aqua_receipt_extra_info: 'NORWICH UNION BUILDING, GROUND FLOOR SHOP NUMBER 14\nMAMA NGINA STREET',
  pos_receipt_footer_notes: 'Goods once sold cannot be returned after seven days without the original receipt and packaging',
  aqua_receipt_footer_notes: 'Goods once sold cannot be returned after seven days without the original receipt and packaging',
};
const REF_SALE = { id: 'n1', timestamp: new Date('2026-09-26T17:39:36+03:00').getTime(), paymentMethod: 'cash', amountTendered: 400, change: 50,
  refNumber: 'ref-00002001', servedBy: 'John', items: [{ code: '00012', name: 'Predator Shin-Guards (Black)', qty: 1, price: 350, unit: 'pcs', vatCategory: 'A' }] };
const LONG_SALE = {
  id: 'L1', timestamp: Date.now(), paymentMethod: 'split', cashAmount: 1000000, mpesaAmount: 234567.89, amountTendered: 1000000, change: 0,
  mpesaReceiptNumber: 'QWERTY12345', refNumber: 'ref-00099999', servedBy: 'Wanjiku Kamau Njoroge the Senior Cashier', customerName: 'Mwalimu Jonathan Kiprotich Arap Kiplagat',
  totalDiscount: 1234.5,
  items: [
    { code: '5901234123457', name: 'Extra Heavy Duty Galvanised Corrugated Roofing Sheet Gauge 28 (3 metre, blue)', qty: 1250, price: 987.5, unit: 'pcs', vatCategory: 'A' },
    { code: 'X1', name: 'Soap', qty: 1, price: 50, unit: 'pcs', vatCategory: 'B' },
    { code: 'X2', name: 'Maize flour 2kg — Jogoo', qty: 3, price: 199.99, unit: 'pcs', vatCategory: 'Z' },
    { code: 'X3', name: 'Exercise book', qty: 12, price: 45, unit: 'pcs', vatCategory: 'E' },
  ],
};
const BILL = Object.assign(JSON.parse(JSON.stringify(REF_SALE)), { id: 'b1', paymentMethod: 'bill', paid: false, amountPaid: 300, customerName: 'John Doe' });

const gridLines = (d) => [...d.querySelectorAll('#receipt-body .receipt-grid .rg-l')].map((e) => e.textContent);
function checkLayout(label, lines, cols) {
  for (const l of lines) {
    assert.ok(l.length <= cols, `${label}: line wider than the paper (${l.length} > ${cols}): "${l}"`);
    assert.doesNotMatch(l, /(^|\s)-?KES\s*$/, `${label}: "KES" left without its amount: "${l}"`);
    assert.doesNotMatch(l, /^\s*\d*\.\d{0,1}$|^\s*\d+\.$/, `${label}: a number split across lines: "${l}"`);
  }
}

for (const app of APPS) {
  test(`${app}: 58 mm, 80 mm and a custom 70 mm roll — preview = print, nothing wider than the paper, no split amounts (long data)`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: STORE, wait: 900 });
    w.eval('showToast = function () {};');
    for (const [width, custom, cols] of [['58', '', 32], ['80', '', 48], ['custom', '70', w.eval("(function(){ receiptWidth='custom'; receiptCustomWidth='70'; return getPaperCols(); })()")]]) {
      w.eval(`receiptWidth='${width}'; receiptCustomWidth='${custom}';`);
      for (const [name, sale] of [['long sale', LONG_SALE], ['bill', BILL], ['reference', REF_SALE]]) {
        const label = `${app} ${width}${custom} ${name}`;
        w.eval('renderReceipt(' + JSON.stringify(sale) + ')');
        assert.equal(w.eval('getPaperCols()'), cols, `${label}: columns`);
        const preview = gridLines(d);
        assert.ok(preview.length > 10, `${label}: the preview is the grid`);
        checkLayout(`${label} preview`, preview, cols);
        const bytes = w.eval("typeof buildReceiptEscPosBytes === 'function' ? buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter) : buildEscPosBytes(lastReceiptText)");
        const raw = decodeEscPos(bytes).text.split('\n').filter((l) => l.length);
        checkLayout(`${label} USB/Bluetooth`, raw, cols);
        // what the printer gets is what the preview shows (printers centre by command; the preview centres with spaces)
        const norm = (a) => a.map((l) => l.trim().replace(/[—–]/g, '-')).filter(Boolean);
        assert.deepEqual(norm(raw), norm(preview), `${label}: preview and printer differ`);
        // the money is intact
        const txt = preview.join('\n');
        if (sale === LONG_SALE) {
          assert.match(txt, /1250(pcs)?\b/, `${label}: large quantity`);   // (Aqua POS prints a bare quantity)
          assert.match(txt, /1234375\.00/, `${label}: large amount whole`);
          assert.match(txt, /Paid by M-Pesa +KES 234567\.89/, `${label}: split payment right-aligned`);
        }
        if (sale === BILL) { assert.match(txt, /BALANCE +KES 50\.00/, `${label}: bill balance`); assert.match(txt, /PAID +KES 300\.00/); }
      }
    }
    assert.deepEqual(errors, []);
    close();
  });
}

test('the reference receipt (attached photo) on 58 mm: every field on its own line, columns in line, VAT preserved', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_receipt_print_vat: 'true', pos_biz_name: 'NILE SPORTS WEAR', pos_receipt_contact: '0704472629, 0725533442', pos_receipt_extra_info: 'NORWICH UNION\nMAMA NGINA STREET' }, wait: 900 });
  w.eval("receiptWidth='58'; renderReceipt(" + JSON.stringify(REF_SALE) + ')');
  const g = gridLines(d).map((l) => l.replace(/\s+$/, ''));
  assert.ok(g.includes('Predator Shin-Guards (Black)'), 'the name on a line of its own');
  assert.ok(g.includes('#00012    1pcs  350.00  350.00 A'), 'qty / price / amount under their headings');
  assert.ok(g.includes('ITEM       QTY   PRICE    AMOUNT'));
  assert.ok(g.includes('TOTAL KES 350.00'), 'the grand total is one big bold row on half the columns');
  assert.ok(g.includes('CASH                  KES 400.00'));
  assert.ok(g.includes('CHANGE                 KES 50.00'));
  assert.ok(g.includes('A    16%        301.72     48.28'), 'VAT figures unchanged');
  assert.ok(g.some((l) => l.trim() === 'Date: 26/09/2026') && g.some((l) => l.trim() === 'Time: 17:39:36'), 'date and time fit (their own lines on 58 mm)');
  close();
});

test("THIS device's printer width overrides the shop setting (the 58 mm printer in an 80 mm shop), and the print page follows it", async () => {
  const { w, d, close } = await boot('index.html', { wait: 900 });
  w.eval('showToast = function () {};');
  w.eval("receiptWidth='80'");
  assert.equal(w.eval('getPaperCols()'), 48);
  w.eval("setDevicePaperWidth('58')");
  assert.equal(w.eval('getPaperCols()'), 32, 'this device prints 32 characters a line');
  assert.equal(w.localStorage.getItem('pos_device_paper_mm'), '58');
  w.eval("setPrintMode('receipt')");
  assert.match(d.getElementById('print-page-style').textContent, /size: 58mm \d+mm;/, 'the print page is the real paper, with a valid length ("58mm auto" is invalid CSS and fell back to A4/Letter)');
  assert.equal(d.body.style.getPropertyValue('--rg-paper'), '58mm');
  assert.equal(d.body.style.getPropertyValue('--rg-side'), '5.00mm', 'content fits the 48 mm the head can print');
  w.eval("setDevicePaperWidth('')");
  assert.equal(w.eval('getPaperCols()'), 48, 'back to the shop setting');
  close();
});

test('a receipt laid out on an 80 mm till and printed by a 58 mm printer (print relay) is squeezed, never broken mid-number', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_receipt_print_vat: 'true' }, wait: 900 });
  w.eval("receiptWidth='80'; renderReceipt(" + JSON.stringify(REF_SALE) + ')');
  const text80 = w.eval('lastReceiptText');
  w.eval("receiptWidth='58'");
  const out = w.eval('thermalPrepareText(' + JSON.stringify(text80) + ')').split('\n');
  checkLayout('relay', out, 32);
  assert.ok(out.some((l) => /1pcs +350\.00 +350\.00 A$/.test(l)), 'the numbers row stays one row: ' + out.join(' / '));
  close();
});

test('hotel: restaurant, bar, room-service and room documents carry their own content; a walk-in sale is unchanged', async () => {
  const { w, d, close } = await boot('hotel/index.html', { wait: 1200 });
  w.eval("tables.push('Table 12'); rooms.push('Room 104'); roomStays['Room 104'] = { guestName: 'Jane Guest', checkInAt: '2026-09-26T12:00:00+03:00', checkOutDue: '2026-09-28' };");
  w.eval("tabs.push({ id: 'T1', kind: 'table', label: 'Table 12', waiter: 'Otieno', orderType: 'DINE_IN', orders: [] });");
  const base = { timestamp: Date.now(), paymentMethod: 'cash', amountTendered: 2000, change: 0, servedBy: 'Cashier Amina', refNumber: 'R-9',
    items: [{ code: 'C1', name: 'Chicken', qty: 2, price: 500, unit: 'plate', vatCategory: 'A' }, { code: 'S1', name: 'Soda', qty: 2, price: 100, unit: 'pcs', vatCategory: 'A' }] };
  const txt = (sale) => { w.eval('renderReceipt(' + JSON.stringify(sale) + ')'); return gridLines(d).join('\n'); };
  let t = txt({ ...base, id: 'h1', tableOrRoom: 'Table 12', tabId: 'T1', orderType: 'DINE_IN' });
  assert.match(t, /RESTAURANT RECEIPT/); assert.match(t, /Table: Table 12/); assert.match(t, /Waiter: Otieno/); assert.doesNotMatch(t, /Table\/Room:/);
  t = txt({ ...base, id: 'h2', tableOrRoom: 'Room 104', orderType: 'ROOM_SERVICE', paymentMethod: 'bill', paid: false });
  assert.match(t, /ROOM SERVICE BILL/); assert.match(t, /Room: Room 104/); assert.match(t, /Guest: Jane Guest/); assert.match(t, /Check-in: 26\/09\/2026/); assert.match(t, /Check-out: 28\/09\/2026/);
  t = txt({ ...base, id: 'h3', tableOrRoom: 'Table 12', outlet: 'Main Bar', orderType: 'walkin', partNumber: 2 });
  assert.match(t, /BAR RECEIPT/); assert.match(t, /Split bill: part 2/);
  t = txt({ ...base, id: 'h4' });
  assert.match(t, /Sales Receipt/); assert.doesNotMatch(t, /Waiter:|Table:|Room:/);
  close();
});

test('services: a services-only sale is a SERVICE RECEIPT / SERVICE INVOICE; a parts sale stays a Sales Receipt', async () => {
  const { w, d, close } = await boot('services/index.html', { wait: 1000 });
  const svc = { id: 's1', timestamp: Date.now(), paymentMethod: 'cash', amountTendered: 1500, change: 0, servedBy: 'Tech Ali', refNumber: 'R-1',
    items: [{ code: 'SV1', name: 'Sole replacement', qty: 1, price: 1500, unit: 'job', isService: true, vatCategory: 'A' }] };
  w.eval('renderReceipt(' + JSON.stringify(svc) + ')');
  assert.match(gridLines(d).join('\n'), /SERVICE RECEIPT/);
  w.eval('renderReceipt(' + JSON.stringify({ ...svc, id: 's2', paymentMethod: 'bill', paid: false }) + ')');
  assert.match(gridLines(d).join('\n'), /SERVICE INVOICE/);
  w.eval('renderReceipt(' + JSON.stringify({ ...svc, id: 's3', items: [{ ...svc.items[0], isService: false }] }) + ')');
  assert.match(gridLines(d).join('\n'), /Sales Receipt/);
  close();
});

for (const app of APPS.filter((a) => a !== 'water/index.html')) {
  test(`${app}: kitchen tickets / order slips use the same grid (nothing wider than the paper)`, async () => {
    const { w, d, close } = await boot(app, { wait: 900 });
    w.eval("receiptWidth='58'");
    const text = 'KITCHEN ORDER\nTable 12 — Waiter Otieno\n' + '-'.repeat(32) + '\n2 x Chicken tikka masala with extra garlic naan and a side of kachumbari salad';
    w.eval(`setPrintBodyText(document.getElementById('kitchen-ticket-body'), ${JSON.stringify(text)})`);
    const lines = [...d.querySelectorAll('#kitchen-ticket-body .receipt-grid .rg-l')].map((e) => e.textContent);
    assert.ok(lines.length >= 5, 'wrapped at word boundaries');
    checkLayout(`${app} kitchen`, lines, 32);
    close();
  });
}
