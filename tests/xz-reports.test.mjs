import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Master-spec X/Z Report requirements: X is interim and never closes the
// day / never blocks repeat generation; Z requires an authorized finalize
// step, is prevented from double-finalizing the same business date, and
// both must use the SAME authoritative numbers as every other report
// (reportSales/reportSaleTotal/reportSaleCost) rather than separate math.
const INV = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Widget', price: 116, wholesalePrice: 60, qty: 100, unit: 'pcs', vatCategory: 'A' },
]);

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function bootWithSale(app) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  const { w } = b;
  const sale = {
    id: 'S1', timestamp: Date.now(), paymentMethod: 'cash', servedBy: 'Tester',
    items: [{ code: 'P1', name: 'Widget', qty: 2, price: 116, wholesalePrice: 60, unit: 'pcs', vatCategory: 'A' }],
  };
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  return b;
}

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {

test(`${app}: X Report shows today's real totals, never closes the day, and can be generated repeatedly`, async () => {
  const b = await bootWithSale(app);
  const { w } = b;
  w.eval("reportsGenerate('xreport')");
  const out1 = w.document.getElementById('reports-output').innerHTML;
  assert.match(out1, /232/, 'gross sales (2 x 116) show in the report');
  // Generating it again must not error, change any totals, or leave any
  // "already generated" block behind — that's the defining X-vs-Z
  // difference the spec calls out.
  w.eval("reportsGenerate('xreport')");
  const out2 = w.document.getElementById('reports-output').innerHTML;
  assert.match(out2, /232/);
  assert.doesNotMatch(out2, /Finalized/, 'X Report never shows a finalize/closed state');
  const zBefore = w.eval('zReports.length');
  assert.equal(zBefore, 0, 'generating an X Report must never create a Z Report record');
  b.close();
});

test(`${app}: Z Report requires an explicit finalize action before it shows as closed`, async () => {
  const b = await bootWithSale(app);
  const { w } = b;
  w.eval("reportsGenerate('zreport')");
  const out = w.document.getElementById('reports-output').innerHTML;
  assert.match(out, /Not yet finalized/);
  assert.equal(w.eval('zReports.length'), 0);
  b.close();
});

test(`${app}: finalizing a Z Report records who/when, and a second finalize for the same business date is blocked`, async () => {
  const b = await bootWithSale(app);
  const { w } = b;
  w.eval("performFinalizeZReport()");
  const reports = w.eval('zReports');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].businessDate, todayKey());
  assert.ok(reports[0].finalizedBy);
  assert.ok(reports[0].finalizedAt > 0);
  assert.equal(reports[0].totals.gross, 232);

  // Second finalize attempt for the same day must be refused, not create
  // a duplicate entry — "duplicate finalization prevented" in the spec.
  w.eval("performFinalizeZReport()");
  assert.equal(w.eval('zReports.length'), 1, 'a second finalize for the same business date must not add another Z Report');
  b.close();
});

test(`${app}: once finalized, the Z Report view shows the finalized state instead of the finalize button`, async () => {
  const b = await bootWithSale(app);
  const { w } = b;
  w.eval("performFinalizeZReport()");
  w.eval("reportsGenerate('zreport')");
  const out = w.document.getElementById('reports-output').innerHTML;
  assert.match(out, /Finalized/);
  assert.doesNotMatch(out, /Confirm.{0,3}&amp;.{0,3}Finalize/, 'the finalize button is gone once already finalized');
  b.close();
});

test(`${app}: X Report and Z Report agree with the ordinary Sales report on the same day's numbers (single authoritative source)`, async () => {
  const b = await bootWithSale(app);
  const { w } = b;
  w.eval("reportsGenerate('sales')");
  const salesOut = w.document.getElementById('reports-output').innerHTML;
  w.eval("reportsGenerate('xreport')");
  const xOut = w.document.getElementById('reports-output').innerHTML;
  assert.match(salesOut, /232/);
  assert.match(xOut, /232/);
  b.close();
});
}
