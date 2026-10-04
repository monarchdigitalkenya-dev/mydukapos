import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];

for (const app of APPS) {
  test(`${app}: measure-by-price maths (100 @ 90/kg -> 1.111, balanced totals) and only for measured units`, async () => {
    const b = await boot(app, { wait: 800 });
    const { w } = b;
    assert.ok(w.__mbp, 'block loaded');
    const c = w.__mbp.calc({ price: 90 }, 100);
    assert.equal(c.near.qty, 1.111);
    assert.equal(c.down.qty, 1.111); assert.equal(c.up.qty, 1.112);
    assert.ok(Math.abs(c.near.total - 99.99) < 0.005, 'total = price x qty, shown before applying');
    assert.equal(w.__mbp.calc({ price: 90 }, 0), null);
    assert.equal(w.__mbp.measured({ unit: 'kg' }), true);
    assert.equal(w.__mbp.measured({ unit: 'l' }), true);
    assert.equal(w.__mbp.measured({ unit: 'pcs' }), false);
    b.close();
  });

  test(`${app}: removing an item's image deletes it, stamps updatedAt and persists`, async () => {
    const b = await boot(app, { wait: 800 });
    const { w } = b;
    w.eval(`inventory.push({code:'IMG1',name:'Pic item',qty:5,price:10,wholesalePrice:5,image:'data:image/png;base64,AAAA'})`);
    const before = Date.now();
    assert.equal(w.removeItemImage('IMG1'), true);
    const p = w.eval(`inventory.find(x=>x.code==='IMG1')`);
    assert.equal(p.image, undefined);
    assert.ok(p.updatedAt >= before);
    assert.equal(JSON.parse(w.localStorage.getItem('pos_inventory')).find((x) => x.code === 'IMG1').image, undefined);
    assert.equal(w.removeItemImage('IMG1'), false, 'nothing to remove the second time');
    b.close();
  });

  test(`${app}: Balance Sheet balances (Assets = Liabilities + Equity) from the shop's data`, async () => {
    const b = await boot(app, { wait: 800 });
    const { w, d } = b;
    assert.ok(d.querySelector('#reports-tab [data-kind="balance"]'), 'button present');
    w.eval(`inventory.push({code:'BS1',name:'Sugar',qty:10,price:150,wholesalePrice:100})`);
    w.eval(`if (typeof tradeCredits!=='undefined'){ tradeCredits.push({id:'t1',direction:'i_owe',amount:300,status:'open'},{id:'t2',direction:'they_owe',amount:200,status:'open'},{id:'t3',direction:'i_owe',amount:999,status:'settled'}); }`);
    w.localStorage.setItem('pos_bs_cash_v1', '1000');
    const c = w.bsCompute();
    const hasTc = w.eval(`typeof tradeCredits!=='undefined'`);
    assert.ok(c.stockCost >= 1000);
    assert.equal(c.cash, 1000);
    if (hasTc) { assert.equal(c.iOwe, 300); assert.equal(c.theyOwe, 200); }
    assert.ok(Math.abs(c.assets - (c.liabilities + c.equity)) < 1e-9);
    w.reportsGenerate('balance');
    const out = d.getElementById('reports-output').innerHTML;
    assert.match(out, /Balance Sheet/); assert.match(out, /TOTAL ASSETS/);
    assert.ok(Array.isArray(w.__reportCsv) && w.__reportCsv.length > 5);
    b.close();
  });
}
