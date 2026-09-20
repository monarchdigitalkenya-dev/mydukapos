import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The owner's income model: making a link permanent adds nothing; the 💰 toggle records money agreed + paid; a balance becomes a bill that can be
// settled in part or in full and reminded.
const CLIENT = { id: 'C9', label: 'Acme Ltd', businessName: 'Acme Ltd', slug: 'acme', product: 'shop', type: 'permanent', valid: true, phone: '0700111222', link: 'https://acme.mydukapos.store', revenue: null, notice: null };

function makeFetch(calls, overrides = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? (() => { try { return JSON.parse(opts.body); } catch (e) { return null; } })() : null;
    if (body) calls.push({ url: u.split('?')[0], body });
    if (overrides[u.split('?')[0]]) return overrides[u.split('?')[0]](body);
    return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now(), clients: [] }) };
  };
}
async function owner(calls, overrides) {
  const b = await boot('owner/index.html', { fetch: makeFetch(calls, overrides), wait: 900 });
  b.w.eval("showToast = function () {}");
  b.w.eval("bills = []; salesLog = []");
  return b;
}
const sum = (b, expr) => b.w.eval(`${expr}.reduce((s, x) => s + (x.items || []).reduce((t, l) => t + l.price * l.qty, 0), 0)`);
const openRecord = async (b, agreed, paid, method) => {
  b.w.eval(`unifiedClientsCache = [${JSON.stringify(CLIENT)}]; clientDetailCurrentGroup = null; openRevenueModal(unifiedClientsCache[0])`);
  b.d.getElementById('revenue-agreed-input').value = agreed;
  b.d.getElementById('revenue-paid-input').value = paid;
  if (method) b.w.eval(`setRevenuePayMethod('${method}')`);
  await b.w.eval('submitRevenue()');
};

test('the toggle exists only under PERMANENT links, starts Off, and shows a recorded link as On and locked', async () => {
  const calls = []; const b = await owner(calls);
  b.w.eval(`window.__h = revenueToggleHtml(${JSON.stringify(CLIENT)}, 'Acme')`);
  assert.match(b.w.__h, /type="checkbox"/); assert.doesNotMatch(b.w.__h, /checked/);
  b.w.eval(`window.__d = revenueToggleHtml(${JSON.stringify({ ...CLIENT, type: 'demo' })}, 'Acme')`);
  assert.equal(b.w.__d, '', 'nothing for a demo link');
  b.w.eval(`window.__r = revenueToggleHtml(${JSON.stringify({ ...CLIENT, revenue: { at: Date.now(), agreed: 3000, paid: 2000, method: 'mpesa' } })}, 'Acme')`);
  assert.match(b.w.__r, /checked disabled/); assert.match(b.w.__r, /agreed KES 3,000, paid KES 2,000/); assert.match(b.w.__r, /KES 1,000 on the/);
  b.close();
});

test('agreed 3,000 / paid 2,000: 2,000 goes into sales, and a bill of 1,000 with the debt details appears in Bills', async () => {
  const calls = []; const b = await owner(calls);
  await openRecord(b, '3000', '2000', 'mpesa');
  const rev = calls.find((c) => c.body.action === 'recordRevenue');
  assert.ok(rev && rev.body.agreedAmount === 3000 && rev.body.paidAmount === 2000 && rev.body.c === 'C9', 'the server is told');
  assert.equal(b.w.eval('salesLog.length'), 1);
  assert.equal(sum(b, 'salesLog'), 2000, 'sales hold exactly the money paid');
  assert.equal(b.w.eval('salesLog[0].mpesaAmount'), 2000);
  assert.equal(b.w.eval('bills.length'), 1);
  assert.equal(sum(b, 'bills'), 1000, 'the bill is the balance');
  assert.equal(b.w.eval('bills[0].licenseDebt.agreed'), 3000);
  assert.equal(b.w.eval('bills[0].customerName'), 'Acme Ltd');
  b.w.eval('renderBillsTab()');
  const row = b.d.querySelector('#bills-table tbody').textContent;
  assert.match(row, /Acme Ltd/); assert.match(row, /agreed KES 3,000 · paid KES 2,000 · balance KES 1,000/);
  assert.match(b.d.querySelector('#bills-table tbody').innerHTML, /Settle/); assert.match(b.d.querySelector('#bills-table tbody').innerHTML, /Remind admin/);
  b.close();
});

