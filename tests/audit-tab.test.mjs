import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Audit tab (spec sections 38-42): a searchable, read-only timeline built
// from the logs that already exist (X/Z report activity, stock movements,
// sale voids/discounts, KRA classification changes) rather than a
// duplicate logging system — same principle X/Z Reports used for sales
// totals. Covers: events actually show up, filters narrow them correctly,
// and nothing here can mutate the underlying records.
const INV = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Widget', price: 116, wholesalePrice: 60, qty: 100, unit: 'pcs', vatCategory: 'A' },
]);

async function session(app) {
  const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
  return b;
}

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {

test(`${app}: a stock adjustment shows up in the Audit tab with who/what/why`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("logStockMovement('P1', 'Widget', 5, 'Manual inventory adjustment')");
  w.eval('renderAuditTab()');
  const out = w.document.getElementById('audit-output').innerHTML;
  assert.match(out, /Stock added/);
  assert.match(out, /Widget/);
  assert.match(out, /Manual inventory adjustment/);
  b.close();
});

test(`${app}: a sale, a void and a discount all appear as distinct audit events`, async () => {
  const b = await session(app);
  const { w } = b;
  const sale = {
    id: 'S1', timestamp: Date.now(), paymentMethod: 'cash', servedBy: 'Tester',
    items: [{ code: 'P1', name: 'Widget', qty: 1, price: 100, wholesalePrice: 60, unit: 'pcs', vatCategory: 'A', offerApplied: { label: 'Loyalty', amount: 16 } }],
  };
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  w.eval("pendingVoidSaleSource = 'sales'; pendingVoidReason = 'wrong item'; performVoidSale('S1')");
  w.eval('renderAuditTab()');
  const out = w.document.getElementById('audit-output').innerHTML;
  assert.match(out, /Sale created/);
  assert.match(out, /Sale voided/);
  assert.match(out, /wrong item/);
  assert.match(out, /Discount applied/);
  assert.match(out, /Loyalty/);
  b.close();
});

test(`${app}: an X/Z Report event and a KRA classification change both appear`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("reportsGenerate('xreport')");
  w.eval("document.getElementById('inv-code').value='P1'; document.getElementById('inv-name').value='Widget'; document.getElementById('inv-price').value='116'; document.getElementById('inv-wholesale-price').value='60'; document.getElementById('inv-qty').value='100'; document.getElementById('inv-kra-class-code').value='KRA-1'; document.getElementById('inv-kra-etims-code').value='ET-1'; saveInventoryItem();");
  w.eval('renderAuditTab()');
  const out = w.document.getElementById('audit-output').innerHTML;
  assert.match(out, /X Report generated/);
  assert.match(out, /KRA classification changed/);
  b.close();
});

test(`${app}: the module filter narrows results, and the search box filters by text`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("logStockMovement('P1', 'Widget', 5, 'Restock')");
  w.eval("reportsGenerate('xreport')");
  w.eval('renderAuditTab()');
  const all = w.document.getElementById('audit-output').innerHTML;
  assert.match(all, /Stock added/);
  assert.match(all, /X Report generated/);

  w.document.getElementById('audit-module-select').value = 'Inventory';
  w.eval('renderAuditTab()');
  const inventoryOnly = w.document.getElementById('audit-output').innerHTML;
  assert.match(inventoryOnly, /Stock added/);
  assert.doesNotMatch(inventoryOnly, /X Report generated/);

  w.document.getElementById('audit-module-select').value = 'all';
  w.document.getElementById('audit-search-input').value = 'Restock';
  w.eval('renderAuditTab()');
  const searched = w.document.getElementById('audit-output').innerHTML;
  assert.match(searched, /Stock added/);
  assert.doesNotMatch(searched, /X Report generated/);
  b.close();
});

test(`${app}: the Audit tab never mutates the underlying logs — same event count on repeated renders`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("logStockMovement('P1', 'Widget', 5, 'Restock')");
  w.eval('renderAuditTab()');
  const count1 = w.eval('window.__auditEvents.length');
  w.eval('renderAuditTab()');
  w.eval('renderAuditTab()');
  const count2 = w.eval('window.__auditEvents.length');
  assert.equal(count1, count2);
  assert.equal(w.eval('stockMovementLog.length'), 1);
  b.close();
});
}
