import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';

// zip 156 (server) — merge rules, on BOTH storage backends (the single record and the shop database must give the same answer):
//   DEFECT 3  concurrent payments on one bill / debt were lost (the "more advanced" bill or the newest debt replaced the other whole)
//   DEFECT 5  a non-array value for a list field (null, {}, '') replaced the stored list
//   DEFECT 6  a small gap between the device's clock and the server's (upload delay, a retry) was "corrected" as if it were clock error
//   DEFECT 7  the shop database lacked two rules the single record has: blank unstamped settings never replace a stored value; the inventory
//             photo / pour setup survives a newer copy that leaves it empty
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const sync = await load('functions/api/pos-sync.js');
const merge = await load('functions/api/_merge.js');
const { ShopStore } = await load('wildcard-router/shop-store.js');
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();

async function backends() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
  const out = [{ name: 'blob', kv, push: async (b) => { const r = await sync.onRequestPost({ request: req('POST', { businessName: 'Biz', ...b }), env, waitUntil() {} }); assert.equal(r.status, 200); }, state: async () => (await sync.onRequestGet({ request: req('GET'), env })).json() }];
  if (hasSqlite) {
    const store = new ShopStore(fakeDoState(), {});
    out.push({ name: 'db', store, push: async (b) => { await store.fetch(new Request('https://s/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', ...b }, serverNow: Date.now() }) })); }, state: async () => JSON.parse(store.stateText(null)) });
  }
  return out;
}

const bill = (extra = {}) => ({ id: 'b1', timestamp: iso(Date.now() - 86400000), customerName: 'X', items: [{ code: 'A', name: 'Alpha', price: 100, qty: 1 }], amountPaid: 0, paymentHistory: [], status: 'unpaid', closed: false, ...extra });
const pay = (id, amount, at) => ({ id, timestamp: iso(at), amount, method: 'cash', reference: '' });

test('DEFECT 3: two tills each take a payment on the same bill — both payments are kept, the paid amount is their sum, and the bill closes (both orders, both backends)', async () => {
  for (const order of ['1-2', '2-1']) {
    for (const b of await backends()) {
      const t = Date.now();
      await b.push({ updatedAt: t, bills: [bill({ updatedAt: t - 5000 })] });
      await wait();
      const till1 = { updatedAt: t + 1, bills: [bill({ amountPaid: 60, status: 'partially_paid', paymentHistory: [pay('pA', 60, t - 2000)], updatedAt: t - 2000 })] };
      const till2 = { updatedAt: t + 2, bills: [bill({ amountPaid: 40, status: 'partially_paid', paymentHistory: [pay('pB', 40, t - 1000)], updatedAt: t - 1000 })] };
      for (const p of (order === '1-2' ? [till1, till2] : [till2, till1])) { await b.push({ ...p, updatedAt: Date.now() }); await wait(); }
      const bl = (await b.state()).bills.find((x) => x.id === 'b1');
      assert.deepEqual(bl.paymentHistory.map((p) => p.id).sort(), ['pA', 'pB'], `${b.name}/${order}: both payments`);
      assert.equal(bl.amountPaid, 100, `${b.name}/${order}: paid = 60 + 40`);
      assert.equal(bl.closed, true, `${b.name}/${order}: fully paid = closed`);
      assert.equal(bl.status, 'fully_paid');
      // the same push again changes nothing (a retry)
      await b.push({ ...till1, updatedAt: Date.now() }); await wait();
      const again = (await b.state()).bills.find((x) => x.id === 'b1');
      assert.equal(again.paymentHistory.length, 2, `${b.name}/${order}: a retry adds nothing`);
      assert.equal(again.amountPaid, 100);
    }
  }
});

