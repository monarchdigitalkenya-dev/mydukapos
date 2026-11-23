import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// "In the hotel a bill was settled, and once refreshed it came back." A till that was slow to sync and still held the bill only had to TOUCH
// it (a reminder flag, a takeaway status) to give it a newer time than the deletion, and the settled bill reappeared on the server and on every till.
// For lists whose records get a unique id and are never re-created (bills, debts, suppliers, delivery zones, recurring expenses, contracts) a
// deletion is now final, and a bill only ever moves forward (settled stays settled, a payment is never lost). A settled bill is also KEPT
// (closed) so it shows under "Show closed bills".
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function backends() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{ name: 'blob', push: async (b) => { await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); }, state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json() }];
  if (hasSqlite) {
    const { ShopStore } = await load('wildcard-router/shop-store.js');
    const store = new ShopStore(fakeDoState(), {});
    out.push({ name: 'db', store, push: async (b) => { await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) })); }, state: async () => JSON.parse(store.stateText(120)) });
  }
  return out;
}

test('server: a deleted bill / debt / supplier / zone / recurring expense / contract cannot be brought back by a NEWER copy; an inventory item (same code re-added) still can (both backends)', async () => {
  for (const b of await backends()) {
    for (const col of ['bills', 'debts', 'suppliers', 'deliveryZones', 'recurringExpenses', 'contracts']) {
      const t = Date.now();
      await b.push({ updatedAt: t, [col]: [{ id: 'x1', name: 'Ann', updatedAt: t - 100 }, { id: 'x2', name: 'Bob', updatedAt: t - 100 }] });
      await wait();
      await b.push({ updatedAt: Date.now(), [col]: [{ id: 'x1', _deleted: true, updatedAt: Date.now() }] });
      await wait();
      await b.push({ updatedAt: Date.now(), [col]: [{ id: 'x1', name: 'Ann', lastOverdueReminderDate: '2026-09-21', updatedAt: Date.now() + 5000 }] });   // a stale till touches it: NEWER
      const st = await b.state();
      assert.deepEqual(st[col].map((x) => x.id), ['x2'], `${b.name}/${col}: the deleted record did not come back`);
    }
    // the code-keyed list is unchanged: the same code can be added again on purpose
    const t = Date.now();
    await b.push({ updatedAt: t, inventory: [{ code: 'A', qty: 1, updatedAt: t - 100 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', _deleted: true, updatedAt: Date.now() }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', qty: 9, name: 'Re-added', updatedAt: Date.now() + 5000 }] });
    assert.equal((await b.state()).inventory[0].qty, 9, `${b.name}: inventory: a newer record with the same code replaces the tombstone`);
  }
});

const INV = JSON.stringify([{ code: 'A1', type: 'item', name: 'Tea', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }]);
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
async function makeBill(dev) {
  dev.w.eval("showToast = function () {}; window.confirm = () => true");
  dev.w.eval("addToCart('A1'); addToCart('A1'); currentPaymentMethod = 'bill'");
  const nameEl = dev.w.document.getElementById('bill-customer-name-input'); if (nameEl) nameEl.value = 'Jane'; const ph = dev.w.document.getElementById('sms-checkout-phone-input'); if (ph) ph.value = '0712345678';   // zip 328: a bill needs a name AND a phone
  await dev.w.eval('checkoutCart()');
}
const settleAll = async (dev, id) => { dev.w.eval(`openBillSettleModal('sale', '${id}')`); await dev.w.eval('confirmBillSettle(true)'); };

for (const app of ['hotel/index.html', 'index.html']) {
  test(`${app}: a bill settled on the cashier till stays settled (closed, with its payment) when a stale till still holding it as open touches it — on the server, on the stale till once it syncs, and after a refresh`, async () => {
    const s = makeServer();
    const a = await openDevice(app, s, { pos_inventory: INV });
    await makeBill(a);
    await settled(a); await a.w.eval('pushNow()'); await a.w.eval('pullState()');
    await sleep(1200);
    const c = await openDevice(app, s, deviceStorage(a.w), 1500);                      // a waiter's / kitchen phone that holds the bill (open, unpaid)
    c.w.eval("showToast = function () {}; window.confirm = () => true");
    const id = a.w.eval('bills[0].id');
    await settleAll(a, id);                                                            // the cashier settles it
    await settled(a); await a.w.eval('pushNow()');
    const closedOnServer = () => (s.serverState().bills || []).map((x) => [!!x.closed, x.amountPaid]);
    assert.deepEqual(closedOnServer(), [[true, 200]], 'settled on the server');
    // the stale phone has not pulled yet: it touches its copy and pushes (a NEWER time, an OLDER state)
    c.w.eval("bills[0].takeawayStatus = 'collected'; bills[0].lastOverdueReminderDate = '2026-09-21'; safeSetItem('pos_bills', JSON.stringify(bills)); queuePush()");
    await settled(c); await c.w.eval('pushNow()');
    assert.deepEqual(closedOnServer(), [[true, 200]], 'the server still has it settled, with the payment');
    const openCount = (dev) => dev.w.eval('getOpenBillsList(false).length');
    const a2 = await openDevice(app, s, deviceStorage(a.w), 2500);
    await a2.w.eval('pullState()');
    assert.equal(openCount(a2), 0, 'the cashier till after a refresh: no open bill');
    assert.equal(a2.w.eval('bills[0].closed'), true, 'it is there as a closed bill');
    await c.w.eval('flushThenPull()');
    assert.equal(openCount(c), 0, 'the stale phone, once it syncs: no open bill'); assert.equal(c.w.eval('bills[0].closed'), true);
    for (const d of [a, c, a2]) d.close();
  });
}
