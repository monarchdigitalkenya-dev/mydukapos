// functions/api/_chama-a.js — Chama (zip 217), part 1 of the actions: setting up, signing in, members and devices, settings, the home screens,
// payment reports (the M-Pesa paste -> verify flow) and the ledger. Every action is { p, fn }: p = 'public' | 'member' | a permission.
import {
  fail, text, toCents, kes, normPhone, showPhone, uid, todayKey, isDate, rows, niceDate, time12, parseMpesa,
  loadGroup, auditStmt, noteStmt, fundFor, ensureCycles, currentCycle, cyclePosition, arrears, totalContributed, allocateContribution, statusOf,
  pinProblem, hashPin, checkPin, openDevice, can, ROLE_PERMS, ALL_PERMS, MAX_FAILS, LOCK_MS, cleanSettings, readSettings, FREQS, addMonths, FUND_NAMES,
} from './_chama-core.js';

const pick = (o, ...k) => k.reduce((a, x) => { a[x] = o[x]; return a; }, {});
export const strOf = (b, k, max) => text(b && b[k], max);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
export async function runBatches(ctx, stmts, size = 50) { for (const part of chunk(stmts, size)) await ctx.db.batch(part); }
const REQ_ID = /^[A-Za-z0-9_-]{8,48}$/;
export const reqId = (b) => (REQ_ID.test(String(b && b.requestId || '')) ? String(b.requestId) : uid());

// ---------- loans (shared by the home screen and the loan actions) ----------
export function loanCalc(loan, repaid, today = todayKey()) {
  const total = loan.principal_cents + loan.interest_cents, months = Math.max(1, loan.months), inst = Math.ceil(total / months);
  const out = { totalDueCents: total, repaidCents: repaid, outstandingCents: Math.max(0, total - repaid), instalmentCents: inst, months, nextDue: null, overdueCents: 0 };
  if (loan.status !== 'active' && loan.status !== 'cleared') return out;
  if (!loan.disburse_date) return out;
  const dates = []; for (let k = 1; k <= months; k++) dates.push(addMonths(loan.disburse_date, k, Number(loan.disburse_date.slice(8, 10))));
  const dueCount = dates.filter((d) => d <= today).length;
  out.overdueCents = Math.max(0, Math.min(total, inst * dueCount) - repaid);
  const nextIdx = dates.findIndex((d) => d >= today);
  if (out.outstandingCents > 0) {
    const k = nextIdx === -1 ? months : nextIdx + 1;
    out.nextDue = { date: dates[k - 1], amountCents: Math.max(0, Math.min(total, inst * k) - repaid) };
  }
  return out;
}
export async function repaidByLoan(ctx, memberId) {
  const r = rows(await ctx.db.prepare(`SELECT ref_id, COALESCE(SUM(amount_cents), 0) AS t FROM chama_ledger WHERE client_id = ? AND kind = 'loan_repayment' ${memberId ? 'AND member_id = ?' : ''} GROUP BY ref_id`).bind(...(memberId ? [ctx.c, memberId] : [ctx.c])).all());
  const m = {}; r.forEach((x) => { m[x.ref_id] = x.t; }); return m;
}
export function loanOut(l, repaid, nameOf) {
  const c = loanCalc(l, repaid || 0);
  const status = l.status === 'active' && c.outstandingCents <= 0 ? 'cleared' : l.status;
  return { id: l.id, memberId: l.member_id, memberName: nameOf ? nameOf(l.member_id) : undefined, principalCents: l.principal_cents, interestCents: l.interest_cents, purpose: l.purpose, loanType: l.loan_type, months: l.months, status, requestedAt: l.requested_at, decisionNote: l.decision_note, disburseDate: l.disburse_date, ...c };
}

// ======================================================================================================================================
export const A = {};

// ---------- the front door ----------
A.status = { p: 'public', fn: async (ctx) => {
  const g = await loadGroup(ctx);
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_member WHERE client_id = ?').bind(ctx.c).first();
  return { hasGroup: !!g, name: g ? g.name : '', setupNeeded: !n || n.n === 0 };
} };

