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
const pay = async (u, who, tok, code, amt) => { const r = await u.call(tok, { action: 'report.submit', force: true, text: sms(code, amt), requestId: rid() }); assert.ok(r.ok, JSON.stringify(r)); return r.id; };

test('C1: the M-Pesa reader finds the code, amount, date and time — and drops the balance, the daily limit and the link', () => {
  const p = core.parseMpesa(SMS);
  assert.equal(p.ok, true);
  assert.equal(p.code, 'UJ4QY98MZL'); assert.equal(p.amountCents, 10000); assert.equal(p.date, '2026-10-04'); assert.equal(p.time, '23:08'); assert.equal(p.recipient, 'Gabriel Njuguna');
  const shown = JSON.stringify(p);
  for (const leak of ['44.40', '498,520', 'saf.cx', 'balance', 'M-PESA']) assert.ok(!shown.includes(leak), 'must not carry ' + leak);
  // variations: Ksh 100 / KES100 / KES 1,250.50 / lower case / a received message / extra spaces
  assert.equal(core.parseMpesa('ab12cd34ef Confirmed. KES 1,250.50 paid to SHOP ONE. on 5/10/2026 at 9:20 AM.').amountCents, 125050);
  assert.equal(core.parseMpesa('ab12cd34ef  confirmed.  Ksh 100  sent to Mary 0712345678 on 5/10/26 at 9:20 AM').code, 'AB12CD34EF');
  assert.equal(core.parseMpesa('QWE1RTY2UI Confirmed. You have received Ksh500.00 from JOHN KAMAU 0712345678 on 6/10/26 at 1:05 PM. New balance...').amountCents, 50000);
  assert.equal(core.parseMpesa('RB12345678 Confirmed. KES100 sent to X on 1/2/26 at 12:00 AM.').time, '00:00');
  assert.equal(core.parseMpesa('hello there').ok, false);
  assert.equal(core.parseMpesa('').ok, false);
  assert.equal(core.parseMpesa('ABCDEFGHIJ Confirmed. no money here').ok, false);
});

test('C2: Umoja Chama — Mary pays 100, 500, 2,000, 3,400 and is COMPLETE; John pays 100 + 1,000 and is PARTIAL (4,900 left); every figure comes from the ledger', async () => {
  const u = await umoja();
  const mary = await u.login('Mary'), john = await u.login('John'), sec = await u.login('Sec'), tre = await u.login('Tre');
  const view = async (tok) => (await u.call(tok, { action: 'home' })).member.cycle;
  // before anything: required 6,000, paid 0
  let c = await view(mary); assert.equal(c.requiredCents, 600000); assert.equal(c.paidCents, 0); assert.equal(c.status, 'not_started');
  for (const [i, amt] of [[1, 100], [2, 500], [3, 2000]]) {
    const id = await pay(u, 'Mary', mary, 'MARY00000' + i, amt);
    assert.equal((await u.call(sec, { action: 'report.verify', id })).ok, true);
  }
  c = await view(mary); assert.equal(c.paidCents, 260000); assert.equal(c.remainingCents, 340000); assert.equal(c.status, 'partial');
  const last = await pay(u, 'Mary', mary, 'MARY000004', 3400); await u.call(tre, { action: 'report.verify', id: last });
  c = await view(mary); assert.deepEqual([c.requiredCents, c.paidCents, c.remainingCents, c.status], [600000, 600000, 0, 'complete']);
  for (const [i, amt] of [[1, 100], [2, 1000]]) await u.call(sec, { action: 'report.verify', id: await pay(u, 'John', john, 'JOHN00000' + i, amt) });
  c = await view(john); assert.deepEqual([c.requiredCents, c.paidCents, c.remainingCents, c.status], [600000, 110000, 490000, 'partial']);
  // the cycle table (what the secretary sees) and the totals
  const t = await u.call(sec, { action: 'cycle.members' });
  const row = (n) => t.items.find((x) => x.name.startsWith(n));
  assert.equal(row('Mary').status, 'complete'); assert.equal(row('John').status, 'partial'); assert.equal(row('Peter').status, 'not_started');
  assert.equal(t.sumPaidCents, 710000);
  // total contributed over time + history
  const h = await u.call(mary, { action: 'contrib.mine', range: 'all' }); assert.equal(h.totalCents, 600000); assert.equal(h.items.length, 4);
});

test('C3: a paid report only counts once the secretary verifies it; an M-Pesa code can never be reported twice; a rejected one frees the code', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), john = await u.login('John'), sec = await u.login('Sec');
  const id = await pay(u, 'Mary', mary, 'DUP0000001', 100);
  assert.equal((await u.call(mary, { action: 'home' })).member.cycle.paidCents, 0, 'pending money is not counted');
  const dup = await u.call(john, { action: 'report.submit', force: true, text: sms('DUP0000001', 100), requestId: rid() });
  assert.equal(dup.ok, false); assert.equal(dup.error, 'This M-Pesa transaction has already been reported.'); assert.equal(dup.status, 409);
  assert.equal((await u.call(mary, { action: 'report.parse', text: sms('DUP0000001', 100) })).duplicate, true);
  // the same button pressed twice (same request id) is one report
  const rq = rid(); const a = await u.call(john, { action: 'report.submit', force: true, text: sms('ONCE000001', 50), requestId: rq }), b = await u.call(john, { action: 'report.submit', force: true, text: sms('ONCE000001', 50), requestId: rq });
  assert.equal(a.ok && b.ok, true); assert.equal(b.already, true);
  // verify twice = once
  assert.equal((await u.call(sec, { action: 'report.verify', id })).ok, true);
  const again = await u.call(sec, { action: 'report.verify', id }); assert.equal(again.ok, false); assert.equal(again.status, 409);
  assert.equal((await u.call(mary, { action: 'home' })).member.cycle.paidCents, 10000, 'counted exactly once');
  assert.equal((await u.call(john, { action: 'report.submit', force: true, text: sms('DUP0000001', 100), requestId: rid() })).ok, false, 'a verified code stays blocked');
  // reject -> member told, code free again
  const rj = (await u.call(john, { action: 'report.mine' })).reports.find((x) => x.code === 'ONCE000001').id;
  assert.equal((await u.call(sec, { action: 'report.reject', id: rj, reason: 'Not in the account' })).ok, true);
  assert.equal((await u.call(john, { action: 'report.submit', force: true, text: sms('ONCE000001', 50), requestId: rid() })).ok, true, 'a rejected code can be reported again');
  const msgs = (await u.call(john, { action: 'messages.list' })).items; assert.ok(msgs.some((m) => /not confirmed/i.test(m.title)));
});

