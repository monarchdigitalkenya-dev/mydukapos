import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';

// zip 293: an order a waiter POSTED must show in that waiter's own order list - even when the table's tab was opened by someone else.
test('hotel: a waiter sees the order they posted on a table another waiter opened; still not other waiters\' own tabs', async () => {
  const inv = [{ code: 'T1', type: 'item', name: 'Tea', price: 50, wholesalePrice: 20, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Drinks' }];
  const dev = await openDevice('hotel/index.html', makeServer(), { pos_inventory: JSON.stringify(inv) });
  const { w } = dev;
  w.eval("showToast = function () {}; tables = ['Table 1']; currentServer = { id: 's2', name: 'Mary' }");
  w.eval("svcDraft = { tabId: null, lines: [{ code: 'T1', qty: 1 }] }; document.getElementById('svc-new-location').innerHTML = '<option value=\"Table 1\">Table 1</option>'; document.getElementById('svc-new-location').value = 'Table 1';");
  assert.ok(w.eval('svcPostOrder()'), 'Mary opened Table 1');
  w.eval("currentServer = { id: 's1', name: 'Jane' }");
  assert.equal(w.eval('hospVisibleTabs().length'), 0, 'Jane does not see Mary\'s table before she posts');
  w.eval("svcDraft = { tabId: " + JSON.stringify(w.eval('tabs[0].id')) + ", lines: [{ code: 'T1', qty: 1 }] }");
  assert.ok(w.eval('svcPostOrder()'), 'Jane adds to Table 1');
  assert.equal(w.eval('hospVisibleTabs().length'), 1, 'Jane now sees the table she posted to');
  dev.close();
});