A.setup = { p: 'public', fn: async (ctx) => {
  const b = ctx.body, name = strOf(b, 'groupName', 80), mname = strOf(b, 'name', 80), phone = normPhone(b.phone), pin = String(b.pin || '');
  if (!name) fail('Give your chama a name.');
  if (!mname) fail('Type your name.');
  if (!phone) fail('Type a Kenyan phone number, for example 0712345678.');
  const pp = pinProblem(pin); if (pp) fail(pp);
  const id = uid(), now = Date.now(), hash = await hashPin(pin);
  const settings = readSettings('{}'); settings.contribution.startDate = todayKey();
  await ctx.db.batch([
    ctx.db.prepare('INSERT OR IGNORE INTO chama_group (client_id, name, settings, created_at) VALUES (?,?,?,?)').bind(ctx.c, name, JSON.stringify(settings), now),
    ctx.db.prepare(`INSERT INTO chama_member (client_id, id, name, phone, pin_hash, role, perms, status, must_change_pin, joined_at)
      SELECT ?, ?, ?, ?, ?, 'admin', '[]', 'active', 0, ? WHERE NOT EXISTS (SELECT 1 FROM chama_member WHERE client_id = ?)`).bind(ctx.c, id, mname, phone, hash, now, ctx.c),
  ]);
  const mine = await ctx.db.prepare('SELECT id FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (!mine) fail('This chama is already set up. Ask your admin for your phone number and PIN.', 'already_setup', 409);
  await fundFor(ctx, 'main');
  const dev = await openDevice(ctx, id, true, b.label);
  ctx.me = { id, name: mname, perms: ['*'], role: 'admin' };
  await ctx.db.prepare('INSERT INTO chama_audit (client_id, ts, actor_id, actor_name, action, record, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)').bind(ctx.c, now, id, mname, 'Created the chama "' + name + '"', 'group', null, null).run();
  return { token: dev.token, remember: true };
} };

A.login = { p: 'public', fn: async (ctx) => {
  const b = ctx.body, phone = normPhone(b.phone), pin = String(b.pin || ''), now = Date.now();
  const bad = () => fail('Wrong phone number or PIN.', 'bad_login', 401);
  if (!phone || !pin) bad();
  const m = await ctx.db.prepare('SELECT id, name, pin_hash, status, failed_pins, locked_until, must_change_pin FROM chama_member WHERE client_id = ? AND phone = ?').bind(ctx.c, phone).first();
  if (!m) bad();
  if (m.status !== 'active') fail('This account is switched off. Ask your admin.', 'disabled', 403);
  if (m.locked_until > now) fail(`Too many wrong PINs. Try again in ${Math.ceil((m.locked_until - now) / 60000)} minutes, or ask your admin to reset your PIN.`, 'locked', 429);
  if (!(await checkPin(m.pin_hash, pin))) {
    const fails = m.failed_pins + 1;
    await ctx.db.prepare('UPDATE chama_member SET failed_pins = ?, locked_until = ? WHERE client_id = ? AND id = ?').bind(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now + LOCK_MS : 0, ctx.c, m.id).run();
    bad();
  }
  await ctx.db.prepare('UPDATE chama_member SET failed_pins = 0, locked_until = 0 WHERE client_id = ? AND id = ?').bind(ctx.c, m.id).run();
  const dev = await openDevice(ctx, m.id, b.remember !== false, b.label);
  return { token: dev.token, remember: dev.remember, mustChangePin: !!m.must_change_pin };
} };

A.logout = { p: 'member', fn: async (ctx) => {
  await ctx.db.prepare('UPDATE chama_device SET revoked_at = ? WHERE client_id = ? AND id = ?').bind(Date.now(), ctx.c, ctx.me.deviceId).run();
  return {};
} };

A['pin.change'] = { p: 'member', fn: async (ctx) => {
  const b = ctx.body, np = String(b.newPin || ''), pp = pinProblem(np); if (pp) fail(pp);
  const m = await ctx.db.prepare('SELECT pin_hash FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, ctx.me.id).first();
  if (!(await checkPin(m.pin_hash, String(b.oldPin || '')))) fail('Your current PIN is not right.', 'bad_pin', 403);
  await ctx.db.batch([
    ctx.db.prepare('UPDATE chama_member SET pin_hash = ?, must_change_pin = 0, failed_pins = 0, locked_until = 0 WHERE client_id = ? AND id = ?').bind(await hashPin(np), ctx.c, ctx.me.id),
    ctx.db.prepare('UPDATE chama_device SET revoked_at = ? WHERE client_id = ? AND member_id = ? AND id <> ? AND revoked_at IS NULL').bind(Date.now(), ctx.c, ctx.me.id, ctx.me.deviceId),
    auditStmt(ctx, 'Changed their own PIN', 'member:' + ctx.me.id),
  ]);
  return {};
} };

// ---------- settings (admin) ----------
A['settings.get'] = { p: 'member', fn: async (ctx) => {
  const g = await loadGroup(ctx); const s = g.settings;
  if (!can(ctx.me, '*')) return { settings: { features: s.features, payInstructions: s.payInstructions, privacy: s.privacy } };
  const funds = rows(await ctx.db.prepare('SELECT id, name, kind, active FROM chama_fund WHERE client_id = ? ORDER BY rowid').bind(ctx.c).all());
  return { name: g.name, settings: s, funds, freqs: Object.keys(FREQS) };
} };
A['settings.save'] = { p: '*', fn: async (ctx) => {
  const g = await loadGroup(ctx), b = ctx.body, before = g.settings;
  const next = cleanSettings(b.settings || {}, before);
  const name = strOf(b, 'name', 80) || g.name;
  const stmts = [ctx.db.prepare('UPDATE chama_group SET name = ?, settings = ? WHERE client_id = ?').bind(name, JSON.stringify(next), ctx.c)];
  const diff = [];
  if (name !== g.name) diff.push(`name "${g.name}" -> "${name}"`);
  if (next.contribution.amountCents !== before.contribution.amountCents) diff.push(`contribution requirement ${kes(before.contribution.amountCents)} -> ${kes(next.contribution.amountCents)}`);
  if (next.contribution.freq !== before.contribution.freq || next.contribution.every !== before.contribution.every || next.contribution.unit !== before.contribution.unit) diff.push('contribution period changed');
  for (const k of Object.keys(next.features)) if (next.features[k] !== before.features[k]) diff.push(`${k} ${next.features[k] ? 'turned on' : 'turned off'}`);
  if (JSON.stringify(next.penalties) !== JSON.stringify(before.penalties)) diff.push('penalty rules changed');
  if (JSON.stringify(next.loans) !== JSON.stringify(before.loans)) diff.push('loan rules changed');
  if (JSON.stringify(next.privacy) !== JSON.stringify(before.privacy)) diff.push('privacy settings changed');
  // "apply to the cycle that is running now too"
  if (b.applyToCurrent && next.contribution.amountCents !== before.contribution.amountCents) {
    const cur = await currentCycle(ctx);
    if (cur) stmts.push(ctx.db.prepare('UPDATE chama_cycle SET required_cents = ? WHERE client_id = ? AND id = ?').bind(next.contribution.amountCents, ctx.c, cur.id), ctx.db.prepare('UPDATE chama_obligation SET required_cents = ? WHERE client_id = ? AND cycle_id = ?').bind(next.contribution.amountCents, ctx.c, cur.id));
  }
  stmts.push(auditStmt(ctx, 'Admin changed settings: ' + (diff.join('; ') || 'saved'), 'settings', pick(before, 'contribution', 'features', 'penalties', 'loans', 'privacy'), pick(next, 'contribution', 'features', 'penalties', 'loans', 'privacy')));
  await ctx.db.batch(stmts);
  ctx.group = null; await loadGroup(ctx);
  if (next.features.mgr) await fundFor(ctx, 'mgr');
  if (next.features.loans) await fundFor(ctx, 'loan');
  if (next.features.fundraising) await fundFor(ctx, 'fundraising');
  await ensureCycles(ctx);
  return { settings: ctx.group.settings };
} };

// ---------- funds ----------
A['fund.list'] = { p: 'member', fn: async (ctx) => {
  const funds = rows(await ctx.db.prepare(`SELECT f.id, f.name, f.kind, f.active, COALESCE((SELECT SUM(amount_cents) FROM chama_ledger l WHERE l.client_id = f.client_id AND l.fund_id = f.id), 0) AS balance FROM chama_fund f WHERE f.client_id = ? ORDER BY f.rowid`).bind(ctx.c).all());
  const staff = can(ctx.me, 'money') || can(ctx.me, 'reports');
  return { funds: funds.map((f) => ({ id: f.id, name: f.name, kind: f.kind, active: !!f.active, ...(staff ? { balanceCents: f.balance } : {}) })) };
} };
A['fund.save'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, name = strOf(b, 'name', 60), kind = Object.keys(FUND_NAMES).includes(b.kind) ? b.kind : 'other';
  if (!name) fail('Give the fund a name.');
  if (b.id) {
    await ctx.db.batch([ctx.db.prepare('UPDATE chama_fund SET name = ?, active = ? WHERE client_id = ? AND id = ?').bind(name, b.active === false ? 0 : 1, ctx.c, String(b.id)), auditStmt(ctx, `Edited fund "${name}"`, 'fund:' + b.id)]);
    return { id: b.id };
  }
  const id = uid();
  await ctx.db.batch([ctx.db.prepare('INSERT INTO chama_fund (client_id, id, name, kind, active) VALUES (?,?,?,?,1)').bind(ctx.c, id, name, kind), auditStmt(ctx, `Created fund "${name}"`, 'fund:' + id)]);
  return { id };
} };

// ---------- members ----------
const memberOut = (r) => ({ id: r.id, name: r.name, phone: showPhone(r.phone), role: r.role, perms: r.role === 'admin' ? ['*'] : JSON.parse(r.perms || '[]'), status: r.status, mustChangePin: !!r.must_change_pin, joinedAt: r.joined_at });
A['members.list'] = { p: 'members', fn: async (ctx) => {
  const r = rows(await ctx.db.prepare('SELECT id, name, phone, role, perms, status, must_change_pin, joined_at FROM chama_member WHERE client_id = ? ORDER BY name').bind(ctx.c).all());
  return { members: r.map(memberOut), allPerms: ALL_PERMS, rolePerms: ROLE_PERMS };
} };
// a short list of names for pickers (guarantors, assignees): names only, for any signed-in member
A['members.names'] = { p: 'member', fn: async (ctx) => ({ members: rows(await ctx.db.prepare("SELECT id, name FROM chama_member WHERE client_id = ? AND status = 'active' ORDER BY name").bind(ctx.c).all()) }) };

function tempPin() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(1000 + (a[0] % 9000)); }
A['members.add'] = { p: 'members', fn: async (ctx) => {
  const b = ctx.body, name = strOf(b, 'name', 80), phone = normPhone(b.phone), role = ['admin', 'secretary', 'treasurer', 'member'].includes(b.role) ? b.role : 'member';
  if (!name) fail('Type the member\'s name.');
  if (!phone) fail('Type a Kenyan phone number, for example 0712345678.');
  if (role !== 'member' && !can(ctx.me, '*')) fail('Only the admin can give a role.', 'forbidden', 403);
  const pin = b.pin ? String(b.pin) : tempPin(); const pp = pinProblem(pin); if (pp) fail(pp);
  const id = uid(), now = Date.now(), perms = JSON.stringify(ROLE_PERMS[role].filter((x) => x !== '*'));
  const dup = await ctx.db.prepare('SELECT name FROM chama_member WHERE client_id = ? AND phone = ?').bind(ctx.c, phone).first();
  if (dup) fail(`${dup.name} already uses that phone number.`, 'duplicate', 409);
  const stmts = [ctx.db.prepare("INSERT INTO chama_member (client_id, id, name, phone, pin_hash, role, perms, status, must_change_pin, joined_at) VALUES (?,?,?,?,?,?,?, 'active', 1, ?)").bind(ctx.c, id, name, phone, await hashPin(pin), role, perms, now)];
  const cur = await currentCycle(ctx);   // the new member owes for the period that is running now
  if (cur) stmts.push(ctx.db.prepare('INSERT OR IGNORE INTO chama_obligation (client_id, cycle_id, member_id, required_cents) VALUES (?,?,?,?)').bind(ctx.c, cur.id, id, cur.required_cents));
  stmts.push(noteStmt(ctx, id, 'welcome', `Welcome, ${name.split(' ')[0]} 👋`, 'You have been added to the chama. Open Report payment whenever you pay.'), auditStmt(ctx, `Added member ${name}`, 'member:' + id));
  await ctx.db.batch(stmts);
  return { id, pin, note: 'Give the member this PIN. They will be asked to choose their own the first time they sign in.' };
} };
async function memberById(ctx, id) { const m = await ctx.db.prepare('SELECT id, name, phone, role, perms, status, must_change_pin, joined_at FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, String(id || '')).first(); if (!m) fail('That member was not found.', 'not_found', 404); return m; }
async function otherAdmins(ctx, id) { const r = await ctx.db.prepare("SELECT COUNT(*) AS n FROM chama_member WHERE client_id = ? AND role = 'admin' AND status = 'active' AND id <> ?").bind(ctx.c, id).first(); return r ? r.n : 0; }
A['members.update'] = { p: 'members', fn: async (ctx) => {
  const b = ctx.body, m = await memberById(ctx, b.id), isAdmin = can(ctx.me, '*');
  const name = b.name !== undefined ? strOf(b, 'name', 80) : m.name;
  const phone = b.phone !== undefined ? normPhone(b.phone) : m.phone;
  if (!name || !phone) fail('A member needs a name and a valid phone number.');
  let role = m.role, perms = m.perms, status = m.status;
  if ((b.role !== undefined && b.role !== m.role) || b.perms !== undefined || (b.status !== undefined && b.status !== m.status)) { if (!isAdmin) fail('Only the admin can change roles, permissions or switch a member off.', 'forbidden', 403); }
  if (b.role !== undefined && ['admin', 'secretary', 'treasurer', 'member'].includes(b.role)) { role = b.role; if (role !== m.role) perms = JSON.stringify(ROLE_PERMS[role].filter((x) => x !== '*')); }
  if (Array.isArray(b.perms) && role !== 'admin') perms = JSON.stringify(b.perms.filter((x) => ALL_PERMS.includes(x)));
  if (b.status === 'active' || b.status === 'disabled') status = b.status;
  if ((m.role === 'admin' && (role !== 'admin' || status !== 'active')) && !(await otherAdmins(ctx, m.id))) fail('There must always be one active admin.', 'last_admin', 409);
  if (phone !== m.phone) { const dup = await ctx.db.prepare('SELECT name FROM chama_member WHERE client_id = ? AND phone = ? AND id <> ?').bind(ctx.c, phone, m.id).first(); if (dup) fail(`${dup.name} already uses that phone number.`, 'duplicate', 409); }
  const stmts = [ctx.db.prepare('UPDATE chama_member SET name = ?, phone = ?, role = ?, perms = ?, status = ? WHERE client_id = ? AND id = ?').bind(name, phone, role, perms, status, ctx.c, m.id)];
  if (status === 'disabled' && m.status !== 'disabled') stmts.push(ctx.db.prepare('UPDATE chama_device SET revoked_at = ? WHERE client_id = ? AND member_id = ? AND revoked_at IS NULL').bind(Date.now(), ctx.c, m.id));
  stmts.push(auditStmt(ctx, `Updated member ${name}${status !== m.status ? ' (' + status + ')' : ''}${role !== m.role ? ' (role ' + m.role + ' -> ' + role + ')' : ''}`, 'member:' + m.id, memberOut(m), { name, phone: showPhone(phone), role, status }));
  await ctx.db.batch(stmts);
  return {};
} };
A['members.resetPin'] = { p: 'members', fn: async (ctx) => {
  const m = await memberById(ctx, ctx.body.id);
  if (m.role === 'admin' && !can(ctx.me, '*')) fail('Only the admin can reset an admin\'s PIN.', 'forbidden', 403);
  const pin = tempPin();
  await ctx.db.batch([
    ctx.db.prepare('UPDATE chama_member SET pin_hash = ?, must_change_pin = 1, failed_pins = 0, locked_until = 0 WHERE client_id = ? AND id = ?').bind(await hashPin(pin), ctx.c, m.id),
    ctx.db.prepare('UPDATE chama_device SET revoked_at = ? WHERE client_id = ? AND member_id = ? AND revoked_at IS NULL').bind(Date.now(), ctx.c, m.id),
    auditStmt(ctx, `Reset the PIN of ${m.name}`, 'member:' + m.id),
  ]);
  return { pin, note: 'Give the member this new PIN. All their remembered devices were signed out.' };
} };
A['devices.list'] = { p: 'members', fn: async (ctx) => ({ devices: rows(await ctx.db.prepare('SELECT id, label, created_at, last_seen, expires_at, revoked_at FROM chama_device WHERE client_id = ? AND member_id = ? ORDER BY created_at DESC LIMIT 20').bind(ctx.c, String(ctx.body.memberId || '')).all()).map((d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastSeen: d.last_seen, active: !d.revoked_at && d.expires_at > Date.now() })) }) };
A['devices.revoke'] = { p: 'members', fn: async (ctx) => {
  const d = await ctx.db.prepare('SELECT d.id, m.name FROM chama_device d JOIN chama_member m ON m.client_id = d.client_id AND m.id = d.member_id WHERE d.client_id = ? AND d.id = ?').bind(ctx.c, String(ctx.body.id || '')).first();
  if (!d) fail('That device was not found.', 'not_found', 404);
  await ctx.db.batch([ctx.db.prepare('UPDATE chama_device SET revoked_at = ? WHERE client_id = ? AND id = ?').bind(Date.now(), ctx.c, d.id), auditStmt(ctx, `Signed out a remembered device of ${d.name}`, 'device:' + d.id)]);
  return {};
} };

// ---------- payment reports: paste -> detect -> submit -> verify ----------
const KIND_TEXT = { contribution: 'contribution', loan: 'loan repayment', fundraiser: 'fundraiser contribution', penalty: 'penalty payment', mgr: 'merry-go-round contribution' };
async function liveDuplicate(ctx, code) { return code ? await ctx.db.prepare("SELECT id FROM chama_report WHERE client_id = ? AND mpesa_code = ? AND status IN ('pending','verified')").bind(ctx.c, code).first() : null; }
const DUP_MSG = 'This M-Pesa transaction has already been reported.';

A['report.parse'] = { p: 'member', fn: async (ctx) => {
  const p = parseMpesa(ctx.body.text);
  if (!p.ok) return { ok: false, error: p.error };
  const dup = await liveDuplicate(ctx, p.code);
  return { ok: true, code: p.code, amountCents: p.amountCents, date: p.date, time: p.time, dateText: p.date ? niceDate(p.date, true) : '', timeText: time12(p.time), recipient: p.recipient, duplicate: !!dup, duplicateMessage: dup ? DUP_MSG : '' };
} };

async function targetCheck(ctx, kind, targetId, memberId) {
  const g = await loadGroup(ctx), f = g.settings.features;
  if (kind === 'contribution') return null;
  if (kind === 'loan') { if (!f.loans) fail('Loans are not switched on for this chama.'); const l = await ctx.db.prepare('SELECT id, status FROM chama_loan WHERE client_id = ? AND id = ? AND member_id = ?').bind(ctx.c, String(targetId || ''), memberId).first(); if (!l || !['active'].includes(l.status)) fail('Pick the loan you are repaying.'); return l.id; }
  if (kind === 'fundraiser') { const x = await ctx.db.prepare("SELECT id FROM chama_fundraiser WHERE client_id = ? AND id = ? AND status = 'active'").bind(ctx.c, String(targetId || '')).first(); if (!x) fail('Pick a fundraiser that is still open.'); return x.id; }
  if (kind === 'penalty') return targetId ? String(targetId) : null;
  if (kind === 'mgr') { if (!f.mgr) fail('The merry-go-round is not switched on.'); const t = targetId ? await ctx.db.prepare("SELECT id FROM chama_mgr_turn WHERE client_id = ? AND id = ? AND status = 'open'").bind(ctx.c, String(targetId)).first() : await ctx.db.prepare("SELECT t.id FROM chama_mgr_turn t JOIN chama_mgr g ON g.client_id = t.client_id AND g.id = t.mgr_id WHERE t.client_id = ? AND t.status = 'open' AND g.status = 'active' ORDER BY t.seq LIMIT 1").bind(ctx.c).first(); if (!t) fail('There is no open turn to pay into.'); return t.id; }
  fail('Choose what this payment is for.');
}

A['report.submit'] = { p: 'member', fn: async (ctx) => {
  const b = ctx.body, p = parseMpesa(b.text);
  if (!p.ok) fail(p.error);
  const kind = KIND_TEXT[b.kind] ? b.kind : 'contribution';
  const target = await targetCheck(ctx, kind, b.targetId, ctx.me.id);
  const id = reqId(b);
  const existing = await ctx.db.prepare('SELECT id, status FROM chama_report WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (existing) return { id, already: true };
  if (await liveDuplicate(ctx, p.code)) fail(DUP_MSG, 'duplicate_mpesa', 409);
  const g = await loadGroup(ctx);
  const anon = kind === 'fundraiser' && b.anonymous ? 1 : 0;
  try {
    await ctx.db.prepare('INSERT INTO chama_report (client_id, id, member_id, kind, target_id, amount_cents, method, mpesa_code, tx_date, tx_time, recipient, anonymous, source, status, reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(ctx.c, id, ctx.me.id, kind, target, p.amountCents, 'mpesa', p.code, p.date || null, p.time || null, p.recipient || null, anon && g.settings.features.fundraising ? 1 : 0, 'member', 'pending', Date.now()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) { if (await liveDuplicate(ctx, p.code)) fail(DUP_MSG, 'duplicate_mpesa', 409); return { id, already: true }; }
    throw e;
  }
  return { id, amountCents: p.amountCents, code: p.code };
} };

A['report.mine'] = { p: 'member', fn: async (ctx) => ({ reports: rows(await ctx.db.prepare('SELECT id, kind, amount_cents, mpesa_code, tx_date, tx_time, status, reported_at, note FROM chama_report WHERE client_id = ? AND member_id = ? ORDER BY reported_at DESC LIMIT 30').bind(ctx.c, ctx.me.id).all()).map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amount_cents, code: r.mpesa_code, date: r.tx_date, time: time12(r.tx_time), status: r.status, reportedAt: r.reported_at, note: r.status === 'rejected' ? r.note : undefined })) }) };