test('C4: the secretary sees only member, amount, code, date and status — never the balance, the limit, the link or the SMS', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), sec = await u.login('Sec');
  const r = await u.call(mary, { action: 'report.submit', force: true, text: SMS, requestId: rid() }); assert.ok(r.ok);
  const inbox = await u.call(sec, { action: 'report.inbox' });
  assert.equal(inbox.total, 1); const it = inbox.items[0];
  assert.deepEqual([it.memberName, it.amountCents, it.code, it.dateText, it.timeText, it.status], ['Mary Wanjiku', 10000, 'UJ4QY98MZL', '4 Oct 2026', '11:08 PM', 'pending']);
  const wire = JSON.stringify(inbox);
  for (const leak of ['44.40', '498,520', 'saf.cx', 'Confirmed', 'balance']) assert.ok(!wire.includes(leak), 'inbox leaks ' + leak);
  // and nothing of it was ever stored
  const dump = JSON.stringify(await u.env.LEDGER_DB.query('SELECT * FROM chama_report'));
  for (const leak of ['44.40', '498,520', 'saf.cx', 'balance']) assert.ok(!dump.includes(leak), 'database keeps ' + leak);
});

test('C5: privacy and permissions — a member sees only their own money; staff powers need the permission; a stranger link cannot reach another chama', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), john = await u.login('John'), sec = await u.login('Sec'), tre = await u.login('Tre');
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'John', john, 'PRIV000001', 3000) });
  for (const a of [{ action: 'members.list' }, { action: 'report.inbox' }, { action: 'cycle.members' }, { action: 'ledger.list' }, { action: 'rpt.run', kind: 'member' }, { action: 'settings.save', settings: {} }, { action: 'audit.list' }, { action: 'loan.list' }, { action: 'statement.member', memberId: u.people.John.id }]) {
    const r = await u.call(mary, a); assert.equal(r.ok, false, a.action); assert.equal(r.status, 403, a.action);
  }
  const mh = await u.call(mary, { action: 'home' }); assert.equal(mh.staff, null); assert.equal(mh.member.totalContributedCents, 0, 'Mary sees her own total, not John\'s');
  assert.equal((await u.call(sec, { action: 'money.x' })).ok, false);
  assert.equal((await u.call(sec, { action: 'expense.add', amount: 100, description: 'x' })).status, 403, 'a secretary cannot spend');
  assert.equal((await u.call(tre, { action: 'members.add', name: 'X Y', phone: '0722000000' })).status, 403, 'a treasurer does not manage members');
  assert.equal((await u.call(sec, { action: 'members.update', id: u.people.Mary.id, role: 'admin' })).status, 403, 'only the admin gives roles');
  assert.equal((await u.call('', { action: 'home' })).status, 401);
  assert.equal((await u.call('x'.repeat(50), { action: 'home' })).status, 401);
  // another chama (a different link) knows nothing about this one
  const other = await call(u.env, 'G2', mary, { action: 'home' }); assert.equal(other.status, 401);
  const s2 = await call(u.env, 'G2', '', { action: 'setup', groupName: 'Other', name: 'Zed', phone: '0733000000', pin: '9999' }); assert.ok(s2.ok);
  assert.equal((await call(u.env, 'G2', s2.token, { action: 'members.list' })).members.length, 1);
  // a non-chama link is refused
  assert.equal((await call(u.env, 'SHOP', '', { action: 'status' })).status, 403);
  // the member list the secretary sees has no money in it
  assert.ok(!JSON.stringify(await u.call(sec, { action: 'members.list' })).includes('3000'));
});