test('fully paid records income only (no bill); nothing paid creates the bill only; bad amounts are refused and log nothing', async () => {
  let calls = []; let b = await owner(calls);
  await openRecord(b, '3000', '3000', 'cash');
  assert.equal(sum(b, 'salesLog'), 3000); assert.equal(b.w.eval('bills.length'), 0); assert.equal(b.w.eval('salesLog[0].cashAmount'), 3000);
  b.close();
  calls = []; b = await owner(calls);
  await openRecord(b, '3000', '0');
  assert.equal(b.w.eval('salesLog.length'), 0); assert.equal(sum(b, 'bills'), 3000);
  b.close();
  calls = []; b = await owner(calls);
  await openRecord(b, '3000', '3500');
  assert.match(b.d.getElementById('revenue-modal-error').textContent, /cannot be more/);
  await openRecord(b, '', '100');
  assert.match(b.d.getElementById('revenue-modal-error').textContent, /money agreed/);
  assert.equal(calls.filter((c) => c.body.action === 'recordRevenue').length, 0, 'the server was never asked');
  assert.equal(b.w.eval('salesLog.length + bills.length'), 0);
  b.close();
});

test('if the server says it is already recorded, nothing is added to sales or bills', async () => {
  const calls = [];
  const b = await owner(calls, { '/api/owner-lock': () => ({ ok: false, status: 409, json: async () => ({ error: 'Income is already recorded for this link.' }) }) });
  await openRecord(b, '3000', '2000');
  assert.match(b.d.getElementById('revenue-modal-error').textContent, /already recorded/);
  assert.equal(b.w.eval('salesLog.length + bills.length'), 0);
  b.close();
});

test('the balance can be settled in part and then in full: sales end up holding exactly the agreed amount, and the bill disappears', async () => {
  const calls = []; const b = await owner(calls);
  await openRecord(b, '3000', '2000');
  b.w.eval('window.confirm = () => true; renderReceipt = function () {}');
  const id = b.w.eval('bills[0].id');
  b.w.eval(`openBillSettleModal('sale', '${id}')`);
  assert.equal(b.d.getElementById('bill-settle-license-amount-input').value, '1000', 'the whole balance is offered by default');
  b.d.getElementById('bill-settle-license-amount-input').value = '1500';
  b.w.eval('confirmBillSettle()');
  assert.match(b.d.getElementById('bill-settle-modal-error').textContent, /more than the balance/);
  assert.equal(b.w.eval('salesLog.length'), 1, 'refused: nothing logged');
  b.d.getElementById('bill-settle-license-amount-input').value = '400';
  b.w.eval('confirmBillSettle()');
  assert.equal(sum(b, 'salesLog'), 2400);
  assert.equal(sum(b, 'bills'), 600, 'the bill shrank to what is still owed');
  assert.equal(b.w.eval('bills[0].licenseDebt.paid'), 2400);
  b.w.eval(`openBillSettleModal('sale', '${id}')`);
  assert.equal(b.d.getElementById('bill-settle-license-amount-input').value, '600');
  b.w.eval('confirmBillSettle()');
  assert.equal(b.w.eval('bills.length'), 0, 'fully settled: the bill is gone');
  assert.equal(sum(b, 'salesLog'), 3000, 'sales = the money agreed, no more, no less');
  const billing = calls.filter((c) => c.body.action === 'billing').pop();
  assert.ok(billing && billing.body.paidAmount === 3000 && billing.body.agreedAmount === 3000, 'the link\'s own record is kept in step');
  b.close();
});

