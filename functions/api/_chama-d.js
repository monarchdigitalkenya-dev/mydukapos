// functions/api/_chama-d.js — Chama (zip 232): the terms and conditions, the chama logo, and running the late-payment penalties on demand.
import { A, runBatches } from './_chama-a.js';
import { fail, loadGroup, can, auditStmt, noteStmt, text, todayKey, applyLatePenalties, rows, uid, kes } from './_chama-core.js';

const logoKey = (ctx) => 'logo:' + ctx.c;
export async function readLogo(ctx) {
  const r = await ctx.db.prepare('SELECT v FROM chama_meta WHERE k = ?').bind(logoKey(ctx)).first();
  if (!r) return { logo: '', v: 0 };
  try { const j = JSON.parse(r.v); return { logo: j.data || '', v: j.v || 0 }; } catch (e) { return { logo: '', v: 0 }; }
}

// ---- terms and conditions: everyone reads, the admin writes ----
A['terms.get'] = { p: 'member', fn: async (ctx) => {
  const g = await loadGroup(ctx), s = g.settings, p = s.penalties, lc = p.lateContribution, mm = p.missedMeeting;
  const rules = [];
  if (s.contribution.enabled && s.contribution.amountCents) rules.push({ title: 'Contributions', text: `Each member contributes KES ${(s.contribution.amountCents / 100).toLocaleString('en-KE')} ${({ daily: 'every day', weekly: 'every week', biweekly: 'every 2 weeks', monthly: 'every month', bimonthly: 'every 2 months', quarterly: 'every 3 months' })[s.contribution.freq] || 'each period'}.` });
  if (s.features.penalties && lc.enabled) rules.push({ title: 'Late contribution', text: `A contribution not complete by the end of the period${lc.graceDays ? ' (plus ' + lc.graceDays + ' grace day' + (lc.graceDays === 1 ? '' : 's') + ')' : ''} is fined ${lc.mode === 'percent' ? lc.percent + '% of the amount that was missing' : 'KES ' + (lc.amountCents / 100).toLocaleString('en-KE')}. The fine is added automatically.` });
  if (s.features.penalties && mm.enabled) rules.push({ title: 'Missed meeting', text: `A member marked absent from a meeting is fined KES ${(mm.amountCents / 100).toLocaleString('en-KE')}.` });
  if (s.features.loans) rules.push({ title: 'Loans', text: `Interest ${s.loans.interestPct}%${s.loans.guarantors ? ', ' + s.loans.guarantors + ' guarantor' + (s.loans.guarantors === 1 ? '' : 's') + ' needed' : ''}${s.loans.maxMultiple ? ', up to ' + s.loans.maxMultiple + ' times what you have contributed' : ''}.` });
  return { text: s.terms.text, updatedAt: s.terms.updatedAt, updatedBy: s.terms.updatedBy, rules, canEdit: can(ctx.me, '*') };
} };
A['terms.save'] = { p: '*', fn: async (ctx) => {
  const t = text(ctx.body.text, 20000), g = await loadGroup(ctx), s = g.settings;
  s.terms = { text: t, updatedAt: Date.now(), updatedBy: ctx.me.name };
  await ctx.db.batch([
    ctx.db.prepare('UPDATE chama_group SET settings = ? WHERE client_id = ?').bind(JSON.stringify(s), ctx.c),
    auditStmt(ctx, 'Updated the terms and conditions', 'settings:terms', null, { length: t.length }),
  ]);
  ctx.group = null;
  return { saved: true, updatedAt: s.terms.updatedAt };
} };

