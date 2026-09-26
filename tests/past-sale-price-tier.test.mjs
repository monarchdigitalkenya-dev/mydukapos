import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Reported: "in production and every other module ... for recording a past
// sale I cannot quote the price its just fixed I need to be able to record
// either retail, wholesale or custom for past sales or past hires." The
// field was always a plain editable number that silently defaulted to
// retail with no visible route to wholesale — this covers the fix
// (Retail/Wholesale/Custom quick-select, same idea as the live counter).
const INV = JSON.stringify([
  { code: 'P1', type: 'item', name: 'Priced Item', price: 500, wholesalePrice: 200, wholesaleSellingPrice: 400, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'P2', type: 'item', name: 'No Wholesale Item', price: 300, wholesalePrice: 100, qty: 10, unit: 'pcs', vatCategory: 'A' },
]);

for (const app of ['index.html', 'production/index.html', 'hotel/index.html', 'hospital/index.html', 'services/index.html', 'pharmacy/index.html']) {
  test(`${app}: Record a Past Sale defaults to Retail but Wholesale is one tap away, and Custom clears the field for a typed amount`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
    const { w } = b;
    w.eval("selectPastSaleItem('P1')");
    assert.equal(w.document.getElementById('past-sale-price-input').value, '500.00', 'defaults to retail, same as before this fix');
    assert.match(w.document.getElementById('past-sale-price-wholesale-btn').textContent, /400\.00/, 'the wholesale button shows the item\'s real wholesale price, not a placeholder');

    w.eval("choosePastSalePriceTier('wholesale')");
    assert.equal(w.document.getElementById('past-sale-price-input').value, '400.00', 'one tap now fills the wholesale price — previously only reachable by typing it in by hand');

    w.eval("choosePastSalePriceTier('custom')");
    assert.equal(w.document.getElementById('past-sale-price-input').value, '', 'Custom clears the field for a free-typed amount instead of leaving the retail default silently in place');
    w.document.getElementById('past-sale-price-input').value = '275';
    assert.equal(w.document.getElementById('past-sale-price-input').value, '275', 'a custom price can still be typed freely, exactly as before');
    b.close();
  });

  test(`${app}: an item with no wholesale price set hides the Wholesale button instead of offering a meaningless KES 0.00`, async () => {
    const b = await boot(app, { storage: { pos_inventory: INV }, wait: 900 });
    const { w } = b;
    w.eval("selectPastSaleItem('P2')");
    assert.equal(w.document.getElementById('past-sale-price-wholesale-btn').style.display, 'none');
    b.close();
  });
}