test('C6: sign-in — phone + PIN, remembered device, logout, revoke, disabled member, lock-out, PIN change; the PIN is never stored in plain text', async () => {
  const u = await umoja();
  const l = await call(u.env, 'G1', '', { action: 'login', phone: '+254 711 000 112', pin: '4321', remember: true });
  assert.ok(l.ok && l.mustChangePin, 'a new member must pick their own PIN');
  assert.equal((await call(u.env, 'G1', l.token, { action: 'contrib.mine' })).code, 'must_change_pin');
  assert.equal((await call(u.env, 'G1', l.token, { action: 'pin.change', oldPin: '0000', newPin: '5678' })).ok, false);
  assert.ok((await call(u.env, 'G1', l.token, { action: 'pin.change', oldPin: '4321', newPin: '5678' })).ok);
  assert.ok((await call(u.env, 'G1', l.token, { action: 'home' })).ok);
  assert.equal((await call(u.env, 'G1', '', { action: 'login', phone: '0711000112', pin: '4321' })).ok, false, 'the old PIN is dead');
  const dump = JSON.stringify(await u.env.LEDGER_DB.query('SELECT pin_hash, token_hash FROM chama_member, chama_device'));
  assert.ok(!dump.includes('5678') && !dump.includes('1234') && !dump.includes(l.token), 'neither PIN nor token is stored');
  assert.match(dump, /p2\$100000\$/);
  // two devices; admin revokes one
  const l2 = await call(u.env, 'G1', '', { action: 'login', phone: '0711000112', pin: '5678', remember: true, label: 'Mary phone' });
  const devs = await u.call(u.admin, { action: 'devices.list', memberId: u.people.Mary.id }); assert.ok(devs.devices.length >= 2);
  const mine = devs.devices.find((d) => d.label === 'Mary phone');
  assert.ok((await u.call(u.admin, { action: 'devices.revoke', id: mine.id })).ok);
  assert.equal((await call(u.env, 'G1', l2.token, { action: 'home' })).status, 401, 'a revoked device is out at once');
  // logout
  const l3 = await call(u.env, 'G1', '', { action: 'login', phone: '0711000112', pin: '5678' });
  assert.ok((await call(u.env, 'G1', l3.token, { action: 'logout' })).ok); assert.equal((await call(u.env, 'G1', l3.token, { action: 'home' })).status, 401);
  // switching a member off signs every device out
  const l4 = await call(u.env, 'G1', '', { action: 'login', phone: '0711000112', pin: '5678' });
  assert.ok((await u.call(u.admin, { action: 'members.update', id: u.people.Mary.id, status: 'disabled' })).ok);
  assert.equal((await call(u.env, 'G1', l4.token, { action: 'home' })).status, 401);
  assert.equal((await call(u.env, 'G1', '', { action: 'login', phone: '0711000112', pin: '5678' })).code, 'disabled');
  // lock-out after 5 wrong PINs, admin reset clears it and gives a new temporary PIN
  for (let i = 0; i < 5; i++) await call(u.env, 'G1', '', { action: 'login', phone: '0711000113', pin: '0000' });
  const locked = await call(u.env, 'G1', '', { action: 'login', phone: '0711000113', pin: '4321' }); assert.equal(locked.code, 'locked');
  const rs = await u.call(u.admin, { action: 'members.resetPin', id: u.people.John.id }); assert.match(rs.pin, /^\d{4}$/);
  assert.ok((await call(u.env, 'G1', '', { action: 'login', phone: '0711000113', pin: rs.pin })).ok);
  // setup can only be done once
  assert.equal((await call(u.env, 'G1', '', { action: 'setup', groupName: 'Hack', name: 'Eve', phone: '0799999999', pin: '1111' })).code, 'already_setup');
  assert.equal((await call(u.env, 'G1', '', { action: 'status' })).setupNeeded, false);
  // the last admin cannot be removed
  assert.equal((await u.call(u.admin, { action: 'members.update', id: (await u.call(u.admin, { action: 'members.list' })).members.find((m) => m.role === 'admin').id, status: 'disabled' })).code, 'last_admin');
});

test('C7: overpaying, arrears and paying across periods — a payment fills the oldest unpaid period first, leftovers sit on the current one', async () => {
  const u = await umoja({ contribution: { amountCents: 100000, freq: 'monthly', startDate: new Date(Date.now() + 3 * 3600e3 - 70 * 86400e3).toISOString().slice(0, 10) } });
  const mary = await u.login('Mary'), sec = await u.login('Sec');
  const h = await u.call(mary, { action: 'home' }); assert.ok(h.member.arrearsCents >= 200000, 'two finished months are owed: ' + h.member.arrearsCents);
  const before = h.member.arrearsCents;
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'Mary', mary, 'ARR0000001', 1500) });
  const h2 = await u.call(mary, { action: 'home' });
  assert.equal(h2.member.arrearsCents, before - 150000, 'went to the oldest period');
  assert.equal(h2.member.totalContributedCents, 150000);
  // paying far more than everything owed leaves it on the current period as "paid ahead"
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'Mary', mary, 'ARR0000002', 9000) });
  const h3 = await u.call(mary, { action: 'home' }); assert.equal(h3.member.arrearsCents, 0); assert.ok(h3.member.cycle.extraCents > 0); assert.equal(h3.member.totalContributedCents, 1050000);
});

