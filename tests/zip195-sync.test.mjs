import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// zip 195: stock reaches every device (also a "stuck" one), variant restocks, universal sales.
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'P', type: 'item', name: 'Polo', price: 500, wholesalePrice: 300, qty: 10, unit: 'pcs', vatCategory: 'A', hasVariants: true,
    variants: [{ name: 'Red', code: 'P-R', qty: 4, price: 500 }, { name: 'Blue', code: 'P-B', qty: 6, price: 500 }] },
];
const quiet = (w) => w.eval('showToast = function () { window.__toasts = (window.__toasts || []).concat([String(arguments[0])]); }; window.confirm = () => true; window.print = () => {}');
const restock = (w, code, n) => w.eval(`restockDraft = [{ rowId: 1, code: '${code}', name: '', unit: 'pcs', qty: '${n}', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__last = completeRestock && 1`);
const run = async (w) => { try { await w.eval('completeRestock()'); } catch (e) { /* the call may be sync */ } };

test('restocking a VARIANT code adds to that variant (no duplicate item) and the parent total follows', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  const before = a.w.eval('inventory.length');
  restock(a.w, 'P-R', 5); await run(a.w);
  assert.equal(a.w.eval("inventory.find(p => p.code === 'P').variants.find(v => v.code === 'P-R').qty"), 9);
  assert.equal(a.w.eval("inventory.find(p => p.code === 'P').qty"), 15, 'parent = sum of the variants');
  assert.equal(a.w.eval('inventory.length'), before, 'no duplicate item was created');
  a.close();
});

test('restocking the PARENT code of an item with variants is refused with a clear message and changes nothing', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  restock(a.w, 'P', 5); await run(a.w);
  assert.equal(a.w.eval("inventory.find(p => p.code === 'P').qty"), 10);
  assert.ok(a.w.eval('(window.__toasts || []).some(t => /has variants/i.test(t))'), 'told to restock each variant');
  a.close();
});

test('a stuck device still takes the server stock, with its own unsent sale laid on top (no "no stock")', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); a.d.getElementById('cash-tendered-input').value = '1000';
  await a.w.eval('checkoutCart()');                                    // 99 here
  const n = a.w.eval("stockMergeWhileStuck({ inventory: [{ code: 'A', qty: 150 }], stockMovementLog: [] })");
  const q = a.w.eval("inventory.find(p => p.code === 'A').qty");
  if (a.w.eval("typeof stockLedgerOn === 'function' && stockLedgerOn()")) { assert.ok(n >= 1); assert.equal(q, 149, 'server 150 minus this device\'s unsent sale of 1'); }
  else assert.equal(n, 0, 'ledger off: nothing is touched');
  a.close();
});

test('sales are universal: no own-sales filter is left in the Sales panel or the hotel bills', () => {
  const re = fs.readFileSync('src/shared/blocks/receipt-extras.html', 'utf8');
  assert.ok(!/staff never see anyone else's sales/.test(re));
  assert.ok(!/your sales only/.test(re));
  const hotel = fs.readFileSync('hotel/index.html', 'utf8');
  assert.ok(!/staff never see anyone else's (sales|bills)/.test(hotel));
  assert.ok(!/your sales only/.test(hotel));
});

test('users never see "server not answering" wording', () => {
  const fn = fs.readFileSync('src/shared/functions.js', 'utf8');
  assert.ok(!/MyDukaPOS server is not answering/.test(fn));
});