// what the secretary sees: the member, amount, code, date and status — never the SMS, a balance, a limit or a link
A['report.inbox'] = { p: 'payments', fn: async (ctx) => {
  const b = ctx.body, status = ['pending', 'verified', 'rejected'].includes(b.status) ? b.status : 'pending', off = Math.max(0, Number(b.offset) || 0), lim = Math.min(50, Math.max(1, Number(b.limit) || 25));
  const g = await loadGroup(ctx), hint = (g.settings.paymentTo || '').toLowerCase();
  const total = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_report WHERE client_id = ? AND status = ?').bind(ctx.c, status).first();
  const r = rows(await ctx.db.prepare(`SELECT r.id, r.kind, r.target_id, r.amount_cents, r.mpesa_code, r.tx_date, r.tx_time, r.recipient, r.status, r.reported_at, r.source, r.anonymous, m.name FROM chama_report r JOIN chama_member m ON m.client_id = r.client_id AND m.id = r.member_id
    WHERE r.client_id = ? AND r.status = ? ORDER BY r.reported_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).bind(ctx.c, status, lim, off).all());
  return { total: total.n, items: r.map((x) => ({ id: x.id, memberName: x.name, kind: x.kind, kindText: KIND_TEXT[x.kind], amountCents: x.amount_cents, code: x.mpesa_code, date: x.tx_date, dateText: x.tx_date ? niceDate(x.tx_date, true) : '', timeText: time12(x.tx_time), status: x.status, reportedAt: x.reported_at, source: x.source, recipientMismatch: !!(hint && x.recipient && !x.recipient.toLowerCase().includes(hint)) })) };
} };

// the ledger parts a verified report turns into: [{ kind, fundId, refType, refId, cents }]
async function partsFor(ctx, r) {
  const parts = [];
  if (r.kind === 'contribution') {
    for (const a of await allocateContribution(ctx, r.member_id, r.amount_cents)) {
      let fund = null; if (a.cycleId) { const cy = await ctx.db.prepare('SELECT fund_id FROM chama_cycle WHERE client_id = ? AND id = ?').bind(ctx.c, a.cycleId).first(); fund = cy && cy.fund_id; }
      parts.push({ kind: 'contribution', fundId: fund || await fundFor(ctx, 'main'), refType: a.cycleId ? 'cycle' : 'general', refId: a.cycleId, cents: a.cents });
    }
  } else if (r.kind === 'loan') {
    const l = await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND id = ? AND status = 'active'").bind(ctx.c, r.target_id).first();
    if (!l) fail('That loan is not active, so a repayment cannot be added to it.', 'bad_target', 409);
    const rep = (await repaidByLoan(ctx, null))[l.id] || 0, out = l.principal_cents + l.interest_cents - rep;
    if (r.amount_cents > out) fail(`This is ${kes(r.amount_cents - out)} more than the loan balance (${kes(out)}). Reject it, or record the correct amount.`, 'over_balance', 409);
    parts.push({ kind: 'loan_repayment', fundId: await fundFor(ctx, 'loan'), refType: 'loan', refId: l.id, cents: r.amount_cents });
  } else if (r.kind === 'fundraiser') {
    parts.push({ kind: 'fundraising', fundId: await fundFor(ctx, 'fundraising'), refType: 'fundraiser', refId: r.target_id, cents: r.amount_cents });
  } else if (r.kind === 'penalty') {
    const open = rows(await ctx.db.prepare(`SELECT p.id, p.amount_cents - COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0) AS rem FROM chama_penalty p WHERE p.client_id = ? AND p.member_id = ? AND p.status = 'open' ${r.target_id ? 'AND p.id = ?' : ''} ORDER BY p.created_at`).bind(...(r.target_id ? [ctx.c, r.member_id, r.target_id] : [ctx.c, r.member_id])).all()).filter((x) => x.rem > 0);
    let left = r.amount_cents;
    for (const p of open) { if (left <= 0) break; const take = Math.min(left, p.rem); parts.push({ kind: 'penalty', fundId: null, refType: 'penalty', refId: p.id, cents: take }); left -= take; }
    if (left > 0) fail(`This is ${kes(left)} more than the penalties owed. Reject it, or record the correct amount.`, 'over_balance', 409);
    const fid = await fundFor(ctx, 'main'); parts.forEach((x) => { x.fundId = fid; });
  } else if (r.kind === 'mgr') {
    const t = await ctx.db.prepare("SELECT id FROM chama_mgr_turn WHERE client_id = ? AND id = ? AND status = 'open'").bind(ctx.c, r.target_id).first();
    if (!t) fail('That merry-go-round turn is already closed.', 'bad_target', 409);
    parts.push({ kind: 'mgr_contribution', fundId: await fundFor(ctx, 'mgr'), refType: 'mgr_turn', refId: t.id, cents: r.amount_cents });
  }
  return parts;
}
const ledgerInsert = (ctx, id, p, r, i, who, by) => ctx.db.prepare(`INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, report_id, method, reference, note, created_by, idem_key)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM chama_report WHERE client_id = ? AND id = ? AND status = 'pending')`)
  .bind(ctx.c, uid(), Date.now(), r.tx_date || todayKey(), p.kind, p.fundId, r.member_id, p.cents, p.refType, p.refId || null, id, r.method, r.mpesa_code || null, r.note || null, by, `rep:${id}:${i}`, ctx.c, id);
const DONE = { contribution: (c) => `✅ Payment confirmed — ${c} has been added to your contribution.`, loan_repayment: (c) => `✅ Payment confirmed — ${c} was added to your loan repayment.`, fundraising: (c) => `✅ Thank you — your ${c} fundraiser contribution was confirmed.`, penalty: (c) => `✅ Payment confirmed — ${c} was paid towards your penalty.`, mgr_contribution: (c) => `✅ Payment confirmed — ${c} was added to the merry-go-round.` };

export async function verifyReport(ctx, id) {
  const r = await ctx.db.prepare('SELECT * FROM chama_report WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (!r) fail('That payment report was not found.', 'not_found', 404);
  if (r.status !== 'pending') fail(r.status === 'verified' ? 'This payment was already verified.' : 'This payment report was already handled.', 'already_done', 409);
  if (r.member_id === ctx.me.id && !can(ctx.me, '*') && r.source === 'member') { /* a treasurer confirming their own payment is allowed: the audit trail shows who did it */ }
  await ensureCycles(ctx);
  const parts = await partsFor(ctx, r);
  if (!parts.length) fail('Nothing to add for this payment.', 'bad_target', 409);
  const stmts = parts.map((p, i) => ledgerInsert(ctx, id, p, r, i, null, ctx.me.id));
  stmts.push(ctx.db.prepare("UPDATE chama_report SET status = 'verified', reviewed_by = ?, reviewed_at = ? WHERE client_id = ? AND id = ? AND status = 'pending'").bind(ctx.me.id, Date.now(), ctx.c, id));
  const who = await ctx.db.prepare('SELECT name FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, r.member_id).first();
  const total = r.amount_cents;
  stmts.push(noteStmt(ctx, r.member_id, 'payment', 'Payment confirmed', (DONE[parts[0].kind] || DONE.contribution)(kes(total))));
  stmts.push(auditStmt(ctx, `${ctx.me.name} verified ${kes(total)} ${KIND_TEXT[r.kind]} for ${who ? who.name : r.member_id}${r.mpesa_code ? ' (' + r.mpesa_code + ')' : ''}`, 'report:' + id, { status: 'pending' }, { status: 'verified', parts: parts.length }));
  await ctx.db.batch(stmts);
  const after = await ctx.db.prepare('SELECT status FROM chama_report WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_ledger WHERE client_id = ? AND report_id = ?').bind(ctx.c, id).first();
  if (!after || after.status !== 'verified' || n.n < parts.length) fail('Someone else just handled this payment. Refresh the list.', 'already_done', 409);
  if (r.kind === 'loan') { const l = await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND id = ?").bind(ctx.c, r.target_id).first(); const rep = (await repaidByLoan(ctx, null))[r.target_id] || 0; if (l && rep >= l.principal_cents + l.interest_cents) await ctx.db.prepare("UPDATE chama_loan SET status = 'cleared' WHERE client_id = ? AND id = ? AND status = 'active'").bind(ctx.c, l.id).run(); }
  return { id, amountCents: total, parts: parts.map((p) => ({ cents: p.cents, cycleId: p.refType === 'cycle' ? p.refId : null })) };
}
A['report.verify'] = { p: 'payments', fn: async (ctx) => verifyReport(ctx, String(ctx.body.id || '')) };
A['report.reject'] = { p: 'payments', fn: async (ctx) => {
  const id = String(ctx.body.id || ''), reason = strOf(ctx.body, 'reason', 200);
  const r = await ctx.db.prepare("SELECT member_id, amount_cents, mpesa_code, kind FROM chama_report WHERE client_id = ? AND id = ? AND status = 'pending'").bind(ctx.c, id).first();
  if (!r) fail('That payment report is not waiting any more.', 'already_done', 409);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE chama_report SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, note = ? WHERE client_id = ? AND id = ? AND status = 'pending'").bind(ctx.me.id, Date.now(), reason || null, ctx.c, id),
    noteStmt(ctx, r.member_id, 'payment', 'Payment not confirmed', `Your ${kes(r.amount_cents)} report${r.mpesa_code ? ' (' + r.mpesa_code + ')' : ''} was not confirmed.${reason ? ' Reason: ' + reason : ''} Please speak to the treasurer.`),
    auditStmt(ctx, `${ctx.me.name} rejected ${kes(r.amount_cents)} ${r.mpesa_code || ''}`, 'report:' + id, { status: 'pending' }, { status: 'rejected', reason }),
  ]);
  return {};
} };

// the treasurer records money that arrived another way (cash at the meeting, a bank transfer, an M-Pesa already seen)
A['payment.record'] = { p: 'payments', fn: async (ctx) => {
  const b = ctx.body, memberId = String(b.memberId || ''), kind = KIND_TEXT[b.kind] ? b.kind : 'contribution', cents = toCents(b.amount);
  if (!isFinite(cents) || cents <= 0) fail('Type the amount.');
  await memberById(ctx, memberId);
  const target = await targetCheck(ctx, kind, b.targetId, memberId);
  const method = ['cash', 'mpesa', 'bank', 'other'].includes(b.method) ? b.method : 'cash';
  let code = null;
  if (b.code) { code = String(b.code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20); if (code && await liveDuplicate(ctx, code)) fail(DUP_MSG, 'duplicate_mpesa', 409); }
  const id = reqId(b);
  const have = await ctx.db.prepare('SELECT status FROM chama_report WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (have) return { id, already: true };
  const date = isDate(b.date) ? b.date : todayKey();
  try {
    await ctx.db.prepare('INSERT INTO chama_report (client_id, id, member_id, kind, target_id, amount_cents, method, mpesa_code, tx_date, source, status, reported_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(ctx.c, id, memberId, kind, target, cents, method, code || null, date, 'staff', 'pending', Date.now(), strOf(b, 'note', 200) || null).run();
  } catch (e) { if (/UNIQUE/i.test(String(e && e.message))) fail(DUP_MSG, 'duplicate_mpesa', 409); throw e; }
  try { return await verifyReport(ctx, id); }
  catch (e) { await ctx.db.prepare("UPDATE chama_report SET status = 'rejected', note = ? WHERE client_id = ? AND id = ? AND status = 'pending'").bind('Not recorded: ' + (e.error || e.message), ctx.c, id).run(); throw e; }
} };

// ---------- contributions: positions, history, statements ----------
A['cycle.list'] = { p: 'reports', fn: async (ctx) => {
  await ensureCycles(ctx);
  const r = rows(await ctx.db.prepare(`SELECT cy.id, cy.label, cy.start_date, cy.end_date, cy.required_cents,
      COALESCE((SELECT SUM(o.required_cents) FROM chama_obligation o WHERE o.client_id = cy.client_id AND o.cycle_id = cy.id), 0) AS expected,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = cy.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = cy.id), 0) AS collected
      FROM chama_cycle cy WHERE cy.client_id = ? ORDER BY cy.start_date DESC LIMIT 36`).bind(ctx.c).all());
  const cur = await currentCycle(ctx);
  return { currentId: cur ? cur.id : null, cycles: r.map((c) => ({ id: c.id, label: c.label, start: c.start_date, end: c.end_date, requiredCents: c.required_cents, expectedCents: c.expected, collectedCents: c.collected })) };
} };
A['cycle.members'] = { p: 'reports', fn: async (ctx) => {
  await ensureCycles(ctx);
  const b = ctx.body; let cycleId = String(b.cycleId || ''); if (!cycleId) { const c = await currentCycle(ctx); cycleId = c ? c.id : ''; }
  if (!cycleId) return { cycle: null, items: [], total: 0 };
  const cy = await ctx.db.prepare('SELECT id, label, start_date, end_date, required_cents FROM chama_cycle WHERE client_id = ? AND id = ?').bind(ctx.c, cycleId).first();
  if (!cy) fail('That period was not found.', 'not_found', 404);
  const off = Math.max(0, Number(b.offset) || 0), lim = Math.min(100, Math.max(1, Number(b.limit) || 50)), only = ['partial', 'not_started', 'complete'].includes(b.only) ? b.only : '';
  const base = `FROM (SELECT o.member_id, m.name, o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid
      FROM chama_obligation o JOIN chama_member m ON m.client_id = o.client_id AND m.id = o.member_id WHERE o.client_id = ? AND o.cycle_id = ? AND m.status = 'active') x`;
  const cond = only === 'complete' ? 'WHERE x.paid >= x.req' : only === 'partial' ? 'WHERE x.paid > 0 AND x.paid < x.req' : only === 'not_started' ? 'WHERE x.paid <= 0 AND x.req > 0' : '';
  const tot = await ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(x.req),0) AS req, COALESCE(SUM(x.paid),0) AS paid, COALESCE(SUM(MAX(x.req - x.paid, 0)),0) AS owed ${base} ${cond}`).bind(ctx.c, cycleId).first();
  const r = rows(await ctx.db.prepare(`SELECT x.member_id, x.name, x.req, x.paid ${base} ${cond} ORDER BY x.name LIMIT ? OFFSET ?`).bind(ctx.c, cycleId, lim, off).all());
  return { cycle: { id: cy.id, label: cy.label, start: cy.start_date, end: cy.end_date, requiredCents: cy.required_cents }, total: tot.n, sumRequiredCents: tot.req, sumPaidCents: tot.paid, sumOwedCents: tot.owed, items: r.map((x) => ({ memberId: x.member_id, name: x.name, requiredCents: x.req, paidCents: x.paid, remainingCents: Math.max(0, x.req - x.paid), status: statusOf(x.req, x.paid) })) };
} };
A['obligation.set'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, cents = toCents(b.amount);
  if (!isFinite(cents) || cents < 0) fail('Type the amount this member owes for the period (0 to excuse them).');
  const o = await ctx.db.prepare('SELECT o.required_cents, m.name FROM chama_obligation o JOIN chama_member m ON m.client_id = o.client_id AND m.id = o.member_id WHERE o.client_id = ? AND o.cycle_id = ? AND o.member_id = ?').bind(ctx.c, String(b.cycleId || ''), String(b.memberId || '')).first();
  if (!o) fail('That member does not owe for that period.', 'not_found', 404);
  await ctx.db.batch([ctx.db.prepare('UPDATE chama_obligation SET required_cents = ? WHERE client_id = ? AND cycle_id = ? AND member_id = ?').bind(cents, ctx.c, String(b.cycleId), String(b.memberId)), auditStmt(ctx, `${ctx.me.name} changed ${o.name}'s requirement for a period from ${kes(o.required_cents)} to ${kes(cents)}`, 'obligation:' + b.cycleId + ':' + b.memberId)]);
  return {};
} };

