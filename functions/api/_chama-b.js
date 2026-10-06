// functions/api/_chama-b.js — Chama (zip 217), part 2 of the actions: the home screens, meetings / attendance / minutes, messages, penalties, loans and
// guarantors, the merry-go-round, fundraisers, member statements and the group reports.
import {
  fail, text, toCents, kes, uid, todayKey, isDate, rows, niceDate, time12, addDays, loadGroup, auditStmt, noteStmt, fundFor, ensureCycles, currentCycle,
  cyclePosition, arrears, totalContributed, statusOf, can, showPhone, applyLatePenalties, readLogoV,
} from './_chama-core.js';
import { A, strOf, reqId, runBatches, loanCalc, repaidByLoan, loanOut, memberById, KIND_TEXT } from './_chama-a.js';

const MEETING_TYPES = ['normal', 'agm', 'emergency', 'special', 'other'];
const TYPE_TEXT = { normal: 'Normal meeting', agm: 'AGM', emergency: 'Emergency meeting', special: 'Special meeting', other: 'Meeting' };
const meetingWhen = (m) => `${niceDate(m.meet_date, true)}${m.meet_time ? ' at ' + time12(m.meet_time) : ''}${m.location ? ', ' + m.location : ''}`;
const meetingOut = (m) => ({ id: m.id, title: m.title, type: m.meeting_type, typeText: TYPE_TEXT[m.meeting_type] || 'Meeting', date: m.meet_date, dateText: niceDate(m.meet_date, true), time: m.meet_time || '', timeText: time12(m.meet_time), location: m.location || '', agenda: m.agenda || '', notes: m.notes || '', attachmentUrl: m.attachment_url || '', status: m.status });
const SAFE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'p', 'div']);
// minutes may carry simple formatting; everything else (scripts, links, attributes) is stripped
export const cleanHtml = (s, max = 20000) => String(s == null ? '' : s).slice(0, max).replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, t) => (SAFE_TAGS.has(t.toLowerCase()) ? (m[1] === '/' ? `</${t.toLowerCase()}>` : `<${t.toLowerCase()}>`) : '')).replace(/<(?!\/?(?:b|strong|i|em|u|ul|ol|li|br|p|div)>)/gi, '&lt;');

// ---------- the home screens ----------
async function owedPenalties(ctx, memberId) {
  const r = await ctx.db.prepare(`SELECT COALESCE(SUM(MAX(p.amount_cents - COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0), 0)), 0) AS owed FROM chama_penalty p WHERE p.client_id = ? AND p.member_id = ? AND p.status = 'open'`).bind(ctx.c, memberId).first();
  return r ? r.owed : 0;
}
async function nextMeeting(ctx) {
  const m = await ctx.db.prepare("SELECT * FROM chama_meeting WHERE client_id = ? AND status = 'scheduled' AND meet_date >= ? ORDER BY meet_date, meet_time LIMIT 1").bind(ctx.c, todayKey()).first();
  return m ? meetingOut(m) : null;
}
async function nextTurn(ctx) {
  return await ctx.db.prepare(`SELECT t.id, t.mgr_id, t.seq, t.member_id, t.due_date, t.expected_cents, m.name, g.name AS mgr_name, g.per_member_cents,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_contribution' AND l.ref_type = 'mgr_turn' AND l.ref_id = t.id), 0) AS collected
    FROM chama_mgr_turn t JOIN chama_mgr g ON g.client_id = t.client_id AND g.id = t.mgr_id JOIN chama_member m ON m.client_id = t.client_id AND m.id = t.member_id
    WHERE t.client_id = ? AND t.status = 'open' AND g.status = 'active' ORDER BY t.seq LIMIT 1`).bind(ctx.c).first();
}
async function unread(ctx) {
  const r = await ctx.db.prepare('SELECT COUNT(*) AS n FROM chama_message m WHERE m.client_id = ? AND (m.member_id IS NULL OR m.member_id = ?) AND m.created_at >= ? AND NOT EXISTS (SELECT 1 FROM chama_message_read r WHERE r.client_id = m.client_id AND r.message_id = m.id AND r.member_id = ?)').bind(ctx.c, ctx.me.id, ctx.me.joinedAt || 0, ctx.me.id).first();
  return r ? r.n : 0;
}
async function fundraiserList(ctx) {
  const r = rows(await ctx.db.prepare(`SELECT f.id, f.title, f.category, f.note, f.target_cents, f.end_date, f.status, f.allow_anonymous,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = f.client_id AND l.kind = 'fundraising' AND l.ref_type = 'fundraiser' AND l.ref_id = f.id), 0) AS raised
    FROM chama_fundraiser f WHERE f.client_id = ? ORDER BY f.status, f.created_at DESC LIMIT 50`).bind(ctx.c).all());
  return r.map((f) => ({ id: f.id, title: f.title, category: f.category, note: f.note || '', targetCents: f.target_cents, raisedCents: f.raised, remainingCents: Math.max(0, f.target_cents - f.raised), endDate: f.end_date, status: f.status, allowAnonymous: !!f.allow_anonymous }));
}

