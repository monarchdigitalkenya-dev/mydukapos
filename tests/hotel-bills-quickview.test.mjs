import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Hotel Sales Counter -> inline "Bills" panel: just two boxes.
//   green = money actually received on bills, red = money still owed on bills.
// Staff see only the bills they logged; admin sees a pair of boxes per server. Live-updates on sync.
const BILL = (id, servedBy, customer, total, amountPaid = 0) => ({
  id, total, timestamp: new Date().toISOString(), customerName: customer, paymentMethod: 'bill', paid: false, amountPaid, servedBy,
  items: [{ code: '1', name: 'SECRET-ITEM-NAME', qty: 1, price: total, unit: 'pcs', vatCategory: 'A' }],
});
const boxes = (d) => ({
  paid: d.querySelector('#my-bills-list .my-bills-box.paid .val')?.textContent,
  unpaid: d.querySelector('#my-bills-list .my-bills-box.unpaid .val')?.textContent,
});

test('hotel: Sales Counter has a Bills button that opens an inline panel (no popup)', async () => {
  const { d, errors, close } = await boot('hotel/index.html');
  const btn = d.getElementById('my-bills-toggle-btn');
  assert.ok(btn && d.getElementById('sales-tab').contains(btn), 'Bills button lives on the Sales Counter');
  const panel = d.getElementById('my-bills-panel');
  assert.equal(panel.style.display, 'none', 'closed by default');
  btn.click();
  assert.notEqual(panel.style.display, 'none', 'opens on click');
  assert.ok(d.getElementById('sales-tab').contains(panel), 'inline, not a modal');
  btn.click();
  assert.equal(panel.style.display, 'none', 'closes on second click');
  assert.deepEqual(errors, []);
  close();
});

test('hotel: staff see two boxes for their own bills only — paid money (green) and unpaid money (red)', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html');
  w.eval(`bills.push(
    ${JSON.stringify(BILL('a', 'Jane', 'Ann', 500))},
    ${JSON.stringify(BILL('b', 'Jane', 'Bea', 300, 300))},
    ${JSON.stringify(BILL('c', 'Jane', 'Cy', 800, 200))},
    ${JSON.stringify(BILL('d', 'Omar', 'Dee', 999, 100))},
    ${JSON.stringify(Object.assign(BILL('e', 'Jane', 'Voided', 111, 111), { voided: true }))}
  ); currentServer = { id: 'x', name: 'Jane' }; toggleMyBillsPanel();`);
  // Jane: received 0 + 300 + 200 = 500; still owed 500 + 0 + 600 = 1100. Omar's and the voided bill are ignored.
  assert.deepEqual(boxes(d), { paid: 'KES 500.00', unpaid: 'KES 1100.00' });
  const panel = d.getElementById('my-bills-panel');
  assert.equal(panel.querySelectorAll('.my-bills-box').length, 2, 'exactly two boxes');
  assert.ok(d.querySelector('#my-bills-list .my-bills-box.paid') && d.querySelector('#my-bills-list .my-bills-box.unpaid'));
  const text = panel.textContent;
  for (const hidden of ['Ann', 'Bea', 'Cy', 'Dee', 'Omar', 'SECRET-ITEM-NAME']) assert.ok(!text.includes(hidden), `"${hidden}" not shown`);
  assert.equal(panel.querySelectorAll('button, table, .my-bill-row').length, 0, 'no lists, filters or buttons');
  assert.deepEqual(errors, []);
  close();
});

test('hotel: a staff member with no bills still sees the two boxes at zero', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html');
  w.eval(`currentServer = { id: 'x', name: 'Nobody' }; toggleMyBillsPanel();`);
  assert.deepEqual(boxes(d), { paid: 'KES 0.00', unpaid: 'KES 0.00' });
  assert.deepEqual(errors, []);
  close();
});

test('hotel: admin sees one pair of boxes per server', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html');
  w.eval(`bills.push(
    ${JSON.stringify(BILL('a', 'Jane', 'Ann', 500))},
    ${JSON.stringify(BILL('b', 'Jane', 'Bea', 300, 300))},
    ${JSON.stringify(BILL('d', 'Omar', 'Dee', 999))},
    ${JSON.stringify(BILL('f', '', 'Old bill', 50))}
  ); currentServer = null; toggleMyBillsPanel();`);
  const names = [...d.querySelectorAll('#my-bills-list .my-bills-staff')].map((n) => n.textContent.trim());
  assert.equal(names.length, 3, 'Jane, Omar and the admin (old bill with nobody on it)');
  assert.ok(names.includes('👤 Jane') && names.includes('👤 Omar'));
  assert.equal(d.querySelectorAll('#my-bills-list .my-bills-box').length, 6, 'two boxes per server');
  const jane = [...d.querySelectorAll('#my-bills-list .my-bills-staff')].find((n) => n.textContent.includes('Jane')).nextElementSibling;
  assert.equal(jane.querySelector('.paid .val').textContent, 'KES 300.00');
  assert.equal(jane.querySelector('.unpaid .val').textContent, 'KES 500.00');
  assert.deepEqual(errors, []);
  close();
});

test('hotel: boxes update live when a bill is paid on another device (synced in), without any refresh', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html');
  w.eval(`bills.push(${JSON.stringify(BILL('a', 'Jane', 'Ann', 500))}); currentServer = { id: 'x', name: 'Jane' }; toggleMyBillsPanel();`);
  assert.deepEqual(boxes(d), { paid: 'KES 0.00', unpaid: 'KES 500.00' });
  // Another device settles part of the bill; the change arrives through the normal sync path (poll / WebSocket push).
  const remote = JSON.stringify({ updatedAt: Date.now() + 1000, bills: [BILL('a', 'Jane', 'Ann', 500, 200)] });
  w.eval(`applyRemotePayload(${remote})`);
  assert.deepEqual(boxes(d), { paid: 'KES 200.00', unpaid: 'KES 300.00' });
  const remote2 = JSON.stringify({ updatedAt: Date.now() + 2000, bills: [BILL('a', 'Jane', 'Ann', 500, 500), BILL('n', 'Jane', 'New', 100)] });
  w.eval(`applyRemotePayload(${remote2})`);
  assert.deepEqual(boxes(d), { paid: 'KES 500.00', unpaid: 'KES 100.00' });
  assert.deepEqual(errors, []);
  close();
});

test('hotel: boxes update when a bill is settled on this device', async () => {
  const { w, d, errors, close } = await boot('hotel/index.html');
  w.eval(`bills.push(${JSON.stringify(BILL('a', 'Jane', 'Ann', 500))}); currentServer = { id: 'x', name: 'Jane' }; toggleMyBillsPanel();`);
  w.eval('bills[0].amountPaid = 500; recomputeBillStatus(bills[0]); renderBillsTab();');
  assert.deepEqual(boxes(d), { paid: 'KES 500.00', unpaid: 'KES 0.00' });
  assert.deepEqual(errors, []);
  close();
});