// my contributions, filtered
A['contrib.mine'] = { p: 'member', fn: async (ctx) => {
  await ensureCycles(ctx);
  const b = ctx.body, range = ['cycle', 'last', 'year', 'all'].includes(b.range) ? b.range : 'cycle', off = Math.max(0, Number(b.offset) || 0), lim = Math.min(100, Math.max(1, Number(b.limit) || 30));
  const today = todayKey(); let where = '', args = [];
  if (range === 'cycle') { const c = await currentCycle(ctx); where = c ? "AND l.ref_type = 'cycle' AND l.ref_id = ?" : "AND 1 = 0"; if (c) args.push(c.id); }
  else if (range === 'last') { const c = await ctx.db.prepare('SELECT id FROM chama_cycle WHERE client_id = ? AND end_date < ? ORDER BY end_date DESC LIMIT 1').bind(ctx.c, today).first(); where = c ? "AND l.ref_type = 'cycle' AND l.ref_id = ?" : "AND 1 = 0"; if (c) args.push(c.id); }
  else if (range === 'year') { where = 'AND l.entry_date >= ?'; args.push(today.slice(0, 4) + '-01-01'); }
  const sum = await ctx.db.prepare(`SELECT COALESCE(SUM(l.amount_cents), 0) AS t FROM chama_ledger l WHERE l.client_id = ? AND l.member_id = ? AND l.kind = 'contribution' ${where}`).bind(ctx.c, ctx.me.id, ...args).first();
  const r = rows(await ctx.db.prepare(`SELECT l.entry_date, l.amount_cents, l.reference, l.reversal_of FROM chama_ledger l WHERE l.client_id = ? AND l.member_id = ? AND l.kind = 'contribution' ${where} ORDER BY l.ts DESC LIMIT ? OFFSET ?`).bind(ctx.c, ctx.me.id, ...args, lim, off).all());
  return { range, totalCents: sum.t, items: r.map((x) => ({ date: x.entry_date, dateText: niceDate(x.entry_date, true), amountCents: x.amount_cents, type: x.reversal_of ? 'Reversal' : 'Contribution', reference: x.reference || '' })) };
} };