A.home = { p: 'member', fn: async (ctx) => {
  // zip 232: SPEED. This used to ask the database about 30 things one after another (each a network round trip); the independent ones now run together.
  await ensureCycles(ctx);
  await applyLatePenalties(ctx);   // zip 232: a late contribution is fined automatically (once a day at most)
  const g = await loadGroup(ctx), s = g.settings, me = ctx.me;
  const q = (sql, ...a) => ctx.db.prepare(sql).bind(ctx.c, ...a).first();
  const [mrow, cp, total, arr, pen, rep, loanRows, pendingN, gr, tp, nextMtg, unreadN, frs, logoV] = await Promise.all([
    q('SELECT joined_at FROM chama_member WHERE client_id = ? AND id = ?', me.id),
    currentCycle(ctx).then(async (c) => [c, c ? await cyclePosition(ctx, c.id, me.id) : null]),
    totalContributed(ctx, me.id), arrears(ctx, me.id), owedPenalties(ctx, me.id), repaidByLoan(ctx, me.id),
    ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND member_id = ? AND status IN ('active','requested','changes','approved') ORDER BY requested_at DESC LIMIT 5").bind(ctx.c, me.id).all(),
    q("SELECT COUNT(*) AS n FROM chama_report WHERE client_id = ? AND member_id = ? AND status = 'pending'", me.id),
    q("SELECT COUNT(*) AS n FROM chama_guarantor WHERE client_id = ? AND member_id = ? AND status = 'pending'", me.id),
    s.features.mgr ? nextTurn(ctx).then(async (t) => [t, t ? (await q("SELECT COALESCE(SUM(amount_cents),0) AS t FROM chama_ledger WHERE client_id = ? AND kind = 'mgr_contribution' AND ref_id = ? AND member_id = ?", t.id, me.id)).t : 0]) : [null, 0],
    s.features.meetings ? nextMeeting(ctx) : null,
    unread(ctx),
    s.features.fundraising ? fundraiserList(ctx) : [],
    readLogoV(ctx),
  ]);
  me.joinedAt = mrow ? mrow.joined_at : 0;
  const [cur, pos] = cp, [turn, myTurnPaid] = tp;
  const loans = rows(loanRows).map((l) => loanOut(l, rep[l.id]));
  const member = {
    name: me.name, firstName: me.name.split(' ')[0],
    totalContributedCents: total, arrearsCents: arr, penaltiesCents: pen,
    cycle: cur ? { id: cur.id, label: cur.label, start: cur.start_date, end: cur.end_date, dueText: niceDate(cur.end_date, true), ...pos } : null,
    loans, nextMeeting: nextMtg,
    nextRecipient: turn && (s.privacy.showRecipient || turn.member_id === me.id) ? { name: turn.name, isMe: turn.member_id === me.id, expectedCents: turn.expected_cents, dueDate: turn.due_date, dueText: niceDate(turn.due_date, true), mgrName: turn.mgr_name } : null,
    myTurnPaidCents: myTurnPaid,
    myTurnPerMemberCents: turn ? turn.per_member_cents : 0,
    unread: unreadN, pendingReports: pendingN.n, guarantorRequests: gr.n,
    fundraisers: frs.filter((f) => f.status === 'active'),
  };
  const group = { name: g.name, logoV, features: s.features, payInstructions: s.payInstructions, privacy: s.privacy, hasContribution: !!(s.contribution.enabled && s.contribution.amountCents), freq: s.contribution.freq };
  const out = { me: { id: me.id, name: me.name, role: me.role, roles: me.roles || [], perms: me.perms, mustChangePin: me.mustChangePin }, group, member, staff: null };
  if (!(me.perms.length > 0)) return out;

  const st = {}, T = {}, jobs = [];
  const job = (k, p) => { jobs.push(Promise.resolve(p).then((v) => { T[k] = v; })); };
  const sum = (kind) => q(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM chama_ledger WHERE client_id = ? AND kind = '${kind}'`);
  const cnt = (table, where) => q(`SELECT COUNT(*) AS n FROM ${table} WHERE client_id = ? AND ${where}`);
  const pay = can(me, 'payments'), rep2 = can(me, 'reports'), mon = can(me, 'money'), lo = can(me, 'loans'), mt = can(me, 'meetings') || can(me, '*');
  job('members', cnt('chama_member', "status = 'active'"));
  if (pay || rep2) job('pendingReports', cnt('chama_report', "status = 'pending'"));
  if (rep2 || mon || pay) {
    job('totalContributions', sum('contribution'));
    if (cur) job('cycle', ctx.db.prepare(`SELECT COALESCE(SUM(x.req),0) AS req, COALESCE(SUM(x.paid),0) AS paid, COALESCE(SUM(MAX(x.req - x.paid,0)),0) AS owed, COALESCE(SUM(CASE WHEN x.paid >= x.req THEN 1 ELSE 0 END),0) AS done, COUNT(*) AS n FROM (
        SELECT o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid
        FROM chama_obligation o JOIN chama_member m ON m.client_id = o.client_id AND m.id = o.member_id AND m.status = 'active' WHERE o.client_id = ? AND o.cycle_id = ?) x`).bind(ctx.c, cur.id).first());
    job('recent', A['ledger.list'].fn({ ...ctx, body: { limit: 8 } }));
  }
  if (mon || lo || rep2) {
    job('allRepaid', repaidByLoan(ctx, null));
    job('activeLoans', ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND status = 'active'").bind(ctx.c).all());
    job('disbursed', sum('loan_disbursement')); job('repayments', sum('loan_repayment')); job('expenses', sum('expense'));
    job('pendingRequests', cnt('chama_loan', "status IN ('requested','changes')")); job('toDisburse', cnt('chama_loan', "status = 'approved'"));
    job('funds', A['fund.list'].fn(ctx));
  }
  job('activeFundraisers', cnt('chama_fundraiser', "status = 'active'"));
  if (mt) {
    job('lastMeeting', ctx.db.prepare("SELECT id, title, meet_date FROM chama_meeting WHERE client_id = ? AND status = 'held' ORDER BY meet_date DESC LIMIT 1").bind(ctx.c).first().then(async (last) => last ? [last, await q("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END),0) AS p FROM chama_attendance WHERE client_id = ? AND meeting_id = ?", last.id)] : null));
    job('draftMinutes', cnt('chama_minutes', "status = 'draft'"));
  }
  await Promise.all(jobs);
  st.members = T.members.n;
  if (T.pendingReports) st.pendingReports = T.pendingReports.n;
  if (T.totalContributions) {
    st.totalContributionsCents = T.totalContributions.t;
    if (T.cycle) st.cycle = { id: cur.id, label: cur.label, requiredCents: T.cycle.req, collectedCents: T.cycle.paid, outstandingCents: T.cycle.owed, completeCount: T.cycle.done, memberCount: T.cycle.n };
    st.recent = T.recent.items;
  }
  if (T.activeLoans) {
    const act = rows(T.activeLoans).map((l) => loanOut(l, T.allRepaid[l.id]));
    st.loans = { activeCount: act.length, outstandingCents: act.reduce((a, l) => a + l.outstandingCents, 0), overdueCents: act.reduce((a, l) => a + l.overdueCents, 0), overdueCount: act.filter((l) => l.overdueCents > 0).length,
      disbursedCents: -T.disbursed.t, repaymentsCents: T.repayments.t, pendingRequests: T.pendingRequests.n, toDisburse: T.toDisburse.n };
    st.expensesCents = -T.expenses.t;
    st.funds = T.funds.funds;
  }
  st.activeFundraisers = T.activeFundraisers.n;
  if (turn && (mon || pay || can(me, '*'))) st.mgr = { recipient: turn.name, dueText: niceDate(turn.due_date, true), expectedCents: turn.expected_cents, collectedCents: turn.collected, outstandingCents: Math.max(0, turn.expected_cents - turn.collected), turnId: turn.id };
  if (mt) {
    if (T.lastMeeting) { const [last, a] = T.lastMeeting; st.lastAttendance = { title: last.title, dateText: niceDate(last.meet_date, true), present: a.p, marked: a.n, percent: a.n ? Math.round(a.p / a.n * 100) : 0 }; }
    st.draftMinutes = T.draftMinutes.n;
  }
  out.staff = st;
  return out;
} };

// ---------- meetings ----------
A['meeting.list'] = { p: 'member', fn: async (ctx) => {
  const scope = ['upcoming', 'past', 'all'].includes(ctx.body.scope) ? ctx.body.scope : 'upcoming', today = todayKey();
  const where = scope === 'upcoming' ? "AND (m.meet_date >= ? AND m.status <> 'held')" : scope === 'past' ? "AND (m.meet_date < ? OR m.status = 'held')" : 'AND ? IS NOT NULL';
  const staff = can(ctx.me, 'meetings');
  const r = rows(await ctx.db.prepare(`SELECT m.*, (SELECT status FROM chama_minutes x WHERE x.client_id = m.client_id AND x.meeting_id = m.id) AS minutes_status FROM chama_meeting m WHERE m.client_id = ? ${where} ORDER BY m.meet_date ${scope === 'upcoming' ? 'ASC' : 'DESC'}, m.meet_time LIMIT 50`).bind(ctx.c, today).all());
  return { meetings: r.map((m) => ({ ...meetingOut(m), minutesStatus: m.minutes_status ? (staff || m.minutes_status === 'approved' ? m.minutes_status : null) : null })) };
} };
A['meeting.get'] = { p: 'member', fn: async (ctx) => {
  const m = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, String(ctx.body.id || '')).first();
  if (!m) fail('That meeting was not found.', 'not_found', 404);
  const mine = await ctx.db.prepare('SELECT status FROM chama_attendance WHERE client_id = ? AND meeting_id = ? AND member_id = ?').bind(ctx.c, m.id, ctx.me.id).first();
  return { meeting: meetingOut(m), myStatus: mine ? mine.status : null };
} };
A['meeting.save'] = { p: 'meetings', fn: async (ctx) => {
  const b = ctx.body, title = strOf(b, 'title', 100) || 'Chama meeting';
  if (!isDate(b.date)) fail('Pick the meeting date.');
  const type = MEETING_TYPES.includes(b.type) ? b.type : 'normal', time = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '';
  const f = { title, meeting_type: type, meet_date: b.date, meet_time: time, location: strOf(b, 'location', 120), agenda: strOf(b, 'agenda', 3000), notes: strOf(b, 'notes', 3000), attachment_url: /^https?:\/\//i.test(b.attachmentUrl || '') ? String(b.attachmentUrl).slice(0, 300) : '' };
  if (b.id) {
    const o = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, String(b.id)).first();
    if (!o) fail('That meeting was not found.', 'not_found', 404);
    const stmts = [ctx.db.prepare('UPDATE chama_meeting SET title = ?, meeting_type = ?, meet_date = ?, meet_time = ?, location = ?, agenda = ?, notes = ?, attachment_url = ? WHERE client_id = ? AND id = ?').bind(f.title, f.meeting_type, f.meet_date, f.meet_time, f.location, f.agenda, f.notes, f.attachment_url, ctx.c, o.id)];
    if (o.meet_date !== f.meet_date || (o.meet_time || '') !== f.meet_time) stmts.push(noteStmt(ctx, null, 'meeting', '🔔 Meeting time changed', `${f.title} is now on ${meetingWhen({ ...f })}.`));
    else if ((o.location || '') !== f.location) stmts.push(noteStmt(ctx, null, 'meeting', '🔔 Meeting place changed', `${f.title} will now be at ${f.location || 'a place to be announced'} (${niceDate(f.meet_date, true)}${f.meet_time ? ' at ' + time12(f.meet_time) : ''}).`));
    stmts.push(auditStmt(ctx, `${ctx.me.name} edited the meeting "${f.title}"`, 'meeting:' + o.id));
    await ctx.db.batch(stmts);
    return { id: o.id };
  }
  const id = uid();
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO chama_meeting (client_id, id, title, meeting_type, meet_date, meet_time, location, agenda, notes, attachment_url, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, ?)").bind(ctx.c, id, f.title, f.meeting_type, f.meet_date, f.meet_time, f.location, f.agenda, f.notes, f.attachment_url, ctx.me.id, Date.now()),
    noteStmt(ctx, null, 'meeting', '🔔 Chama meeting', `${f.title}: ${meetingWhen({ ...f })}.`),
    auditStmt(ctx, `${ctx.me.name} scheduled "${f.title}" for ${niceDate(f.meet_date, true)}`, 'meeting:' + id),
  ]);
  return { id };
} };
A['meeting.cancel'] = { p: 'meetings', fn: async (ctx) => {
  const m = await ctx.db.prepare("SELECT * FROM chama_meeting WHERE client_id = ? AND id = ? AND status = 'scheduled'").bind(ctx.c, String(ctx.body.id || '')).first();
  if (!m) fail('That meeting is not scheduled any more.', 'not_found', 404);
  const why = strOf(ctx.body, 'reason', 200);
  await ctx.db.batch([ctx.db.prepare("UPDATE chama_meeting SET status = 'cancelled' WHERE client_id = ? AND id = ?").bind(ctx.c, m.id), noteStmt(ctx, null, 'meeting', '🔔 Meeting cancelled', `${m.title} on ${niceDate(m.meet_date, true)} is cancelled.${why ? ' ' + why : ''}`), auditStmt(ctx, `${ctx.me.name} cancelled the meeting "${m.title}"`, 'meeting:' + m.id)]);
  return {};
} };

// attendance: one tap per member, or MARK ALL PRESENT then fix the few who were not
A['attendance.get'] = { p: 'meetings', fn: async (ctx) => {
  const id = String(ctx.body.meetingId || ''), m = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (!m) fail('That meeting was not found.', 'not_found', 404);
  const r = rows(await ctx.db.prepare("SELECT m.id, m.name, a.status FROM chama_member m LEFT JOIN chama_attendance a ON a.client_id = m.client_id AND a.member_id = m.id AND a.meeting_id = ? WHERE m.client_id = ? AND m.status = 'active' ORDER BY m.name").bind(id, ctx.c).all());
  return { meeting: meetingOut(m), members: r.map((x) => ({ id: x.id, name: x.name, status: x.status || '' })) };
} };
A['attendance.save'] = { p: 'meetings', fn: async (ctx) => {
  const b = ctx.body, id = String(b.meetingId || ''), m = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, id).first();
  if (!m) fail('That meeting was not found.', 'not_found', 404);
  if (m.status === 'cancelled') fail('This meeting was cancelled.');
  const ok = ['present', 'absent', 'excused', 'late'], marks = b.marks && typeof b.marks === 'object' ? b.marks : {};
  const active = rows(await ctx.db.prepare("SELECT id FROM chama_member WHERE client_id = ? AND status = 'active'").bind(ctx.c).all()).map((x) => x.id);
  const set = {}; if (ok.includes(b.markAll)) active.forEach((x) => { set[x] = b.markAll; });
  Object.keys(marks).forEach((k) => { if (active.includes(k) && ok.includes(marks[k])) set[k] = marks[k]; });
  const ids = Object.keys(set), now = Date.now();
  if (!ids.length) fail('Mark at least one member.');
  const stmts = ids.map((k) => ctx.db.prepare('INSERT INTO chama_attendance (client_id, meeting_id, member_id, status, marked_by, marked_at) VALUES (?,?,?,?,?,?) ON CONFLICT (client_id, meeting_id, member_id) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, marked_at = excluded.marked_at').bind(ctx.c, id, k, set[k], ctx.me.id, now));
  await runBatches(ctx, stmts);
  await ctx.db.prepare("UPDATE chama_meeting SET status = 'held' WHERE client_id = ? AND id = ? AND status = 'scheduled'").bind(ctx.c, id).run();
  // the optional missed-meeting penalty (off unless the admin turned it on)
  const g = await loadGroup(ctx), rule = g.settings.penalties.missedMeeting; let raised = 0, voided = 0;
  if (g.settings.features.penalties && rule.enabled && rule.amountCents > 0) {
    const pen = [];
    for (const k of ids) {
      if (set[k] === 'absent') {
        let amt = rule.amountCents;
        if (rule.repeatAfter > 0 && rule.repeatAmountCents > 0) { const prior = await ctx.db.prepare("SELECT COUNT(*) AS n FROM chama_attendance a JOIN chama_meeting mt ON mt.client_id = a.client_id AND mt.id = a.meeting_id WHERE a.client_id = ? AND a.member_id = ? AND a.status = 'absent' AND mt.meet_date < ?").bind(ctx.c, k, m.meet_date).first(); if (prior.n >= rule.repeatAfter) amt = rule.repeatAmountCents; }
        pen.push(ctx.db.prepare("INSERT OR IGNORE INTO chama_penalty (client_id, id, member_id, kind, amount_cents, reason, ref_type, ref_id, status, created_by, created_at) VALUES (?,?,?, 'missed_meeting', ?, ?, 'meeting', ?, 'open', ?, ?)").bind(ctx.c, uid(), k, amt, `Missed ${m.title} on ${niceDate(m.meet_date, true)}`, id, ctx.me.id, now));
        pen.push(noteStmt(ctx, k, 'penalty', 'Missed meeting', `You were marked absent from ${m.title} on ${niceDate(m.meet_date, true)}. A penalty of ${kes(amt)} applies unless it is waived.`));
        raised++;
      } else {
        pen.push(ctx.db.prepare(`UPDATE chama_penalty SET status = 'void' WHERE client_id = ? AND member_id = ? AND kind = 'missed_meeting' AND ref_id = ? AND status = 'open' AND NOT EXISTS (SELECT 1 FROM chama_ledger l WHERE l.client_id = chama_penalty.client_id AND l.kind = 'penalty' AND l.ref_id = chama_penalty.id)`).bind(ctx.c, k, id));
        voided++;
      }
    }
    await runBatches(ctx, pen);
  }
  await ctx.db.prepare('INSERT INTO chama_audit (client_id, ts, actor_id, actor_name, action, record) VALUES (?,?,?,?,?,?)').bind(ctx.c, now, ctx.me.id, ctx.me.name, `${ctx.me.name} recorded attendance for "${m.title}" (${ids.length} members)`, 'meeting:' + id).run();
  return { marked: ids.length, penaltiesRaised: raised };
} };
A['attendance.mine'] = { p: 'member', fn: async (ctx) => {
  const r = rows(await ctx.db.prepare("SELECT mt.id, mt.title, mt.meeting_type, mt.meet_date, a.status FROM chama_attendance a JOIN chama_meeting mt ON mt.client_id = a.client_id AND mt.id = a.meeting_id WHERE a.client_id = ? AND a.member_id = ? ORDER BY mt.meet_date DESC LIMIT 60").bind(ctx.c, ctx.me.id).all());
  const total = await ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END),0) AS p FROM chama_attendance WHERE client_id = ? AND member_id = ?").bind(ctx.c, ctx.me.id).first();
  return { attended: total.p, total: total.n, percent: total.n ? Math.round(total.p / total.n * 100) : 0, items: r.map((x) => ({ id: x.id, title: x.title, typeText: TYPE_TEXT[x.meeting_type] || 'Meeting', dateText: niceDate(x.meet_date, true), status: x.status })) };
} };

// minutes: draft until the secretary approves; members only ever see approved ones
A['minutes.get'] = { p: 'member', fn: async (ctx) => {
  const id = String(ctx.body.meetingId || ''), staff = can(ctx.me, 'meetings');
  const m = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, id).first(); if (!m) fail('That meeting was not found.', 'not_found', 404);
  const x = await ctx.db.prepare('SELECT * FROM chama_minutes WHERE client_id = ? AND meeting_id = ?').bind(ctx.c, id).first();
  const meeting = meetingOut(m);
  if (!x || (!staff && x.status !== 'approved')) return { meeting, minutes: null, canEdit: staff };
  const items = rows(await ctx.db.prepare('SELECT id, action, assigned_to, due_date, status FROM chama_action_item WHERE client_id = ? AND meeting_id = ? ORDER BY rowid').bind(ctx.c, id).all());
  const att = rows(await ctx.db.prepare("SELECT status, COUNT(*) AS n FROM chama_attendance WHERE client_id = ? AND meeting_id = ? GROUP BY status").bind(ctx.c, id).all());
  return { meeting, canEdit: staff, minutes: { chairperson: x.chairperson || '', secretary: x.secretary || '', body: x.body || '', decisions: x.decisions || '', financialDecisions: x.financial_decisions || '', status: x.status, attendance: att.reduce((a, r) => { a[r.status] = r.n; return a; }, {}), actions: items.map((i) => ({ action: i.action, assignedTo: i.assigned_to || '', dueDate: i.due_date || '', status: i.status })) } };
} };
A['minutes.save'] = { p: 'meetings', fn: async (ctx) => {
  const b = ctx.body, id = String(b.meetingId || ''), m = await ctx.db.prepare('SELECT * FROM chama_meeting WHERE client_id = ? AND id = ?').bind(ctx.c, id).first(); if (!m) fail('That meeting was not found.', 'not_found', 404);
  const old = await ctx.db.prepare('SELECT status FROM chama_minutes WHERE client_id = ? AND meeting_id = ?').bind(ctx.c, id).first();
  const status = b.approve ? 'approved' : 'draft', now = Date.now();
  if (old && old.status === 'approved' && !can(ctx.me, '*')) fail('Approved minutes can only be changed by the admin.', 'forbidden', 403);
  const stmts = [ctx.db.prepare(`INSERT INTO chama_minutes (client_id, meeting_id, chairperson, secretary, body, decisions, financial_decisions, status, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (client_id, meeting_id) DO UPDATE SET chairperson = excluded.chairperson, secretary = excluded.secretary, body = excluded.body, decisions = excluded.decisions, financial_decisions = excluded.financial_decisions, status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(ctx.c, id, strOf(b, 'chairperson', 80), strOf(b, 'secretary', 80), cleanHtml(b.body), cleanHtml(b.decisions, 8000), cleanHtml(b.financialDecisions, 8000), status, ctx.me.id, now)];
  if (Array.isArray(b.actions)) {
    stmts.push(ctx.db.prepare('DELETE FROM chama_action_item WHERE client_id = ? AND meeting_id = ?').bind(ctx.c, id));
    b.actions.slice(0, 40).forEach((a) => { const t = strOf(a, 'action', 200); if (t) stmts.push(ctx.db.prepare('INSERT INTO chama_action_item (client_id, id, meeting_id, action, assigned_to, due_date, status) VALUES (?,?,?,?,?,?,?)').bind(ctx.c, uid(), id, t, strOf(a, 'assignedTo', 80) || null, isDate(a.dueDate) ? a.dueDate : null, a.status === 'done' ? 'done' : 'open')); });
  }
  if (status === 'approved' && !(old && old.status === 'approved')) stmts.push(noteStmt(ctx, null, 'minutes', '📄 Minutes published', `The minutes of ${m.title} (${niceDate(m.meet_date, true)}) are ready to read under Meetings.`));
  stmts.push(auditStmt(ctx, `${ctx.me.name} ${status === 'approved' ? 'approved' : 'saved a draft of'} the minutes of "${m.title}"`, 'minutes:' + id, old ? { status: old.status } : null, { status }));
  await ctx.db.batch(stmts);
  return { status };
} };

// ---------- messages ----------
A['messages.list'] = { p: 'member', fn: async (ctx) => {
  const off = Math.max(0, Number(ctx.body.offset) || 0), lim = Math.min(50, Math.max(1, Number(ctx.body.limit) || 30));
  const jr = await ctx.db.prepare('SELECT joined_at FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, ctx.me.id).first();
  const r = rows(await ctx.db.prepare(`SELECT m.id, m.kind, m.title, m.body, m.created_at, m.member_id, (SELECT read_at FROM chama_message_read x WHERE x.client_id = m.client_id AND x.message_id = m.id AND x.member_id = ?) AS read_at
    FROM chama_message m WHERE m.client_id = ? AND (m.member_id IS NULL OR m.member_id = ?) AND m.created_at >= ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`).bind(ctx.me.id, ctx.c, ctx.me.id, jr ? jr.joined_at : 0, lim, off).all());
  return { items: r.map((x) => ({ id: x.id, kind: x.kind, title: x.title, body: x.body || '', at: x.created_at, read: !!x.read_at, personal: !!x.member_id })) };
} };
A['messages.read'] = { p: 'member', fn: async (ctx) => {
  const now = Date.now(), jr = await ctx.db.prepare('SELECT joined_at FROM chama_member WHERE client_id = ? AND id = ?').bind(ctx.c, ctx.me.id).first();
  if (ctx.body.all) { await ctx.db.prepare('INSERT OR IGNORE INTO chama_message_read (client_id, message_id, member_id, read_at) SELECT ?, id, ?, ? FROM chama_message WHERE client_id = ? AND (member_id IS NULL OR member_id = ?) AND created_at >= ?').bind(ctx.c, ctx.me.id, now, ctx.c, ctx.me.id, jr ? jr.joined_at : 0).run(); return {}; }
  const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).slice(0, 50).map(String);
  await runBatches(ctx, ids.map((i) => ctx.db.prepare('INSERT OR IGNORE INTO chama_message_read (client_id, message_id, member_id, read_at) SELECT ?, id, ?, ? FROM chama_message WHERE client_id = ? AND id = ? AND (member_id IS NULL OR member_id = ?)').bind(ctx.c, ctx.me.id, now, ctx.c, i, ctx.me.id)));
  return {};
} };
A['announce.send'] = { p: 'messages', fn: async (ctx) => {
  const b = ctx.body, title = strOf(b, 'title', 100), body = strOf(b, 'body', 1000);
  if (!title && !body) fail('Type your message.');
  let to = null, toName = 'everyone';
  if (b.memberId) { const m = await memberById(ctx, b.memberId); to = m.id; toName = m.name; }
  await ctx.db.batch([noteStmt(ctx, to, 'announcement', title || 'Message from your chama', body), auditStmt(ctx, `${ctx.me.name} sent a message to ${toName}`, 'message')]);
  return {};
} };
A['reminders.send'] = { p: 'messages', fn: async (ctx) => {
  await ensureCycles(ctx);
  const cur = await currentCycle(ctx); if (!cur) fail('There is no contribution period running.');
  const owing = rows(await ctx.db.prepare(`SELECT x.member_id, x.req - x.paid AS rem FROM (SELECT o.member_id, o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid
    FROM chama_obligation o JOIN chama_member m ON m.client_id = o.client_id AND m.id = o.member_id AND m.status = 'active' WHERE o.client_id = ? AND o.cycle_id = ?) x WHERE x.paid < x.req`).bind(ctx.c, cur.id).all());
  const late = todayKey() > cur.end_date;
  await runBatches(ctx, owing.map((o) => noteStmt(ctx, o.member_id, 'reminder', late ? 'Contribution overdue' : 'Contribution reminder', `You still owe ${kes(o.rem)} for ${cur.label}. Please complete it by ${niceDate(cur.end_date, true)}.`)));
  await ctx.db.prepare('INSERT INTO chama_audit (client_id, ts, actor_id, actor_name, action, record) VALUES (?,?,?,?,?,?)').bind(ctx.c, Date.now(), ctx.me.id, ctx.me.name, `${ctx.me.name} sent contribution reminders to ${owing.length} members`, 'reminders').run();
  return { sent: owing.length };
} };

// ---------- penalties (all optional) ----------
A['penalty.list'] = { p: 'member', fn: async (ctx) => {
  const staff = can(ctx.me, 'penalties'), all = staff && ctx.body.all !== false && ctx.body.mine !== true;
  const r = rows(await ctx.db.prepare(`SELECT p.id, p.member_id, m.name, p.kind, p.amount_cents, p.reason, p.status, p.created_at, p.waived_by, p.waived_at, p.waive_reason,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0) AS paid
    FROM chama_penalty p JOIN chama_member m ON m.client_id = p.client_id AND m.id = p.member_id WHERE p.client_id = ? ${all ? '' : 'AND p.member_id = ?'} ORDER BY p.created_at DESC LIMIT 100`).bind(...(all ? [ctx.c] : [ctx.c, ctx.me.id])).all());
  const wn = {}; if (all) rows(await ctx.db.prepare('SELECT id, name FROM chama_member WHERE client_id = ?').bind(ctx.c).all()).forEach((x) => { wn[x.id] = x.name; });
  return { items: r.map((p) => ({ id: p.id, memberId: p.member_id, memberName: all ? p.name : undefined, kind: p.kind, kindText: { missed_meeting: 'Missed meeting', late_contribution: 'Late contribution', missed_contribution: 'Missed contribution', late_loan: 'Late loan repayment' }[p.kind] || 'Penalty', amountCents: p.amount_cents, paidCents: p.paid, remainingCents: p.status === 'open' ? Math.max(0, p.amount_cents - p.paid) : 0, reason: p.reason || '', status: p.status, waivedBy: wn[p.waived_by] || undefined, waivedAtText: p.waived_at ? niceDate(new Date(p.waived_at + 3 * 3600000).toISOString().slice(0, 10), true) : '', waiveReason: p.waive_reason || '' })) };
} };
A['penalty.add'] = { p: 'penalties', fn: async (ctx) => {
  const b = ctx.body, m = await memberById(ctx, b.memberId), cents = toCents(b.amount), reason = strOf(b, 'reason', 200);
  const kind = ['late_contribution', 'missed_contribution', 'late_loan', 'other'].includes(b.kind) ? b.kind : 'other';
  if (!isFinite(cents) || cents <= 0) fail('Type the penalty amount.');
  if (!reason) fail('Say what the penalty is for.');
  const id = uid();
  await ctx.db.batch([ctx.db.prepare("INSERT INTO chama_penalty (client_id, id, member_id, kind, amount_cents, reason, status, created_by, created_at) VALUES (?,?,?,?,?,?, 'open', ?, ?)").bind(ctx.c, id, m.id, kind, cents, reason, ctx.me.id, Date.now()), noteStmt(ctx, m.id, 'penalty', 'A penalty was added', `${kes(cents)}: ${reason}`), auditStmt(ctx, `${ctx.me.name} added a ${kes(cents)} penalty for ${m.name}: ${reason}`, 'penalty:' + id)]);
  return { id };
} };
A['penalty.waive'] = { p: 'penalties', fn: async (ctx) => {
  const id = String(ctx.body.id || ''), reason = strOf(ctx.body, 'reason', 200);
  if (!reason) fail('Say why the penalty is being waived.');
  const p = await ctx.db.prepare("SELECT p.*, m.name FROM chama_penalty p JOIN chama_member m ON m.client_id = p.client_id AND m.id = p.member_id WHERE p.client_id = ? AND p.id = ? AND p.status = 'open'").bind(ctx.c, id).first();
  if (!p) fail('That penalty is not open any more.', 'already_done', 409);
  await ctx.db.batch([ctx.db.prepare("UPDATE chama_penalty SET status = 'waived', waived_by = ?, waived_at = ?, waive_reason = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(ctx.me.id, Date.now(), reason, ctx.c, id), noteStmt(ctx, p.member_id, 'penalty', 'Penalty waived', `Your ${kes(p.amount_cents)} penalty was waived. Reason: ${reason}`), auditStmt(ctx, `${ctx.me.name} waived ${p.name}'s ${kes(p.amount_cents)} penalty: ${reason}`, 'penalty:' + id, { status: 'open' }, { status: 'waived' })]);
  return {};
} };
A['penalty.applyCycle'] = { p: 'penalties', fn: async (ctx) => {
  const g = await loadGroup(ctx), rule = g.settings.penalties.lateContribution;
  if (!g.settings.features.penalties || !rule.enabled || !rule.amountCents) fail('The late-contribution penalty is not switched on.');
  const cy = await ctx.db.prepare('SELECT id, label, end_date FROM chama_cycle WHERE client_id = ? AND id = ?').bind(ctx.c, String(ctx.body.cycleId || '')).first();
  if (!cy) fail('Pick a period.'); if (cy.end_date >= todayKey()) fail('That period has not ended yet.');
  const late = rows(await ctx.db.prepare(`SELECT x.member_id FROM (SELECT o.member_id, o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid FROM chama_obligation o WHERE o.client_id = ? AND o.cycle_id = ?) x WHERE x.paid < x.req`).bind(ctx.c, cy.id).all());
  await runBatches(ctx, late.map((l) => ctx.db.prepare("INSERT OR IGNORE INTO chama_penalty (client_id, id, member_id, kind, amount_cents, reason, ref_type, ref_id, status, created_by, created_at) VALUES (?,?,?, 'late_contribution', ?, ?, 'cycle', ?, 'open', ?, ?)").bind(ctx.c, uid(), l.member_id, rule.amountCents, `Contribution for ${cy.label} not completed`, cy.id, ctx.me.id, Date.now())));
  return { members: late.length };
} };

// ---------- loans ----------
const LOAN_TYPES = ['normal', 'emergency', 'development', 'school_fees', 'business', 'other'];
async function loanGuarantors(ctx, loanId) { return rows(await ctx.db.prepare('SELECT g.member_id, m.name, g.amount_cents, g.status FROM chama_guarantor g JOIN chama_member m ON m.client_id = g.client_id AND m.id = g.member_id WHERE g.client_id = ? AND g.loan_id = ?').bind(ctx.c, loanId).all()).map((g) => ({ memberId: g.member_id, name: g.name, amountCents: g.amount_cents, status: g.status })); }
A['loan.request'] = { p: 'member', fn: async (ctx) => {
  const g = await loadGroup(ctx), s = g.settings, b = ctx.body;
  if (!s.features.loans) fail('Loans are not switched on for this chama.');
  const cents = toCents(b.amount); if (!isFinite(cents) || cents <= 0) fail('Type the loan amount.');
  const purpose = strOf(b, 'purpose', 200); if (!purpose) fail('Say what the loan is for.');
  const months = Math.max(1, Math.min(60, Math.round(Number(b.months) || s.loans.defaultMonths))), type = LOAN_TYPES.includes(b.loanType) ? b.loanType : 'normal';
  const open = await ctx.db.prepare("SELECT id FROM chama_loan WHERE client_id = ? AND member_id = ? AND status IN ('requested','changes','approved','active')").bind(ctx.c, ctx.me.id).first();
  if (open) fail('You already have a loan or a loan request. Finish that one first.', 'has_loan', 409);
  if (s.loans.maxMultiple > 0) { const saved = await totalContributed(ctx, ctx.me.id); if (cents > Math.round(saved * s.loans.maxMultiple)) fail(`You can borrow up to ${s.loans.maxMultiple} times what you have contributed (${kes(Math.round(saved * s.loans.maxMultiple))}).`, 'over_limit', 409); }
  const gs = Array.isArray(b.guarantors) ? b.guarantors : [], seen = new Set(), chosen = [];
  for (const x of gs) { const id = String(x && x.memberId || ''); if (!id || id === ctx.me.id || seen.has(id)) continue; const m = await ctx.db.prepare("SELECT id, name FROM chama_member WHERE client_id = ? AND id = ? AND status = 'active'").bind(ctx.c, id).first(); if (m) { seen.add(id); const amt = toCents(x.amount); chosen.push({ id, name: m.name, cents: isFinite(amt) && amt > 0 ? amt : Math.ceil(cents / Math.max(1, gs.length)) }); } }
  if (chosen.length < s.loans.guarantors) fail(`Pick at least ${s.loans.guarantors} guarantor${s.loans.guarantors === 1 ? '' : 's'}.`);
  const id = reqId(b), have = await ctx.db.prepare('SELECT id FROM chama_loan WHERE client_id = ? AND id = ?').bind(ctx.c, id).first(); if (have) return { id, already: true };
  const interest = Math.round(cents * s.loans.interestPct / 100);
  const stmts = [ctx.db.prepare("INSERT INTO chama_loan (client_id, id, member_id, principal_cents, interest_cents, months, purpose, loan_type, status, requested_at) VALUES (?,?,?,?,?,?,?,?, 'requested', ?)").bind(ctx.c, id, ctx.me.id, cents, interest, months, purpose, type, Date.now())];
  chosen.forEach((c) => { stmts.push(ctx.db.prepare('INSERT INTO chama_guarantor (client_id, loan_id, member_id, amount_cents, status) VALUES (?,?,?,?, \'pending\')').bind(ctx.c, id, c.id, c.cents), noteStmt(ctx, c.id, 'guarantor', 'Guarantor request', `${ctx.me.name} has requested a ${kes(cents)} loan and selected you as a guarantor for ${kes(c.cents)}. Open My Loan to accept or reject.`)); });
  stmts.push(auditStmt(ctx, `${ctx.me.name} requested a ${kes(cents)} loan`, 'loan:' + id));
  await ctx.db.batch(stmts);
  return { id };
} };
A['loan.resubmit'] = { p: 'member', fn: async (ctx) => {
  const l = await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND id = ? AND member_id = ? AND status = 'changes'").bind(ctx.c, String(ctx.body.id || ''), ctx.me.id).first();
  if (!l) fail('There is no loan waiting for your changes.', 'not_found', 404);
  const g = await loadGroup(ctx), cents = ctx.body.amount ? toCents(ctx.body.amount) : l.principal_cents, months = Math.max(1, Math.min(60, Math.round(Number(ctx.body.months) || l.months)));
  if (!isFinite(cents) || cents <= 0) fail('Type the loan amount.');
  await ctx.db.batch([ctx.db.prepare("UPDATE chama_loan SET principal_cents = ?, interest_cents = ?, months = ?, purpose = ?, status = 'requested' WHERE client_id = ? AND id = ? AND status = 'changes'").bind(cents, Math.round(cents * g.settings.loans.interestPct / 100), months, strOf(ctx.body, 'purpose', 200) || l.purpose, ctx.c, l.id), auditStmt(ctx, `${ctx.me.name} changed and re-sent a loan request`, 'loan:' + l.id)]);
  return {};
} };
A['guarantor.respond'] = { p: 'member', fn: async (ctx) => {
  const loanId = String(ctx.body.loanId || ''), accept = !!ctx.body.accept;
  const gr = await ctx.db.prepare("SELECT g.amount_cents, l.member_id, l.principal_cents, l.status FROM chama_guarantor g JOIN chama_loan l ON l.client_id = g.client_id AND l.id = g.loan_id WHERE g.client_id = ? AND g.loan_id = ? AND g.member_id = ? AND g.status = 'pending'").bind(ctx.c, loanId, ctx.me.id).first();
  if (!gr) fail('There is no guarantor request waiting for you on that loan.', 'not_found', 404);
  await ctx.db.batch([ctx.db.prepare("UPDATE chama_guarantor SET status = ?, responded_at = ? WHERE client_id = ? AND loan_id = ? AND member_id = ? AND status = 'pending'").bind(accept ? 'accepted' : 'rejected', Date.now(), ctx.c, loanId, ctx.me.id), noteStmt(ctx, gr.member_id, 'guarantor', accept ? 'A guarantor accepted' : 'A guarantor declined', `${ctx.me.name} ${accept ? 'agreed to guarantee' : 'declined to guarantee'} your ${kes(gr.principal_cents)} loan.`), auditStmt(ctx, `${ctx.me.name} ${accept ? 'accepted' : 'rejected'} a guarantor request`, 'loan:' + loanId)]);
  return {};
} };
A['loan.mine'] = { p: 'member', fn: async (ctx) => {
  const rep = await repaidByLoan(ctx, ctx.me.id);
  const loans = rows(await ctx.db.prepare('SELECT * FROM chama_loan WHERE client_id = ? AND member_id = ? ORDER BY requested_at DESC LIMIT 20').bind(ctx.c, ctx.me.id).all());
  const out = []; for (const l of loans) out.push({ ...loanOut(l, rep[l.id]), guarantors: await loanGuarantors(ctx, l.id) });
  const asG = rows(await ctx.db.prepare("SELECT g.loan_id, g.amount_cents, l.principal_cents, m.name FROM chama_guarantor g JOIN chama_loan l ON l.client_id = g.client_id AND l.id = g.loan_id JOIN chama_member m ON m.client_id = l.client_id AND m.id = l.member_id WHERE g.client_id = ? AND g.member_id = ? AND g.status = 'pending'").bind(ctx.c, ctx.me.id).all());
  return { loans: out, guarantorRequests: asG.map((x) => ({ loanId: x.loan_id, borrower: x.name, loanCents: x.principal_cents, guaranteeCents: x.amount_cents })) };
} };
A['loan.list'] = { p: 'loans', fn: async (ctx) => {
  const st = ['requested', 'changes', 'approved', 'active', 'cleared', 'rejected'].includes(ctx.body.status) ? ctx.body.status : '';
  const names = {}; rows(await ctx.db.prepare('SELECT id, name FROM chama_member WHERE client_id = ?').bind(ctx.c).all()).forEach((m) => { names[m.id] = m.name; });
  const rep = await repaidByLoan(ctx, null);
  const r = rows(await ctx.db.prepare(`SELECT * FROM chama_loan WHERE client_id = ? ${st ? 'AND status = ?' : ''} ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'changes' THEN 1 WHEN 'approved' THEN 2 WHEN 'active' THEN 3 ELSE 4 END, requested_at DESC LIMIT 100`).bind(...(st ? [ctx.c, st] : [ctx.c])).all());
  const out = []; for (const l of r) out.push({ ...loanOut(l, rep[l.id], (id) => names[id]), guarantors: l.status === 'requested' || l.status === 'changes' || l.status === 'approved' ? await loanGuarantors(ctx, l.id) : [] });
  return { loans: out };
} };
A['loan.decide'] = { p: 'loans', fn: async (ctx) => {
  const b = ctx.body, l = await ctx.db.prepare("SELECT l.*, m.name FROM chama_loan l JOIN chama_member m ON m.client_id = l.client_id AND m.id = l.member_id WHERE l.client_id = ? AND l.id = ? AND l.status IN ('requested','changes')").bind(ctx.c, String(b.id || '')).first();
  if (!l) fail('That loan is not waiting for a decision.', 'already_done', 409);
  const d = b.decision, note = strOf(b, 'note', 200); if (!['approve', 'reject', 'changes'].includes(d)) fail('Choose approve, reject or ask for changes.');
  if (d !== 'approve' && !note) fail('Add a short note for the member.');
  if (d === 'approve') {
    const gs = await loanGuarantors(ctx, l.id);
    if (gs.some((x) => x.status === 'rejected')) fail('A guarantor declined. Ask the member to choose another, or reject the loan.', 'guarantor', 409);
    if (gs.some((x) => x.status === 'pending')) fail('Some guarantors have not answered yet.', 'guarantor', 409);
    const g = await loadGroup(ctx); if (g.settings.loans.guarantors > gs.length) fail('This loan does not have enough guarantors.', 'guarantor', 409);
  }
  const status = d === 'approve' ? 'approved' : d === 'reject' ? 'rejected' : 'changes', msg = d === 'approve' ? `Your ${kes(l.principal_cents)} loan was approved. The treasurer will pay it out.` : d === 'reject' ? `Your ${kes(l.principal_cents)} loan request was not approved. ${note}` : `Please change your ${kes(l.principal_cents)} loan request: ${note}`;
  await ctx.db.batch([ctx.db.prepare("UPDATE chama_loan SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE client_id = ? AND id = ? AND status IN ('requested','changes')").bind(status, ctx.me.id, Date.now(), note || null, ctx.c, l.id), noteStmt(ctx, l.member_id, 'loan', status === 'approved' ? 'Loan approved' : status === 'rejected' ? 'Loan not approved' : 'Loan: changes needed', msg), auditStmt(ctx, `${ctx.me.name} ${status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'asked for changes to'} ${l.name}'s ${kes(l.principal_cents)} loan`, 'loan:' + l.id, { status: l.status }, { status })]);
  return { status };
} };
A['loan.disburse'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, l = await ctx.db.prepare("SELECT l.*, m.name FROM chama_loan l JOIN chama_member m ON m.client_id = l.client_id AND m.id = l.member_id WHERE l.client_id = ? AND l.id = ? AND l.status = 'approved'").bind(ctx.c, String(b.id || '')).first();
  if (!l) fail('That loan is not approved, or was already paid out.', 'already_done', 409);
  const date = isDate(b.date) ? b.date : todayKey(), fund = await fundFor(ctx, 'loan'), idem = 'loan:disb:' + l.id;
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, method, reference, created_by, idem_key) SELECT ?,?,?,?, 'loan_disbursement', ?,?,?, 'loan', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chama_loan WHERE client_id = ? AND id = ? AND status = 'approved')").bind(ctx.c, uid(), Date.now(), date, fund, l.member_id, -l.principal_cents, l.id, strOf(b, 'method', 20) || 'mpesa', strOf(b, 'reference', 60) || null, ctx.me.id, idem, ctx.c, l.id),
    ctx.db.prepare("UPDATE chama_loan SET status = 'active', disbursed_at = ?, disburse_date = ? WHERE client_id = ? AND id = ? AND status = 'approved'").bind(Date.now(), date, ctx.c, l.id),
    noteStmt(ctx, l.member_id, 'loan', 'Loan paid out', `${kes(l.principal_cents)} was paid out to you. You will repay ${kes(l.principal_cents + l.interest_cents)} over ${l.months} month${l.months === 1 ? '' : 's'}.`),
    auditStmt(ctx, `${ctx.me.name} paid out ${kes(l.principal_cents)} to ${l.name}`, 'loan:' + l.id, { status: 'approved' }, { status: 'active' }),
  ]);
  const chk = await ctx.db.prepare("SELECT status FROM chama_loan WHERE client_id = ? AND id = ?").bind(ctx.c, l.id).first();
  if (!chk || chk.status !== 'active') fail('This loan was just handled by someone else.', 'already_done', 409);
  return {};
} };
A['loan.get'] = { p: 'member', fn: async (ctx) => {
  const l = await ctx.db.prepare('SELECT * FROM chama_loan WHERE client_id = ? AND id = ?').bind(ctx.c, String(ctx.body.id || '')).first();
  if (!l || (l.member_id !== ctx.me.id && !can(ctx.me, 'loans') && !can(ctx.me, 'money'))) fail('That loan was not found.', 'not_found', 404);
  const rep = await repaidByLoan(ctx, l.member_id);
  const pay = rows(await ctx.db.prepare("SELECT entry_date, amount_cents, reference, reversal_of FROM chama_ledger WHERE client_id = ? AND kind = 'loan_repayment' AND ref_id = ? ORDER BY ts DESC LIMIT 50").bind(ctx.c, l.id).all());
  return { loan: { ...loanOut(l, rep[l.id]), guarantors: await loanGuarantors(ctx, l.id) }, repayments: pay.map((x) => ({ dateText: niceDate(x.entry_date, true), amountCents: x.amount_cents, reference: x.reference || '', reversal: !!x.reversal_of })) };
} };

