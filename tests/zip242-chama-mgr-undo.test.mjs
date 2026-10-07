import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 217 — Chama: the server (REAL SQL on node:sqlite behind the D1 fake): the M-Pesa reader, partial contributions, verification, privacy, ledger rules.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const core = await load('functions/api/_chama-core.js');
const route = await load('functions/api/chama.js');
const SMS = 'UJ4QY98MZL Confirmed. Ksh100.00 sent to Gabriel Njuguna on 4/10/26 at 11:08 PM. New M-PESA balance is Ksh44.40. Transaction cost, Ksh0.00. Amount you can transact within the day is 498,520.00. See all your balances now https://saf.cx/kWQpy';

const world = () => { const kv = makeKV(); seedShop(kv, 'G1', { product: 'chama' }); seedShop(kv, 'G2', { product: 'chama' }); seedShop(kv, 'SHOP', { product: 'shop' }); return { env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } }; };
const call = async (env, c, tok, body) => {
  const r = await route.onRequestPost({ request: new Request(`https://x/api/chama?c=${c}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(tok ? { 'X-Chama-Token': tok } : {}) } }), env });
  return { status: r.status, ...(await r.json()) };
};
let seq = 0; const rid = () => 'req-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
const sms = (code, amt, d = '4/10/26', t = '11:08 PM') => `${code} Confirmed. Ksh${amt}.00 sent to Gabriel Njuguna on ${d} at ${t}. New M-PESA balance is Ksh44.40. Transaction cost, Ksh0.00. Amount you can transact within the day is 498,520.00. See all your balances now https://saf.cx/kWQpy`;

// Umoja Chama: admin + secretary + treasurer + 8 members, KES 6,000 every 2 months, members pay in portions
async function umoja(extraSettings = {}) {
  const { env } = world();
  const s = await call(env, 'G1', '', { action: 'setup', groupName: 'Umoja Chama', name: 'Alice Admin', phone: '0711000001', pin: '1234' });
  assert.ok(s.ok, JSON.stringify(s));
  const admin = s.token;
  const names = ['Mary Wanjiku', 'John Kamau', 'Peter Otieno', 'Jane Achieng', 'Sam Mutua', 'Lucy Njeri', 'Tom Kiprop', 'Ann Mwende'];
  const people = {};
  for (let i = 0; i < names.length + 2; i++) {
    const nm = i === 0 ? 'Sec Retary' : i === 1 ? 'Tre Asurer' : names[i - 2], role = i === 0 ? 'secretary' : i === 1 ? 'treasurer' : 'member';
    const r = await call(env, 'G1', admin, { action: 'members.add', name: nm, phone: '07110001' + String(10 + i), role, pin: '4321' });
    assert.ok(r.ok, JSON.stringify(r)); people[nm.split(' ')[0]] = { id: r.id, phone: '07110001' + String(10 + i), name: nm };
  }
  const save = await call(env, 'G1', admin, { action: 'settings.save', settings: { contribution: { amountCents: 600000, freq: 'bimonthly', startDate: core.todayKey().slice(0, 8) + '01' }, features: { meetings: true, mgr: true, loans: true, fundraising: true, penalties: true }, ...extraSettings } });
  assert.ok(save.ok, JSON.stringify(save));
  const login = async (who, pin = '1234') => {
    const l = await call(env, 'G1', '', { action: 'login', phone: people[who].phone, pin: '4321', remember: true });
    assert.ok(l.ok, JSON.stringify(l));
    if (l.mustChangePin) { const c = await call(env, 'G1', l.token, { action: 'pin.change', oldPin: '4321', newPin: '5678' }); assert.ok(c.ok, JSON.stringify(c)); }
    return l.token;
  };
  return { env, admin, people, login, call: (tok, body) => call(env, 'G1', tok, body) };
}
const pay = async (u, who, tok, code, amt) => { const r = await u.call(tok, { action: 'report.submit', text: sms(code, amt), requestId: rid() }); assert.ok(r.ok, JSON.stringify(r)); return r.id; };



const turns = async (u, tok) => (await u.call(tok, { action: 'mgr.status' })).turns;

test('M1: two members marked "already received" by accident -> admin undoes them, they are waiting again and the next recipient is right; non-admin is refused', async () => {
  const u = await umoja(); const tre = await u.login('Tre');
  const mg = await u.call(u.admin, { action: 'mgr.save', name: 'Round', perMember: 1000, everyDays: 7, ongoing: true, received: [u.people.Mary.id, u.people.John.id], lastPayoutDate: core.todayKey(), orderMode: 'fixed' });
  assert.ok(mg.ok, JSON.stringify(mg));
  let t = await turns(u, u.admin);
  assert.deepEqual(t.filter((x) => x.status === 'paid_out').map((x) => x.name.split(' ')[0]), ['Mary', 'John']);
  const maryTurn = t.find((x) => x.name.startsWith('Mary')), johnTurn = t.find((x) => x.name.startsWith('John'));
  const denied = await u.call(tre, { action: 'mgr.undoTurn', turnId: maryTurn.id }); assert.equal(denied.ok, false); assert.equal(denied.status, 403);
  assert.ok((await u.call(u.admin, { action: 'mgr.undoTurn', turnId: johnTurn.id })).ok);
  assert.ok((await u.call(u.admin, { action: 'mgr.undoTurn', turnId: maryTurn.id })).ok);
  t = await turns(u, u.admin);
  assert.equal(t.filter((x) => x.status === 'paid_out').length, 0);
  const st = await u.call(u.admin, { action: 'mgr.status' });
  assert.equal(st.next.name, 'Mary Wanjiku', 'the first turn is next again');
  assert.equal((await u.call(u.admin, { action: 'mgr.undoTurn', turnId: maryTurn.id })).code, 'not_found', 'cannot undo a turn that is not received');
});

test('M2: a recorded payout is reversed by the undo (money held again) and the turn can be paid out again', async () => {
  const u = await umoja(); const sec = await u.login('Sec'), mary = await u.login('Mary');
  const mg = await u.call(u.admin, { action: 'mgr.save', name: 'Round', perMember: 1000, everyDays: 7, startDate: core.todayKey(), orderMode: 'admin', order: [u.people.Mary.id] }); assert.ok(mg.ok, JSON.stringify(mg));
  const first = (await turns(u, u.admin))[0];
  const r = await u.call(u.admin, { action: 'report.submit', force: true, text: sms('MGRU000001', 1000), kind: 'mgr', requestId: rid() }); assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await u.call(u.admin, { action: 'report.verify', id: r.id })).ok);
  assert.ok((await u.call(u.admin, { action: 'mgr.payout', turnId: first.id, method: 'cash' })).ok);
  const out = await u.call(u.admin, { action: 'mgr.undoTurn', turnId: first.id, reason: 'wrong person' });
  assert.ok(out.ok, JSON.stringify(out)); assert.equal(out.reversedPayouts, 1);
  const sg = await u.call(u.admin, { action: 'mgr.status' });
  assert.equal(sg.next.turnId, first.id); assert.equal(sg.next.collectedCents, 100000, 'collected money is back on the turn');
  const again = await u.call(u.admin, { action: 'mgr.payout', turnId: first.id, method: 'cash' });
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal((await turns(u, u.admin))[0].status, 'paid_out');
});
