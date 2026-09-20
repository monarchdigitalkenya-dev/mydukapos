import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// A device that pushes right after another device's change must not mark itself "up to date" and miss that change.
test('till B pushes something unrelated right after till A changed a record: B still receives A\'s change', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, {}); a.w.eval("showToast = function () {}");
  a.w.eval("suppliers.push({ id: 'S0', name: 'First', updatedAt: 1 }); safeSetItem('pos_suppliers', JSON.stringify(suppliers))");
  await a.w.eval('pushNow()'); await a.w.eval('pullState()'); await sleep(100);
  const b = await openDevice('index.html', s, deviceStorage(a.w), 1200); b.w.eval("showToast = function () {}");
  // A adds a supplier; B has not heard yet
  a.w.eval("suppliers.push({ id: 'S1', name: 'Added by A', updatedAt: Date.now() }); safeSetItem('pos_suppliers', JSON.stringify(suppliers))");
  await a.w.eval('pushNow()');
  // B, before its poll/poke arrives, pushes an unrelated change and then pulls
  b.w.eval("paymentDetails = 'Till 4455'; safeSetItem('pos_payment_details', paymentDetails)");
  await b.w.eval('pushNow()');
  await sleep(300);
  await b.w.eval('pullState()'); await sleep(150);
  assert.ok(b.w.eval("suppliers.some(x => x.id === 'S1')"), 'B has the supplier A added');
  await a.w.eval('pullState()'); await sleep(150);
  assert.equal(a.w.eval('paymentDetails'), 'Till 4455', 'and A got B\'s change too');
  a.close(); b.close();
});
