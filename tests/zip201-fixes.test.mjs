import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeServer, openDevice, closeWhenIdle } from './e2e-harness.mjs';

const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true; window.print = () => {}');
const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('pharmacy: an EXPIRED batch is sold last, in-date batches first', async () => {
  const s = makeServer();
  const item = { code: 'M', type: 'item', name: 'Med', price: 10, wholesalePrice: 5, qty: 12, unit: 'pcs', vatCategory: 'A', expiryDate: d(-30),
    batches: [{ id: 'b1', batchNumber: 'OLD', expiryDate: d(-30), qty: 4 }, { id: 'b2', batchNumber: 'SOON', expiryDate: d(20), qty: 3 }, { id: 'b3', batchNumber: 'LATE', expiryDate: d(300), qty: 5 }] };
  const a = await openDevice('pharmacy/index.html', s, { pos_inventory: JSON.stringify([item]) }); quiet(a.w);
  a.w.eval("deductStockForSaleUnit(inventory.find(p => p.code === 'M'), 4, 'unit')");
  const bs = a.w.eval("JSON.stringify(inventory.find(p => p.code === 'M').batches.map(b => [b.id, b.qty]))");
  assert.equal(bs, JSON.stringify([['b1', 4], ['b3', 4]]), 'SOON (3) then 1 of LATE went; the expired batch is untouched');
  a.w.eval("deductStockForSaleUnit(inventory.find(p => p.code === 'M'), 8, 'unit')");
  assert.equal(a.w.eval("inventory.find(p => p.code === 'M').qty"), 0, 'only when nothing in date is left, the expired one is used');
  await closeWhenIdle(a);
});

test('customers: 0712… and +254712… are one customer (no duplicate)', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: '[]' }); quiet(a.w);
  a.w.eval("registerOrUpdateCustomer('0712345678', 'Ann')");
  a.w.eval("registerOrUpdateCustomer('+254712345678', '')");
  a.w.eval("registerOrUpdateCustomer('254712345678', '')");
  assert.equal(a.w.eval('customers.length'), 1);
  await closeWhenIdle(a);
});

test('variants: kg items keep decimal variant stock (source guards)', () => {
  for (const f of ['src/shared/functions.js', 'index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/const vQty = parseInt\(v\.qty, 10\);/.test(t), f + ': modal save no longer truncates');
  }
});

test('deleted expenses / trade credits / saved barcodes are tracked for deletion (source guard)', () => {
  const t = fs.readFileSync('src/shared/functions.js', 'utf8');
  assert.ok(/'expenses', 'tradeCredits', 'savedBarcodes', 'patients'/.test(t));
});
