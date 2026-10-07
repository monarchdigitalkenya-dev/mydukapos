import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 230 — Chama upgrade: split payments, an ALREADY-RUNNING chama and merry-go-round, "Who is logging in?", cash confirmation with a correction, roles.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const core = await load('functions/api/_chama-core.js');
const route = await load('functions/api/chama.js');
const world = () => { const kv = makeKV(); seedShop(kv, 'G1', { product: 'chama' }); return { env: { mydukapos_kv: kv, LEDGER_DB: makeD1() } }; };
const call = async (env, tok, body) => {
  const r = await route.onRequestPost({ request: new Request('https://x/api/chama?c=G1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(tok ? { 'X-Chama-Token': tok } : {}) } }), env });
  return { status: r.status, ...(await r.json()) };
};
let seq = 0; const rid = () => 'req-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
const sms = (code, amt) => `${code} Confirmed. Ksh${amt}.00 sent to Gabriel Njuguna on 4/10/26 at 11:08 PM. New M-PESA balance is Ksh44.40. Transaction cost, Ksh0.00.`;

// a chama: admin Alice + secretary + treasurer + chairperson (Secretary AND Chairperson roles on one person) + N members
async function chama({ members = 6, amount = 100000, feats = { meetings: true, mgr: true, loans: true, fundraising: true, penalties: true } } = {}) {
  const { env } = world();
  const s = await call(env, '', { action: 'setup', groupName: 'Umoja Chama', name: 'Alice Admin', phone: '0711000001', pin: '1234' });
  assert.ok(s.ok, JSON.stringify(s));
  const admin = s.token, people = {};
  const add = async (name, extra = {}) => { const r = await call(env, admin, { action: 'members.add', name, phone: '0711' + String(100000 + Object.keys(people).length * 7 + 11).slice(0, 6), ...extra }); assert.ok(r.ok, JSON.stringify(r)); people[name.split(' ')[0]] = { id: r.id, pin: r.pin, name }; return r; };
  await add('Sec Retary', { roles: ['secretary', 'chairperson'] });
  await add('Tre Asurer', { roles: ['treasurer'] });
  for (let i = 1; i <= members; i++) await add('Member' + String.fromCharCode(64 + i) + ' Test');
  const save = await call(env, admin, { action: 'settings.save', settings: { contribution: { amountCents: amount, freq: 'monthly', startDate: core.todayKey().slice(0, 8) + '01' }, features: feats } });
  assert.ok(save.ok, JSON.stringify(save));
  const login = async (who) => {   // by tapping a name (memberId) + the temporary PIN, then choosing a PIN
    const p = people[who]; const l = await call(env, '', { action: 'login', memberId: p.id, pin: p.pin, remember: true }); assert.ok(l.ok, JSON.stringify(l));
    if (l.mustChangePin) { const c = await call(env, l.token, { action: 'pin.change', oldPin: p.pin, newPin: '5678' }); assert.ok(c.ok, JSON.stringify(c)); p.pin = '5678'; }
    return l.token;
  };
  return { env, admin, people, login, call: (tok, body) => call(env, tok, body) };
}
const cashTo = async (u, tok, receiverId, amount, extra = {}) => { const r = await u.call(tok, { action: 'report.submit', force: true, method: 'cash', amount, receiverId, requestId: rid(), ...extra }); assert.ok(r.ok, JSON.stringify(r)); return r.id; };
const mpesa = async (u, tok, code, amt) => { const r = await u.call(tok, { action: 'report.submit', force: true, text: sms(code, amt), requestId: rid() }); assert.ok(r.ok, JSON.stringify(r)); return r.id; };

test('A: split M-Pesa 600 + cash 400 on a KES 1,000 contribution -> paid 1,000, remaining 0, Complete (one obligation, two methods)', async () => {
  const u = await chama(); const sec = await u.login('Sec'), mary = await u.login('MemberA');
  const m1 = await mpesa(u, mary, 'AB11CD22EF', 600);
  const v1 = await u.call(sec, { action: 'report.verify', id: m1 }); assert.ok(v1.ok, JSON.stringify(v1));
  let b = await u.call(mary, { action: 'contrib.breakdown' });
  assert.equal(b.paidCents, 60000); assert.equal(b.remainingCents, 40000); assert.equal(b.status, 'partial');
  const c1 = await cashTo(u, mary, u.people.Sec.id, 400);
  b = await u.call(mary, { action: 'contrib.breakdown' });
  assert.equal(b.paidCents, 60000, 'a pending cash report is not verified money'); assert.equal(b.pendingCents, 40000);
  const v2 = await u.call(sec, { action: 'report.verify', id: c1 }); assert.ok(v2.ok, JSON.stringify(v2));
  b = await u.call(mary, { action: 'contrib.breakdown' });
  assert.equal(b.paidCents, 100000); assert.equal(b.remainingCents, 0); assert.equal(b.status, 'complete');
  assert.equal(b.byMethod.mpesa, 60000); assert.equal(b.byMethod.cash, 40000);
});

test('B: four split payments (100 M-Pesa, 200 cash, 300 M-Pesa, 400 cash) add up to KES 1,000', async () => {
  const u = await chama(); const sec = await u.login('Sec'), mary = await u.login('MemberA');
  for (const [kind, amt, code] of [['m', 100, 'BB11CC22DD'], ['c', 200], ['m', 300, 'BB33CC44DD'], ['c', 400]]) {
    const id = kind === 'm' ? await mpesa(u, mary, code, amt) : await cashTo(u, mary, u.people.Sec.id, amt);
    const v = await u.call(sec, { action: 'report.verify', id }); assert.ok(v.ok, JSON.stringify(v));
  }
  const b = await u.call(mary, { action: 'contrib.breakdown' });
  assert.equal(b.paidCents, 100000); assert.equal(b.remainingCents, 0); assert.equal(b.status, 'complete'); assert.equal(b.payments.length, 4);
});

test('J: KES 6,000 cycle paid as 100 M-Pesa, 1,000 cash, 2,000 M-Pesa, 900 cash, 2,000 M-Pesa -> Complete', async () => {
  const u = await chama({ amount: 600000 }); const sec = await u.login('Sec'), mary = await u.login('MemberA');
  const steps = [['m', 100, 'JJ11AA22BB'], ['c', 1000], ['m', 2000, 'JJ33AA44BB'], ['c', 900], ['m', 2000, 'JJ55AA66BB']];
  for (const [kind, amt, code] of steps) { const id = kind === 'm' ? await mpesa(u, mary, code, amt) : await cashTo(u, mary, u.people.Sec.id, amt); assert.ok((await u.call(sec, { action: 'report.verify', id })).ok); }
  const b = await u.call(mary, { action: 'contrib.breakdown' });
  assert.equal(b.requiredCents, 600000); assert.equal(b.paidCents, 600000); assert.equal(b.remainingCents, 0); assert.equal(b.status, 'complete');
});

test('H: cash reported 1,000, receiver confirms 900 -> ledger 900, the report keeps 1,000, the difference is audited; only the receiver can confirm', async () => {
  const u = await chama(); const sec = await u.login('Sec'), tre = await u.login('Tre'), mary = await u.login('MemberA');
  const id = await cashTo(u, mary, u.people.Sec.id, 1000);
  const wrong = await u.call(tre, { action: 'report.verify', id }); assert.equal(wrong.ok, false); assert.equal(wrong.code, 'forbidden');
  const noReason = await u.call(sec, { action: 'report.verify', id, amount: 900 }); assert.equal(noReason.ok, false); assert.equal(noReason.code, 'reason_needed');
  const ok = await u.call(sec, { action: 'report.verify', id, amount: 900, reason: 'only 900 was in the envelope' }); assert.ok(ok.ok, JSON.stringify(ok));
  const b = await u.call(mary, { action: 'contrib.breakdown' }); assert.equal(b.paidCents, 90000); assert.equal(b.remainingCents, 10000);
  const inbox = await u.call(sec, { action: 'report.inbox', status: 'verified' });
  const row = inbox.items.find((x) => x.id === id); assert.equal(row.amountCents, 90000); assert.equal(row.reportedCents, 100000); assert.equal(row.method, 'cash');
  const audit = await u.call(u.admin, { action: 'audit.list' });
  assert.ok(JSON.stringify(audit).includes('corrected from') && JSON.stringify(audit).includes('only 900'), 'the correction is in the audit trail');
});

test('I: the same M-Pesa code twice is refused and nothing is added twice', async () => {
  const u = await chama(); const sec = await u.login('Sec'), mary = await u.login('MemberA'), john = await u.login('MemberB');
  const id = await mpesa(u, mary, 'DD11EE22FF', 500);
  const again = await u.call(john, { action: 'report.submit', force: true, text: sms('DD11EE22FF', 500), requestId: rid() });
  assert.equal(again.ok, false); assert.match(again.error, /already/i);
  await u.call(sec, { action: 'report.verify', id });
  const third = await u.call(mary, { action: 'report.submit', force: true, text: sms('DD11EE22FF', 500), requestId: rid() }); assert.equal(third.ok, false);
  const b = await u.call(mary, { action: 'contrib.breakdown' }); assert.equal(b.paidCents, 50000);
});

test('verifying the same payment twice at once adds it once', async () => {
  const u = await chama(); const sec = await u.login('Sec'), tre = await u.login('Tre'), mary = await u.login('MemberA');
  const id = await mpesa(u, mary, 'CC11DD22EE', 700);
  const [a, b] = await Promise.all([u.call(sec, { action: 'report.verify', id }), u.call(tre, { action: 'report.verify', id })]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, JSON.stringify([a, b]));
  assert.equal((await u.call(mary, { action: 'contrib.breakdown' })).paidCents, 70000);
});

test('F + roles: the creator is a real member (Member + Admin); one person can be Secretary + Chairperson and gets both sets of permissions', async () => {
  const u = await chama();
  const list = await u.call(u.admin, { action: 'members.list' });
  const alice = list.members.find((x) => x.name === 'Alice Admin'); assert.ok(alice); assert.equal(alice.role, 'admin'); assert.equal(alice.status, 'active');
  const sec = list.members.find((x) => x.name === 'Sec Retary'); assert.deepEqual(sec.roles.slice().sort(), ['chairperson', 'secretary']);
  assert.ok(sec.perms.includes('payments') && sec.perms.includes('loans') && sec.perms.includes('mgr'));
  const tok = await u.login('Sec'); const home = await u.call(tok, { action: 'home' }); assert.deepEqual(home.me.roles.slice().sort(), ['chairperson', 'secretary']);
  const upd = await u.call(u.admin, { action: 'members.update', id: u.people.MemberA.id, roles: ['chairperson'] }); assert.ok(upd.ok, JSON.stringify(upd));
  const mem = await u.login('MemberA'); assert.ok((await u.call(mem, { action: 'report.inbox' })).ok, 'a chairperson can see payments');
  const plain = await u.login('MemberB'); assert.equal((await u.call(plain, { action: 'mgr.adjust', field: 'nextDate', value: '2030-01-01', reason: 'x' })).code, 'forbidden');
  const giveRole = await u.call(tok, { action: 'members.update', id: u.people.MemberB.id, roles: ['treasurer'] }); assert.equal(giveRole.ok, false, 'only the admin can give a role');
});

test('G: a new member gets an account and a temporary PIN; tapping the name alone does not sign in; the temporary PIN works once and is replaced by their own', async () => {
  const u = await chama();
  const tiles = await u.call('', { action: 'members.tiles' }); assert.ok(tiles.ok); assert.ok(tiles.tiles.length >= 9);
  const mary = tiles.tiles.find((x) => x.name === 'MemberA Test'); assert.equal(mary.needsSetup, true);
  assert.ok(!JSON.stringify(tiles).includes('0711'), 'no phone numbers on the sign-in screen');
  const noPin = await u.call('', { action: 'login', memberId: mary.id }); assert.equal(noPin.ok, false);
  const wrong = await u.call('', { action: 'login', memberId: mary.id, pin: '9999' }); assert.equal(wrong.ok, false); assert.equal(wrong.status, 401);
  const l = await u.call('', { action: 'login', memberId: mary.id, pin: u.people.MemberA.pin, remember: true }); assert.ok(l.ok); assert.equal(l.mustChangePin, true);
  const blocked = await u.call(l.token, { action: 'contrib.breakdown' }); assert.equal(blocked.ok, false); assert.equal(blocked.code, 'must_change_pin');
  const ch = await u.call(l.token, { action: 'pin.change', oldPin: u.people.MemberA.pin, newPin: '2468' }); assert.ok(ch.ok);
  const old = await u.call('', { action: 'login', memberId: mary.id, pin: u.people.MemberA.pin }); assert.equal(old.ok, false, 'the temporary PIN no longer works');
  const fresh = await u.call('', { action: 'login', memberId: mary.id, pin: '2468' }); assert.ok(fresh.ok); assert.equal(fresh.mustChangePin, false);
  const tiles2 = await u.call('', { action: 'members.tiles' }); assert.equal(tiles2.tiles.find((x) => x.id === mary.id).needsSetup, false);
  const reset = await u.call(u.admin, { action: 'members.resetPin', id: mary.id }); assert.ok(reset.pin && reset.pin !== '2468');
  const so = await u.call(u.admin, { action: 'members.signOutAll', id: mary.id }); assert.ok(so.note);
  assert.equal((await u.call('', { action: 'login', memberId: mary.id, pin: '2468' })).ok, false);
});

test('C + D + E: a chama that is already running — last payout 15 Aug 2026, every 2 months -> next 15 Oct 2026; 20 members, 7 already received -> 8th is next, 12 waiting after; collected 12,500 of 20,000', async () => {
  const u = await chama({ members: 17 }); const sec = await u.login('Sec');   // Alice + Sec + Tre + 17 = 20 members
  const ob = await u.call(u.admin, { action: 'onboard.save', name: 'Umoja Chama', startedOn: '2025-01-01', ongoing: true, contribution: { amount: 1000, freq: 'monthly', currentCycleStart: core.todayKey().slice(0, 8) + '01' } });
  assert.ok(ob.ok, JSON.stringify(ob));
  const list = await u.call(u.admin, { action: 'members.list' }); const ids = list.members.map((x) => x.id); assert.equal(ids.length, 20);
  const received = ids.slice(0, 7);
  const save = await u.call(sec, { action: 'mgr.save', name: 'Merry-go-round', perMember: 1000, everyMonths: 2, ongoing: true, received, lastPayoutDate: '2026-08-15', orderMode: 'fixed' });
  assert.ok(save.ok, JSON.stringify(save));
  assert.equal(save.completed, 7); assert.equal(save.remaining, 13); assert.equal(save.nextDate, '2026-10-15');
  const st = await u.call(sec, { action: 'mgr.status' });
  assert.equal(st.completed, 7); assert.equal(st.waiting, 12); assert.equal(st.total, 20);
  assert.ok(st.turns.slice(0, 7).every((t) => t.status === 'paid_out' && t.opening), 'the first seven are marked as received before the system'); assert.equal(st.turns[7].status, 'open'); assert.equal(st.next.name, st.turns[7].name, 'the 8th member is next');
  assert.equal(st.next.expectedCents, 2000000); assert.equal(st.next.dueDate, '2026-10-15'); assert.ok(st.next.countdown && typeof st.next.countdown.days === 'number');
  assert.equal(st.next.collectedCents, 0);
  // 12.5 members' worth: 12 full shares + half
  const pays = ids.slice(0, 12).map((id) => ({ id, amount: 1000 })).concat([{ id: ids[12], amount: 500 }]);
  for (const p of pays) { const r = await u.call(sec, { action: 'payment.record', force: true, memberId: p.id, amount: p.amount, kind: 'mgr', method: 'cash', requestId: rid() }); assert.ok(r.ok, JSON.stringify(r)); }
  const st2 = await u.call(sec, { action: 'mgr.status' });
  assert.equal(st2.next.collectedCents, 1250000); assert.equal(st2.next.outstandingCents, 750000);
  const half = st2.collection.find((x) => x.memberId === ids[12]); assert.equal(half.status, 'partial'); assert.equal(half.remainingCents, 50000);
  assert.equal(st2.collection.find((x) => x.memberId === ids[19]).status, 'not_started');
  // an ordinary member sees the card but not the collection list
  const mem = await u.login('MemberD'); const st3 = await u.call(mem, { action: 'mgr.status' }); assert.ok(st3.next); assert.equal(st3.collection, undefined);
  // adjusting the date needs a reason, is audited with who / before / after, and keeps the original calculated date
  const noWhy = await u.call(sec, { action: 'mgr.adjust', field: 'nextDate', value: '2026-10-20' }); assert.equal(noWhy.ok, false);
  const adj = await u.call(sec, { action: 'mgr.adjust', field: 'nextDate', value: '2026-10-20', reason: 'Members agreed to postpone the meeting.' }); assert.ok(adj.ok, JSON.stringify(adj));
  const st4 = await u.call(sec, { action: 'mgr.status' }); assert.equal(st4.next.dueDate, '2026-10-20'); assert.match(st4.next.originalDueText, /15 Oct 2026/);
  const aud = JSON.stringify(await u.call(u.admin, { action: 'audit.list' })); assert.ok(aud.includes('2026-10-20') && aud.includes('postpone the meeting') && aud.includes('Sec Retary'));
  // the next recipient cannot be swapped once money has been collected for them
  const tenth = list.members.find((x) => x.name === st4.turns[9].name); const swap = await u.call(sec, { action: 'mgr.adjust', field: 'recipient', value: tenth.id, reason: 'test' }); assert.equal(swap.ok, false); assert.equal(swap.code, 'collected');
});

test('an existing chama does not invent history: tracking starts at the current period and opening amounts are labelled', async () => {
  const u = await chama({ members: 2 });
  const list = await u.call(u.admin, { action: 'members.list' }); const mary = list.members.find((x) => x.name === 'MemberA Test');
  const ob = await u.call(u.admin, { action: 'onboard.save', name: 'Umoja Chama', startedOn: '2024-03-01', ongoing: true, contribution: { amount: 1000, freq: 'monthly', currentCycleStart: core.todayKey().slice(0, 8) + '01', paid: { [mary.id]: 400 } }, opening: [{ fund: 'main', amount: 50000, note: 'savings brought forward' }] });
  assert.ok(ob.ok, JSON.stringify(ob)); assert.equal(ob.openingPaidCents, 40000); assert.equal(ob.openingFundsCents, 5000000);
  const again = await u.call(u.admin, { action: 'onboard.save', name: 'Umoja Chama', startedOn: '2024-03-01', ongoing: true, contribution: { amount: 1000, freq: 'monthly', currentCycleStart: core.todayKey().slice(0, 8) + '01', paid: { [mary.id]: 400 } }, opening: [{ fund: 'main', amount: 50000, note: 'savings brought forward' }] });
  assert.ok(again.ok);
  const tok = await u.login('MemberA'); const b = await u.call(tok, { action: 'contrib.breakdown' });
  assert.equal(b.paidCents, 40000, 'saving the wizard twice does not count the opening payment twice'); assert.equal(b.byMethod.other, 40000);
  assert.equal(b.payments[0].method, 'Opening balance');
  const g = await u.call(u.admin, { action: 'settings.get' }); assert.equal(g.settings.chama.startedOn, '2024-03-01');
  const cyc = await u.call(u.admin, { action: 'cycle.list' }); assert.ok(JSON.stringify(cyc).length > 0);
  const nonAdmin = await u.login('MemberB'); assert.equal((await u.call(nonAdmin, { action: 'onboard.save', name: 'x' })).ok, false);
});

test('a brand-new merry-go-round still works (nobody has received yet)', async () => {
  const u = await chama({ members: 3 }); const sec = await u.login('Sec');
  const save = await u.call(sec, { action: 'mgr.save', perMember: 500, everyDays: 14, startDate: core.todayKey() }); assert.ok(save.ok, JSON.stringify(save));
  const st = await u.call(sec, { action: 'mgr.status' }); assert.equal(st.completed, 0); assert.equal(st.total, 6); assert.equal(st.next.expectedCents, 6 * 50000);
  const bad = await u.call(sec, { action: 'mgr.save', perMember: 500, everyDays: 14, startDate: core.todayKey() }); assert.equal(bad.ok, false);
});