// ---------- the ledger ----------
async function ledgerView(ctx, rowsIn) {
  const names = {}; rows(await ctx.db.prepare('SELECT id, name FROM chama_member WHERE client_id = ?').bind(ctx.c).all()).forEach((m) => { names[m.id] = m.name; });
  return rowsIn.map((x) => ({ id: x.id, ts: x.ts, date: x.entry_date, dateText: niceDate(x.entry_date, true), kind: x.kind, fundId: x.fund_id, memberName: x.member_id ? names[x.member_id] || '' : '', amountCents: x.amount_cents, refType: x.ref_type, reference: x.reference || '', note: x.note || '', method: x.method || '', reversalOf: x.reversal_of || null, reversed: !!x.reversed }));
}
A['ledger.list'] = { p: 'reports', fn: async (ctx) => {
  const b = ctx.body, off = Math.max(0, Number(b.offset) || 0), lim = Math.min(100, Math.max(1, Number(b.limit) || 30));
  const where = ['l.client_id = ?'], args = [ctx.c];
  if (b.kind) { where.push('l.kind = ?'); args.push(String(b.kind)); }
  if (b.memberId) { where.push('l.member_id = ?'); args.push(String(b.memberId)); }
  if (isDate(b.from)) { where.push('l.entry_date >= ?'); args.push(b.from); }
  if (isDate(b.to)) { where.push('l.entry_date <= ?'); args.push(b.to); }
  const n = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM chama_ledger l WHERE ${where.join(' AND ')}`).bind(...args).first();
  const r = rows(await ctx.db.prepare(`SELECT l.*, EXISTS (SELECT 1 FROM chama_ledger z WHERE z.client_id = l.client_id AND z.reversal_of = l.id) AS reversed FROM chama_ledger l WHERE ${where.join(' AND ')} ORDER BY l.ts DESC, l.rowid DESC LIMIT ? OFFSET ?`).bind(...args, lim, off).all());
  return { total: n.n, items: await ledgerView(ctx, r) };
} };
A['expense.add'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, cents = toCents(b.amount), desc = strOf(b, 'description', 200);
  if (!isFinite(cents) || cents <= 0) fail('Type the amount spent.');
  if (!desc) fail('Say what the money was spent on.');
  const fundId = b.fundId ? String(b.fundId) : await fundFor(ctx, 'main');
  const f = await ctx.db.prepare('SELECT id FROM chama_fund WHERE client_id = ? AND id = ?').bind(ctx.c, fundId).first(); if (!f) fail('Pick the fund the money came from.');
  const id = reqId(b), date = isDate(b.date) ? b.date : todayKey();
  const have = await ctx.db.prepare('SELECT id FROM chama_ledger WHERE client_id = ? AND idem_key = ?').bind(ctx.c, 'exp:' + id).first(); if (have) return { already: true };
  await ctx.db.batch([ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, method, reference, note, created_by, idem_key) VALUES (?,?,?,?, 'expense', ?, NULL, ?, 'expense', ?, ?, ?, ?, ?)").bind(ctx.c, uid(), Date.now(), date, fundId, -cents, strOf(b, 'method', 20) || null, strOf(b, 'reference', 60) || null, desc, ctx.me.id, 'exp:' + id), auditStmt(ctx, `${ctx.me.name} recorded an expense of ${kes(cents)}: ${desc}`, 'expense')]);
  return {};
} };
A['ledger.reverse'] = { p: 'money', fn: async (ctx) => {
  const id = String(ctx.body.id || ''), reason = strOf(ctx.body, 'reason', 200);
  if (!reason) fail('Say why this entry is being reversed.');
  const o = await ctx.db.prepare('SELECT * FROM chama_ledger WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (!o) fail('That entry was not found.', 'not_found', 404);
  if (o.reversal_of) fail('A reversal cannot itself be reversed. Record a new entry instead.', 'bad_request', 409);
  const dup = await ctx.db.prepare('SELECT id FROM chama_ledger WHERE client_id = ? AND reversal_of = ?').bind(ctx.c, id).first(); if (dup) fail('This entry was already reversed.', 'already_done', 409);
  const stmts = [ctx.db.prepare(`INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, report_id, method, reference, note, created_by, reversal_of, idem_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ctx.c, uid(), Date.now(), todayKey(), o.kind, o.fund_id, o.member_id, -o.amount_cents, o.ref_type, o.ref_id, o.report_id, o.method, o.reference, 'REVERSAL: ' + reason, ctx.me.id, id, 'rev:' + id)];
  stmts.push(auditStmt(ctx, `${ctx.me.name} reversed a ${o.kind} of ${kes(Math.abs(o.amount_cents))}: ${reason}`, 'ledger:' + id, { amountCents: o.amount_cents }, { reversal: -o.amount_cents }));
  if (o.member_id) stmts.push(noteStmt(ctx, o.member_id, 'payment', 'A correction was made', `An entry of ${kes(Math.abs(o.amount_cents))} on your account was reversed. Reason: ${reason}`));
  await ctx.db.batch(stmts);
  if (o.report_id) {   // the report is "reversed" once every one of its entries has been
    const left = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_ledger l WHERE l.client_id = ? AND l.report_id = ? AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM chama_ledger z WHERE z.client_id = l.client_id AND z.reversal_of = l.id)').bind(ctx.c, o.report_id).first();
    if (left && left.n === 0) await ctx.db.prepare("UPDATE chama_report SET status = 'reversed' WHERE client_id = ? AND id = ? AND status = 'verified'").bind(ctx.c, o.report_id).run();
  }
  return {};
} };
A['fund.transfer'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, cents = toCents(b.amount), from = String(b.fromFund || ''), to = String(b.toFund || '');
  if (!isFinite(cents) || cents <= 0) fail('Type the amount to move.');
  if (!from || !to || from === to) fail('Pick two different funds.');
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_fund WHERE client_id = ? AND id IN (?, ?)').bind(ctx.c, from, to).first(); if (n.n !== 2) fail('Pick two funds from the list.');
  const id = reqId(b), date = todayKey(), note = strOf(b, 'note', 200) || 'Transfer between funds';
  const have = await ctx.db.prepare('SELECT id FROM chama_ledger WHERE client_id = ? AND idem_key = ?').bind(ctx.c, 'tr:' + id + ':out').first(); if (have) return { already: true };
  const ins = (fund, amt, key) => ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, amount_cents, ref_type, note, created_by, idem_key) VALUES (?,?,?,?, 'transfer', ?, ?, 'transfer', ?, ?, ?)").bind(ctx.c, uid(), Date.now(), date, fund, amt, note, ctx.me.id, key);
  await ctx.db.batch([ins(from, -cents, 'tr:' + id + ':out'), ins(to, cents, 'tr:' + id + ':in'), auditStmt(ctx, `${ctx.me.name} moved ${kes(cents)} between funds`, 'transfer')]);
  return {};
} };
A['ledger.refund'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, cents = toCents(b.amount), m = await memberById(ctx, b.memberId), note = strOf(b, 'note', 200);
  if (!isFinite(cents) || cents <= 0) fail('Type the amount refunded.');
  if (!note) fail('Say why the money is being refunded.');
  const fundId = b.fundId ? String(b.fundId) : await fundFor(ctx, 'main'), id = reqId(b);
  const have = await ctx.db.prepare('SELECT id FROM chama_ledger WHERE client_id = ? AND idem_key = ?').bind(ctx.c, 'ref:' + id).first(); if (have) return { already: true };
  await ctx.db.batch([ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, note, created_by, idem_key) VALUES (?,?,?,?, 'refund', ?, ?, ?, 'refund', ?, ?, ?)").bind(ctx.c, uid(), Date.now(), todayKey(), fundId, m.id, -cents, note, ctx.me.id, 'ref:' + id), auditStmt(ctx, `${ctx.me.name} refunded ${kes(cents)} to ${m.name}: ${note}`, 'refund')]);
  return {};
} };
A['ledger.adjust'] = { p: '*', fn: async (ctx) => {
  const b = ctx.body, cents = Math.round(Number(b.amountSigned) * 100), note = strOf(b, 'note', 200);
  if (!isFinite(cents) || cents === 0) fail('Type the adjustment (a minus sign takes money out).');
  if (!note) fail('Say why the adjustment is needed.');
  const fundId = b.fundId ? String(b.fundId) : await fundFor(ctx, 'main'), id = reqId(b);
  const have = await ctx.db.prepare('SELECT id FROM chama_ledger WHERE client_id = ? AND idem_key = ?').bind(ctx.c, 'adj:' + id).first(); if (have) return { already: true };
  await ctx.db.batch([ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, amount_cents, ref_type, note, created_by, idem_key) VALUES (?,?,?,?, 'adjustment', ?, ?, 'adjustment', ?, ?, ?)").bind(ctx.c, uid(), Date.now(), todayKey(), fundId, cents, note, ctx.me.id, 'adj:' + id), auditStmt(ctx, `${ctx.me.name} adjusted a fund by ${kes(cents)}: ${note}`, 'adjustment')]);
  return {};
} };
A['audit.list'] = { p: 'audit', fn: async (ctx) => {
  const off = Math.max(0, Number(ctx.body.offset) || 0), lim = Math.min(100, Math.max(1, Number(ctx.body.limit) || 40));
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_audit WHERE client_id = ?').bind(ctx.c).first();
  const r = rows(await ctx.db.prepare('SELECT id, ts, actor_name, action, record, before_json, after_json FROM chama_audit WHERE client_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').bind(ctx.c, lim, off).all());
  return { total: n.n, items: r.map((x) => ({ id: x.id, ts: x.ts, actor: x.actor_name, action: x.action, record: x.record, before: x.before_json, after: x.after_json })) };
} };
export { memberById, KIND_TEXT };