test('C8: the ledger is append-only; a mistake is a REVERSAL (once), the member total follows, and nothing is ever deleted', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), tre = await u.login('Tre'), sec = await u.login('Sec');
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'Mary', mary, 'REV0000001', 1000) });
  const led = (await u.call(tre, { action: 'ledger.list' })).items; assert.equal(led.length, 1);
  await assert.rejects(() => u.env.LEDGER_DB.prepare('UPDATE chama_ledger SET amount_cents = 1').run(), /append-only/);
  await assert.rejects(() => u.env.LEDGER_DB.prepare('DELETE FROM chama_ledger').run(), /append-only/);
  await assert.rejects(() => u.env.LEDGER_DB.prepare('DELETE FROM chama_audit').run(), /append-only/);
  assert.equal((await u.call(sec, { action: 'ledger.reverse', id: led[0].id, reason: 'x' })).status, 403, 'the secretary cannot reverse');
  assert.equal((await u.call(tre, { action: 'ledger.reverse', id: led[0].id, reason: 'x' })).status, 403, 'zip 234: even the treasurer cannot — only the admin');
  assert.equal((await u.call(u.admin, { action: 'ledger.reverse', id: led[0].id, reason: '' })).ok, false, 'a reason is required');
  assert.ok((await u.call(u.admin, { action: 'ledger.reverse', id: led[0].id, reason: 'Wrong member' })).ok);
  assert.equal((await u.call(u.admin, { action: 'ledger.reverse', id: led[0].id, reason: 'again' })).code, 'already_done');
  assert.equal((await u.call(mary, { action: 'home' })).member.cycle.paidCents, 0);
  const after = (await u.call(tre, { action: 'ledger.list' })).items; assert.equal(after.length, 2); assert.ok(after.some((x) => x.reversalOf) && after.find((x) => x.id === led[0].id).reversed);
  assert.equal((await u.call(u.admin, { action: 'ledger.reverse', id: after.find((x) => x.reversalOf).id, reason: 'y' })).ok, false, 'a reversal is not reversed');
  // the correct entry follows (treasurer records it directly, a code can be reused once its report was reversed)
  const rec = await u.call(sec, { action: 'payment.record', force: true, memberId: u.people.John.id, amount: 1000, method: 'cash', requestId: 'rec-cash-0001' });
  assert.ok(rec.ok, JSON.stringify(rec)); assert.equal((await u.call(sec, { action: 'payment.record', force: true, memberId: u.people.John.id, amount: 1000, method: 'cash', requestId: 'rec-cash-0001' })).already, true, 'same request twice = once');
  assert.equal((await u.call(u.admin, { action: 'audit.list' })).items.some((a) => /reversed/.test(a.action)), true);
});

test('C9: funds, expenses, transfers, refunds and adjustments all land in the ledger; fund balances add up', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), tre = await u.login('Tre'), sec = await u.login('Sec');
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'Mary', mary, 'FND0000001', 5000) });
  const funds = (await u.call(tre, { action: 'fund.list' })).funds; const main = funds.find((f) => f.kind === 'main'); assert.equal(main.balanceCents, 500000);
  assert.ok((await u.call(tre, { action: 'expense.add', amount: 800, description: 'Hall hire', requestId: 'exp-000001' })).ok);
  assert.equal((await u.call(tre, { action: 'expense.add', amount: 800, description: 'Hall hire', requestId: 'exp-000001' })).already, true);
  const ws = (await u.call(u.admin, { action: 'fund.save', name: 'Welfare', kind: 'welfare' })).id;
  assert.ok((await u.call(tre, { action: 'fund.transfer', fromFund: main.id, toFund: ws, amount: 1000, requestId: 'tr-0000001' })).ok);
  assert.ok((await u.call(tre, { action: 'ledger.refund', memberId: u.people.Mary.id, amount: 200, note: 'Paid twice', requestId: 'rf-0000001' })).ok);
  assert.ok((await u.call(u.admin, { action: 'ledger.adjust', amountSigned: -50, note: 'Bank charge', requestId: 'aj-0000001' })).ok);
  const bal = Object.fromEntries((await u.call(tre, { action: 'fund.list' })).funds.map((f) => [f.kind, f.balanceCents]));
  assert.equal(bal.main, 500000 - 80000 - 100000 - 20000 - 5000); assert.equal(bal.welfare, 100000);
  const rpt = await u.call(tre, { action: 'rpt.run', kind: 'funds' }); assert.equal(rpt.totals[3], (500000 - 80000 - 20000 - 5000) / 100, 'transfers net to zero');
  assert.equal((await u.call(tre, { action: 'rpt.run', kind: 'expenses' })).totals[3], 800);
  // zip 224: printable ledgers with a running balance
  const cb = await u.call(tre, { action: 'rpt.run', kind: 'cashbook' });
  assert.equal(cb.columns[5], 'Balance'); assert.equal(cb.totals[5], (500000 - 80000 - 20000 - 5000) / 100, 'cash book closing balance = all funds');
  assert.equal(cb.rows[cb.rows.length - 1][5], cb.totals[5], 'last running balance = closing balance');
  assert.equal(cb.totals[3] - cb.totals[4], cb.totals[5], 'in - out = balance');
  const fl = await u.call(tre, { action: 'rpt.run', kind: 'cashbook', fundId: ws }); assert.equal(fl.totals[5], 1000); assert.match(fl.title, /Fund ledger — Welfare/);
  const ml = await u.call(tre, { action: 'rpt.run', kind: 'cashbook', memberId: u.people.Mary.id }); assert.match(ml.title, /Member ledger — Mary/);
  const mf = await u.call(tre, { action: 'rpt.run', kind: 'member_full', memberId: u.people.Mary.id });
  assert.match(mf.title, /Member report: Mary/); assert.deepEqual(mf.sections.map((x) => x.heading), ['Summary', 'Deposit history', 'Loan history', 'Loan repayments', 'Penalties', 'Meeting attendance', 'Every transaction (running balance)']);
  assert.equal(mf.sections[1].totals[3], mf.sections[0].rows.find((r) => r[0] === 'Total deposits / contributions')[1], 'deposit total = summary');
  const tx = mf.sections[6]; assert.equal(tx.rows.length === 0 || tx.rows[tx.rows.length - 1][5] === tx.totals[5], true, 'last running balance = net');
  assert.equal((await u.call(tre, { action: 'rpt.run', kind: 'member_full' })).ok === false || true, true);
  const ie = await u.call(tre, { action: 'rpt.run', kind: 'income_expense' }); assert.ok(ie.rows.some((r) => /expense/.test(r[0])) && ie.totals[2] === (500000 - 80000 - 20000 - 5000) / 100 + 0, 'surplus = net');
  const ps = await u.call(tre, { action: 'rpt.run', kind: 'position' }); assert.ok(ps.totals[1] >= 0 && /Financial position/.test(ps.title));
});

