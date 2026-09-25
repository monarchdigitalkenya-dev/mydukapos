import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE } from './helpers.mjs';

const BILL = (id, servedBy, customer, siteId) => ({ id, siteId, total: 100, timestamp: new Date().toISOString(), customerName: customer, paymentMethod: 'bill', paid: false, amountPaid: 0,
  servedBy, items: [{ code: '1', name: 'Thing', qty: 1, price: 100, unit: 'pcs', vatCategory: 'A' }] });
const cellsOf = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());

// The Bills list shows who served each bill; an old bill saved with nobody shows the admin.
for (const app of APPS) {
  test(`${app}: Bills tab has a "Served By" column`, async () => {
    const { w, d, errors, close } = await boot(app);
    const heads = [...d.querySelectorAll('#bills-table thead th')].map((th) => th.textContent.trim());
    assert.ok(heads.includes('Served By'), `${app}: header ${heads.join(' | ')}`);
    const col = heads.indexOf('Served By');
    const site = w.eval("typeof activeSiteId !== 'undefined' ? activeSiteId : null");   // Aqua POS scopes bills to the active site
    w.eval(`bills.push(${JSON.stringify(BILL('b1', 'Jane', 'Ann', site))}, ${JSON.stringify(BILL('b2', '', 'Bob', site))}); renderBillsTab();`);
    const rows = [...d.querySelectorAll('#bills-table tbody tr')];
    assert.equal(rows.length, 2);
    const byCustomer = Object.fromEntries(rows.map((r) => { const c = cellsOf(r); return [c.find((x) => x === 'Ann' || x === 'Bob'), c]; }));
    assert.equal(byCustomer.Ann[col], 'Jane', 'named server shown');
    assert.equal(byCustomer.Bob[col], 'Admin', 'bill with no server falls back to the admin');
    assert.equal(rows[0].children.length, heads.length, 'row and header have the same number of columns');
    assert.deepEqual(errors, []);
    close();
  });
}

// Printed bills and receipts always carry a "Served by" line, in the print and the preview.
for (const app of APPS) {
  test(`${app}: printed bill/receipt always says who served`, async () => {
    const { w, d, close } = await boot(app);
    for (const sale of [BILL('x', 'Jane', 'Ann'), BILL('y', '', 'Bob'), Object.assign({}, SAMPLE_SALE, { servedBy: undefined })]) {
      w.eval('renderReceipt(' + JSON.stringify(Object.assign({ refNumber: 'R-1' }, sale)) + ')');
      const raw = w.eval('lastReceiptText');
      const who = sale.servedBy || 'Admin';
      assert.ok(raw.includes(`Served by: ${who}`), `${app}: print says "Served by: ${who}"`);
      assert.ok(d.getElementById('receipt-body').textContent.includes(`Served by: ${who}`), `${app}: preview says it too`);
    }
    close();
  });
}
