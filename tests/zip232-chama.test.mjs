import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
// Zip 232 — Chama: terms and conditions, logo, automatic late-payment penalties, faster home.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const core = await load('functions/api/_chama-core.js');
const route = await load('functions/api/chama.js');
const call = async (env, tok, body) => { const r = await route.onRequestPost({ request: new Request('https://x/api/chama?c=G1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(tok ? { 'X-Chama-Token': tok } : {}) } }), env }); return { status: r.status, ...(await r.json()) }; };
async function world() {
  const kv = makeKV(); seedShop(kv, 'G1', { product: 'chama' }); const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  const s = await call(env, '', { action: 'setup', groupName: 'Umoja', name: 'Alice Admin', phone: '0711000001', pin: '1234' }); assert.ok(s.ok);
  const m = await call(env, s.token, { action: 'members.add', name: 'Mary Late', phone: '0722000001' }); assert.ok(m.ok);
  const m2 = await call(env, s.token, { action: 'members.add', name: 'Paul Prompt', phone: '0733000001' }); assert.ok(m2.ok);
  return { env, admin: s.token, mary: m, paul: m2 };
}
const monthsAgo = (n) => { const d = new Date(Date.now() + 3 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

test('T1: terms — admin writes, everyone reads, penalty rules shown automatically', async () => {
  const w = await world();
  const t = await call(w.env, w.admin, { action: 'terms.save', text: '1. Pay on time.\n2. Attend meetings.' }); assert.ok(t.ok, JSON.stringify(t));
  const mt = await call(w.env, '', { action: 'login', memberId: w.mary.id, pin: w.mary.pin }); assert.ok(mt.ok);
  assert.ok((await call(w.env, mt.token, { action: 'pin.change', oldPin: w.mary.pin, newPin: '5678' })).ok);
  const read = await call(w.env, mt.token, { action: 'terms.get' }); assert.ok(read.ok);
  assert.match(read.text, /Pay on time/); assert.equal(read.canEdit, false);
  const denied = await call(w.env, mt.token, { action: 'terms.save', text: 'x' }); assert.equal(denied.status, 403);
});
test('T2: logo — saved by the admin, shown on the public status, removable; junk refused', async () => {
  const w = await world();
  const bad = await call(w.env, w.admin, { action: 'logo.save', logo: 'http://evil/x.png' }); assert.equal(bad.ok, false);
  const ok = await call(w.env, w.admin, { action: 'logo.save', logo: 'data:image/png;base64,iVBORw0KGgo=' }); assert.ok(ok.ok);
  const st = await call(w.env, '', { action: 'status' }); assert.equal(st.logoV, ok.v);
  const lg = await call(w.env, '', { action: 'logo.get' }); assert.match(lg.logo, /^data:image\/png/);
  await call(w.env, w.admin, { action: 'logo.remove' });
  assert.equal((await call(w.env, '', { action: 'status' })).logoV, 0);
});
test('T3: a late contribution is fined automatically, once, and a prompt payer is not', async () => {
  const w = await world();
  const start = monthsAgo(2);
  const sv = await call(w.env, w.admin, { action: 'settings.save', settings: { contribution: { amountCents: 100000, freq: 'monthly', startDate: start }, features: { penalties: true }, penalties: { lateContribution: { enabled: true, amountCents: 20000, graceDays: 0, since: start } } } });
  assert.ok(sv.ok, JSON.stringify(sv));
  // Paul pays the first period on time (entered as a staff payment dated inside the period); Mary pays nothing
  const rec = await call(w.env, w.admin, { action: 'payment.record', memberId: w.paul.id, amount: 1000, date: start, method: 'cash', requestId: 'r1' });
  assert.ok(rec.ok, JSON.stringify(rec));
  const h = await call(w.env, w.admin, { action: 'home' }); assert.ok(h.ok, JSON.stringify(h));
  const list = await call(w.env, w.admin, { action: 'penalty.list' });
  const late = list.items.filter((p) => p.kind === 'late_contribution');
  assert.ok(late.some((p) => p.memberName === 'Mary Late'), 'Mary was fined');
  const n = (name) => late.filter((p) => p.memberName === name).length;
  assert.ok(n('Mary Late') >= 2 && n('Paul Prompt') === n('Mary Late') - 1, 'Paul paid the first period on time so he is fined one period fewer: ' + JSON.stringify(late.map((p) => p.memberName)));
  const again = await call(w.env, w.admin, { action: 'penalty.runLate' });
  assert.equal(again.raised, 0, 'running again raises nothing new');
});
test('T4: home still answers for admin and member (parallel version)', async () => {
  const w = await world();
  const h = await call(w.env, w.admin, { action: 'home' });
  assert.ok(h.ok); assert.ok(h.staff && typeof h.staff.members === 'number'); assert.ok('logoV' in h.group);
});
