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


const bal = async (u, tok) => (await u.call(tok, { action: 'contrib.mine', range: 'all' })).totalCents;

test('D1: the same payment within 2 minutes asks first (maybe_duplicate) and goes through when confirmed with force; other amounts are never blocked', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), sec = await u.login('Sec');
  const a = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid() }); assert.ok(a.ok, JSON.stringify(a));
  const dup = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid() });
  assert.equal(dup.ok, false); assert.equal(dup.code, 'maybe_duplicate'); assert.equal(dup.status, 409); assert.match(dup.error, /second payment/);
  assert.equal(await bal(u, mary), 100000, 'nothing was recorded by the refused attempt');
  const other = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1500, method: 'cash', requestId: rid() }); assert.ok(other.ok, 'a different amount is fine');
  const forced = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid(), force: true }); assert.ok(forced.ok, JSON.stringify(forced));
  assert.equal(await bal(u, mary), 350000);
  const john = await u.call(sec, { action: 'payment.record', memberId: u.people.John.id, amount: 1000, method: 'cash', requestId: rid() }); assert.ok(john.ok, 'another member paying the same amount is fine');
});

test('D2: a retry of the SAME request is still harmless (not an error), and the member\'s own M-Pesa / cash reports are guarded the same way', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), sec = await u.login('Sec');
  const id = rid(); const a = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 700, method: 'cash', requestId: id }); assert.ok(a.ok);
  const again = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 700, method: 'cash', requestId: id }); assert.ok(again.ok); assert.equal(again.already, true);
  const r1 = await u.call(mary, { action: 'report.submit', text: sms('AAA1111111', 300), requestId: rid() }); assert.ok(r1.ok);
  const r2 = await u.call(mary, { action: 'report.submit', text: sms('AAA2222222', 300), requestId: rid() }); assert.equal(r2.code, 'maybe_duplicate');
  const r3 = await u.call(mary, { action: 'report.submit', text: sms('AAA2222222', 300), requestId: rid(), force: true }); assert.ok(r3.ok, JSON.stringify(r3));
  const c1 = await u.call(mary, { action: 'report.submit', method: 'cash', amount: 250, receiverId: u.people.Sec.id, requestId: rid() }); assert.ok(c1.ok, JSON.stringify(c1));
  const c2 = await u.call(mary, { action: 'report.submit', method: 'cash', amount: 250, receiverId: u.people.Sec.id, requestId: rid() }); assert.equal(c2.code, 'maybe_duplicate');
});

test('D3: after 2 minutes the same payment is allowed without asking', async () => {
  const u = await umoja(); const sec = await u.login('Sec');
  await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid() });
  await u.env.LEDGER_DB.prepare("UPDATE chama_report SET reported_at = reported_at - 130000").run();
  const again = await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid() }); assert.ok(again.ok, JSON.stringify(again));
});

test('D4: Undo — only the admin; the duplicate goes, the member total is right, the ledger keeps both rows', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), tre = await u.login('Tre');
  await u.call(tre, { action: 'payment.record', memberId: u.people.Mary.id, amount: 6000, method: 'cash', requestId: rid() });
  await u.call(tre, { action: 'payment.record', memberId: u.people.Mary.id, amount: 6000, method: 'cash', requestId: rid(), force: true });
  assert.equal(await bal(u, mary), 1200000, 'recorded twice: 12,000');
  const led = (await u.call(u.admin, { action: 'ledger.list', memberId: u.people.Mary.id })).items; assert.equal(led.length, 2);
  assert.equal((await u.call(tre, { action: 'ledger.reverse', id: led[0].id, reason: 'twice' })).status, 403, 'the treasurer cannot undo');
  assert.equal((await u.call(mary, { action: 'ledger.reverse', id: led[0].id, reason: 'twice' })).status, 403, 'a member cannot undo');
  const ok = await u.call(u.admin, { action: 'ledger.reverse', id: led[0].id, reason: 'recorded twice' }); assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(await bal(u, mary), 600000, 'back to 6,000');
  const after = (await u.call(u.admin, { action: 'ledger.list', memberId: u.people.Mary.id })).items; assert.equal(after.length, 3, 'the original, the other payment and the correction are all kept');
});

test('D5: Reset test payments — one member, then everyone; admin only; corrections not deletions; loans/expenses untouched; reports cleared; safe to repeat', async () => {
  const u = await umoja(); const mary = await u.login('Mary'), john = await u.login('John'), sec = await u.login('Sec');
  await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 2000, method: 'cash', requestId: rid() });
  await u.call(sec, { action: 'payment.record', memberId: u.people.Mary.id, amount: 1000, method: 'cash', requestId: rid() });
  await u.call(sec, { action: 'payment.record', memberId: u.people.John.id, amount: 3000, method: 'cash', requestId: rid() });
  await pay(u, 'Mary', mary, 'RST0000001', 400);                                    // a waiting report
  await u.env.LEDGER_DB.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, member_id, amount_cents, created_by, idem_key, fund_id) SELECT 'G1','exp1',1,'2026-01-01','expense',NULL,-5000,'x','exp:1', id FROM chama_fund WHERE client_id = 'G1' LIMIT 1").run();
  assert.equal((await u.call(sec, { action: 'payments.reset', memberId: u.people.Mary.id })).status, 403, 'a secretary cannot reset');
  assert.equal((await u.call(mary, { action: 'payments.reset', memberId: u.people.Mary.id })).status, 403);
  const r = await u.call(u.admin, { action: 'payments.reset', memberId: u.people.Mary.id, reason: 'practice' }); assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.reversed, 2); assert.equal(r.amountCents, 300000);
  assert.equal(await bal(u, mary), 0, 'Mary is back to zero'); assert.equal(await bal(u, john), 300000, 'John is untouched');
  const n = async (q) => (await u.env.LEDGER_DB.prepare(q).first()).n;
  assert.equal(await n("SELECT COUNT(*) n FROM chama_ledger WHERE kind = 'contribution' AND reversal_of IS NOT NULL"), 2, 'two corrections, nothing deleted');
  assert.equal(await n("SELECT COUNT(*) n FROM chama_report WHERE status = 'pending'"), 0, 'her waiting report is cleared');
  assert.equal(await n("SELECT COUNT(*) n FROM chama_ledger WHERE kind = 'expense'"), 1, 'expenses untouched');
  const again = await u.call(u.admin, { action: 'payments.reset', memberId: u.people.Mary.id }); assert.ok(again.ok); assert.equal(again.reversed, 0, 'nothing left to reset, nothing doubled');
  assert.equal((await u.call(u.admin, { action: 'payments.reset', all: true })).code, 'confirm_needed', 'resetting everyone needs the word RESET');
  const all = await u.call(u.admin, { action: 'payments.reset', all: true, confirm: 'reset' }); assert.ok(all.ok); assert.equal(all.reversed, 1);
  assert.equal(await bal(u, john), 0);
  const msg = await u.call(john, { action: 'messages.list', limit: 5 }); assert.ok(msg.items.some((m) => /Test payments cleared/.test(m.title)), 'the member is told');
  const aud = await u.env.LEDGER_DB.prepare("SELECT COUNT(*) n FROM chama_audit WHERE action LIKE '%reset%'").first(); assert.ok(aud.n >= 2, 'the audit trail records who reset');
  await assert.rejects(() => u.env.LEDGER_DB.prepare('DELETE FROM chama_ledger').run(), /append-only/);
});
