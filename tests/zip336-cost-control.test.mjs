// zip 336: cost corrections, profit adjustments and the stock audit trail (/api/cost-control) - manager-only on the SERVER (Admin password / manager
// PIN as X-Pay-Proof), idempotent, append-only, books closed through a date; and the sync guard on batch cost / status changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sealed = (pin, salt = 'saltsalt', iter = 1000) => `p2$${iter}$${salt}$${crypto.pbkdf2Sync(sha(pin), salt, iter, 32, 'sha256').toString('hex')}`;
const hdr = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const adminProof = (pw) => hdr({ a: true, p: sha(pw) });
const mgrProof = (id, pin) => hdr({ s: id, p: sha(pin) });
const STAFF = [
  { id: 'm1', name: 'Manager Mary', pinHash: sealed('7777'), isManager: true, roles: [], updatedAt: 1 },
  { id: 'c1', name: 'Cashier Cate', pinHash: sealed('2222'), roles: ['service-tab'], updatedAt: 1 },
];
const sync = await imp('pos-sync.js');
const cc = await imp('cost-control.js');
const lic = await imp('_license.js');
const guard = await imp('_perm-guard.js');

async function shop() {
  const kv = makeKV();
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), LICENSE_CACHE_MS: '0' };
  const rec = await lic.createClient(env, 'permanent', 'Kisumu Pharmacy', 'shop', { phone: '0712345678' });
  const state = { businessName: 'Biz', updatedAt: Date.now(), staff: STAFF, pwHash: sealed('shoppass') };
  await sync.onRequestPost({ request: new Request(`https://x.pages.dev/api/pos-sync?c=${rec.id}`, { method: 'POST', body: JSON.stringify(state) }), env, waitUntil() {} });
  return { env, id: rec.id };
}
const post = async (s, body, proof) => {
  const headers = { 'Content-Type': 'application/json' }; if (proof) headers['X-Pay-Proof'] = proof;
  const res = await cc.onRequestPost({ request: new Request(`https://x.pages.dev/api/cost-control?c=${s.id}`, { method: 'POST', headers, body: JSON.stringify(body) }), env: s.env, waitUntil() {} });
  let d = {}; try { d = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, d };
};
const CORR = { action: 'correct', corrId: 'cc-0000000001', code: 'X1', name: 'Gloves', mode: 'restate', oldCost: 2000, newCost: 10, from: '2026-10-01', to: '2026-10-27', reason: 'carton cost typed per piece', qtyOnHand: 30, valueEffect: -59700, cogsEffect: -5970, linesAffected: 3 };

test('Test E - a cost correction needs a manager ON THE SERVER: no proof, a wrong password and a cashier PIN are refused', async () => {
  const s = await shop();
  assert.equal((await post(s, CORR)).status, 401);
  assert.equal((await post(s, CORR, adminProof('nope'))).status, 403);
  assert.equal((await post(s, CORR, mgrProof('c1', '2222'))).status, 403, 'a cashier is not a manager');
  const list = await post(s, { action: 'list' });
  assert.equal(list.d.corrections.length, 0, 'nothing was recorded by the refused attempts');
});

test('Test E - an approved correction is recorded once (who, when, why, old -> new, effect); a repeat is a no-op; the record cannot be edited or deleted', async () => {
  const s = await shop();
  const r = await post(s, CORR, mgrProof('m1', '7777'));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const c = r.d.correction;
  assert.deepEqual([c.code, c.old_cost, c.new_cost, c.mode, c.date_from, c.date_to, c.actor_kind, c.lines_affected, c.cogs_effect], ['X1', 2000, 10, 'restate', '2026-10-01', '2026-10-27', 'manager', 3, -5970]);
  assert.equal(c.reason, 'carton cost typed per piece');
  const again = await post(s, CORR, mgrProof('m1', '7777'));
  assert.equal(again.d.replay, true);
  assert.equal((await post(s, { action: 'list' })).d.corrections.length, 1, 'the same correction twice is ONE record');
  const db = s.env.LEDGER_DB;
  await assert.rejects(() => db.prepare(`UPDATE cost_corrections SET new_cost = 0`).run(), /never changed/);
  await assert.rejects(() => db.prepare(`DELETE FROM cost_corrections`).run(), /never deleted/);
  // validation
  assert.equal((await post(s, { ...CORR, corrId: 'cc-0000000002', reason: 'x' }, adminProof('shoppass'))).status, 400, 'a reason is required');
  assert.equal((await post(s, { ...CORR, corrId: 'cc-0000000003', newCost: -1 }, adminProof('shoppass'))).status, 400);
  assert.equal((await post(s, { ...CORR, corrId: 'cc-0000000004', newCost: 2000 }, adminProof('shoppass'))).status, 400, 'same as the old cost');
});

