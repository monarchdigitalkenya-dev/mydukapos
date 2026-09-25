import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html', 'owner/index.html'];

test('every app carries the phone card styles and the fix for tiny form fields', () => {
  for (const a of APPS) {
    const html = fs.readFileSync(path.join(ROOT, a), 'utf8');
    assert.match(html, /table\.m-cards td::before \{ content: attr\(data-label\)/, `${a}: card layout`);
    assert.match(html, /font-size: 16px !important/, `${a}: 16px fields`);
    assert.match(html, /@media \(max-width: 700px\)/, `${a}: phone breakpoint`);
  }
});

const ITEMS = Array.from({ length: 4 }, (_, i) => ({ code: 'C' + i, type: 'item', name: 'Product ' + i, price: 100 + i, wholesalePrice: 60, qty: 10 + i, unit: 'pcs', vatCategory: 'A', category: 'Cat' }));
const phone = (w, on) => { w.matchMedia = () => ({ matches: on, addEventListener() {}, removeEventListener() {} }); };

for (const app of ['hotel/index.html', 'index.html', 'hospital/index.html']) {
  test(`${app}: on a phone the Inventory table becomes labelled cards (name as the title, buttons at the bottom); new rows are labelled as they appear; a computer is untouched`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: JSON.stringify(ITEMS) }, wait: 1500 });
    const table = d.getElementById('inventory-table');
    // computer: nothing added
    assert.ok(!table.classList.contains('m-cards'));
    assert.equal(table.querySelectorAll('td[data-label]').length, 0);
    // phone
    phone(w, true); w.eval('renderInventoryTable(); mobileCardsRefresh()'); await sleep(200);
    assert.ok(table.classList.contains('m-cards'), 'the table is in card mode');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.replace(/\s+/g, ' ').trim());
    const row = table.querySelector('tbody tr');
    const labels = [...row.children].map((td) => td.getAttribute('data-label'));
    assert.deepEqual(labels, heads, 'each cell carries its column name');
    assert.ok(row.querySelector('td[data-title]'), 'the item name is the card title');
    // rows drawn later (a search, a sync, an edit) are labelled too
    w.eval("inventory.push({ code: 'NEW1', type: 'item', name: 'Brand New', price: 5, wholesalePrice: 3, qty: 2, unit: 'pcs', vatCategory: 'A' }); renderInventoryTable()"); await sleep(200);
    const rows = [...table.querySelectorAll('tbody tr')];
    assert.ok(rows.length >= 5); assert.ok(rows.every((r) => r.querySelector('td[data-label]')), 'every row, old and new, is labelled');
    // the sales-counter cart keeps its own compact layout
    assert.ok(!d.getElementById('cart-table').classList.contains('m-cards'));
    // back to a wide screen: cards off
    phone(w, false); w.eval('mobileCardsRefresh()');
    assert.ok(!table.classList.contains('m-cards'));
    assert.deepEqual(errors, []);
    close();
  });
}

test('other wide tables become cards too (Store, Bills, Daily Sales, Stock Report, Restock, Orders), and 2-3 column tables are left alone', async () => {
  const { w, d, close } = await boot('hotel/index.html', { wait: 1500 });
  phone(w, true); w.eval('mobileCardsRefresh()'); await sleep(200);
  for (const id of ['store-items-table', 'bills-table', 'daily-sales-table', 'stock-report-table', 'restock-rows-table', 'po-orders-table', 'debts-table', 'kitchen-table']) {
    assert.ok(d.getElementById(id).classList.contains('m-cards'), `${id} is card-ready`);
  }
  assert.ok(!d.getElementById('dash-top-sellers-table').classList.contains('m-cards'), '3 columns: unchanged');
  close();
});