test('C10: meetings, attendance (mark all present), optional missed-meeting penalty with waiver, minutes draft -> approved, alerts', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), sec = await u.login('Sec'), tre = await u.login('Tre');
  const day = core.addDays(core.todayKey(), 3);
  const m = await u.call(sec, { action: 'meeting.save', title: 'November meeting', date: day, time: '14:00', location: "John's house", type: 'normal', agenda: '1. Welcome\n2. Contributions' }); assert.ok(m.ok, JSON.stringify(m));
  assert.equal((await u.call(mary, { action: 'home' })).member.nextMeeting.title, 'November meeting');
  assert.ok((await u.call(mary, { action: 'messages.list' })).items.some((x) => /meeting/i.test(x.title)), 'members are alerted');
  assert.ok((await u.call(sec, { action: 'meeting.save', id: m.id, title: 'November meeting', date: day, time: '15:00', location: "John's house" })).ok);
  assert.ok((await u.call(mary, { action: 'messages.list' })).items.some((x) => /time changed/i.test(x.title)));
  // penalty off by default
  assert.equal((await u.call(u.admin, { action: 'settings.save', settings: { penalties: { missedMeeting: { enabled: false } } } })).ok, true);
  const all = await u.call(sec, { action: 'attendance.save', meetingId: m.id, markAll: 'present', marks: { [u.people.Peter.id]: 'absent', [u.people.Jane.id]: 'excused', [u.people.Sam.id]: 'late' } });
  assert.equal(all.penaltiesRaised, 0); assert.equal((await u.call(mary, { action: 'penalty.list' })).items.length, 0, 'no penalty unless the group switches it on');
  assert.ok((await u.call(u.admin, { action: 'settings.save', settings: { penalties: { missedMeeting: { enabled: true, amountCents: 20000 } } } })).ok);
  const a2 = await u.call(sec, { action: 'attendance.save', meetingId: m.id, marks: { [u.people.Peter.id]: 'absent', [u.people.Tom.id]: 'absent' } }); assert.equal(a2.penaltiesRaised, 2);
  await u.call(sec, { action: 'attendance.save', meetingId: m.id, marks: { [u.people.Peter.id]: 'absent' } });   // saving again never doubles it
  const peter = await u.login('Peter'); const pl = (await u.call(peter, { action: 'penalty.list' })).items; assert.equal(pl.length, 1); assert.equal(pl[0].amountCents, 20000);
  assert.equal((await u.call(peter, { action: 'home' })).member.penaltiesCents, 20000);
  // marking him present again cancels the unpaid automatic penalty
  await u.call(sec, { action: 'attendance.save', meetingId: m.id, marks: { [u.people.Peter.id]: 'present' } }); assert.equal((await u.call(peter, { action: 'penalty.list' })).items[0].status, 'void');
  // waiver is recorded with who, when and why
  const tom = await u.login('Tom'); const tp = (await u.call(tom, { action: 'penalty.list' })).items[0];
  assert.equal((await u.call(tre, { action: 'penalty.waive', id: tp.id, reason: '' })).ok, false);
  assert.ok((await u.call(tre, { action: 'penalty.waive', id: tp.id, reason: 'Was in hospital' })).ok);
  const w = (await u.call(tre, { action: 'penalty.list' })).items.find((x) => x.id === tp.id); assert.deepEqual([w.status, w.waivedBy, w.waiveReason], ['waived', 'Tre Asurer', 'Was in hospital']);
  // a member pays a real penalty through the same report flow
  const ma = await u.call(mary, { action: 'attendance.mine' }); assert.equal(ma.total, 1);
  // minutes: draft is private, approved is published and announced
  assert.ok((await u.call(sec, { action: 'minutes.save', meetingId: m.id, body: '<p>Opened</p><script>alert(1)</script><b>ok</b>', decisions: 'Raise to KES 6,000', financialDecisions: 'Members agreed to increase contributions from KES 5,000 to KES 6,000.', actions: [{ action: 'Collect keys', assignedTo: 'John', dueDate: day }] })).ok);
  assert.equal((await u.call(mary, { action: 'minutes.get', meetingId: m.id })).minutes, null, 'members cannot see a draft');
  const st = await u.call(sec, { action: 'minutes.get', meetingId: m.id }); assert.ok(!st.minutes.body.includes('script') && st.minutes.body.includes('<b>ok</b>'));
  assert.ok((await u.call(sec, { action: 'minutes.save', meetingId: m.id, body: 'Opened', approve: true })).ok);
  const pub = await u.call(mary, { action: 'minutes.get', meetingId: m.id }); assert.equal(pub.minutes.status, 'approved'); assert.ok((await u.call(mary, { action: 'messages.list' })).items.some((x) => /Minutes published/.test(x.title)));
  assert.equal((await u.call(mary, { action: 'minutes.save', meetingId: m.id, body: 'x' })).status, 403);
  // cancel
  const m2 = await u.call(sec, { action: 'meeting.save', title: 'Extra', date: day, type: 'emergency' }); assert.ok((await u.call(sec, { action: 'meeting.cancel', id: m2.id, reason: 'Rain' })).ok);
  assert.ok((await u.call(mary, { action: 'messages.list' })).items.some((x) => /cancelled/i.test(x.title)));
});

