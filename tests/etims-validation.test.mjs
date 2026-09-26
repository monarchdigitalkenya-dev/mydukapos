import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Spec section 19: validate before eTIMS submission, never silently
// submit bad data. Structural errors (bad name/qty/price/VAT category)
// block submission with a clear what/why/how message. A classification
// gap (item not yet KRA-classified) is a real, surfaced warning but must
// NOT block the actual tax filing — blocking a live invoice over an
// unfinished classification would be worse for compliance than filing it.
const INV_UNCLASSIFIED = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Widget', price: 116, wholesalePrice: 60, qty: 100, unit: 'pcs', vatCategory: 'A' },
]);
const INV_CLASSIFIED = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Widget', price: 116, wholesalePrice: 60, qty: 100, unit: 'pcs', vatCategory: 'A', kra: { status: 'Confirmed', kraClassCode: 'KRA-1', etimsItemCode: 'ET-1' } },
]);

function makeSale(items) {
  return { id: 'S1', timestamp: new Date().toISOString(), paymentMethod: 'cash', servedBy: 'Tester', items };
}

async function sessionWithEtims(app, inv, fetchImpl) {
  const b = await boot(app, { storage: { pos_inventory: inv }, wait: 900, fetch: fetchImpl });
  const { w } = b;
  w.eval("kraEtimsReceiptsEnabled = true; etimsPin = 'A123456789Z';");
  return b;
}

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {

test(`${app}: a sale line with an invalid quantity is blocked from eTIMS submission with a clear explanation, and never calls the API`, async () => {
  let fetchCalled = false;
  const b = await sessionWithEtims(app, INV_UNCLASSIFIED, async (url) => { if (String(url).includes('etims-submit')) fetchCalled = true; return { ok: true, json: async () => ({}) }; });
  const { w } = b;
  fetchCalled = false;
  const sale = makeSale([{ code: 'P1', name: 'Widget', qty: 0, price: 116, vatCategory: 'A' }]);
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  await w.eval("submitSaleToEtims(salesLog[0])");
  const updated = w.eval('salesLog[0]');
  assert.equal(updated.etimsStatus, 'validation_failed');
  assert.ok(updated.etimsValidationErrors.some(e => /quantity/i.test(e.issue)));
  assert.equal(fetchCalled, false, 'a structurally invalid sale must never reach the eTIMS API');
  b.close();
});

test(`${app}: an unrecognized VAT category is blocked from submission`, async () => {
  let fetchCalled = false;
  const b = await sessionWithEtims(app, INV_UNCLASSIFIED, async (url) => { if (String(url).includes('etims-submit')) fetchCalled = true; return { ok: true, json: async () => ({}) }; });
  const { w } = b;
  fetchCalled = false;
  const sale = makeSale([{ code: 'P1', name: 'Widget', qty: 1, price: 116, vatCategory: 'Q' }]);
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  await w.eval("submitSaleToEtims(salesLog[0])");
  const updated = w.eval('salesLog[0]');
  assert.equal(updated.etimsStatus, 'validation_failed');
  assert.ok(updated.etimsValidationErrors.some(e => /VAT category/i.test(e.issue)));
  assert.equal(fetchCalled, false);
  b.close();
});

test(`${app}: an unclassified item is a WARNING, not a blocker — the sale still gets submitted to eTIMS`, async () => {
  let fetchCalled = false;
  const b = await sessionWithEtims(app, INV_UNCLASSIFIED, async (url) => {
    if (String(url).includes('etims-submit')) fetchCalled = true;
    return { ok: true, json: async () => ({ invcNo: 'INV1', curRcptNo: 1, totRcptNo: 1, intrlData: 'x', rcptSign: 'y', sdcDateTime: 'z' }) };
  });
  const { w } = b;
  const sale = makeSale([{ code: 'P1', name: 'Widget', qty: 1, price: 116, vatCategory: 'A' }]);
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  await w.eval("submitSaleToEtims(salesLog[0])");
  const updated = w.eval('salesLog[0]');
  assert.equal(fetchCalled, true, 'an unclassified item must not block the actual KRA submission');
  assert.equal(updated.etimsStatus, 'submitted');
  assert.ok(updated.etimsClassificationWarnings.some(wr => /not yet set/i.test(wr.issue)));
  b.close();
});

test(`${app}: a fully classified item submits cleanly with no warnings`, async () => {
  const b = await sessionWithEtims(app, INV_CLASSIFIED, async () => ({ ok: true, json: async () => ({ invcNo: 'INV1', curRcptNo: 1, totRcptNo: 1, intrlData: 'x', rcptSign: 'y', sdcDateTime: 'z' }) }));
  const { w } = b;
  const sale = makeSale([{ code: 'P1', name: 'Widget', qty: 1, price: 116, vatCategory: 'A' }]);
  w.eval(`salesLog.push(${JSON.stringify(sale)})`);
  await w.eval("submitSaleToEtims(salesLog[0])");
  const updated = w.eval('salesLog[0]');
  assert.equal(updated.etimsStatus, 'submitted');
  assert.equal(updated.etimsClassificationWarnings, null);
  b.close();
});
}
