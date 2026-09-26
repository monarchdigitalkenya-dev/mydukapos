import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Reported alongside the past-sale pricing gap: hires had no wholesale
// option in Record a Past Hire at all — resolvePastHireGeneralSelection()
// always used product.hirePricePerDay, even though the live Hiring
// Counter's own cart price picker (selectHireCartPriceOption) already
// supports a wholesaleHirePricePerDay rate. This covers the Record Past
// Hire fix bringing it in line with the live counter.
const INV = JSON.stringify([
  { code: 'H1', type: 'item', name: 'Tent', price: 0, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A', canBeHired: true, hirePricePerDay: 500, wholesaleHirePricePerDay: 350 },
  { code: 'H2', type: 'item', name: 'Chair', price: 0, wholesalePrice: 0, qty: 10, unit: 'pcs', vatCategory: 'A', canBeHired: true, hirePricePerDay: 50 },
]);

async function session() {
  const b = await boot('production/index.html', { storage: { pos_inventory: INV }, wait: 900 });
  return b;
}

test('production/index.html: Record a Past Hire defaults to the Retail day-rate, and Wholesale is one tap away when the item has one', async () => {
  const b = await session();
  const { w } = b;
  w.eval("selectPastHireItem('H1')");
  w.document.getElementById('past-hire-qty-input').value = '2';
  w.eval('updatePastHireGeneralPreview()');
  assert.match(w.document.getElementById('past-hire-general-preview').textContent, /500\.00/, 'starts at the retail day-rate');
  assert.notEqual(w.document.getElementById('past-hire-price-wholesale-btn').style.display, 'none', 'wholesale button is offered — the item has a wholesale rate');

  w.eval("choosePastHirePriceTier('wholesale')");
  assert.match(w.document.getElementById('past-hire-general-preview').textContent, /350\.00/, 'switches to the wholesale day-rate');

  w.document.getElementById('past-hire-days-input').value = '3';
  w.eval('updatePastHireAmount()');
  assert.equal(w.document.getElementById('past-hire-amount-input').value, (350 * 2 * 3).toFixed(2), 'the computed total uses the wholesale rate, not retail');
  b.close();
});

test('production/index.html: an item with no wholesale hire rate hides the Wholesale button', async () => {
  const b = await session();
  const { w } = b;
  w.eval("selectPastHireItem('H2')");
  assert.equal(w.document.getElementById('past-hire-price-wholesale-btn').style.display, 'none');
  b.close();
});
