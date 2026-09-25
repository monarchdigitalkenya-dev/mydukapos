import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// completeRestock() had no coverage at all, and no protection against a
// double-tap on a slow tablet re-submitting the same delivery twice — which
// would silently add the same quantity to stock a second time (e.g. "I
// added 6 and it became 12").
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Widget', price: 100, wholesalePrice: 20, qty: 4, unit: 'pcs', vatCategory: 'A' }]);
const setDraft = (w, qty) => w.eval(`restockDraft = [{ rowId: 1, code: 'A1', name: 'Widget', qty: '${qty}', cost: '20', sellPrice: '', wholesaleSell: '', unit: 'pcs' }];`);
const qtyOf = (w) => w.eval("inventory.find(p => p.code === 'A1').qty");

for (const app of APPS) {
  test(`${app}: completeRestock() adds the typed quantity exactly once, and a double-tap within the same instant does not add it twice`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1200 });
    w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); };");
    setDraft(w, '6');
    w.eval('completeRestock()');
    assert.equal(qtyOf(w), 10, 'one restock of 6 added to a starting stock of 4');
    // The double-tap: same draft still sitting there (as it would be for the
    // fraction of a second before the UI clears it), called again right away.
    setDraft(w, '6');
    w.eval('completeRestock()');
    assert.equal(qtyOf(w), 10, 'a second call in the same instant is dropped — stock is not doubled');
    // A genuinely later, separate restock still works normally.
    w.eval('window.__lastRestockAt = 0;'); // simulate real time having passed
    setDraft(w, '3');
    w.eval('completeRestock()');
    assert.equal(qtyOf(w), 13, 'a later, separate restock is never blocked');
    assert.deepEqual(errors, []);
    close();
  });
}