test('Test F - recalculation and adjustment are separate; an adjustment keeps amount, reason, user and period; reversal is its own entry, once', async () => {
  const s = await shop();
  const adj = { action: 'adjust', adjId: 'pa-0000000001', kind: 'zero', from: '2026-10-01', to: '2026-10-07', amount: 4500, reportedBefore: -4500, reason: 'opening stock entered at carton prices' };
  assert.equal((await post(s, adj)).status, 401, 'an ordinary call cannot bypass the approval');
  const r = await post(s, adj, adminProof('shoppass'));
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.adjustment.amount, r.d.adjustment.reported_before, r.d.adjustment.reported_after, r.d.adjustment.date_from, r.d.adjustment.date_to, r.d.adjustment.actor_kind], [4500, -4500, 0, '2026-10-01', '2026-10-07', 'admin']);
  assert.equal((await post(s, adj, adminProof('shoppass'))).d.replay, true);
  const rv = await post(s, { action: 'reverse', adjId: 'rv-0000000001', reverseOf: 'pa-0000000001', reason: 'decided to correct the costs instead' }, mgrProof('m1', '7777'));
  assert.equal(rv.status, 200); assert.equal(rv.d.adjustment.amount, -4500);
  const rv2 = await post(s, { action: 'reverse', adjId: 'rv-0000000002', reverseOf: 'pa-0000000001', reason: 'again by mistake' }, mgrProof('m1', '7777'));
  assert.equal(rv2.d.replay, true, 'an adjustment is reversed only once');
  const l = (await post(s, { action: 'list' })).d.adjustments;
  assert.equal(l.length, 2);
  assert.equal(l.reduce((t, a) => t + a.amount, 0), 0, 'adjustment + reversal = 0: the reported figure is back to the one from the sales');
  await assert.rejects(() => s.env.LEDGER_DB.prepare(`DELETE FROM profit_adjustments`).run(), /never deleted/);
});

test('books closed through a date: no restating or adjusting that period; only the Admin moves the date back', async () => {
  const s = await shop();
  assert.equal((await post(s, { action: 'setClosed', through: '2026-10-15', reason: 'October first half audited' }, mgrProof('m1', '7777'))).status, 200);
  const r = await post(s, { ...CORR, corrId: 'cc-0000000009', from: '2026-10-10' }, adminProof('shoppass'));
  assert.equal(r.status, 409); assert.match(r.d.error, /closed through 2026-10-15/);
  assert.equal((await post(s, { ...CORR, corrId: 'cc-0000000010', from: '2026-10-16' }, adminProof('shoppass'))).status, 200, 'an open period is fine');
  assert.equal((await post(s, { ...CORR, corrId: 'cc-0000000011', mode: 'forward' }, adminProof('shoppass'))).status, 200, '"from now on" never touches the closed period');
  assert.equal((await post(s, { action: 'adjust', adjId: 'pa-0000000009', kind: 'amount', from: '2026-10-01', to: '2026-10-07', amount: -10, reportedBefore: 5, reason: 'late correction' }, adminProof('shoppass'))).status, 409);
  assert.equal((await post(s, { action: 'setClosed', through: '2026-10-01', reason: 'reopen most of October' }, mgrProof('m1', '7777'))).status, 403, 'a manager cannot move it back');
  assert.equal((await post(s, { action: 'setClosed', through: '2026-10-01', reason: 'reopen most of October' }, adminProof('shoppass'))).status, 200);
  const list = await post(s, { action: 'list' });
  assert.equal(list.d.settings.closedThrough, '2026-10-01');
  assert.ok(list.d.audit.some((a) => a.kind === 'books_closed'));
});