// ---------- merry-go-round ----------
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const r = new Uint32Array(1); crypto.getRandomValues(r); const j = r[0] % (i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }
A['mgr.save'] = { p: 'money', fn: async (ctx) => {
  const g = await loadGroup(ctx); if (!g.settings.features.mgr) fail('The merry-go-round is not switched on. Turn it on in Settings.');
  const b = ctx.body, cents = toCents(b.perMember), name = strOf(b, 'name', 80) || 'Merry-go-round';
  if (!isFinite(cents) || cents <= 0) fail('Type how much each member gives per turn.');
  const every = Math.max(1, Math.min(365, Math.round(Number(b.everyDays) || 7)));
  if (!isDate(b.startDate)) fail('Pick the date of the first turn.');
  const open = await ctx.db.prepare("SELECT id FROM chama_mgr WHERE client_id = ? AND status = 'active'").bind(ctx.c).first(); if (open) fail('A merry-go-round is already running. Close it first.', 'exists', 409);
  const active = rows(await ctx.db.prepare("SELECT id FROM chama_member WHERE client_id = ? AND status = 'active' ORDER BY joined_at, name").bind(ctx.c).all()).map((x) => x.id);
  let order = active;
  const mode = ['fixed', 'random', 'admin', 'custom'].includes(b.orderMode) ? b.orderMode : 'fixed';
  if (mode === 'random') order = shuffle(active);
  else if ((mode === 'admin' || mode === 'custom') && Array.isArray(b.order)) { const want = b.order.map(String).filter((x, i, a) => active.includes(x) && a.indexOf(x) === i); order = want.concat(active.filter((x) => !want.includes(x))); }
  if (order.length < 2) fail('You need at least two members for a merry-go-round.');
  const id = uid(), expected = cents * order.length, stmts = [ctx.db.prepare("INSERT INTO chama_mgr (client_id, id, name, per_member_cents, every_days, start_date, order_mode, status, created_at) VALUES (?,?,?,?,?,?,?, 'active', ?)").bind(ctx.c, id, name, cents, every, b.startDate, mode, Date.now())];
  order.forEach((mid, i) => stmts.push(ctx.db.prepare("INSERT INTO chama_mgr_turn (client_id, id, mgr_id, seq, member_id, due_date, expected_cents, status) VALUES (?,?,?,?,?,?,?, 'open')").bind(ctx.c, uid(), id, i + 1, mid, addDays(b.startDate, every * i), expected)));
  stmts.push(noteStmt(ctx, null, 'mgr', '🔄 Merry-go-round started', `${name}: each member gives ${kes(cents)} every ${every === 7 ? 'week' : every + ' days'}. See the order under Merry-go-round.`), auditStmt(ctx, `${ctx.me.name} started the merry-go-round "${name}" (${order.length} members, ${kes(cents)} each)`, 'mgr:' + id));
  await runBatches(ctx, stmts, 80);
  return { id, turns: order.length };
} };
A['mgr.get'] = { p: 'member', fn: async (ctx) => {
  const g = await loadGroup(ctx); if (!g.settings.features.mgr) return { mgr: null };
  const m = await ctx.db.prepare("SELECT * FROM chama_mgr WHERE client_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(ctx.c).first();
  if (!m) return { mgr: null };
  const staff = can(ctx.me, 'money') || can(ctx.me, 'payments'), show = staff || g.settings.privacy.showRecipient;
  const t = rows(await ctx.db.prepare(`SELECT t.id, t.seq, t.member_id, t.due_date, t.expected_cents, t.status, mm.name,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_contribution' AND l.ref_type = 'mgr_turn' AND l.ref_id = t.id), 0) AS collected,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_payout' AND l.ref_id = t.id), 0) AS payout
    FROM chama_mgr_turn t JOIN chama_member mm ON mm.client_id = t.client_id AND mm.id = t.member_id WHERE t.client_id = ? AND t.mgr_id = ? ORDER BY t.seq`).bind(ctx.c, m.id).all());
  const next = t.find((x) => x.status === 'open') || null;
  const turns = t.map((x) => ({ id: x.id, seq: x.seq, name: show || x.member_id === ctx.me.id ? x.name : 'A member', isMe: x.member_id === ctx.me.id, dueText: niceDate(x.due_date, true), status: x.status, expectedCents: x.expected_cents, ...(staff ? { collectedCents: x.collected, payoutCents: -x.payout } : {}) }));
  let who = null;
  if (next && staff) who = rows(await ctx.db.prepare(`SELECT mm.id, mm.name, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = mm.client_id AND l.kind = 'mgr_contribution' AND l.ref_id = ? AND l.member_id = mm.id), 0) AS paid FROM chama_member mm WHERE mm.client_id = ? AND mm.status = 'active' ORDER BY mm.name`).bind(next.id, ctx.c).all()).map((x) => ({ memberId: x.id, name: x.name, paidCents: x.paid, remainingCents: Math.max(0, m.per_member_cents - x.paid) }));
  return { mgr: { id: m.id, name: m.name, perMemberCents: m.per_member_cents, everyDays: m.every_days }, turns, next: next ? { id: next.id, name: show || next.member_id === ctx.me.id ? next.name : 'A member', isMe: next.member_id === ctx.me.id, dueText: niceDate(next.due_date, true), expectedCents: next.expected_cents, ...(staff ? { collectedCents: next.collected, outstandingCents: Math.max(0, next.expected_cents - next.collected) } : {}) } : null, members: who, staff };
} };
A['mgr.payout'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, t = await ctx.db.prepare("SELECT t.*, m.name FROM chama_mgr_turn t JOIN chama_member m ON m.client_id = t.client_id AND m.id = t.member_id WHERE t.client_id = ? AND t.id = ? AND t.status = 'open'").bind(ctx.c, String(b.turnId || '')).first();
  if (!t) fail('That turn was already paid out.', 'already_done', 409);
  const col = await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM chama_ledger WHERE client_id = ? AND kind = 'mgr_contribution' AND ref_type = 'mgr_turn' AND ref_id = ?").bind(ctx.c, t.id).first();
  const cents = b.amount ? toCents(b.amount) : col.t;
  if (!isFinite(cents) || cents <= 0) fail('Nothing has been collected for this turn yet.');
  if (cents > col.t) fail(`Only ${kes(col.t)} has been collected, so ${kes(cents)} cannot be paid out.`, 'over_collected', 409);
  const date = isDate(b.date) ? b.date : todayKey(), fund = await fundFor(ctx, 'mgr');
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, method, reference, note, created_by, idem_key) SELECT ?,?,?,?, 'mgr_payout', ?,?,?, 'mgr_turn', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chama_mgr_turn WHERE client_id = ? AND id = ? AND status = 'open')").bind(ctx.c, uid(), Date.now(), date, fund, t.member_id, -cents, t.id, strOf(b, 'method', 20) || 'mpesa', strOf(b, 'reference', 60) || null, 'Approved by ' + (strOf(b, 'approvedBy', 80) || ctx.me.name), ctx.me.id, 'mgr:pay:' + t.id, ctx.c, t.id),
    ctx.db.prepare("UPDATE chama_mgr_turn SET status = 'paid_out' WHERE client_id = ? AND id = ? AND status = 'open'").bind(ctx.c, t.id),
    noteStmt(ctx, t.member_id, 'mgr', 'Merry-go-round: your turn', `${kes(cents)} was paid out to you.`),
    auditStmt(ctx, `${ctx.me.name} paid out ${kes(cents)} to ${t.name} (merry-go-round)`, 'mgr_turn:' + t.id),
  ]);
  const chk = await ctx.db.prepare('SELECT status FROM chama_mgr_turn WHERE client_id = ? AND id = ?').bind(ctx.c, t.id).first();
  if (!chk || chk.status !== 'paid_out') fail('This turn was just handled by someone else.', 'already_done', 409);
  return {};
} };
A['mgr.close'] = { p: 'money', fn: async (ctx) => { await ctx.db.batch([ctx.db.prepare("UPDATE chama_mgr SET status = 'closed' WHERE client_id = ? AND status = 'active'").bind(ctx.c), auditStmt(ctx, `${ctx.me.name} closed the merry-go-round`, 'mgr')]); return {}; } };