// ---- the logo: a small picture (the phone shrinks it first) shown next to the chama name ----
A['logo.get'] = { p: 'public', fn: async (ctx) => readLogo(ctx) };
A['logo.save'] = { p: '*', fn: async (ctx) => {
  const d = String(ctx.body.logo || '');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) fail('Choose a PNG or JPG picture.');
  if (d.length > 160000) fail('That picture is too big. Choose a smaller one.');
  const v = Date.now();
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO chama_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(logoKey(ctx), JSON.stringify({ data: d, v })),
    ctx.db.prepare('INSERT INTO chama_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('logov:' + ctx.c, String(v)),
    auditStmt(ctx, 'Changed the chama logo', 'settings:logo'),
  ]);
  return { v };
} };
A['logo.remove'] = { p: '*', fn: async (ctx) => {
  await ctx.db.batch([ctx.db.prepare('DELETE FROM chama_meta WHERE k = ?').bind(logoKey(ctx)), ctx.db.prepare('DELETE FROM chama_meta WHERE k = ?').bind('logov:' + ctx.c), auditStmt(ctx, 'Removed the chama logo', 'settings:logo')]);
  return { v: 0 };
} };

// ---- late penalties: normally automatic; this runs them right now ----
A['penalty.runLate'] = { p: 'penalties', fn: async (ctx) => {
  const g = await loadGroup(ctx), lc = g.settings.penalties.lateContribution;
  if (!g.settings.features.penalties || !lc.enabled) fail('The late-contribution penalty is not switched on (Settings).');
  const r = await applyLatePenalties(ctx, true);
  return { raised: r.raised };
} };


