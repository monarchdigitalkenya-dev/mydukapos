// functions/api/_chama-d.js — Chama (zip 232): the terms and conditions, the chama logo, and running the late-payment penalties on demand.
import { A } from './_chama-a.js';
import { fail, loadGroup, can, auditStmt, text, todayKey, applyLatePenalties, rows } from './_chama-core.js';

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
