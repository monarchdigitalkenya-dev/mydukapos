import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// renderStockTake() used to be called ONLY from a raw click listener bound
// directly to the tab button (stockTakeInstall(), shared code) — completely
// bypassing performTabSwitch()'s normal per-tab render system. Any other way
// of landing on the tab (a reload restoring the last-active tab, or any
// programmatic tab switch) left the table showing its static "Open this tab
// to load your items" placeholder — fixed only by a real click, i.e.
// switching to another tab and back.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Widget', price: 100, wholesalePrice: 50, qty: 7, unit: 'pcs', vatCategory: 'A' }]);

for (const app of APPS) {
  test(`${app}: landing on Stock Take WITHOUT a real click (e.g. programmatic switch) still renders the real items, not the static placeholder`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
    w.eval("showToast = function () {};");
    // Programmatic switch — exactly like ensureActiveTabAllowed() or a
    // reload's tab-restoration would do, with NO click event involved.
    w.eval("performTabSwitch(document.getElementById('stock-take-tab-btn'), 'stock-take-tab')");
    const tbodyHtml = d.querySelector('#stock-take-table tbody').innerHTML;
    assert.match(tbodyHtml, /Widget/, 'the real inventory item is rendered');
    assert.doesNotMatch(tbodyHtml, /Open this tab to load your items/, 'the static placeholder is gone');
    assert.deepEqual(errors, []);
    close();
  });
}