// ---- zip 235: reset test payments (admin) ----
// Some people try the app out with pretend payments. "Reset" clears them WITHOUT erasing anything: every payment entry that has not been undone gets a matching
// REVERSAL row (the ledger stays append-only and the audit trail keeps who did it and why), balances go back to zero, pending reports are cleared.
// Only payment entries are touched (contributions, merry-go-round contributions, fundraiser gifts, penalty payments) — never loans, payouts or expenses.
const RESET_KINDS = ['contribution', 'mgr_contribution', 'fundraising', 'penalty'];
A['payments.reset'] = { p: '*', fn: async (ctx) => {
  const b = ctx.body, all = b.all === true, reason = text(b.reason, 160) || 'Test payments cleared';
  let member = null;
  if (all) { if (String(b.confirm || '').trim().toUpperCase() !== 'RESET') fail('Type RESET to clear every member\'s payments.', 'confirm_needed', 400); }
  else {
    member = await ctx.db.prepare('SELECT id, name FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, String(b.memberId || '')).first();
    if (!member) fail('That member was not found.', 'not_found', 404);
  }
  const kinds = RESET_KINDS.map((k) => `'${k}'`).join(',');
  const live = rows(await ctx.db.prepare(`SELECT l.* FROM chama_ledger l WHERE l.client_id = ? AND l.reversal_of IS NULL AND l.kind IN (${kinds}) AND l.member_id IS NOT NULL ${all ? '' : 'AND l.member_id = ?'}
      AND NOT EXISTS (SELECT 1 FROM chama_ledger z WHERE z.client_id = l.client_id AND z.reversal_of = l.id) ORDER BY l.ts LIMIT 2000`).bind(...(all ? [ctx.c] : [ctx.c, member.id])).all());
  const stmts = live.map((o) => ctx.db.prepare(`INSERT OR IGNORE INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, report_id, method, reference, note, created_by, reversal_of, idem_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ctx.c, uid(), Date.now(), todayKey(), o.kind, o.fund_id, o.member_id, -o.amount_cents, o.ref_type, o.ref_id, o.report_id, o.method, o.reference, 'RESET: ' + reason, ctx.me.id, o.id, 'rev:' + o.id));
  const people = [...new Set(live.map((o) => o.member_id))];
  stmts.push(ctx.db.prepare(`UPDATE chama_report SET status = 'rejected', note = 'Cleared by the admin (test payments)' WHERE client_id = ? AND status = 'pending' ${all ? '' : 'AND member_id = ?'}`).bind(...(all ? [ctx.c] : [ctx.c, member.id])));
  const total = live.reduce((t, o) => t + o.amount_cents, 0);
  stmts.push(auditStmt(ctx, `${ctx.me.name} reset ${live.length} test payment${live.length === 1 ? '' : 's'} (${kes(total)}) for ${all ? 'everyone' : member.name}: ${reason}`, 'reset:' + (all ? 'all' : member.id), { entries: live.length, amountCents: total }, null));
  people.slice(0, 200).forEach((id) => stmts.push(noteStmt(ctx, id, 'payment', 'Test payments cleared', 'The admin cleared the practice payments on your account. Your balance starts from zero.')));
  await runBatches(ctx, stmts, 50);
  // a report is "reversed" once every one of its entries has been undone
  await ctx.db.prepare(`UPDATE chama_report SET status = 'reversed' WHERE client_id = ? AND status = 'verified' AND EXISTS (SELECT 1 FROM chama_ledger a WHERE a.client_id = chama_report.client_id AND a.report_id = chama_report.id)
      AND NOT EXISTS (SELECT 1 FROM chama_ledger l WHERE l.client_id = chama_report.client_id AND l.report_id = chama_report.id AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM chama_ledger z WHERE z.client_id = l.client_id AND z.reversal_of = l.id))`).bind(ctx.c).run();
  return { reversed: live.length, amountCents: total, members: people.length };
} };

// ---- zip 242: undo "this member already received" in the merry-go-round (admin only) ----
// Puts a paid-out turn back to "waiting". If a payout was actually recorded for it, that payout is cancelled by a matching correction (nothing is erased),
// so the money collected for the turn is held again. A turn marked as received while setting the round up has no payout and is simply re-opened.
A['mgr.undoTurn'] = { p: '*', fn: async (ctx) => {
  const t = await ctx.db.prepare("SELECT t.id, t.seq, t.member_id, m.name, g.status AS mgr_status FROM chama_mgr_turn t JOIN chama_mgr g ON g.client_id = t.client_id AND g.id = t.mgr_id JOIN chama_member m ON m.client_id = t.client_id AND m.id = t.member_id WHERE t.client_id = ? AND t.id = ? AND t.status = 'paid_out'").bind(ctx.c, String(ctx.body.turnId || '')).first();
  if (!t) fail('That turn is not marked as received.', 'not_found', 404);
  if (t.mgr_status !== 'active') fail('That merry-go-round is closed.', 'bad_request', 409);
  const reason = String(ctx.body.reason || '').trim().slice(0, 200) || 'Marked as received by mistake';
  const pays = rows(await ctx.db.prepare("SELECT * FROM chama_ledger l WHERE l.client_id = ? AND l.kind = 'mgr_payout' AND l.ref_id = ? AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM chama_ledger z WHERE z.client_id = l.client_id AND z.reversal_of = l.id)").bind(ctx.c, t.id).all());
  const stmts = pays.map((o) => ctx.db.prepare(`INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, report_id, method, reference, note, created_by, reversal_of, idem_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ctx.c, uid(), Date.now(), todayKey(), o.kind, o.fund_id, o.member_id, -o.amount_cents, o.ref_type, o.ref_id, o.report_id, o.method, o.reference, 'REVERSAL: ' + reason, ctx.me.id, o.id, 'rev:' + o.id));
  stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET status = 'open', paid_date = NULL, opening = 0 WHERE client_id = ? AND id = ? AND status = 'paid_out'").bind(ctx.c, t.id));
  stmts.push(auditStmt(ctx, `${ctx.me.name} undid "${t.name} has received" in the merry-go-round (${reason})${pays.length ? ' and reversed the payout' : ''}`, 'mgr_turn:' + t.id, null, { payoutsReversed: pays.length }));
  await runBatches(ctx, stmts, 80);
  const chk = await ctx.db.prepare('SELECT status FROM chama_mgr_turn WHERE client_id = ? AND id = ?').bind(ctx.c, t.id).first();
  if (!chk || chk.status !== 'open') fail('Could not undo that turn. Try again.', 'conflict', 409);
  return { reversedPayouts: pays.length };
} };
