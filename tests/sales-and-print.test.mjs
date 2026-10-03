import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Aqua POS: sales made while "Both sites" is selected were stored against a site that does not exist ----------
test('Aqua POS: a sale made while "both sites" is selected belongs to the Shop and shows in Daily Sales; old records stored as "both" show too', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { wait: 1500 });
  w.eval("showToast = function () {}; window.confirm = () => true; seedDefaultSizesIfEmpty(); ensureRefillSizesForEverySite(); renderRefillSizeGrid()");
  const shop = w.eval('shopSiteId()');
  w.eval("activeSiteId = 'both'");
  const sizeId = w.eval("refillSizes.find(s => s.siteId === shopSiteId()).id");
  w.eval(`addRefillToCart('${sizeId}'); currentPaymentMethod = 'cash'`);
  d.getElementById('cash-tendered-input').value = '10000';
  // zip 185: "All Sites" is a reporting view: a sale is refused there (nothing could leave a shelf), and the cart is kept for the right site
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 0, 'refused in the combined view');
  assert.match(d.getElementById('checkout-error').textContent, /Pick Shop or Production/);
  w.eval(`activeSiteId = '${shop}'`);
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1, 'recorded');
  assert.equal(w.eval('salesLog[0].siteId'), shop, 'against the Shop, not against "both"');
  // an old record already stored as "both"
  w.eval("salesLog.push(Object.assign({}, salesLog[0], { id: 'legacy1', siteId: 'both', refNumber: 'REF-LEGACY' }))");
  w.eval(`activeSiteId = '${shop}'`);
  w.eval("setDailySalesPeriod('daily'); renderDailySales()");
  assert.equal(d.querySelectorAll('#daily-sales-table tbody tr').length, 2, 'both sales are in the Shop\'s Daily Sales');
  w.eval("activeSiteId = 'both'; renderDailySales()");
  assert.equal(d.querySelectorAll('#daily-sales-table tbody tr').length, 2, 'and in the combined view');
  w.eval("activeSiteId = 'site-production'; renderDailySales()");
  assert.doesNotMatch(d.querySelector('#daily-sales-table tbody').textContent, /REF-LEGACY|KES 1/, 'and not in Production');
  assert.deepEqual(errors, []);
  close();
});

// ---------- one print per receipt ----------
async function shop(app, printer) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
  const { w, d } = b;
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => (window.__confirmAnswer !== false); window.__confirmAsked = 0; const c0 = window.confirm; window.confirm = (m) => { window.__confirmAsked++; return c0(m); }");
  w.eval("window.__jobs = 0; const orig = printReceiptJob; printReceiptJob = async function () { window.__jobs++; return orig.apply(this, arguments); }");
  if (printer === 'bt') w.eval("printerMode = 'bluetooth'; btPrinterDevice = { name: 'BT', gatt: { connected: true } }; btPrinterCharacteristic = { properties: { write: true, writeWithoutResponse: false }, async writeValue(c) { if (window.__btFail) { const e = new Error('GATT Server is disconnected.'); e.name = 'NetworkError'; throw e; } window.__written = (window.__written || 0) + c.length; } }; receiptCopies = 1");
  else w.eval("printerMode = 'system'; window.__relayWaitMs = 100; window.print = () => { window.__prints = (window.__prints || 0) + 1; window.dispatchEvent(new window.Event('afterprint')); }");
  return b;
}
const sell = async (b) => { b.w.eval("addToCart('A1'); currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = '1000'; await b.w.eval('checkoutCart()'); };
const previewOpen = (b) => b.d.getElementById('receipt-modal').style.display === 'flex';

for (const [app, printer] of [['index.html', 'bt'], ['hotel/index.html', 'bt'], ['index.html', 'system'], ['pharmacy/index.html', 'system']]) {
  test(`${app} (${printer}): tapping Print twice prints once, the preview closes when it worked, and printing the same receipt again asks first`, async () => {
    const b = await shop(app, printer);
    const { w, errors } = b;
    await sell(b);
    if (printer === 'bt') w.eval('autoPrintEnabled = false');
    assert.ok(previewOpen(b), 'the receipt preview is up after the sale');
    w.eval('window.__jobs = 0; window.__written = 0; window.__prints = 0');
    w.eval('printReceipt(); printReceipt(); printReceipt()');                                // three quick taps
    await until(() => !w.eval('window.__receiptPrinting'));
    assert.equal(w.eval('window.__jobs'), 1, 'ONE print job for three taps');
    if (printer === 'bt') assert.ok(w.eval('window.__written') > 0, 'bytes went to the printer');
    else assert.equal(w.eval('window.__prints'), 1);
    assert.equal(previewOpen(b), false, 'the preview closed (nothing left to tap twice)');
    const stored = JSON.parse(w.eval('JSON.stringify(salesLog[0])'));
    assert.ok(stored.printedAt); assert.equal(stored.printCount, 1, 'the sale remembers it was printed');
    assert.equal(w.eval('salesLog.length'), 1, 'and it is recorded once');
    // the same receipt again: asks, and only prints if you say yes
    w.eval('renderReceipt(salesLog[0]); window.__confirmAnswer = false');
    w.eval('printReceipt()'); await sleep(150);
    assert.equal(w.eval('window.__confirmAsked'), 1); assert.equal(w.eval('window.__jobs'), 1, 'no second copy when you decline');
    assert.ok(previewOpen(b), 'the preview stays for a deliberate reprint');
    w.eval('window.__confirmAnswer = true; printReceipt()');
    await until(() => !w.eval('window.__receiptPrinting'));
    assert.equal(w.eval('window.__jobs'), 2, 'a copy when you agree'); assert.equal(w.eval('salesLog[0].printCount'), 2);
    assert.deepEqual(errors, []);
    b.close();
  });
}

test('a failed print keeps the preview open and does not mark the receipt printed, so it can be tried again', async () => {
  const b = await shop('index.html', 'bt');
  const { w } = b;
  w.eval('autoPrintEnabled = false; window.__hwReadyMs = 300');
  await sell(b);
  w.eval('window.__btFail = true; printReceipt()');
  await until(() => !w.eval('window.__receiptPrinting'));
  assert.ok(previewOpen(b), 'still open');
  assert.equal(w.eval('salesLog[0].printedAt || null'), null, 'not marked printed');
  w.eval('window.__btFail = false; printReceipt()');
  await until(() => !w.eval('window.__receiptPrinting'));
  assert.equal(previewOpen(b), false); assert.equal(w.eval('salesLog[0].printCount'), 1);
  b.close();
});

test('with auto-print on, a sale prints once even if the cashier also taps Print', async () => {
  const b = await shop('index.html', 'bt');
  const { w } = b;
  w.eval('autoPrintEnabled = true; window.__jobs = 0');
  await sell(b);                                                                           // auto-print starts 50 ms after the sale
  w.eval('printReceipt()');                                                                // and the cashier taps Print as well
  await sleep(900);
  await until(() => !w.eval('window.__receiptPrinting'));
  assert.equal(w.eval('window.__jobs'), 1);
  b.close();
});

async function until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return false; }
