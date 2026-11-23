import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 332: bulk payroll - tick the people, one draft payroll for exactly those; a second batch for the same period works but nobody is paid twice.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const staffAuth = await load('functions/api/_staff-auth.js');
const route = await load('functions/api/payroll.js');
async function shop() {
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  const tok = (await staffAuth.issueSession(env, 'C1', { id: 'admin', name: 'Admin', perms: ['*'], mgr: true })).token;
  const call = async (body) => { const r = await route.onRequestPost({ request: new Request('https://x/api/payroll?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Staff-Token': tok } }), env }); return { status: r.status, body: await r.json() }; };
  return { call };
}
const emp = (name, pay = 1000) => ({ name, basic_pay: pay, start_date: '2026-01-01', pay_frequency: 'monthly' });

test('B1 only ticked people are in the payroll; a second batch for the same period adds the rest; nobody twice', async () => {
  const { call } = await shop();
  const ids = {};
  for (const n of ['Ann', 'Ben', 'Cy', 'Dee']) { const r = await call({ action: 'employee.save', employee: emp(n) }); assert.equal(r.status, 200, JSON.stringify(r.body)); ids[n] = r.body.employee.emp_id; }
  const P = { action: 'run.create', frequency: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' };
  const r1 = await call({ ...P, empIds: [ids.Ann, ids.Cy] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const g1 = await call({ action: 'run.get', runId: r1.body.runId });
  assert.deepEqual(g1.body.items.map((i) => i.emp_name).sort(), ['Ann', 'Cy']);
  // the same two again -> refused, named
  const dup = await call({ ...P, empIds: [ids.Cy, ids.Dee] });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'already_in_period'); assert.match(JSON.stringify(dup.body), /Cy/);
  // the rest -> allowed as a second payroll for the same period
  const r2 = await call({ ...P, empIds: [ids.Ben, ids.Dee] });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.notEqual(r2.body.runId, r1.body.runId);
  assert.equal((await call({ action: 'run.get', runId: r2.body.runId })).body.items.length, 2);
  // old behaviour untouched: no ticks = everyone, and a period that already has a payroll is refused
  const all = await call({ ...P, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  assert.equal(all.status, 200); assert.equal((await call({ action: 'run.get', runId: all.body.runId })).body.items.length, 4);
  const again = await call({ ...P, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  assert.equal(again.body.code, 'period_exists');
});
