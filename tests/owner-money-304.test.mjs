import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { createClient, getLicense, saveLicense } from '../functions/api/_license.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';
import { onRequestPost as ownerConfirm } from '../functions/api/owner-confirm.js';
import { onRequestPost as ownerMoney } from '../functions/api/owner-money.js';
import { onRequestPost as ownerLock } from '../functions/api/owner-lock.js';
import { claimRef } from '../functions/api/_billing.js';
import { listAll, summarize } from '../functions/api/_owner-money.js';

// zip 304 - ONE money record. Every case of the brief: creating / pending / failed is not money, one KES 3,000 payment counts once whatever repeats,
// totals agree everywhere, reconciliation keeps legitimate history and flags the duplicates the old two forms created.
async function world({ d1 = true } = {}) {
  const kv = makeKV(); const env = { mydukapos_kv: kv, ...(d1 ? { OWNER_DB: makeD1() } : {}) };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const req = (url, body, owner) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + sess } : {}) }, body: JSON.stringify(body) });
  const call = (fn, path, body, owner = true) => fn({ env, request: req('https://x.pages.dev/api/' + path, body, owner) }).then(async (r) => ({ r, j: await r.json() }));
  const money = (body) => call(ownerMoney, 'owner-money', body);
  const buy = (body, owner = false) => call(gml, 'get-my-link?c=demo_retail', body, owner);
  return { kv, env, acct, sess, money, buy, call };
}
const buyer = { action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: '' };
const KES = (c) => c / 100;