test('Remind admin sends the message to that link and the bill remembers when', async () => {
  const calls = []; const b = await owner(calls);
  await openRecord(b, '3000', '2000');
  const id = b.w.eval('bills[0].id');
  b.w.eval("window.prompt = (q, def) => def");
  await b.w.eval(`remindLicenseDebt('${id}')`);
  const r = calls.find((c) => c.body.action === 'remind');
  assert.ok(r && r.body.c === 'C9', 'sent to the admin of THAT link');
  assert.match(r.body.message, /KES 1,000 is still outstanding/); assert.match(r.body.message, /agreed KES 3,000, paid KES 2,000/);
  assert.equal(r.body.balance, 1000);
  assert.ok(b.w.eval('bills[0].licenseDebt.remindedAt') > 0);
  b.w.eval('renderBillsTab()');
  assert.match(b.d.querySelector('#bills-table tbody').textContent, /Last reminded/);
  b.close();
});

test('making a link permanent (either way) adds NOTHING to sales or bills and no longer asks for an amount', async () => {
  const calls = []; const b = await owner(calls);
  b.w.eval("window.confirm = () => true; window.prompt = () => { throw new Error('must not ask for an amount'); }");
  await b.w.eval("requestMakePermanent('C9', 'Acme Ltd', 'shop')");
  await b.w.eval("confirmDemoUpgrade('C9', 'Acme Ltd', 'shop')");
  assert.equal(calls.filter((c) => c.url.includes('owner-confirm')).length, 2, 'the link is made permanent');
  assert.equal(b.w.eval('salesLog.length'), 0); assert.equal(b.w.eval('bills.length'), 0);
  b.close();
});

test('owner console sync: a settled/removed bill is sent as a deletion, and a push that lands after another device\'s change does not hide it', async () => {
  const pushes = []; let prev = 0;
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') { const body = JSON.parse(opts.body); pushes.push(body); return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: 5000, prev }) }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, clients: [] }) };
  };
  const b = await boot('owner/index.html', { fetch, wait: 900, storage: { pos_last_synced_at: '1000' } });
  b.w.eval("showToast = function () {}");
  b.w.eval("bills = [{ id: 'b1', customerName: 'A', items: [{ name: 'x', price: 5, qty: 1 }], updatedAt: 1 }, { id: 'b2', customerName: 'B', items: [{ name: 'y', price: 6, qty: 1 }], updatedAt: 1 }]");
  await b.w.eval('pushNow()');                                    // first push: both bills known
  assert.ok(!JSON.stringify(pushes[0].bills).includes('_deleted'));
  b.w.eval("bills.splice(0, 1)");                                 // b1 settled and removed
  await b.w.eval('pushNow()');
  const tomb = pushes[1].bills.find((x) => x._deleted);
  assert.ok(tomb && tomb.id === 'b1' && tomb.updatedAt > 0, 'a deletion marker is sent for the removed bill');
  assert.equal(pushes[1].bills.filter((x) => !x._deleted).length, 1);
  await b.w.eval('pushNow()');
  assert.ok(!pushes[2].bills.some((x) => x._deleted), 'and it is sent once, not forever');
  // missed change: the server says its record was at 3000 before our push, and this device only held up to 1000
  b.w.localStorage.setItem('pos_last_synced_at', '1000'); prev = 3000; pushes.length = 0;
  await b.w.eval('pushNow()');
  assert.equal(b.w.localStorage.getItem('pos_last_synced_at'), '1000', 'the marker was NOT moved, so the next pull fetches the other device\'s change');
  prev = 1000;
  await b.w.eval('pushNow()');
  assert.equal(b.w.localStorage.getItem('pos_last_synced_at'), '5000', 'when nothing was missed it advances as before');
  b.close();
});
