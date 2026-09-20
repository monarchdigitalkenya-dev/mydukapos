import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot } from './helpers.mjs';

// A canvas that accepts every 2D drawing call, so the real PDF builder runs in the test browser.
const fakeCtx = () => { const store = {}; return new Proxy(store, {
  get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : (k in t ? t[k] : () => {})),
  set: (t, k, v) => { t[k] = v; return true; } }); };
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('\xff\xd8\xff\xe0' + 'x'.repeat(200) + '\xff\xd9', 'latin1').toString('base64');
const OPTS = { getContext: fakeCtx, toDataURL: () => JPEG };

// ---- Share is a PDF ----
for (const app of APPS) {
  test(`${app}: Share sends a PDF file, not text`, async () => {
    const { w, close } = await boot(app, OPTS);
    w.eval("lastReceiptText = 'SHOP\\nTOTAL KES 10.00'; currentReceiptSale = { refNumber: 'R-9' }");
    const shared = [];
    Object.defineProperty(w.navigator, 'canShare', { value: (d) => !!(d && d.files && d.files.length), configurable: true });
    Object.defineProperty(w.navigator, 'share', { value: async (d) => { shared.push(d); }, configurable: true });
    await w.eval('shareReceiptNative()');
    assert.equal(shared.length, 1);
    const f = shared[0].files[0];
    assert.equal(f.type, 'application/pdf'); assert.equal(f.name, 'receipt-R-9.pdf');
    assert.equal('text' in shared[0], false, 'no plain-text copy is sent alongside');
    close();
  });
}

test('browsers that cannot share files get the PDF saved, never a text share', async () => {
  const { w, d, close } = await boot('index.html', OPTS);
  w.eval("lastReceiptText = 'SHOP\\nTOTAL KES 10.00'; currentReceiptSale = { refNumber: 'R-9' }");
  const downloads = []; const shared = []; let opened = 0;
  Object.defineProperty(w.navigator, 'canShare', { value: () => false, configurable: true });
  Object.defineProperty(w.navigator, 'share', { value: async (x) => { shared.push(x); }, configurable: true });
  w.open = () => { opened++; };
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  await w.eval('shareReceiptNative()');
  assert.deepEqual(downloads, ['receipt-R-9.pdf']);
  assert.equal(shared.length, 0, 'text was not shared'); assert.equal(opened, 0, 'no WhatsApp text link opened');
  assert.match(d.body.textContent, /Receipt PDF saved/);
  close();
});

test('if the PDF cannot be made, nothing is shared as text', async () => {
  const { w, close } = await boot('index.html');   // no canvas => no PDF
  w.eval("lastReceiptText = 'SHOP\\nTOTAL KES 10.00'; currentReceiptSale = { refNumber: 'R-9' }");
  const shared = []; let opened = 0;
  Object.defineProperty(w.navigator, 'share', { value: async (x) => { shared.push(x); }, configurable: true });
  w.open = () => { opened++; };
  await w.eval('shareReceiptNative()');
  assert.equal(shared.length, 0); assert.equal(opened, 0);
  close();
});

// ---- Settle a bill without a receipt ----
const BILL = { id: 'b1', timestamp: new Date().toISOString(), customerName: 'Ann', paymentMethod: 'bill', paid: false, amountPaid: 0, servedBy: 'Jane', total: 100,
  items: [{ code: '1', name: 'Thing', qty: 1, price: 100, unit: 'pcs', vatCategory: 'A' }], status: 'unpaid', fulfillmentType: 'carried_immediately', inventoryDeducted: true };

for (const app of APPS) {
  for (const skip of [true, false]) {
    test(`${app}: settling a bill ${skip ? 'with "Save (no receipt)" records the payment but shows no receipt' : 'with the print button still shows the receipt'}`, async () => {
      const { w, d, errors, close } = await boot(app);
      const site = w.eval("typeof activeSiteId !== 'undefined' ? activeSiteId : null");
      w.eval(`bills.push(${JSON.stringify({ ...BILL, siteId: site })});`);
      const isWater = app === 'water/index.html';
      if (isWater) w.eval("openBillSettleModal('b1')"); else w.eval("openBillSettleModal('sale', 'b1')");
      const before = w.eval('salesLog.length');
      let printed = 0; w.eval('printReceipt = function () { window.__printed = (window.__printed || 0) + 1; }');
      w.eval(`confirmBillSettle(${skip ? 'true' : ''})`);
      assert.equal(w.eval('salesLog.length'), before + 1, 'the payment is saved to the sales log either way');
      const shown = d.getElementById('receipt-modal').style.display === 'flex';
      assert.equal(shown, !skip, skip ? 'no receipt window' : 'receipt window');
      assert.ok(!(skip && w.eval('window.__printed || 0') > 0), 'nothing sent to the printer');
      assert.equal(w.eval("bills.every(b => b.id !== 'b1' || b.closed || b.status === 'fully_paid')"), true, 'bill fully settled');
      assert.deepEqual(errors, []);
      await new Promise((r) => setTimeout(r, 300));
      close();
    });
  }
}

test('every settle window offers Save (no receipt) next to the print button', async () => {
  for (const app of APPS) {
    const { d, close } = await boot(app);
    const labels = [...d.querySelectorAll('button')].map((b) => b.getAttribute('onclick') || '').filter((o) => o.startsWith('confirmBillSettle('));
    assert.deepEqual(labels.sort(), ['confirmBillSettle()', 'confirmBillSettle(true)'], app);
    close();
  }
});