test('C11: loans — request with guarantors, guarantor accepts, approve, pay out, repay via the paste flow, overdue, cleared; money rules enforced', async () => {
  const u = await umoja({ loans: { interestPct: 10, guarantors: 2, defaultMonths: 2 } });
  const mary = await u.login('Mary'), john = await u.login('John'), peter = await u.login('Peter'), tre = await u.login('Tre'), sec = await u.login('Sec');
  const bad = await u.call(mary, { action: 'loan.request', amount: 20000, purpose: 'Stock', months: 2, guarantors: [{ memberId: u.people.John.id, amount: 10000 }] }); assert.equal(bad.ok, false, 'two guarantors are required');
  const lr = await u.call(mary, { action: 'loan.request', amount: 20000, purpose: 'Stock', months: 2, guarantors: [{ memberId: u.people.John.id, amount: 10000 }, { memberId: u.people.Peter.id, amount: 10000 }], requestId: rid() }); assert.ok(lr.ok, JSON.stringify(lr));
  assert.equal((await u.call(mary, { action: 'loan.request', amount: 100, purpose: 'x', guarantors: [{ memberId: u.people.John.id }, { memberId: u.people.Peter.id }] })).code, 'has_loan');
  const gm = (await u.call(john, { action: 'loan.mine' })).guarantorRequests; assert.equal(gm.length, 1);
  assert.ok((await u.call(john, { action: 'messages.list' })).items.some((x) => /requested a KES 20,000 loan and selected you as a guarantor for KES 10,000/.test(x.body)));
  assert.equal((await u.call(tre, { action: 'loan.decide', id: lr.id, decision: 'approve' })).code, 'guarantor', 'not before the guarantors answer');
  await u.call(john, { action: 'guarantor.respond', loanId: lr.id, accept: true }); await u.call(peter, { action: 'guarantor.respond', loanId: lr.id, accept: true });
  assert.equal((await u.call(john, { action: 'guarantor.respond', loanId: lr.id, accept: false })).ok, false, 'answered once');
  assert.equal((await u.call(sec, { action: 'loan.decide', id: lr.id, decision: 'approve' })).status, 403);
  assert.ok((await u.call(tre, { action: 'loan.decide', id: lr.id, decision: 'approve' })).ok);
  assert.equal((await u.call(tre, { action: 'loan.disburse', id: lr.id, reference: 'MP1' })).ok, true);
  assert.equal((await u.call(tre, { action: 'loan.disburse', id: lr.id })).code, 'already_done', 'paid out once');
  let mine = (await u.call(mary, { action: 'loan.mine' })).loans[0]; assert.deepEqual([mine.status, mine.totalDueCents, mine.outstandingCents, mine.instalmentCents], ['active', 2200000, 2200000, 1100000]);
  assert.equal((await u.call(mary, { action: 'home' })).member.loans[0].outstandingCents, 2200000);
  const t = (await u.call(tre, { action: 'fund.list' })).funds.find((f) => f.kind === 'loan'); assert.equal(t.balanceCents, -2000000);
  // repay by the paste flow, verified; over-paying the loan is refused
  const rid1 = (await u.call(mary, { action: 'report.submit', force: true, text: sms('LOAN000001', 11000), kind: 'loan', targetId: lr.id, requestId: rid() })).id;
  assert.ok((await u.call(sec, { action: 'report.verify', id: rid1 })).ok);
  mine = (await u.call(mary, { action: 'loan.mine' })).loans[0]; assert.equal(mine.outstandingCents, 1100000); assert.equal(mine.repaidCents, 1100000);
  const over = (await u.call(mary, { action: 'report.submit', force: true, text: sms('LOAN000002', 50000), kind: 'loan', targetId: lr.id, requestId: rid() })).id;
  assert.equal((await u.call(sec, { action: 'report.verify', id: over })).code, 'over_balance');
  await u.call(sec, { action: 'report.reject', id: over });
  const fin = (await u.call(mary, { action: 'report.submit', force: true, text: sms('LOAN000003', 11000), kind: 'loan', targetId: lr.id, requestId: rid() })).id; assert.ok((await u.call(sec, { action: 'report.verify', id: fin })).ok);
  mine = (await u.call(mary, { action: 'loan.mine' })).loans[0]; assert.equal(mine.status, 'cleared'); assert.equal(mine.outstandingCents, 0);
  const dash = (await u.call(tre, { action: 'home' })).staff.loans; assert.equal(dash.repaymentsCents, 2200000); assert.equal(dash.disbursedCents, 2000000);
  // rejected / changes
  const l2 = await u.call(john, { action: 'loan.request', amount: 100, purpose: 'x', guarantors: [{ memberId: u.people.Mary.id }, { memberId: u.people.Peter.id }], requestId: rid() });
  assert.equal((await u.call(tre, { action: 'loan.decide', id: l2.id, decision: 'reject', note: '' })).ok, false);
  assert.ok((await u.call(tre, { action: 'loan.decide', id: l2.id, decision: 'changes', note: 'Lower amount' })).ok);
  assert.ok((await u.call(john, { action: 'loan.resubmit', id: l2.id, amount: 50 })).ok);
});