for (const d1 of [true, false]) {
  const tag = d1 ? '[D1]' : '[KV only]';

  test(`${tag} 1-3: a link request, a pending payment and a failed payment are not collected revenue`, async () => {
    const w = await world({ d1 });
    const s = await w.buy(buyer);                                   // a request: nothing paid
    assert.ok(s.j.id);
    let sum = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(sum.collectedC, 0); assert.equal(sum.linkSalesC, 0);
    await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });  // the buyer says they paid: pending
    sum = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(sum.collectedC, 0); assert.equal(sum.pendingN, 1); assert.equal(KES(sum.pendingC), 3000);
    await w.buy({ action: 'reject', id: s.j.id }, true);            // the owner finds nothing on M-Pesa: failed / cancelled
    sum = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(sum.collectedC, 0); assert.equal(sum.pendingN, 0); assert.equal(sum.failedN, 1);
    // a link created by the owner (not sold) is not money either
    await createClient(w.env, 'permanent', 'Internal test link', 'shop');
    assert.equal((await w.money({ action: 'summary' })).j.summary.collectedC, 0);
  });

  test(`${tag} 4-5, 7-9: one KES 3,000 payment counts once - confirm twice, the same callback twice, refresh, list, export`, async () => {
    const w = await world({ d1 });
    const s = await w.buy(buyer); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });
    await w.buy({ action: 'confirm', id: s.j.id }, true);
    await w.buy({ action: 'confirm', id: s.j.id }, true);           // pressed again
    const rows = await listAll(w.env);
    assert.equal(rows.filter((r) => r.kind === 'link_sale' && r.status === 'success').length, 1);
    const a = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(KES(a.collectedC), 3000); assert.equal(KES(a.linkSalesC), 3000); assert.equal(a.linkSalesN, 1);
    // the same payment event delivered again (a provider retry) changes nothing
    const ref = rows.find((r) => r.kind === 'link_sale').ref;
    const again = await claimRef(w.env, ref, { kind: 'purchase', clientId: 'x', amount: 3000, method: 'stk' });
    assert.equal(again.first, false);
    for (let i = 0; i < 3; i++) await w.money({ action: 'summary' });                       // refresh the dashboard
    await w.money({ action: 'list', all: true });                                            // export
    await w.money({ action: 'links' });                                                      // open the link list
    const b = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(b.collectedC, a.collectedC, 'reading never adds money');
    assert.equal((await listAll(w.env)).length, rows.length, 'no new rows from reading');
  });

  test(`${tag} 6: concurrent confirmations of one payment create one collection`, async () => {
    const w = await world({ d1 });
    const ref = 'purchase:concurrent-1';
    const res = await Promise.all([1, 2, 3, 4].map(() => claimRef(w.env, ref, { kind: 'purchase', clientId: 'c1', amount: 3000, method: 'stk', receipt: 'QWE123' })));
    const rows = (await listAll(w.env)).filter((r) => r.ref === ref);
    assert.equal(rows.length, 1);
    if (d1) assert.equal(res.filter((r) => r.first).length, 1, 'with the owner database exactly one request wins');
    assert.equal(KES(summarize(await listAll(w.env)).collectedC), 3000);
  });

  test(`${tag} 12: dashboard (summary), the transaction list and the export agree for the same dates`, async () => {
    const w = await world({ d1 });
    const c = await createClient(w.env, 'permanent', 'Juma Hardware', 'shop');
    await w.money({ action: 'record', key: 'k-aaaaaaaa1', kind: 'link_sale', clientId: c.id, amount: 3000, method: 'cash', note: 'Paid at the office' });
    await w.money({ action: 'record', key: 'k-aaaaaaaa2', kind: 'other_income', amount: 1500, method: 'mpesa', receipt: 'RTY77', note: 'Training day' });
    const from = Date.now() - 86400000, to = Date.now() + 1000;
    const s = (await w.money({ action: 'summary', from, to })).j.summary;
    const l = (await w.money({ action: 'list', from, to, all: true })).j;
    assert.equal(s.collectedC, l.summary.collectedC);
    assert.equal(KES(s.collectedC), 4500);
    assert.equal(l.rows.filter((r) => r.status === 'success').reduce((a, r) => a + r.amount_c, 0), s.collectedC, 'the rows add up to the figure');
  });

  test(`${tag} manual entry: the same form twice, the same M-Pesa code twice, a second sale for the same link`, async () => {
    const w = await world({ d1 });
    const c = await createClient(w.env, 'permanent', 'Akinyi Salon', 'shop');
    const one = await w.money({ action: 'record', key: 'k-bbbbbbbb1', kind: 'link_sale', clientId: c.id, amount: 3000, method: 'mpesa', receipt: 'ABC123', note: 'Link' });
    assert.equal(one.r.status, 200);
    const dup = await w.money({ action: 'record', key: 'k-bbbbbbbb1', kind: 'link_sale', clientId: c.id, amount: 3000, method: 'mpesa', receipt: 'ABC123', note: 'Link' });
    assert.equal(dup.j.dup, true, 'double click = the same entry');
    const second = await w.money({ action: 'record', key: 'k-bbbbbbbb2', kind: 'link_sale', clientId: c.id, amount: 3000, method: 'cash', note: 'Link again' });
    assert.equal(second.r.status, 409, 'a second sale for the same link is refused unless it is a separate payment');
    const sameCode = await w.money({ action: 'record', key: 'k-bbbbbbbb3', kind: 'other_income', amount: 3000, method: 'mpesa', receipt: 'abc123', note: 'Same code' });
    assert.equal(sameCode.j.review, true, 'an M-Pesa code already counted is kept for review, not counted');
    assert.equal(KES((await w.money({ action: 'summary' })).j.summary.collectedC), 3000);
    // missing description / M-Pesa code are refused
    assert.equal((await w.money({ action: 'record', key: 'k-bbbbbbbb4', kind: 'other_income', amount: 10, method: 'cash', note: '' })).r.status, 400);
    assert.equal((await w.money({ action: 'record', key: 'k-bbbbbbbb5', kind: 'other_income', amount: 10, method: 'mpesa', note: 'x' })).r.status, 400);
  });

  test(`${tag} 11: a refund is its own entry linked to the original; net = collected - refunds; a verified payment cannot be excluded`, async () => {
    const w = await world({ d1 });
    await w.money({ action: 'record', key: 'k-cccccccc1', kind: 'other_income', amount: 2000, method: 'cash', note: 'Setup' });
    const ref = 'manual:k-cccccccc1';
    const ask = await w.money({ action: 'refund', ref, reason: 'Customer cancelled', key: 'r-cccccccc1' });
    assert.equal(ask.r.status, 409);
    const ok = await w.money({ action: 'refund', ref, reason: 'Customer cancelled', amount: 500, key: 'r-cccccccc1', confirm: true });
    assert.equal(ok.r.status, 200);
    const s = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(KES(s.collectedC), 2000); assert.equal(KES(s.refundsC), 500); assert.equal(KES(s.netC), 1500);
    assert.equal((await w.money({ action: 'refund', ref, reason: 'x', amount: 1600, key: 'r-cccccccc2', confirm: true })).r.status, 400, 'never more than what is left');
    await claimRef(w.env, 'purchase:gw-1', { kind: 'purchase', clientId: 'c9', amount: 3000, method: 'stk', receipt: 'GW1' });
    assert.equal((await w.money({ action: 'status', ref: 'purchase:gw-1', status: 'excluded', reason: 'x' })).r.status, 400);
  });

  test(`${tag} "Make permanent" for a free link is complimentary, not a KES 3,000 sale; "Confirm payment" is a sale`, async () => {
    const w = await world({ d1 });
    const free = await createClient(w.env, 'demo', 'Free test shop', 'shop');
    const paid = await createClient(w.env, 'demo', 'Paid shop', 'shop');
    await w.call(ownerConfirm, 'owner-confirm', { c: free.id, complimentary: true });
    await w.call(ownerConfirm, 'owner-confirm', { c: paid.id });
    assert.equal((await getLicense(w.env, free.id)).type, 'permanent');
    const s = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(KES(s.collectedC), 3000); assert.equal(s.complimentaryN, 1);
  });

  test(`${tag} the two old hand-entry forms are closed (no new duplicates from an old cached console)`, async () => {
    const w = await world({ d1 });
    const c = await createClient(w.env, 'permanent', 'Old form shop', 'shop');
    for (const action of ['recordRevenue', 'recordGroupIncome']) {
      const r = await w.call(ownerLock, 'owner-lock', { c: c.id, action, agreedAmount: 3000, paidAmount: 3000, groupKey: 'x' });
      assert.equal(r.r.status, 410);
    }
  });

  test(`${tag} 13: reconciliation flags the duplicates of the old forms, keeps legitimate entries, and is safe to run twice`, async () => {
    const w = await world({ d1 });
    // A: confirmed by the owner (billing ledger, KES 3,000) AND entered with the 💰 switch AND under Quote & Payments = the KES 9,000 that was really 3,000
    const a = await createClient(w.env, 'demo', 'Wanjiru Shop', 'shop');
    await w.call(ownerConfirm, 'owner-confirm', { c: a.id });
    const ra = await getLicense(w.env, a.id); ra.clientName = 'Wanjiru'; ra.revenue = { at: Date.now() - 5000, agreed: 3000, paid: 3000, method: 'mpesa' }; await saveLicense(w.env, ra);
    // B: a link paid by cash, recorded only with the switch: legitimate
    const bb = await createClient(w.env, 'permanent', 'Otieno Agrovet', 'shop');
    const rb = await getLicense(w.env, bb.id); rb.clientName = 'Otieno'; rb.revenue = { at: Date.now() - 4000, agreed: 3000, paid: 2000, method: 'cash' }; await saveLicense(w.env, rb);
    await w.kv.put('owner-group-income:v1', JSON.stringify({ wanjiru: { label: 'Wanjiru', entries: [{ id: 'g1', at: Date.now() - 3000, agreed: 3000, paid: 3000, method: 'mpesa', note: '' }] } }));
    const now = Date.now();
    const sales = [
      { id: 's1', timestamp: new Date(now - 5000).toISOString(), paid: true, customerName: 'Wanjiru Shop', licenseClientId: a.id, items: [{ name: 'License — General Shop (Wanjiru Shop)', price: 3000, qty: 1 }], paymentMethod: 'mpesa' },
      { id: 's2', timestamp: new Date(now - 3000).toISOString(), paid: true, customerName: 'Wanjiru', items: [{ name: 'Quote — Wanjiru', price: 3000, qty: 1 }], paymentMethod: 'mpesa' },
      { id: 's3', timestamp: new Date(now - 4000).toISOString(), paid: true, customerName: 'Otieno Agrovet', licenseClientId: bb.id, items: [{ name: 'License — General Shop (Otieno Agrovet)', price: 2000, qty: 1 }], paymentMethod: 'cash' },
      { id: 's4', timestamp: new Date(now - 2000).toISOString(), paid: true, customerName: 'Otieno Agrovet', licenseClientId: bb.id, items: [{ name: 'License payment — Otieno Agrovet', price: 1000, qty: 1 }], paymentMethod: 'cash' },
      { id: 's5', timestamp: new Date(now - 1000).toISOString(), voided: true, paid: true, customerName: 'x', items: [{ name: 'Test', price: 500, qty: 1 }] },
    ];
    const p = (await w.money({ action: 'reconcile-preview', sales })).j;
    assert.equal(KES(p.before.dashboardC), 9000, 'the old dashboard: 3,000 + 3,000 + 2,000 + 1,000');
    assert.equal(KES(p.before.billingC), 3000);
    assert.equal(KES(p.after.collectedC), 6000, 'Wanjiru 3,000 once + Otieno 2,000 + 1,000 balance');
    assert.equal(p.after.reviewN, 2, 'the 💰 copy and the Quote copy of Wanjiru are flagged for review');
    assert.equal(KES(p.after.outstandingC), 0, 'Otieno agreed 3,000 and paid 2,000 + 1,000');
    assert.equal((await listAll(w.env)).filter((r) => r.source === 'legacy-import').length, 0, 'the preview writes nothing');
    const ap = (await w.money({ action: 'reconcile-apply', sales, confirm: true })).j;
    assert.equal(KES(ap.after.collectedC), 6000);
    const ap2 = (await w.money({ action: 'reconcile-apply', sales, confirm: true })).j;
    assert.equal(ap2.added, 0, 'running it again adds nothing');
    assert.equal(KES((await w.money({ action: 'summary' })).j.summary.collectedC), 6000);
    // the owner decides one flagged entry is real (a separate payment): it counts, with an audited reason
    const flagged = (await listAll(w.env)).find((r) => r.status === 'review');
    const ok = await w.money({ action: 'status', ref: flagged.ref, status: 'success', reason: 'This was a second, separate service' });
    assert.equal(ok.r.status, 200);
    assert.equal(KES((await w.money({ action: 'summary' })).j.summary.collectedC), 9000);
    const log = (await w.money({ action: 'log' })).j.rows;
    assert.ok(log.some((x) => x.action === 'status' && /separate service/.test(x.note)));
  });
}

for (const d1 of [true, false]) {
  test(`${d1 ? '[D1]' : '[KV only]'} agreed more than paid shows as outstanding; a later payment towards it clears it`, async () => {
    const w = await world({ d1 });
    const c = await createClient(w.env, 'permanent', 'Chebet Cosmetics', 'shop');
    const r = await w.money({ action: 'record', key: 'k-dddddddd1', kind: 'link_sale', clientId: c.id, amount: 1000, agreed: 3000, method: 'cash', note: 'Deposit' });
    assert.equal(r.r.status, 200); assert.ok(r.j.charge);
    let s = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(KES(s.outstandingC), 2000); assert.equal(s.outstandingClients, 1);
    await w.money({ action: 'record', key: 'k-dddddddd2', kind: 'link_sale', clientId: c.id, amount: 2000, method: 'cash', note: 'Balance', chargeRef: r.j.charge.ref });   // towards the agreed amount: not refused as a second sale
    s = (await w.money({ action: 'summary' })).j.summary;
    assert.equal(KES(s.outstandingC), 0); assert.equal(KES(s.collectedC), 3000); assert.equal(s.linkSalesN, 1, 'one link sold, paid in two parts');
  });
}