test('stock actions (batch recall, packaging change) go into the append-only audit trail with who and why', async () => {
  const s = await shop();
  assert.equal((await post(s, { action: 'event', evId: 'lot-0000000001', kind: 'lot_status', code: 'AMX', name: 'Amoxicillin', detail: 'Batch B12: ok -> recalled', reason: 'supplier recall notice 44' })).status, 401);
  assert.equal((await post(s, { action: 'event', evId: 'lot-0000000001', kind: 'lot_status', code: 'AMX', name: 'Amoxicillin', detail: 'Batch B12: ok -> recalled', reason: 'supplier recall notice 44' }, mgrProof('m1', '7777'))).status, 200);
  assert.equal((await post(s, { action: 'event', evId: 'lot-0000000001', kind: 'lot_status', code: 'AMX', detail: 'dup', reason: 'supplier recall notice 44' }, mgrProof('m1', '7777'))).status, 200);
  assert.equal((await post(s, { action: 'event', evId: 'x-0000000001', kind: 'delete_everything', reason: 'nope nope' }, mgrProof('m1', '7777'))).status, 400);
  const a = (await post(s, { action: 'list' })).d.audit;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].kind, a[0].actor_kind, a[0].reason], ['lot_status', 'manager', 'supplier recall notice 44']);
  await assert.rejects(() => s.env.LEDGER_DB.prepare(`UPDATE stock_audit SET reason = 'x'`).run(), /append-only/);
});

test('sync guard: with staff sessions required, a cashier\'s device cannot change a batch\'s cost or status - a sale from the batch is fine', () => {
  const stored = { code: 'AMX', qty: 10, batches: [{ id: 'b1', qty: 10, cost: 5, status: 'ok' }] };
  const auth = (mgr) => ({ enforce: true, claims: { sid: 'x', mgr, perms: [] } });
  const get = (col, rec) => (col === 'inventory' && rec.code === 'AMX' ? stored : null);
  const sold = { inventory: [{ code: 'AMX', qty: 8, batches: [{ id: 'b1', qty: 8, cost: 5, status: 'ok' }] }] };
  assert.equal(guard.guardPush(sold, get, auth(false)).held.length, 0);
  const newLot = { inventory: [{ code: 'AMX', qty: 15, batches: [{ id: 'b1', qty: 10, cost: 5 }, { id: 'b2', qty: 5, cost: 6 }] }] };
  assert.equal(guard.guardPush(newLot, get, auth(false)).held.length, 0, 'a delivery (a new batch) is anyone\'s');
  const costEdit = { inventory: [{ code: 'AMX', qty: 10, batches: [{ id: 'b1', qty: 10, cost: 1 }] }] };
  const g = guard.guardPush(costEdit, get, auth(false));
  assert.equal(g.held.length, 1); assert.match(g.held[0].reason, /cost of a batch/);
  assert.equal(g.body.inventory[0].batches[0].cost, 5, 'the stored copy stands');
  const statusEdit = { inventory: [{ code: 'AMX', qty: 10, batches: [{ id: 'b1', qty: 10, cost: 5, status: 'ok' }] }] };
  const st2 = { code: 'AMX', qty: 10, batches: [{ id: 'b1', qty: 10, cost: 5, status: 'recalled' }] };
  assert.equal(guard.guardPush(statusEdit, () => st2, auth(false)).held.length, 1, 'releasing a recalled batch needs a manager');
  assert.equal(guard.guardPush(costEdit, get, auth(true)).held.length, 0, 'a manager may');
  assert.equal(guard.guardPush(costEdit, get, { enforce: false, claims: null }).held.length, 0, 'unchanged when the shop has not switched staff sessions on');
});