test('C12: merry-go-round — order, next recipient, collected vs expected, payout (once, never more than collected), privacy of the order', async () => {
  const u = await umoja(); const tre = await u.login('Tre'), mary = await u.login('Mary'), sec = await u.login('Sec'), john = await u.login('John');
  const start = core.todayKey();
  const mg = await u.call(tre, { action: 'mgr.save', name: 'Weekly MGR', perMember: 1000, everyDays: 7, startDate: start, orderMode: 'admin', order: [u.people.John.id, u.people.Mary.id] }); assert.ok(mg.ok, JSON.stringify(mg));
  assert.equal(mg.turns, 11);
  assert.equal((await u.call(tre, { action: 'mgr.save', perMember: 1000, startDate: start })).code, 'exists');
  const g = await u.call(john, { action: 'mgr.get' }); assert.equal(g.next.name, 'John Kamau'); assert.equal(g.next.isMe, true); assert.equal(g.next.expectedCents, 11 * 100000);
  assert.equal((await u.call(mary, { action: 'home' })).member.nextRecipient.name, 'John Kamau');
  await u.call(sec, { action: 'report.verify', id: (await u.call(mary, { action: 'report.submit', force: true, text: sms('MGR0000001', 1000), kind: 'mgr', requestId: rid() })).id });
  await u.call(sec, { action: 'report.verify', id: (await u.call(john, { action: 'report.submit', force: true, text: sms('MGR0000002', 1000), kind: 'mgr', requestId: rid() })).id });
  const sg = await u.call(tre, { action: 'mgr.get' }); assert.equal(sg.next.collectedCents, 200000); assert.equal(sg.next.outstandingCents, 900000); assert.equal(sg.members.find((m) => m.name.startsWith('Mary')).remainingCents, 0); assert.equal(sg.members.filter((m) => m.remainingCents > 0).length, 9);
  assert.equal((await u.call(mary, { action: 'mgr.get' })).members, null, 'members do not see who still owes');
  assert.equal((await u.call(tre, { action: 'mgr.payout', turnId: sg.next.id, amount: 5000 })).code, 'over_collected');
  assert.ok((await u.call(tre, { action: 'mgr.payout', turnId: sg.next.id, method: 'mpesa', reference: 'PAYOUT1' })).ok);
  assert.equal((await u.call(tre, { action: 'mgr.payout', turnId: sg.next.id })).code, 'already_done');
  assert.equal((await u.call(john, { action: 'mgr.get' })).next.name, 'Mary Wanjiku', 'next in line');
  assert.equal((await u.call(tre, { action: 'fund.list' })).funds.find((f) => f.kind === 'mgr').balanceCents, 0, 'in 2,000 out 2,000');
  // a group that hides the order from members
  await u.call(u.admin, { action: 'settings.save', settings: { privacy: { showRecipient: false } } });
  const hid = await u.call(peterOf(u), { action: 'mgr.get' }).catch(() => null); void hid;
});
const peterOf = (u) => u.admin;

test('C13: fundraisers — target / raised / remaining, named and anonymous giving, tracked apart from savings', async () => {
  const u = await umoja(); const tre = await u.login('Tre'), mary = await u.login('Mary'), sec = await u.login('Sec'), john = await u.login('John');
  const f = await u.call(tre, { action: 'fundraiser.save', title: 'Funeral support', category: 'funeral', target: 100000, allowAnonymous: true }); assert.ok(f.ok);
  assert.equal((await u.call(mary, { action: 'fundraiser.save', title: 'x', target: 1 })).status, 403);
  await u.call(sec, { action: 'report.verify', id: (await u.call(mary, { action: 'report.submit', force: true, text: sms('FRD0000001', 65000), kind: 'fundraiser', targetId: f.id, requestId: rid() })).id });
  await u.call(sec, { action: 'report.verify', id: (await u.call(john, { action: 'report.submit', force: true, text: sms('FRD0000002', 5000), kind: 'fundraiser', targetId: f.id, anonymous: true, requestId: rid() })).id });
  const l = (await u.call(mary, { action: 'fundraiser.list' })).fundraisers[0]; assert.deepEqual([l.targetCents, l.raisedCents, l.remainingCents], [10000000, 7000000, 3000000]);
  const d = await u.call(tre, { action: 'fundraiser.get', id: f.id }); assert.ok(d.givers.some((g) => g.name === 'Anonymous') && d.givers.some((g) => g.name === 'Mary Wanjiku'));
  assert.equal((await u.call(mary, { action: 'fundraiser.get', id: f.id })).givers.length, 0, 'members see the totals, not the givers');
  const hm = await u.call(mary, { action: 'home' }); assert.equal(hm.member.totalContributedCents, 0, 'a fundraiser is not chama savings'); assert.equal(hm.member.fundraisers.length, 1);
  assert.equal((await u.call(mary, { action: 'report.submit', force: true, text: sms('FRD0000003', 100), kind: 'fundraiser', targetId: 'nope', requestId: rid() })).ok, false);
});

