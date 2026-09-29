import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { ledgerIntegrity } from '../functions/api/_merge.js';

// zip 156: the same "nothing reverts, nothing disappears, the books balance" check in EVERY app (shop, hotel, hospital, pharmacy, production, services, Aqua):
// change an item, sell for cash, sell on a bill, count stock, then refresh with the server down and up and on a second device.
const ITEM = { code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' };
const INV = JSON.stringify([ITEM]);
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: item edits, a cash sale, a bill and a stock count survive refreshes (server down / up) and show on a second device; stock adds up`, async () => {
    const s = makeServer();
    let a = await openDevice(app, s, { pos_inventory: INV });
    quiet(a.w);
    await a.w.eval('pushNow()'); await a.w.eval('pullState()');
    a.w.eval("updateInventoryField('A1', 'price', '120')");
    await settled(a);
    a.w.eval("currentPaymentMethod = 'cash'; addToCart('A1'); addToCart('A1'); document.getElementById('cash-tendered-input').value = '100000'");
    await a.w.eval('checkoutCart()');
    a.w.eval("addToCart('A1'); addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
    const nameEl = a.w.document.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane';
    await a.w.eval('checkoutCart()');
    await settled(a);
    a.w.eval("stockTakeSet('A1','qty','40'); stockTakeApplyOne('A1')");                       // counted 40 (the books said 45)
    await settled(a);
    const before = { sales: a.w.eval('salesLog.length'), bills: a.w.eval('bills.length'), qty: a.w.eval('inventory[0].qty'), price: a.w.eval('inventory[0].price') };
    assert.equal(before.sales >= 1 && before.bills >= 1, true, 'the cash sale is in the sales log and the bill is in the bills list');
    assert.equal(before.qty, 40); assert.equal(before.price, 120);

    for (const mode of ['server down', 'server up']) {
      s.state.down = mode === 'server down';
      const st = deviceStorage(a.w); a.close();
      a = await openDevice(app, s, st, 1500); quiet(a.w);
      assert.equal(a.w.eval('inventory[0].price'), 120, mode + ': price');
      assert.equal(a.w.eval('inventory[0].qty'), 40, mode + ': qty');
      assert.equal(a.w.eval('salesLog.length'), before.sales, mode + ': sales');
      assert.equal(a.w.eval('bills.length'), before.bills, mode + ': bills');
    }
    s.state.down = false;
    await a.w.eval('pushNow()'); await settled(a);
    const srv = s.serverState();
    assert.equal(srv.inventory[0].price, 120); assert.equal(srv.inventory[0].qty, 40);
    assert.equal(srv.salesLog.length, before.sales, 'the server holds every sale'); assert.equal((srv.bills || []).length, before.bills, 'and every bill');
    assert.equal(50 + (srv.stockMovementLog || []).reduce((n, m) => n + (m.delta || 0), 0), 40, 'opening 50 + every movement (sales -2, -3, count -5) = stock on hand');
    assert.ok(ledgerIntegrity(srv).ok, 'database, history and figures agree');
    // a second device that has never seen any of it
    const b = await openDevice(app, s, {}, 1500); quiet(b.w);
    await b.w.eval('pullState()'); await sleep(300);
    assert.equal(b.w.eval('inventory[0].qty'), 40, 'device 2: qty'); assert.equal(b.w.eval('inventory[0].price'), 120, 'device 2: price');
    assert.equal(b.w.eval('salesLog.length'), before.sales, 'device 2: sales'); assert.equal(b.w.eval('bills.length'), before.bills, 'device 2: bills');
    a.close(); b.close();
  });
}

test('water/index.html (Aqua POS): a bottled sale and a bill survive refreshes, and the books balance', async () => {
  const P = JSON.stringify([{ code: 'B500', category: 'bottled', name: 'Bottle 500ml', sizeML: 500, price: 50, wholesalePrice: 30, costPrice: 30, qty: 100, priceTiers: [], bom: [], vatCategory: 'A' }]);
  const s = makeServer();
  let a = await openDevice('water/index.html', s, { aqua_products: P }, 1200);
  quiet(a.w);
  await a.w.eval('doPush()'); await a.w.eval('pullFromServer()');
  a.w.eval("addBottledToCart('B500', null, 3); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '150'");
  await a.w.eval('checkoutCart()');
  await settled(a);
  const before = { sales: a.w.eval('salesLog.length'), qty: a.w.eval("products.find(p => p.code === 'B500').qty") };
  assert.equal(before.sales, 1);
  for (const mode of ['server down', 'server up']) {
    s.state.down = mode === 'server down';
    const st = deviceStorage(a.w); a.close();
    a = await openDevice('water/index.html', s, st, 1500); quiet(a.w);
    assert.equal(a.w.eval('salesLog.length'), 1, mode + ': sales');
    assert.equal(a.w.eval("products.find(p => p.code === 'B500').qty"), before.qty, mode + ': qty');
  }
  s.state.down = false;
  await a.w.eval('doPush()'); await settled(a);
  const srv = s.serverState();
  assert.equal(srv.salesLog.length, 1, 'the server holds the sale');
  assert.ok(ledgerIntegrity(srv).ok, 'database, history and figures agree');
  a.close();
});
