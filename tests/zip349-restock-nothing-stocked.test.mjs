import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 349: a restock row that stocks nothing (the PARENT code/name of an item with variants) used to be refused with a red "restock each variant"
// toast - and then the end of completeRestock() showed the green "Restock recorded" toast over it, logged a KES 0 expense, printed an empty note and
// cleared the form. The person saw "success" and the stock number never moved. A restock that stocked nothing must say so, change nothing and keep the rows.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html'];
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Widget', price: 100, wholesalePrice: 20, qty: 4, unit: 'pcs', vatCategory: 'A' },
  { code: 'P', type: 'item', name: 'Polo', price: 500, wholesalePrice: 300, qty: 10, unit: 'pcs', vatCategory: 'A', hasVariants: true,
    variants: [{ name: 'Red', code: 'P-R', qty: 4, price: 500 }, { name: 'Blue', code: 'P-B', qty: 6, price: 500 }] },
]);
const row = (id, code, qty) => `{ rowId: ${id}, code: '${code}', name: '', qty: '${qty}', cost: '20', sellPrice: '', wholesaleSell: '', unit: 'pcs' }`;
const toast = (w) => ({ text: w.document.getElementById('toast').textContent, error: w.document.getElementById('toast').classList.contains('error') });
const restockExpenses = (w) => w.eval("expenses.filter(e => e.category === 'Restock').length");

for (const app of APPS) {
  test(`${app}: restocking only the parent of an item with variants says so, records nothing and keeps the row`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1200 });
    w.eval('window.print = () => {}; window.__prints = 0; if (typeof printRestockNote === "function") { printRestockNote = function () { window.__prints++; }; }');
    w.eval(`restockDraft = [${row(1, 'P', 5)}]; window.__lastRestockAt = 0; completeRestock();`);
    const t = toast(w);
    assert.match(t.text, /variant/i, 'the message is the variants one, not "Restock recorded"');
    assert.equal(t.error, true);
    assert.doesNotMatch(t.text, /Restock recorded/);
    assert.equal(w.eval("inventory.find(p => p.code === 'P').qty"), 10);
    assert.equal(restockExpenses(w), 0, 'no KES 0 restock expense');
    assert.equal(w.eval('window.__prints'), 0, 'no empty delivery note');
    assert.equal(w.eval('restockDraft.length'), 1, 'the row is still there to correct');
    // and the person can fix it straight away - not blocked by the double-tap guard
    w.eval(`restockDraft = [${row(2, 'P-R', 5)}]; completeRestock();`);
    assert.equal(w.eval("inventory.find(p => p.code === 'P').variants.find(v => v.code === 'P-R').qty"), 9, 'the variant restock goes through at once');
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a restock with one good row and one parent-with-variants row stocks the good one and tells you the other was skipped`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1200 });
    w.eval('window.print = () => {}; if (typeof printRestockNote === "function") { printRestockNote = function () {}; }');
    w.eval(`restockDraft = [${row(1, 'A1', 6)}, ${row(2, 'P', 5)}]; window.__lastRestockAt = 0; completeRestock();`);
    assert.equal(w.eval("inventory.find(p => p.code === 'A1').qty"), 10);
    assert.equal(w.eval("inventory.find(p => p.code === 'P').qty"), 10);
    const t = toast(w);
    assert.match(t.text, /Restock recorded/);
    assert.match(t.text, /skipped|not added|variant/i, 'the toast names what was not stocked');
    assert.equal(t.error, true, 'shown in red so it is noticed');
    assert.equal(restockExpenses(w), 1);
    assert.deepEqual(errors, []);
    close();
  });
}
