import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Water/Aqua POS parity: X Report/Z Report and the Audit tab, completing
// the water-module work started in water-vat-category.test.mjs (VAT split,
// KRA classification, the assistant, eTIMS validation). Same master-spec
// requirements as every other module: X is interim and never closes the
// day / never blocks repeat generation; Z requires an authorized finalize
// step and is prevented from double-finalizing the same business date;
// both must use the SAME authoritative numbers as Daily Sales
// (buildDailySalesReportData) rather than separate math; the Audit tab is
// a read-only, consolidated view over logs that already exist.
const PRODUCTS = JSON.stringify([
  { code: 'STD1', category: 'bottled', name: 'Standard Bottle', sizeML: 500, price: 116, wholesalePrice: 60, qty: 100, vatCategory: 'A' },
]);

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function bootWithSale(extraStorage) {
  const b = await boot('water/index.html', { storage: { aqua_products: PRODUCTS, ...extraStorage }, wait: 900 });
  const { w } = b;
  const sale = {
    id: 'S1', siteId: 'site-shop-1', refNumber: 'R-00001', timestamp: new Date().toISOString(),
    orderType: 'walkin', paymentMethod: 'cash', paid: true, servedBy: 'Tester',
    items: [{ code: 'STD1', name: 'Standard Bottle', qty: 2, price: 116, vatCategory: 'A' }],
    total: 232, amountTendered: 232, change: 0,
  };
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  return b;
}

test('water/index.html: X Report shows today\'s real totals, never closes the day, and can be generated repeatedly', async () => {
  const b = await bootWithSale();
  const { w } = b;
  w.eval("renderPosControlReport('xreport')");
  const out1 = w.document.getElementById('daily-sales-xz-output').innerHTML;
  assert.match(out1, /232/, 'gross sales (2 x 116) show in the report');
  // Generating it again must not error, change any totals, or leave any
  // "already generated" block behind — that's the defining X-vs-Z
  // difference the spec calls out.
  w.eval("renderPosControlReport('xreport')");
  const out2 = w.document.getElementById('daily-sales-xz-output').innerHTML;
  assert.match(out2, /232/);
  assert.doesNotMatch(out2, /Finalized/, 'X Report never shows a finalize/closed state');
  assert.equal(w.eval('zReports.length'), 0, 'generating an X Report must never create a Z Report record');
  b.close();
});

test('water/index.html: Z Report requires an explicit finalize action before it shows as closed', async () => {
  const b = await bootWithSale();
  const { w } = b;
  w.eval("renderPosControlReport('zreport')");
  const out = w.document.getElementById('daily-sales-xz-output').innerHTML;
  assert.match(out, /Not yet finalized/);
  assert.equal(w.eval('zReports.length'), 0);
  b.close();
});

test('water/index.html: finalizing a Z Report records who/when, and a second finalize for the same business date is blocked', async () => {
  const b = await bootWithSale();
  const { w } = b;
  w.eval('performFinalizeZReport()');
  const reports = w.eval('zReports');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].businessDate, todayKey());
  assert.ok(reports[0].finalizedBy);
  assert.ok(reports[0].finalizedAt > 0);
  assert.equal(reports[0].totals.gross, 232);
  // Second finalize attempt for the same day must be refused, not create
  // a duplicate entry — "duplicate finalization prevented" in the spec.
  w.eval('performFinalizeZReport()');
  assert.equal(w.eval('zReports.length'), 1, 'a second finalize for the same business date must not add another Z Report');
  b.close();
});

test('water/index.html: once finalized, the Z Report view shows the finalized state instead of the finalize button', async () => {
  const b = await bootWithSale();
  const { w } = b;
  w.eval('performFinalizeZReport()');
  w.eval("renderPosControlReport('zreport')");
  const out = w.document.getElementById('daily-sales-xz-output').innerHTML;
  assert.match(out, /Finalized/);
  assert.doesNotMatch(out, /Confirm.{0,3}&amp;.{0,3}Finalize/, 'the finalize button is gone once already finalized');
  b.close();
});

test('water/index.html: X Report and Z Report agree with Daily Sales on the same day\'s numbers (single authoritative source), regardless of the on-screen payment-method filter', async () => {
  const b = await bootWithSale();
  const { w } = b;
  // Select a payment-method filter chip that would exclude this cash sale
  // from the Daily Sales TABLE — the X/Z totals must still show the whole
  // business date, not whatever's currently selected on screen.
  w.eval("setDailySalesMethodFilter('mpesa')");
  w.eval("renderPosControlReport('xreport')");
  const xOut = w.document.getElementById('daily-sales-xz-output').innerHTML;
  assert.match(xOut, /232/, 'X Report always reflects the whole day, ignoring the Daily Sales method filter chip');
  const totals = w.eval('posControlReportTotals()');
  assert.equal(totals.gross, 232);
  assert.equal(totals.transactionCount, 1);
  b.close();
});

test('water/index.html: finalizing a Z Report requires the management password (or Manager PIN), not a bare click', async () => {
  const b = await bootWithSale({ aqua_admin_pw_hash: '' });
  const { w } = b;
  w.eval('requestFinalizeZReport()');
  assert.equal(w.document.getElementById('admin-pw-modal').style.display, 'flex', 'the management-password modal must open rather than finalizing immediately');
  assert.equal(w.eval('zReports.length'), 0);
  b.close();
});

test('water/index.html: the Audit tab consolidates sales, voids, stock movements and KRA classification changes into one read-only, filterable timeline', async () => {
  const b = await bootWithSale();
  const { w } = b;
  // A stock movement and a KRA classification change, so the Audit tab has
  // more than just the one sale to consolidate.
  w.eval("logStockMovement('STD1', 'Standard Bottle', -5, 'Damaged in transit')");
  w.eval("openEditProductModal('STD1')");
  w.document.getElementById('edit-product-kra-class-code').value = 'KRA-1';
  w.document.getElementById('edit-product-kra-etims-code').value = 'ET-1';
  w.eval('saveProductEditModal()');

  w.eval('renderAuditTab()');
  const out = w.document.getElementById('audit-output').innerHTML;
  assert.match(out, /Sale created/);
  assert.match(out, /Stock removed/);
  assert.match(out, /KRA classification changed/);

  // Filtering by module narrows the view without touching the underlying logs.
  w.document.getElementById('audit-module-select').value = 'Inventory';
  w.eval('renderAuditTab()');
  const filtered = w.document.getElementById('audit-output').innerHTML;
  assert.match(filtered, /Stock removed/);
  assert.doesNotMatch(filtered, /Sale created/);
  b.close();
});

test('water/index.html: a voided sale shows in the Audit tab as both its original sale and a separate void event', async () => {
  const b = await bootWithSale();
  const { w } = b;
  w.eval(`salesLog[0].voided = true; salesLog[0].voidedBy = 'Admin'; salesLog[0].voidedAt = Date.now(); salesLog[0].voidReason = 'Customer changed mind';`);
  w.eval('renderAuditTab()');
  const out = w.document.getElementById('audit-output').innerHTML;
  assert.match(out, /Sale created/);
  assert.match(out, /Sale voided/);
  assert.match(out, /Customer changed mind/);
  b.close();
});