test('DEFECT 3: a line added on one till and a payment taken on another both survive; payments without an id are told apart by their content', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    await b.push({ updatedAt: t, bills: [bill({ updatedAt: t - 5000 })] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [bill({ amountPaid: 50, paymentHistory: [pay('p1', 50, t - 2000)], status: 'partially_paid', updatedAt: t - 2000 })] });
    await wait();
    // till 2 (had not pulled): adds a line to the bill (newer) and records nothing paid
    await b.push({ updatedAt: Date.now(), bills: [bill({ items: [{ code: 'A', name: 'Alpha', price: 100, qty: 1 }, { code: 'B', name: 'Beta', price: 300, qty: 1 }], updatedAt: t - 1000 })] });
    await wait();
    let bl = (await b.state()).bills[0];
    assert.equal(bl.items.length, 2, `${b.name}: the added line is there`);
    assert.equal(bl.amountPaid, 50, `${b.name}: the payment is still there`);
    assert.equal(bl.paymentHistory.length, 1);
    assert.equal(bl.closed, false, `${b.name}: 50 of 400 paid is not closed`);
    // id-less payments: the same one sent twice is one payment, a different one is another
    const idless = (amount, at) => ({ timestamp: iso(at), amount, method: 'cash' });
    await b.push({ updatedAt: Date.now(), bills: [bill({ id: 'b2', amountPaid: 30, paymentHistory: [idless(30, t - 900)], updatedAt: t - 900 })] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [bill({ id: 'b2', amountPaid: 30, paymentHistory: [idless(30, t - 900)], updatedAt: t - 800 })] });   // the same payment again
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [bill({ id: 'b2', amountPaid: 20, paymentHistory: [idless(20, t - 700)], updatedAt: t - 700 })] });    // another one
    bl = (await b.state()).bills.find((x) => x.id === 'b2');
    assert.equal(bl.paymentHistory.length, 2, `${b.name}: two distinct id-less payments`);
    assert.equal(bl.amountPaid, 50);
  }
});

test('DEFECT 3: a settled bill never re-opens, and a payment is never taken off, when a stale copy arrives with a newer time', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    await b.push({ updatedAt: t, bills: [bill({ amountPaid: 100, closed: true, status: 'fully_paid', paymentHistory: [pay('pA', 60, t - 3000), pay('pB', 40, t - 2000)], updatedAt: t - 2000 })] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [bill({ takeawayStatus: 'collected', updatedAt: t + 9000 })] });
    const bl = (await b.state()).bills[0];
    assert.equal(bl.closed, true, `${b.name}: still closed`);
    assert.equal(bl.amountPaid, 100); assert.equal(bl.paymentHistory.length, 2);
  }
});

test('DEFECT 3: two tills each take a payment on the same debt — both payments are kept (both orders, both backends); a retry adds nothing', async () => {
  for (const order of ['1-2', '2-1']) {
    for (const b of await backends()) {
      const t = Date.now();
      const debt = (extra) => ({ id: 'd1', amount: 1000, customerName: 'X', payments: [], ...extra });
      await b.push({ updatedAt: t, debts: [debt({ updatedAt: t - 5000 })] });
      await wait();
      const p1 = { updatedAt: Date.now(), debts: [debt({ payments: [{ id: 'p1', amount: 200, method: 'cash', timestamp: iso(t - 2000) }], updatedAt: t - 2000 })] };
      const p2 = { updatedAt: Date.now(), debts: [debt({ payments: [{ id: 'p2', amount: 300, method: 'cash', timestamp: iso(t - 1000) }], updatedAt: t - 1000 })] };
      for (const p of (order === '1-2' ? [p1, p2] : [p2, p1])) { await b.push({ ...p, updatedAt: Date.now() }); await wait(); }
      await b.push({ ...p1, updatedAt: Date.now() });
      const d = (await b.state()).debts[0];
      assert.deepEqual(d.payments.map((p) => p.id).sort(), ['p1', 'p2'], `${b.name}/${order}`);
      assert.equal(d.payments.reduce((s, p) => s + p.amount, 0), 500);
    }
  }
});