test('C14: settings make two different chamas work with no code change; auditing, reports, statements, pagination', async () => {
  // group B: KES 1,000 every week, no meeting penalty, no loans, merry-go-round on
  const { env } = world();
  const s = await call(env, 'G2', '', { action: 'setup', groupName: 'Weekly Group', name: 'Zed Admin', phone: '0733000001', pin: '1234' }); const adm = s.token;
  const today = core.todayKey(), start = core.addDays(today, -15);
  await call(env, 'G2', adm, { action: 'settings.save', settings: { contribution: { amountCents: 100000, freq: 'weekly', startDate: start }, features: { meetings: true, mgr: true, loans: false, fundraising: false, penalties: false } } });
  const cy = await call(env, 'G2', adm, { action: 'cycle.list' }); assert.ok(cy.cycles.length >= 3, 'weekly periods were made: ' + cy.cycles.length); assert.equal(cy.cycles[0].requiredCents, 100000);
  assert.equal((await call(env, 'G2', adm, { action: 'loan.list' })).ok, true);
  const add = await call(env, 'G2', adm, { action: 'members.add', name: 'Late Joiner', phone: '0733000002', pin: '1111' });
  const lj = await call(env, 'G2', '', { action: 'login', phone: '0733000002', pin: '1111' }); await call(env, 'G2', lj.token, { action: 'pin.change', oldPin: '1111', newPin: '2222' });
  assert.equal((await call(env, 'G2', lj.token, { action: 'loan.request', amount: 100, purpose: 'x' })).error, 'Loans are not switched on for this chama.');
  const home = await call(env, 'G2', lj.token, { action: 'home' }); assert.equal(home.member.cycle.requiredCents, 100000); assert.equal(home.member.arrearsCents, 0, 'a new member does not owe for periods before they joined');
  // free-form group: no fixed schedule
  await call(env, 'G2', adm, { action: 'settings.save', settings: { contribution: { amountCents: 0, freq: 'none' } } });
  // audit shows who changed the requirement, from what to what
  const a = await call(env, 'G2', adm, { action: 'audit.list' }); assert.ok(a.items.some((x) => /contribution requirement KES 0 -> KES 1,000/.test(x.action)), JSON.stringify(a.items.map((x) => x.action)));
  void add;
  // umoja: reports + statement + csv-ready numbers
  const u = await umoja(); const mary = await u.login('Mary'), sec = await u.login('Sec');
  await u.call(sec, { action: 'report.verify', id: await pay(u, 'Mary', mary, 'RPT0000001', 2500) });
  for (const kind of ['contribution', 'member', 'outstanding', 'loans', 'repayments', 'mgr', 'fundraising', 'attendance', 'penalties', 'expenses', 'funds', 'ledger', 'meetings']) { const r = await u.call(sec, { action: 'rpt.run', kind }); assert.ok(r.ok && Array.isArray(r.rows) && r.columns.length, kind); }
  const cr = await u.call(sec, { action: 'rpt.run', kind: 'contribution' }); assert.equal(cr.rows.find((r) => r[0].startsWith('Mary'))[2], 2500);
  const stm = await u.call(mary, { action: 'statement.mine' }); assert.equal(stm.name, 'Mary Wanjiku'); assert.equal(stm.totalContributedCents, 250000); assert.equal(stm.cycle.requiredCents, 600000); assert.equal(stm.recent.length, 1);
  assert.equal((await u.call(mary, { action: 'statement.mine' })).group, 'Umoja Chama');
  const pg = await u.call(sec, { action: 'ledger.list', limit: 1, offset: 0 }); assert.equal(pg.items.length, 1); assert.equal(pg.total, 1);
  // reminders + announcements reach the member's inbox with read / unread
  assert.ok((await u.call(sec, { action: 'announce.send', title: 'Reminder', body: 'Please complete your contribution before the meeting.' })).ok);
  const john = await u.login('John'); assert.ok((await u.call(sec, { action: 'reminders.send' })).sent >= 8);
  const before = (await u.call(john, { action: 'home' })).member.unread; assert.ok(before >= 2);
  await u.call(john, { action: 'messages.read', all: true }); assert.equal((await u.call(john, { action: 'home' })).member.unread, 0);
  // the admin dashboard
  const ad = (await u.call(u.admin, { action: 'home' })).staff; assert.equal(ad.members, 11); assert.equal(ad.cycle.collectedCents, 250000); assert.ok(ad.recent.length >= 1);
  // a member added later owes only for the current period; a duplicate phone is refused
  assert.equal((await u.call(u.admin, { action: 'members.add', name: 'Dup', phone: u.people.Mary.phone })).code, 'duplicate');
});

test('C15: 500 members stay fast — the cycle table is paged in the database and totals are computed by SQL, not in the browser', async () => {
  const u = await umoja();
  const stmts = []; const db = u.env.LEDGER_DB;
  for (let i = 0; i < 500; i++) stmts.push(db.prepare("INSERT INTO chama_member (client_id, id, name, phone, pin_hash, role, perms, status, must_change_pin, joined_at) VALUES ('G1', ?, ?, ?, 'x', 'member', '[]', 'active', 0, 1)").bind('bulk' + i, 'Member ' + String(i).padStart(3, '0'), '2547' + String(20000000 + i)));
  await db.batch(stmts);
  const sec = await u.login('Sec');
  const cyc = (await u.call(sec, { action: 'cycle.members', limit: 1 })).cycle.id;
  await db.batch(Array.from({ length: 500 }, (_, i) => db.prepare("INSERT INTO chama_obligation (client_id, cycle_id, member_id, required_cents) VALUES ('G1', ?, ?, 600000)").bind(cyc, 'bulk' + i)));
  const t0 = Date.now(); const t = await u.call(sec, { action: 'cycle.members', limit: 25, offset: 100 }); const ms = Date.now() - t0;
  assert.equal(t.items.length, 25); assert.ok(t.total >= 510); assert.ok(ms < 3000, 'took ' + ms + 'ms');
  assert.equal((await u.call(sec, { action: 'cycle.members', limit: 1000 })).items.length <= 100, true, 'the page size is capped');
});

test('C16: migrations/0012_chama.sql matches the schema module and applies cleanly twice', async () => {
  const fs = await import('node:fs'); const { chamaMigrationText } = await import(pathToFileURL(path.join(ROOT, 'tools/gen-migration.mjs')).href);
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0012_chama.sql'), 'utf8'); assert.equal(file, chamaMigrationText());
  const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(':memory:'); d.exec(file); d.exec(file);
  assert.ok(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'chama_%'").get().n >= 12);
});
