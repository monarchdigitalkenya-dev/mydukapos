import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot } from './helpers.mjs';

const money = (n) => `KES ${n.toFixed(2)}`;
const cells = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());

for (const app of APPS) {
  test(`${app}: stock report shows opening and closing stock value at retail`, async () => {
    const { w, d, errors, close } = await boot(app);
    // One item: 10 in stock now, retail 50, cost 30, and 2 sold today => it opened the day with 12.
    const list = app === 'water/index.html' ? 'products' : 'inventory';
    w.eval(`${list}.length = 0; ${list}.push({ code: 'T1', name: 'Test Item', qty: 10, price: 50, wholesalePrice: 30, wholesaleSellingPrice: 40, unit: 'pcs', category: 'bottled', type: 'stock', siteId: typeof activeSiteId !== 'undefined' ? activeSiteId : undefined });`);
    w.eval(`salesLog.push({ id: 's1', timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', siteId: typeof activeSiteId !== 'undefined' ? activeSiteId : undefined, items: [{ code: 'T1', name: 'Test Item', qty: 2, price: 50, unit: 'pcs', type: 'product' }] });`);
    w.eval('renderStockReport()');

    const heads = [...d.querySelectorAll('#stock-report-table thead th')].map((th) => th.textContent.trim());
    assert.deepEqual(heads.slice(-4), ['Opening Value (Cost)', 'Closing Value (Cost)', 'Opening Value (Retail)', 'Closing Value (Retail)']);
    const row = cells(d.querySelector('#stock-report-table tbody tr'));
    assert.equal(row.length, heads.length, 'row has one cell per column');
    assert.deepEqual(row.slice(-4), [money(12 * 30), money(10 * 30), money(12 * 50), money(10 * 50)], 'opening 12 / closing 10 at cost 30 and retail 50');
    assert.equal(d.getElementById('stock-report-total-opening-retail').textContent, money(600));
    assert.equal(d.getElementById('stock-report-total-closing-retail').textContent, money(500));
    assert.equal(d.getElementById('stock-report-total-opening-val').textContent, money(360), 'cost totals unchanged');

    // The printout carries the same columns.
    w.eval('printStockReport()');
    const body = d.getElementById('sales-report-body').innerHTML;
    assert.match(body, /Opening Value \(Retail\)<\/th><th>Closing Value \(Retail\)/);
    assert.ok(body.includes(money(600)) && body.includes(money(500)));
    const t = w.eval("typeof lastReportText === 'string' ? lastReportText : ''");
    if (t) {   // Aqua POS prints this report from the on-screen table only; every other app also builds a receipt-printer text version
      assert.match(t, /Opening Value \(Retail\): KES 600\.00\n {2}Closing Value \(Retail\): KES 500\.00/);
    }
    assert.deepEqual(errors, []);
    close();
  });
}