// ---------- fundraisers ----------
const FR_CATS = ['medical', 'funeral', 'wedding', 'school_fees', 'emergency', 'project', 'investment', 'other'];
A['fundraiser.save'] = { p: 'money', fn: async (ctx) => {
  const b = ctx.body, title = strOf(b, 'title', 100), cents = toCents(b.target);
  if (!title) fail('Give the fundraiser a title.');
  if (!isFinite(cents) || cents <= 0) fail('Type the target amount.');
  const cat = FR_CATS.includes(b.category) ? b.category : 'other', end = isDate(b.endDate) ? b.endDate : null, anon = b.allowAnonymous === false ? 0 : 1;
  if (b.id) { await ctx.db.batch([ctx.db.prepare('UPDATE chama_fundraiser SET title = ?, category = ?, note = ?, target_cents = ?, end_date = ?, allow_anonymous = ? WHERE client_id = ? AND id = ?').bind(title, cat, strOf(b, 'note', 600) || null, cents, end, anon, ctx.c, String(b.id)), auditStmt(ctx, `${ctx.me.name} edited the fundraiser "${title}"`, 'fundraiser:' + b.id)]); return { id: b.id }; }
  const id = uid();
  await ctx.db.batch([ctx.db.prepare("INSERT INTO chama_fundraiser (client_id, id, title, category, note, target_cents, end_date, allow_anonymous, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)").bind(ctx.c, id, title, cat, strOf(b, 'note', 600) || null, cents, end, anon, ctx.me.id, Date.now()), noteStmt(ctx, null, 'fundraiser', '💛 New fundraiser', `${title} — target ${kes(cents)}. Open Fundraisers to give.`), auditStmt(ctx, `${ctx.me.name} started the fundraiser "${title}" (${kes(cents)})`, 'fundraiser:' + id)]);
  return { id };
} };
A['fundraiser.close'] = { p: 'money', fn: async (ctx) => { await ctx.db.batch([ctx.db.prepare("UPDATE chama_fundraiser SET status = 'closed' WHERE client_id = ? AND id = ?").bind(ctx.c, String(ctx.body.id || '')), auditStmt(ctx, `${ctx.me.name} closed a fundraiser`, 'fundraiser:' + ctx.body.id)]); return {}; } };
A['fundraiser.list'] = { p: 'member', fn: async (ctx) => ({ fundraisers: await fundraiserList(ctx) }) };
A['fundraiser.get'] = { p: 'member', fn: async (ctx) => {
  const f = (await fundraiserList(ctx)).find((x) => x.id === String(ctx.body.id || '')); if (!f) fail('That fundraiser was not found.', 'not_found', 404);
  const staff = can(ctx.me, 'money') || can(ctx.me, 'payments');
  const rep = rows(await ctx.db.prepare(`SELECT l.member_id, m.name, SUM(l.amount_cents) AS t FROM chama_ledger l JOIN chama_member m ON m.client_id = l.client_id AND m.id = l.member_id WHERE l.client_id = ? AND l.kind = 'fundraising' AND l.ref_id = ? GROUP BY l.member_id ORDER BY t DESC LIMIT 100`).bind(ctx.c, f.id).all());
  const anon = new Set(rows(await ctx.db.prepare("SELECT DISTINCT member_id FROM chama_report WHERE client_id = ? AND kind = 'fundraiser' AND target_id = ? AND anonymous = 1 AND status = 'verified'").bind(ctx.c, f.id).all()).map((x) => x.member_id));
  const mine = rep.find((x) => x.member_id === ctx.me.id);
  return { fundraiser: f, myCents: mine ? mine.t : 0, givers: (staff ? rep : []).map((x) => ({ name: anon.has(x.member_id) ? 'Anonymous' : x.name, amountCents: x.t })), giverCount: rep.length };
} };