test('DEFECT 3: a deleted bill / debt stays deleted even with the payment union (final tombstone)', async () => {
  for (const b of await backends()) {
    const t = Date.now();
    await b.push({ updatedAt: t, bills: [bill({ updatedAt: t - 5000 })], debts: [{ id: 'd1', amount: 5, payments: [], updatedAt: t - 5000 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [{ id: 'b1', _deleted: true, updatedAt: Date.now() }], debts: [{ id: 'd1', _deleted: true, updatedAt: Date.now() }] });
    await wait();
    await b.push({ updatedAt: Date.now(), bills: [bill({ paymentHistory: [pay('pZ', 5, t)], amountPaid: 5, updatedAt: Date.now() + 5000 })], debts: [{ id: 'd1', amount: 5, payments: [{ id: 'pz', amount: 5 }], updatedAt: Date.now() + 5000 }] });
    const st = await b.state();
    assert.equal(st.bills.length, 0, `${b.name}: bill stays deleted`); assert.equal(st.debts.length, 0, `${b.name}: debt stays deleted`);
  }
});

test('DEFECT 5: a null / {} / "" for a list field never replaces the stored list (both backends)', async () => {
  for (const b of await backends()) {
    const good = () => ({ updatedAt: Date.now(), salesLog: [{ id: '1', timestamp: iso(Date.now()), items: [], updatedAt: Date.now() }, { id: '2', timestamp: iso(Date.now()), items: [], updatedAt: Date.now() }], bills: [bill({ updatedAt: 1 })], inventory: [{ code: 'A', qty: 5, updatedAt: 1 }] });
    await b.push(good());
    for (const bad of [null, {}, '']) {
      await b.push({ updatedAt: Date.now(), salesLog: bad, bills: bad, inventory: bad });
      const st = await b.state();
      assert.deepEqual(st.salesLog.map((x) => x.id), ['1', '2'], `${b.name}: salesLog after ${JSON.stringify(bad)}`);
      assert.equal(st.bills.length, 1, `${b.name}: bills after ${JSON.stringify(bad)}`);
      assert.equal(st.inventory.length, 1, `${b.name}: inventory after ${JSON.stringify(bad)}`);
      assert.ok(Array.isArray(st.salesLog));
    }
  }
});

test('DEFECT 6: a device clock that is a little off (upload delay, retry) is NOT "corrected"; a really wrong clock still is', () => {
  const now = 1_800_000_000_000;
  const push = (offset) => ({ updatedAt: now - offset, customers: [{ id: 'c1', updatedAt: now - offset - 500 }], stockMovementLog: [{ id: 'm', code: 'A', delta: -1, timestamp: iso(now - offset - 500) }], _fieldTimes: { vatRateA: now - offset } });
  for (const off of [3000, 30000, 90000, 119000]) {
    const b = push(off), out = merge.correctClockDrift(b, now);
    assert.deepEqual(out, b, `an offset of ${off} ms is left alone`);
  }
  for (const off of [125000, 300000, -300000, 3_600_000]) {
    const out = merge.correctClockDrift(push(off), now);
    assert.equal(out.customers[0].updatedAt, now - 500, `an offset of ${off} ms is corrected`);
    assert.equal(Date.parse(out.stockMovementLog[0].timestamp), now - 500);
    assert.equal(out._fieldTimes.vatRateA, now);
  }
});

test('DEFECT 6: an edit made a few seconds LATER on the other till wins, although the first device\'s slow upload arrives after it (both backends)', async () => {
  for (const b of await backends()) {
    const now = Date.now();
    await b.push({ updatedAt: now, customers: [{ id: 'c1', name: 'Old', updatedAt: now - 100000 }] });
    await wait();
    await b.push({ updatedAt: now - 30000, customers: [{ id: 'c1', name: 'B (edited 30 s ago)', updatedAt: now - 30000 }] });    // slow line: built 30 s ago
    await wait();
    await b.push({ updatedAt: now - 500, customers: [{ id: 'c1', name: 'A (edited later)', updatedAt: now - 500 }] });
    assert.equal((await b.state()).customers[0].name, 'A (edited later)', b.name);
  }
});

test('DEFECT 6: a stock count made 30 s ago and uploaded late still comes BEFORE a sale made after it (both backends)', async () => {
  for (const b of await backends()) {
    const now = Date.now(), t0 = now - 30000, ts = now - 500;
    await b.push({ updatedAt: now - 100000, inventory: [{ code: 'A', name: 'a', qty: 100, updatedAt: now - 100000 }] });
    await wait();
    await b.push({ updatedAt: ts, inventory: [{ code: 'A', name: 'a', qty: 99, updatedAt: ts }], stockMovementLog: [{ id: 'sale1', code: 'A', delta: -1, timestamp: iso(ts) }] });
    await wait();
    await b.push({ updatedAt: t0, inventory: [{ code: 'A', name: 'a', qty: 50, updatedAt: t0 }], stockMovementLog: [{ id: 'cnt1', code: 'A', kind: 'count', counted: 50, timestamp: iso(t0) }] });
    assert.equal((await b.state()).inventory[0].qty, 49, `${b.name}: count 50, then the sale after it`);
  }
});

test('DEFECT 7 (parity): the shop database, like the single record, never lets a BLANK unstamped setting replace a stored value', { skip: !hasSqlite }, async () => {
  const [kvB, dbB] = await backends();
  for (const b of [kvB, dbB]) {
    await b.push({ receiptLogo: 'DATA:logo', receiptFooterNotes: 'Thanks!', vatRateA: 16, lockedTabs: ['x'], _fieldTimes: { receiptLogo: 5 }, updatedAt: Date.now() });
    await wait();
    await b.push({ receiptLogo: '', receiptFooterNotes: '', vatRateA: '', lockedTabs: [], receiptShowLogo: false, updatedAt: Date.now() });     // a fresh device's defaults
    const s = await b.state();
    assert.equal(s.receiptLogo, 'DATA:logo', `${b.name}: logo`);
    assert.equal(s.receiptFooterNotes, 'Thanks!', `${b.name}: footer`);
    assert.equal(s.vatRateA, 16, `${b.name}: vat`);
    assert.deepEqual(s.lockedTabs, ['x'], `${b.name}: locked tabs`);
    // a FILLED value without a stamp is still a real edit, and a stamped blank is a deliberate clear
    await b.push({ receiptFooterNotes: 'New footer', updatedAt: Date.now() });
    assert.equal((await b.state()).receiptFooterNotes, 'New footer', `${b.name}: a real edit wins`);
    await wait();
    await b.push({ receiptFooterNotes: '', _fieldTimes: { receiptFooterNotes: Date.now() + 1000 }, updatedAt: Date.now() });
    assert.equal((await b.state()).receiptFooterNotes, '', `${b.name}: a stamped clear is honoured`);
  }
});

test('DEFECT 7 (parity): the shop database, like the single record, keeps an item\'s photo and pour setup when a newer copy leaves them empty', { skip: !hasSqlite }, async () => {
  const [kvB, dbB] = await backends();
  for (const b of [kvB, dbB]) {
    const t = Date.now();
    await b.push({ updatedAt: t, inventory: [{ code: 'A', name: 'a', qty: 5, image: 'PHOTO', shotMl: 25, updatedAt: t - 1000 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'A', name: 'a2', qty: 5, image: null, updatedAt: t + 1000 }] });
    let it = (await b.state()).inventory[0];
    assert.equal(it.name, 'a2', `${b.name}: the newest copy decides what it states`);
    assert.equal(it.image, 'PHOTO', `${b.name}: photo kept`); assert.equal(it.shotMl, 25, `${b.name}: shot size kept`);
    // and the other way round: an OLDER copy that carries the photo fills the gap left by a newer one that does not
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'B', name: 'b', qty: 1, updatedAt: t + 5000 }] });
    await wait();
    await b.push({ updatedAt: Date.now(), inventory: [{ code: 'B', name: 'b', qty: 1, image: 'PHOTO-B', updatedAt: t + 100 }] });
    it = (await b.state()).inventory.find((x) => x.code === 'B');
    assert.equal(it.image, 'PHOTO-B', `${b.name}: an older copy fills a field the newer one left empty`);
  }
});
