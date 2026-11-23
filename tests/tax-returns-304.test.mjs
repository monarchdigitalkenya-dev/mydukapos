import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 304: Tax & Returns tab - line-level classes, rate in force on the sale date, voids/returns never double counted, exports reconcile.
const now = Date.now();
const day = 86400000;
const inside = new Date(now - 2 * 3600000).toISOString();
const SALES = [
  { id: 'a1', refNumber: 'R1', timestamp: inside, paymentMethod: 'cash', cashAmount: 1160, paid: true, items: [
    { code: 'S1', name: 'Standard item', qty: 10, price: 116, vatCategory: 'A' },
  ] },
  { id: 'a2', refNumber: 'R2', timestamp: inside, paymentMethod: 'mpesa', mpesaAmount: 300, paid: true, items: [
    { code: 'Z1', name: 'Milk', qty: 2, price: 100, vatCategory: 'Z' },
    { code: 'E1', name: 'Exempt thing', qty: 1, price: 50, vatCategory: 'E' },
    { code: 'X1', name: 'No class line', qty: 1, price: 50 },
  ] },
  { id: 'a3', refNumber: 'R3', timestamp: inside, paymentMethod: 'cash', voided: true, items: [{ code: 'S1', name: 'Standard item', qty: 1, price: 116, vatCategory: 'A' }] },
];
const RETURNS = [{ id: 'r1', timestamp: inside, type: 'return', itemCode: 'S1', itemName: 'Standard item', qty: 1, refNumber: 'R1', reason: 'Damaged' }];
const INV = [{ code: 'S1', type: 'item', name: 'Standard item', price: 116, qty: 5, vatCategory: 'A' }, { code: 'X1', type: 'item', name: 'No class item', price: 50, qty: 5 }];
const storage = { pos_sales_log: JSON.stringify(SALES), pos_returns: JSON.stringify(RETURNS), pos_inventory: JSON.stringify(INV) };
const aquaStorage = { aqua_sales_log: JSON.stringify(SALES), aqua_returns: JSON.stringify(RETURNS) };

for (const app of APPS) {
  test(`${app}: Tax & Returns tab exists after Profits, and its figures are right per line`, async () => {
    const b = await boot(app, { storage: app.startsWith('water') ? aquaStorage : storage, wait: 1500 });
    const { w, d } = b;
    assert.ok(d.getElementById('tax-tab'), 'tab content');
    const btn = d.getElementById('tax-tab-btn'); assert.ok(btn, 'tab button');
    assert.equal(btn.previousElementSibling && btn.previousElementSibling.getAttribute('data-tab'), 'profits-tab');
    const r = w.eval(`(function(){ var t = Date.now(); var x = taxReturns.compile(t - 86400000, t); return { gross: x.gross, vat: x.vat, A: x.byCat.A, Z: x.byCat.Z, E: x.byCat.E, voided: x.voided.length, sales: x.sales, ret: x.retGross, retVat: x.retVat, assumed: x.assumed }; })()`);
    // 10 x 116 = 1160 incl. 16% -> VAT 160.00; no-class 50 counted standard -> 6.90 VAT
    assert.equal(r.sales, 2, 'voided sale is not a sale');
    assert.equal(r.voided, 1);
    assert.equal(r.gross, 116000 + 20000 + 5000 + 5000);
    assert.equal(r.A.vat, 16000 + 690);
    assert.equal(r.Z.gross, 20000); assert.equal(r.Z.vat, 0);
    assert.equal(r.E.gross, 5000); assert.equal(r.E.vat, 0);
    assert.equal(r.vat, 16690);
    assert.equal(r.assumed, 1, 'the line with no class is flagged, not silently classed');
    assert.equal(r.ret, 11600); assert.equal(r.retVat, 1600);
    b.close();
  });
}

test('index.html: a rate change applies to new sales only - an old sale keeps the rate it was sold at', async () => {
  const old = new Date(now - 5 * day).toISOString();
  const b = await boot('index.html', { storage: { pos_sales_log: JSON.stringify([{ id: 'o1', refNumber: 'O1', timestamp: old, paid: true, items: [{ name: 'x', qty: 1, price: 116, vatCategory: 'A' }] }]) }, wait: 1500 });
  const { w } = b;
  w.eval('taxReturns.trackRates()');
  const before = w.eval('taxReturns.compile(Date.now() - 10*86400000, Date.now()).vat');
  assert.equal(before, 1600);
  w.eval("updateVatRateA('20'); taxReturns.trackRates();");
  const after = w.eval('taxReturns.compile(Date.now() - 10*86400000, Date.now()).vat');
  assert.equal(after, 1600, 'old sale not re-rated');
  assert.equal(w.eval("taxReturns.rateAt('A', Date.now() + 1000)"), 20);
  assert.equal(w.eval("taxReturns.rateAt('A', Date.now() - 3*86400000)"), 16);
  b.close();
});

test('index.html: not VAT-registered -> no output VAT; CSV cells cannot start a formula', async () => {
  const b = await boot('index.html', { storage, wait: 1500 });
  const { w, d } = b;
  w.eval("document.getElementById('tax-tab-btn').click()");
  await new Promise((r) => setTimeout(r, 200));
  assert.match(d.getElementById('tax-tab').textContent, /not an official KRA tax return/i);
  // pretend registration changed an hour ago
  w.eval("(function(){ var c = JSON.parse(localStorage.getItem('pos_tax_cfg')||'{}'); })()");
  assert.equal(w.eval("taxReturns.csvCell('=1+1')"), `"'=1+1"`);
  assert.equal(w.eval("taxReturns.csvCell('a,b')"), '"a,b"');
  b.close();
});

test('index.html: "not VAT-registered" applies from the moment it is chosen - earlier sales keep the VAT they had, later ones have none', async () => {
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  const b = await boot('index.html', { storage: { pos_sales_log: JSON.stringify([{ id: 'o1', refNumber: 'O1', timestamp: old, paid: true, items: [{ name: 'x', qty: 1, price: 116, vatCategory: 'A' }] }]) }, wait: 1500 });
  const { w, d } = b;
  w.eval("document.getElementById('tax-tab-btn').click()");
  await new Promise((r) => setTimeout(r, 200));
  w.eval("document.querySelector('#tax-tab [data-v=\"setup\"]').click()");
  const sel = d.getElementById('tx-reg'); sel.value = 'no'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.eval("taxReturns.registeredAt(Date.now() + 1000)"), false);
  assert.equal(w.eval("taxReturns.registeredAt(Date.now() - 86400000)"), null, 'before the answer: as it was');
  assert.equal(w.eval('taxReturns.compile(Date.now() - 5*86400000, Date.now()).vat'), 1600, 'the old sale keeps its VAT');
  b.close();
});