// ---------- statements and group reports ----------
async function statementOf(ctx, memberId) {
  const m = await memberById(ctx, memberId), g = await loadGroup(ctx), ctx2 = { ...ctx, me: ctx.me };
  await ensureCycles(ctx);
  const cur = await currentCycle(ctx), pos = cur ? await cyclePosition(ctx, cur.id, memberId) : null;
  const rep = await repaidByLoan(ctx, memberId);
  const loans = rows(await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND member_id = ? AND status IN ('active','cleared') ORDER BY requested_at DESC LIMIT 10").bind(ctx.c, memberId).all()).map((l) => loanOut(l, rep[l.id]));
  const att = await ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END),0) AS p FROM chama_attendance WHERE client_id = ? AND member_id = ?").bind(ctx.c, memberId).first();
  const recent = rows(await ctx.db.prepare("SELECT entry_date, amount_cents, kind, reference, reversal_of FROM chama_ledger WHERE client_id = ? AND member_id = ? AND kind IN ('contribution','loan_repayment','penalty','fundraising','mgr_contribution') ORDER BY ts DESC LIMIT 60").bind(ctx.c, memberId).all());
  void ctx2;
  return { group: g.name, name: m.name, phone: showPhone(m.phone), date: niceDate(todayKey(), true), totalContributedCents: await totalContributed(ctx, memberId), cycle: cur ? { label: cur.label, ...pos } : null, arrearsCents: await arrears(ctx, memberId), penaltiesCents: await owedPenalties(ctx, memberId), loans, attendance: { attended: att.p, total: att.n, percent: att.n ? Math.round(att.p / att.n * 100) : 0 },
    recent: recent.map((x) => ({ dateText: niceDate(x.entry_date, true), amountCents: x.amount_cents, type: (x.reversal_of ? 'Reversal of ' : '') + ({ contribution: 'Contribution', loan_repayment: 'Loan repayment', penalty: 'Penalty payment', fundraising: 'Fundraiser', mgr_contribution: 'Merry-go-round' }[x.kind] || x.kind), reference: x.reference || '' })) };
}
A['statement.mine'] = { p: 'member', fn: async (ctx) => statementOf(ctx, ctx.me.id) };
A['statement.member'] = { p: 'reports', fn: async (ctx) => statementOf(ctx, String(ctx.body.memberId || '')) };

