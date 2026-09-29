import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { ledgerIntegrity } from '../functions/api/_merge.js';

// zip 155: "I add an item / change the quantity or price, refresh, and it is gone", "a sale or a bill disappears", "the books do not balance".
// One shop, one till: make everything, refresh (with the server down, then up), and check that every number is still there and adds up.
const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true");
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);

test('item edits, a cash sale and a bill all survive refreshes (also with the server down) and the stock adds up', async () => {
  const s = makeServer();
  let a = await openDevice('index.html', s, { pos_inventory: INV });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("updateInventoryField('A1', 'price', '120')");
  a.w.eval("updateInventoryField('A1', 'qty', '60')");
  await settled(a);
  // a cash sale of 2 and a bill of 3
  a.w.eval("currentPaymentMethod = 'cash'; addToCart('A1'); addToCart('A1'); document.getElementById('cash-tendered-input').value = '100000'");
  await a.w.eval('checkoutCart()');
  a.w.eval("addToCart('A1'); addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
  const nameEl = a.w.document.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane';
  await a.w.eval('checkoutCart()');
  await settled(a);
  const sold = () => a.w.eval('salesLog.length'), billsN = () => a.w.eval('bills.length');
  assert.equal(sold() >= 1, true, 'the sale is recorded');
  assert.equal(billsN() >= 1 || a.w.eval("salesLog.some(x => x.paymentMethod === 'bill' || x.isBill)"), true, 'the bill is recorded');
  const before = { price: a.w.eval("inventory[0].price"), qty: a.w.eval("inventory[0].qty"), sales: sold(), bills: billsN() };
  assert.equal(before.price, 120); assert.equal(before.qty, 60 - 5, 'stock = counted 60 minus 2 cash minus 3 on bill');

  for (const mode of ['server down', 'server up']) {
    s.state.down = mode === 'server down';
    const st = deviceStorage(a.w); a.close();
    a = await openDevice('index.html', s, st, 1500); quiet(a.w);
    assert.equal(a.w.eval("inventory[0].price"), 120, mode + ': price');
    assert.equal(a.w.eval("inventory[0].qty"), 55, mode + ': qty');
    assert.equal(a.w.eval('salesLog.length'), before.sales, mode + ': sales');
    assert.equal(a.w.eval('bills.length'), before.bills, mode + ': bills');
  }
  s.state.down = false;
  await a.w.eval('pushNow()'); await settled(a);
  const srv = s.serverState();
  assert.equal(srv.inventory[0].price, 120); assert.equal(srv.inventory[0].qty, 55);
  assert.equal(srv.salesLog.length, before.sales); assert.equal((srv.bills || []).length, before.bills);
  const moved = (srv.stockMovementLog || []).reduce((n, m) => n + (m.delta || 0), 0);
  assert.equal(50 + moved, srv.inventory[0].qty, 'opening stock 50 + every recorded movement (edit +10, sales -2, -3) = stock on hand');
  assert.ok(ledgerIntegrity(srv).ok, 'database, history and figures agree');
  a.close();
});
