import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 164 - hotel: 💰 Sales quick view next to Bills (own sales for staff, everyone for the admin), and hide / show of the top bar.
const sale = (id, by, cash, mpesa, card, extra = {}) => ({ id, timestamp: new Date().toISOString(), servedBy: by, paymentMethod: 'cash', cashAmount: cash, mpesaAmount: mpesa, cardAmount: card, items: [{ code: 'X', name: 'X', price: cash + mpesa + card, qty: 1 }], ...extra });
const SALES = () => JSON.stringify([
  sale('s1', 'Sam', 500, 0, 0), sale('s2', 'Sam', 0, 300, 0), sale('s3', 'Joy', 200, 100, 50), sale('s4', 'Sam', 999, 0, 0, { voided: true }),
  sale('s5', 'Sam', 700, 0, 0, { timestamp: new Date(Date.now() - 3 * 86400000).toISOString() }),
]);
const app = () => boot('hotel/index.html', { storage: { pos_sales_log: SALES() }, wait: 1000 });
const vals = (d) => [...d.querySelectorAll('#my-sales-list .my-bills-box')].map((b) => b.querySelector('.lbl').textContent + '=' + b.querySelector('.val').textContent);

test('static: Sales button sits next to Bills; header has Hide and a Show bar', async () => {
  const { w, d, close } = await app();
  const ids = [...d.querySelectorAll('#my-bills-bar button')].map((b) => b.id);
  assert.deepEqual(ids, ['my-bills-toggle-btn', 'my-sales-toggle-btn']);
  assert.ok(d.getElementById('hdr-hide-btn') && d.getElementById('hdr-show-btn'));
  close();
});

test('everyone sees everyone (zip 195: sales are universal): day totals, voided and other days left out', async () => {
  const { w, d, errors, close } = await app();
  w.eval('toggleMySalesPanel()');
  assert.equal(d.getElementById('my-sales-panel').style.display, '');
  const all = vals(d);
  assert.deepEqual(all.slice(0, 4), ['Total=KES 1150.00', 'Cash=KES 700.00', 'M-Pesa=KES 400.00', 'Card=KES 50.00'], all.join(' | '));
  assert.ok(/Sam/.test(d.getElementById('my-sales-list').textContent) && /Joy/.test(d.getElementById('my-sales-list').textContent));
  w.eval("staff.push({ id: 'st1', name: 'Sam', roles: ['cashier'] }); currentServer = { id: 'st1', name: 'Sam' }; refreshMySalesPanel()");
  assert.deepEqual(vals(d).slice(0, 4), ['Total=KES 1150.00', 'Cash=KES 700.00', 'M-Pesa=KES 400.00', 'Card=KES 50.00'], 'staff see every device and staff member (zip 195)');
  assert.ok(/Joy/.test(d.getElementById('my-sales-list').textContent), 'a staff member sees the other servers too');
  w.eval("currentServer = { id: 'st2', name: 'Joy' }; refreshMySalesPanel()");
  assert.deepEqual(vals(d).slice(0, 4), ['Total=KES 1150.00', 'Cash=KES 700.00', 'M-Pesa=KES 400.00', 'Card=KES 50.00']);
  // another day
  const day3 = w.eval("bizDayKey(new Date(Date.now() - 3 * 86400000))");
  w.eval("currentServer = { id: 'st1', name: 'Sam' }; mySalesPickDay('" + day3 + "')");
  assert.deepEqual(vals(d), ['Total=KES 700.00', 'Cash=KES 700.00', 'M-Pesa=KES 0.00']);
  assert.deepEqual(errors, []);
  close();
});

test('hide / show the top bar: only the buttons change it, and it is remembered', async () => {
  const { w, d, close } = await app();
  const hidden = () => d.body.classList.contains('hdr-hidden');
  assert.equal(hidden(), false);
  w.eval("document.getElementById('hdr-hide-btn').click()");
  assert.equal(hidden(), true);
  assert.equal(w.eval("localStorage.getItem('pos_hosp_hdr_hidden')"), '1');
  // nothing re-shows it by itself: tab switches, sync-style re-renders, toasts
  w.eval("showToast('hello'); renderAllViews && renderAllViews(); guardedSwitchTab({ preventDefault() {} }, 'kitchen-tab'); guardedSwitchTab({ preventDefault() {} }, 'sales-tab');");
  assert.equal(hidden(), true, 'stays hidden until Show is pressed');
  w.eval("document.getElementById('hdr-show-btn').click()");
  assert.equal(hidden(), false);
  assert.equal(w.eval("localStorage.getItem('pos_hosp_hdr_hidden')"), '');
  close();
});