const M = (c) => Math.round(c) / 100;   // cents -> KES numbers for the report tables (so a spreadsheet can add them up)
A['rpt.run'] = { p: 'reports', fn: async (ctx) => {
  await ensureCycles(ctx);
  const b = ctx.body, kind = String(b.kind || ''), from = isDate(b.from) ? b.from : '0000-01-01', to = isDate(b.to) ? b.to : '9999-12-31';
  const g = await loadGroup(ctx), name = g.name;
  const names = {}; rows(await ctx.db.prepare('SELECT id, name FROM chama_member WHERE client_id = ?').bind(ctx.c).all()).forEach((m) => { names[m.id] = m.name; });
  const T = (title, columns, data, totals) => ({ title: `${name} — ${title}`, columns, rows: data, totals: totals || null });
  if (kind === 'contribution' || kind === 'outstanding') {
    let cycleId = String(b.cycleId || ''); if (!cycleId) { const c = await currentCycle(ctx); cycleId = c ? c.id : ''; }
    if (!cycleId) return T('Contributions', ['Member'], []);
    const cy = await ctx.db.prepare('SELECT label FROM chama_cycle WHERE client_id = ? AND id = ?').bind(ctx.c, cycleId).first();
    const r = rows(await ctx.db.prepare(`SELECT m.name, o.required_cents AS req, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = o.client_id AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = o.cycle_id AND l.member_id = o.member_id), 0) AS paid FROM chama_obligation o JOIN chama_member m ON m.client_id = o.client_id AND m.id = o.member_id WHERE o.client_id = ? AND o.cycle_id = ? ORDER BY m.name`).bind(ctx.c, cycleId).all());
    const list = kind === 'outstanding' ? r.filter((x) => x.paid < x.req) : r;
    return T(kind === 'outstanding' ? `Outstanding contributions (${cy ? cy.label : ''})` : `Contributions (${cy ? cy.label : ''})`, ['Member', 'Required', 'Paid', 'Remaining', 'Status'], list.map((x) => [x.name, M(x.req), M(x.paid), M(Math.max(0, x.req - x.paid)), statusOf(x.req, x.paid)]), ['Total', M(list.reduce((a, x) => a + x.req, 0)), M(list.reduce((a, x) => a + x.paid, 0)), M(list.reduce((a, x) => a + Math.max(0, x.req - x.paid), 0)), '']);
  }
  if (kind === 'member') {
    const r = rows(await ctx.db.prepare("SELECT m.name, COALESCE(SUM(l.amount_cents), 0) AS t, COUNT(l.id) AS n FROM chama_member m LEFT JOIN chama_ledger l ON l.client_id = m.client_id AND l.member_id = m.id AND l.kind = 'contribution' AND l.entry_date BETWEEN ? AND ? WHERE m.client_id = ? AND m.status = 'active' GROUP BY m.id ORDER BY m.name").bind(from, to, ctx.c).all());
    return T('Member contributions', ['Member', 'Total contributed', 'Entries'], r.map((x) => [x.name, M(x.t), x.n]), ['Total', M(r.reduce((a, x) => a + x.t, 0)), '']);
  }
  if (kind === 'loans' || kind === 'repayments') {
    const rep = await repaidByLoan(ctx, null), l = rows(await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND status IN ('active','cleared') ORDER BY requested_at DESC").bind(ctx.c).all()).map((x) => loanOut(x, rep[x.id], (id) => names[id]));
    if (kind === 'loans') return T('Loans', ['Member', 'Borrowed', 'Interest', 'Repaid', 'Outstanding', 'Overdue', 'Status'], l.map((x) => [x.memberName, M(x.principalCents), M(x.interestCents), M(x.repaidCents), M(x.outstandingCents), M(x.overdueCents), x.status]), ['Total', M(l.reduce((a, x) => a + x.principalCents, 0)), M(l.reduce((a, x) => a + x.interestCents, 0)), M(l.reduce((a, x) => a + x.repaidCents, 0)), M(l.reduce((a, x) => a + x.outstandingCents, 0)), M(l.reduce((a, x) => a + x.overdueCents, 0)), '']);
    const r = rows(await ctx.db.prepare("SELECT entry_date, member_id, amount_cents, reference FROM chama_ledger WHERE client_id = ? AND kind = 'loan_repayment' AND entry_date BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000").bind(ctx.c, from, to).all());
    return T('Loan repayments', ['Date', 'Member', 'Amount', 'Reference'], r.map((x) => [x.entry_date, names[x.member_id] || '', M(x.amount_cents), x.reference || '']), ['Total', '', M(r.reduce((a, x) => a + x.amount_cents, 0)), '']);
  }
  if (kind === 'mgr') {
    const r = rows(await ctx.db.prepare(`SELECT t.seq, t.member_id, t.due_date, t.expected_cents, t.status, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_contribution' AND l.ref_id = t.id), 0) AS col, COALESCE((SELECT -SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_payout' AND l.ref_id = t.id), 0) AS paid FROM chama_mgr_turn t JOIN chama_mgr g ON g.client_id = t.client_id AND g.id = t.mgr_id WHERE t.client_id = ? AND g.status = 'active' ORDER BY t.seq`).bind(ctx.c).all());
    return T('Merry-go-round', ['Turn', 'Recipient', 'Date', 'Expected', 'Collected', 'Paid out', 'Status'], r.map((x) => [x.seq, names[x.member_id] || '', x.due_date, M(x.expected_cents), M(x.col), M(x.paid), x.status === 'paid_out' ? 'Paid out' : 'Open']));
  }
  if (kind === 'fundraising') { const f = await fundraiserList(ctx); return T('Fundraisers', ['Fundraiser', 'Target', 'Raised', 'Remaining', 'Status'], f.map((x) => [x.title, M(x.targetCents), M(x.raisedCents), M(x.remainingCents), x.status]), ['Total', M(f.reduce((a, x) => a + x.targetCents, 0)), M(f.reduce((a, x) => a + x.raisedCents, 0)), M(f.reduce((a, x) => a + x.remainingCents, 0)), '']); }
  if (kind === 'attendance') {
    const r = rows(await ctx.db.prepare(`SELECT m.name, COUNT(a.member_id) AS n, COALESCE(SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END),0) AS p, COALESCE(SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END),0) AS ab FROM chama_member m LEFT JOIN chama_attendance a ON a.client_id = m.client_id AND a.member_id = m.id WHERE m.client_id = ? AND m.status = 'active' GROUP BY m.id ORDER BY m.name`).bind(ctx.c).all());
    return T('Attendance', ['Member', 'Meetings', 'Attended', 'Absent', 'Attendance %'], r.map((x) => [x.name, x.n, x.p, x.ab, x.n ? Math.round(x.p / x.n * 100) : 0]));
  }
  if (kind === 'penalties') {
    const r = rows(await ctx.db.prepare(`SELECT p.member_id, p.kind, p.amount_cents, p.status, p.reason, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0) AS paid FROM chama_penalty p WHERE p.client_id = ? ORDER BY p.created_at DESC LIMIT 1000`).bind(ctx.c).all());
    return T('Penalties', ['Member', 'Reason', 'Amount', 'Paid', 'Status'], r.map((x) => [names[x.member_id] || '', x.reason || x.kind, M(x.amount_cents), M(x.paid), x.status]), ['Total', '', M(r.filter((x) => x.status === 'open').reduce((a, x) => a + x.amount_cents, 0)), M(r.reduce((a, x) => a + x.paid, 0)), '']);
  }
  if (kind === 'expenses') {
    const r = rows(await ctx.db.prepare("SELECT entry_date, amount_cents, note, reference, fund_id FROM chama_ledger WHERE client_id = ? AND kind = 'expense' AND entry_date BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000").bind(ctx.c, from, to).all());
    return T('Expenses', ['Date', 'What for', 'Reference', 'Amount'], r.map((x) => [x.entry_date, x.note || '', x.reference || '', M(-x.amount_cents)]), ['Total', '', '', M(-r.reduce((a, x) => a + x.amount_cents, 0))]);
  }
  if (kind === 'funds') {
    const r = rows(await ctx.db.prepare(`SELECT f.name, COALESCE(SUM(CASE WHEN l.amount_cents > 0 THEN l.amount_cents END),0) AS inn, COALESCE(-SUM(CASE WHEN l.amount_cents < 0 THEN l.amount_cents END),0) AS out, COALESCE(SUM(l.amount_cents),0) AS bal FROM chama_fund f LEFT JOIN chama_ledger l ON l.client_id = f.client_id AND l.fund_id = f.id WHERE f.client_id = ? GROUP BY f.id ORDER BY f.rowid`).bind(ctx.c).all());
    return T('Fund balances', ['Fund', 'Money in', 'Money out', 'Balance'], r.map((x) => [x.name, M(x.inn), M(x.out), M(x.bal)]), ['Total', M(r.reduce((a, x) => a + x.inn, 0)), M(r.reduce((a, x) => a + x.out, 0)), M(r.reduce((a, x) => a + x.bal, 0))]);
  }
  if (kind === 'ledger') {
    const r = rows(await ctx.db.prepare("SELECT l.entry_date, l.kind, l.member_id, l.amount_cents, l.reference, l.note, l.reversal_of FROM chama_ledger l WHERE l.client_id = ? AND l.entry_date BETWEEN ? AND ? ORDER BY l.ts, l.rowid LIMIT 5000").bind(ctx.c, from, to).all());
    return T('Transaction ledger', ['Date', 'Type', 'Member', 'Amount (in +, out −)', 'Reference', 'Note'], r.map((x) => [x.entry_date, (x.reversal_of ? 'REVERSAL — ' : '') + x.kind, names[x.member_id] || '', M(x.amount_cents), x.reference || '', x.note || '']), ['Net', '', '', M(r.reduce((a, x) => a + x.amount_cents, 0)), '', '']);
  }
  // zip 224: printable ledgers with a RUNNING BALANCE (cash book), one member's ledger, one fund's ledger, income & expenditure, financial position
  if (kind === 'cashbook') {
    const fundId = String(b.fundId || ''), memberId = String(b.memberId || '');
    const w = ['client_id = ?'], a = [ctx.c];
    if (fundId) { w.push('fund_id = ?'); a.push(fundId); }
    if (memberId) { w.push('member_id = ?'); a.push(memberId); }
    const open = await ctx.db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM chama_ledger WHERE ${w.join(' AND ')} AND entry_date < ?`).bind(...a, from).first();
    const r = rows(await ctx.db.prepare(`SELECT entry_date, kind, member_id, amount_cents, reference, note, reversal_of FROM chama_ledger WHERE ${w.join(' AND ')} AND entry_date BETWEEN ? AND ? ORDER BY ts, rowid LIMIT 5000`).bind(...a, from, to).all());
    let bal = open ? open.s : 0, inn = 0, out = 0;
    const data = [['', 'Opening balance', '', '', '', M(bal), '']];
    r.forEach((x) => { bal += x.amount_cents; if (x.amount_cents > 0) inn += x.amount_cents; else out -= x.amount_cents; data.push([x.entry_date, (x.reversal_of ? 'REVERSAL — ' : '') + String(x.kind).replace(/_/g, ' '), names[x.member_id] || '', x.amount_cents > 0 ? M(x.amount_cents) : '', x.amount_cents < 0 ? M(-x.amount_cents) : '', M(bal), [x.reference, x.note].filter(Boolean).join(' · ')]); });
    let what = 'Cash book'; if (memberId) what = `Member ledger — ${names[memberId] || ''}`;
    if (fundId) { const f = await ctx.db.prepare('SELECT name FROM chama_fund WHERE client_id = ? AND id = ?').bind(ctx.c, fundId).first(); what = `Fund ledger — ${f ? f.name : ''}`; }
    return T(what, ['Date', 'Type', 'Member', 'Money in', 'Money out', 'Balance', 'Reference / note'], data, ['Totals', '', '', M(inn), M(out), M(bal), '']);
  }
  if (kind === 'income_expense') {
    const r = rows(await ctx.db.prepare("SELECT kind, COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM chama_ledger WHERE client_id = ? AND entry_date BETWEEN ? AND ? GROUP BY kind ORDER BY kind").bind(ctx.c, from, to).all());
    const INC = ['contribution', 'mgr_contribution', 'fundraising', 'penalty', 'loan_repayment'], EXP = ['expense', 'refund', 'loan_disbursement', 'mgr_payout'];
    const lab = (k) => String(k).replace(/_/g, ' ');
    const inc = r.filter((x) => INC.includes(x.kind)), exp = r.filter((x) => EXP.includes(x.kind)), oth = r.filter((x) => !INC.includes(x.kind) && !EXP.includes(x.kind));
    const ti = inc.reduce((n, x) => n + x.s, 0), te = exp.reduce((n, x) => n - x.s, 0), to2 = oth.reduce((n, x) => n + x.s, 0);
    const data = [['MONEY IN', '', ''], ...inc.map((x) => ['   ' + lab(x.kind), x.n, M(x.s)]), ['Total money in', '', M(ti)], ['MONEY OUT', '', ''], ...exp.map((x) => ['   ' + lab(x.kind), x.n, M(-x.s)]), ['Total money out', '', M(te)]];
    if (oth.length) { data.push(['TRANSFERS / ADJUSTMENTS (net)', '', M(to2)]); }
    return T('Income and expenditure', ['Item', 'Entries', 'KES'], data, ['Net surplus / (deficit)', '', M(ti - te + to2)]);
  }
  if (kind === 'position') {
    const funds = rows(await ctx.db.prepare('SELECT f.name, COALESCE(SUM(l.amount_cents),0) AS bal FROM chama_fund f LEFT JOIN chama_ledger l ON l.client_id = f.client_id AND l.fund_id = f.id AND l.entry_date <= ? WHERE f.client_id = ? GROUP BY f.id, f.name ORDER BY f.name').bind(to, ctx.c).all());
    const rep = await repaidByLoan(ctx, null), loans = rows(await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND status = 'active'").bind(ctx.c).all()).map((x) => loanOut(x, rep));
    const owed = loans.reduce((n, l) => n + l.outstandingCents, 0), cash = funds.reduce((n, f) => n + f.bal, 0);
    const pen = await ctx.db.prepare("SELECT COALESCE(SUM(p.amount_cents - COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0)), 0) AS s FROM chama_penalty p WHERE p.client_id = ? AND p.status = 'open'").bind(ctx.c).first().catch(() => ({ s: 0 }));
    const data = [['WHAT THE GROUP HOLDS', ''], ...funds.map((f) => ['   ' + f.name, M(f.bal)]), ['Cash and funds', M(cash)], ['WHAT IS OWED TO THE GROUP', ''], ['   Loans still to be repaid (' + loans.length + ')', M(owed)], ['   Penalties still open', M((pen && pen.s) || 0)]];
    return T(`Financial position as at ${to === '9999-12-31' ? 'today' : to}`, ['Item', 'KES'], data, ['Total (cash + owed to the group)', M(cash + owed + ((pen && pen.s) || 0))]);
  }
  // zip 227: everything about ONE member — summary, deposits, loans + repayments, penalties, meeting attendance, every transaction with a running balance
  if (kind === 'member_full') {
    const mid = String(b.memberId || ''); if (!mid) fail('Choose a member.');
    const mem = await memberById(ctx, mid), tbl = (heading, columns, data, totals) => ({ heading, columns, rows: data, totals: totals || null });
    const led = rows(await ctx.db.prepare('SELECT entry_date, kind, amount_cents, reference, note, reversal_of, method FROM chama_ledger WHERE client_id = ? AND member_id = ? AND entry_date BETWEEN ? AND ? ORDER BY ts, rowid LIMIT 5000').bind(ctx.c, mid, from, to).all());
    const nice = (k) => String(k).replace(/_/g, ' ');
    const dep = led.filter((x) => ['contribution', 'mgr_contribution', 'fundraising'].includes(x.kind) && !x.reversal_of);
    const rep = await repaidByLoan(ctx, mid), loans = rows(await ctx.db.prepare("SELECT * FROM chama_loan WHERE client_id = ? AND member_id = ? ORDER BY requested_at DESC").bind(ctx.c, mid).all()).map((x) => loanOut(x, rep[x.id], (id) => names[id]));
    const pen = rows(await ctx.db.prepare("SELECT p.kind, p.amount_cents, p.status, p.reason, p.created_at, COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = p.client_id AND l.kind = 'penalty' AND l.ref_id = p.id), 0) AS paid FROM chama_penalty p WHERE p.client_id = ? AND p.member_id = ? ORDER BY p.created_at DESC").bind(ctx.c, mid).all());
    const att = rows(await ctx.db.prepare("SELECT m.meet_date, m.title, a.status FROM chama_attendance a JOIN chama_meeting m ON m.client_id = a.client_id AND m.id = a.meeting_id WHERE a.client_id = ? AND a.member_id = ? AND m.meet_date BETWEEN ? AND ? ORDER BY m.meet_date DESC").bind(ctx.c, mid, from, to).all());
    const present = att.filter((x) => x.status === 'present' || x.status === 'late').length;
    const totalDep = dep.reduce((n, x) => n + x.amount_cents, 0), repaid = loans.reduce((n, l) => n + l.repaidCents, 0), owed = loans.reduce((n, l) => n + (l.status === 'active' ? l.outstandingCents : 0), 0);
    let bal = 0;
    const all = led.map((x) => { bal += x.amount_cents; return [x.entry_date, (x.reversal_of ? 'REVERSAL — ' : '') + nice(x.kind), x.method || '', x.amount_cents > 0 ? M(x.amount_cents) : '', x.amount_cents < 0 ? M(-x.amount_cents) : '', M(bal), [x.reference, x.note].filter(Boolean).join(' · ')]; });
    const sections = [
      tbl('Summary', ['Item', 'Value'], [['Member', mem.name], ['Phone', mem.phone ? showPhone(mem.phone) : ''], ['Role', mem.role || ''], ['Status', mem.status || ''], ['Total deposits / contributions', M(totalDep)], ['Number of deposits', dep.length], ['Loans taken', loans.length], ['Total loan repayments', M(repaid)], ['Loan balance still owed', M(owed)], ['Penalties still open', M(pen.filter((x) => x.status === 'open').reduce((n, x) => n + Math.max(0, x.amount_cents - x.paid), 0))], ['Meetings marked', att.length], ['Meetings attended', present], ['Attendance %', att.length ? Math.round(present / att.length * 100) : 0]]),
      tbl('Deposit history', ['Date', 'Type', 'Reference', 'Amount'], dep.map((x) => [x.entry_date, nice(x.kind), x.reference || '', M(x.amount_cents)]), ['Total', '', '', M(totalDep)]),
      tbl('Loan history', ['Requested', 'Borrowed', 'Interest', 'Repaid', 'Outstanding', 'Overdue', 'Status'], loans.map((x) => [(x.requestedAt ? new Date(Number(x.requestedAt) || x.requestedAt).toISOString().slice(0, 10) : ''), M(x.principalCents), M(x.interestCents), M(x.repaidCents), M(x.outstandingCents), M(x.overdueCents), x.status]), ['Total', M(loans.reduce((n, l) => n + l.principalCents, 0)), M(loans.reduce((n, l) => n + l.interestCents, 0)), M(repaid), M(owed), '', '']),
      tbl('Loan repayments', ['Date', 'Reference', 'Amount'], led.filter((x) => x.kind === 'loan_repayment' && !x.reversal_of).map((x) => [x.entry_date, x.reference || '', M(x.amount_cents)])),
      tbl('Penalties', ['Date', 'Reason', 'Amount', 'Paid', 'Status'], pen.map((x) => [x.created_at ? new Date(x.created_at).toISOString().slice(0, 10) : '', x.reason || nice(x.kind), M(x.amount_cents), M(x.paid), x.status])),
      tbl('Meeting attendance', ['Date', 'Meeting', 'Status'], att.map((x) => [x.meet_date, x.title, x.status]), ['Attended', present + ' of ' + att.length, att.length ? Math.round(present / att.length * 100) + '%' : '']),
      tbl('Every transaction (running balance)', ['Date', 'Type', 'Method', 'Money in', 'Money out', 'Balance', 'Reference / note'], all, ['Net', '', '', '', '', M(bal), '']),
    ];
    return { title: `${name} — Member report: ${mem.name}`, sections, columns: [], rows: [], totals: null };
  }
  if (kind === 'meetings') {
    const r = rows(await ctx.db.prepare(`SELECT m.title, m.meeting_type, m.meet_date, m.status, m.location, COALESCE((SELECT COUNT(*) FROM chama_attendance a WHERE a.client_id = m.client_id AND a.meeting_id = m.id AND a.status IN ('present','late')),0) AS p, COALESCE((SELECT COUNT(*) FROM chama_attendance a WHERE a.client_id = m.client_id AND a.meeting_id = m.id),0) AS n, (SELECT status FROM chama_minutes x WHERE x.client_id = m.client_id AND x.meeting_id = m.id) AS mn FROM chama_meeting m WHERE m.client_id = ? AND m.meet_date BETWEEN ? AND ? ORDER BY m.meet_date DESC LIMIT 500`).bind(ctx.c, from, to).all());
    return T('Meetings', ['Date', 'Meeting', 'Place', 'Status', 'Present', 'Marked', 'Minutes'], r.map((x) => [x.meet_date, x.title, x.location || '', x.status, x.p, x.n, x.mn || 'none']));
  }
  fail('Choose a report.');
} };
export { KIND_TEXT };
