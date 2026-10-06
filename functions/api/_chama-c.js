// functions/api/_chama-c.js — Chama (zip 230), part 3 of the actions: a chama that is ALREADY RUNNING (merry-go-round position, last payout date,
// adjustable schedule with an audit trail, who has paid towards the next recipient), the contribution breakdown a member sees, and the set-up wizard
// for an existing chama. It adds to the same action table (A) as _chama-a.js / _chama-b.js; nothing in those parts was removed.
import {
  fail, toCents, kes, uid, todayKey, isDate, rows, niceDate, addDays, addMonths, loadGroup, auditStmt, noteStmt, fundFor, ensureCycles, currentCycle,
  can, canMgr, cleanSettings, statusOf, EAT_MS,
} from './_chama-core.js';
import { A, strOf, runBatches } from './_chama-a.js';

const dayNum = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
const shuffle = (a) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
// one step of the schedule: whole months when the chama pays "every 2 months", otherwise days
export const stepDate = (date, everyMonths, everyDays, k = 1) => (everyMonths > 0 ? addMonths(date, everyMonths * k, Number(date.slice(8, 10))) : addDays(date, everyDays * k));
// the time left until a date, by the real clock in Nairobi (never a number typed in by anyone)
export function countdown(due, now = Date.now()) {
  if (!isDate(due)) return null;
  const today = todayKey(now), days = dayNum(due) - dayNum(today);
  const ms = Date.parse(due + 'T00:00:00+03:00') - now;
  return { days, hours: Math.max(0, Math.floor(ms / 3600000)), overdue: days < 0, today: days === 0, text: days > 1 ? `${days} days` : days === 1 ? '1 day' : days === 0 ? 'Today' : `${-days} day${days === -1 ? '' : 's'} overdue` };
}
const needMgr = (ctx) => { if (!canMgr(ctx.me)) fail('You do not have permission to do that.', 'forbidden', 403); };
const activeMembers = async (ctx) => rows(await ctx.db.prepare("SELECT id, name FROM chama_member WHERE client_id = ? AND status = 'active' ORDER BY joined_at, name").bind(ctx.c).all());

// ===================================================== merry-go-round: start a NEW one or take over one that is already running =====================
// body: { name, perMember, everyDays | everyMonths, startDate (first turn, a new one) , ongoing, received: [member ids who already got their turn, in order],
//         lastPayoutDate, nextDate (optional: overrides the calculated next date), orderMode, order: [member ids for the turns still to come],
//         opening: { memberId: amount already collected for the next recipient } }
A['mgr.save'] = { p: 'member', fn: async (ctx) => {
  needMgr(ctx);
  const g = await loadGroup(ctx); if (!g.settings.features.mgr) fail('The merry-go-round is not switched on. Turn it on in Settings.');
  const b = ctx.body, cents = toCents(b.perMember), name = strOf(b, 'name', 80) || 'Merry-go-round';
  if (!isFinite(cents) || cents <= 0) fail('Type how much each member gives per turn.');
  const everyMonths = Math.max(0, Math.min(24, Math.round(Number(b.everyMonths) || 0)));
  const everyDays = everyMonths > 0 ? 0 : Math.max(1, Math.min(365, Math.round(Number(b.everyDays) || 7)));
  const open = await ctx.db.prepare("SELECT id FROM chama_mgr WHERE client_id = ? AND status = 'active'").bind(ctx.c).first();
  if (open) fail('A merry-go-round is already running. Close it first.', 'exists', 409);
  const members = await activeMembers(ctx), active = members.map((x) => x.id), nameOf = (id) => (members.find((x) => x.id === id) || {}).name || '';
  if (members.length < 2) fail('You need at least two members for a merry-go-round.');
  const ongoing = !!b.ongoing;
  const received = ongoing ? (Array.isArray(b.received) ? b.received.map(String).filter((x, i, a) => active.includes(x) && a.indexOf(x) === i) : []) : [];
  if (received.length >= active.length) fail('Every member has already received - there is nobody left for the next turn. Start a new round instead.');
  const mode = ['fixed', 'random', 'admin', 'custom'].includes(b.orderMode) ? b.orderMode : 'fixed';
  const left = active.filter((x) => !received.includes(x));
  let rest = left;
  if (mode === 'random') rest = shuffle(left);
  else if ((mode === 'admin' || mode === 'custom') && Array.isArray(b.order)) { const want = b.order.map(String).filter((x, i, a) => left.includes(x) && a.indexOf(x) === i); rest = want.concat(left.filter((x) => !want.includes(x))); }
  // ---- dates ----
  let last = isDate(b.lastPayoutDate) ? b.lastPayoutDate : '', next = '';
  if (ongoing) {
    if (received.length && !last) fail('Say the date the last member received their money.');
    next = isDate(b.nextDate) ? b.nextDate : (last ? stepDate(last, everyMonths, everyDays) : (isDate(b.startDate) ? b.startDate : ''));
    if (!next) fail('Say when the next payout is expected.');
  } else {
    if (!isDate(b.startDate)) fail('Pick the date of the first turn.');
    next = b.startDate;
  }
  const mgrId = uid(), perPool = cents * active.length, turnIds = {};
  const order = received.concat(rest);
  const stmts = [ctx.db.prepare("INSERT INTO chama_mgr (client_id, id, name, per_member_cents, every_days, start_date, order_mode, status, created_at, every_months, last_payout_date, ongoing) VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?, ?)")
    .bind(ctx.c, mgrId, name, cents, everyDays || 7, ongoing && received.length ? (stepDate(last, everyMonths, everyDays, -(received.length - 1)) || next) : next, mode, Date.now(), everyMonths, last || null, ongoing ? 1 : 0)];
  order.forEach((mid, i) => {
    const isDone = i < received.length, tid = uid(); turnIds[mid] = tid;
    const due = isDone ? stepDate(last, everyMonths, everyDays, -(received.length - 1 - i)) : stepDate(next, everyMonths, everyDays, i - received.length);
    stmts.push(ctx.db.prepare("INSERT INTO chama_mgr_turn (client_id, id, mgr_id, seq, member_id, due_date, expected_cents, status, opening, due_original, paid_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(ctx.c, tid, mgrId, i + 1, mid, due, perPool, isDone ? 'paid_out' : 'open', isDone ? 1 : 0, due, isDone ? due : null));
  });
  // money already collected for the next recipient before the chama started using the system (real money, recorded once, labelled as opening)
  const nextMember = rest[0];
  let openingTotal = 0;
  if (ongoing && b.opening && typeof b.opening === 'object' && nextMember) {
    const fund = await fundFor(ctx, 'mgr');
    for (const [mid, amt] of Object.entries(b.opening)) {
      if (!active.includes(mid)) continue;
      const c = toCents(amt); if (!isFinite(c) || c <= 0) continue;
      if (c > cents * 50) fail(`${kes(c)} is far more than one share. Check the amount for ${nameOf(mid)}.`);
      openingTotal += c;
      stmts.push(ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, method, reference, note, created_by, idem_key) VALUES (?,?,?,?, 'mgr_contribution', ?,?,?, 'mgr_turn', ?, 'opening', NULL, ?, ?, ?)")
        .bind(ctx.c, uid(), Date.now(), todayKey(), fund, mid, c, turnIds[nextMember], 'Collected before the chama started using the system', ctx.me.id, `open:${mgrId}:${mid}`));
    }
  }
  const desc = ongoing ? `already running: ${received.length} of ${order.length} have received, next is ${nameOf(nextMember)} on ${niceDate(next, true)}` : `new: first turn ${niceDate(next, true)}`;
  stmts.push(noteStmt(ctx, null, 'mgr', '🔄 Merry-go-round', `${name}: each member gives ${kes(cents)}${everyMonths ? ' every ' + (everyMonths === 1 ? 'month' : everyMonths + ' months') : ' every ' + (everyDays === 7 ? 'week' : everyDays + ' days')}. Next recipient: ${nameOf(nextMember)}.`),
    auditStmt(ctx, `${ctx.me.name} set up the merry-go-round "${name}" (${desc})`, 'mgr:' + mgrId, null, { perMemberCents: cents, everyMonths, everyDays, lastPayoutDate: last || null, nextDate: next, received: received.map(nameOf), openingCollectedCents: openingTotal }));
  await runBatches(ctx, stmts, 80);
  return { id: mgrId, turns: order.length, completed: received.length, remaining: order.length - received.length, nextRecipient: nameOf(nextMember), nextDate: next };
} };

// ===================================================== the status card (members) + the collection list (officials) =================================
async function turnRows(ctx, mgrId) {
  return rows(await ctx.db.prepare(`SELECT t.id, t.seq, t.member_id, t.due_date, t.due_original, t.paid_date, t.expected_cents, t.status, t.opening, mm.name,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_contribution' AND l.ref_type = 'mgr_turn' AND l.ref_id = t.id), 0) AS collected,
      COALESCE((SELECT SUM(l.amount_cents) FROM chama_ledger l WHERE l.client_id = t.client_id AND l.kind = 'mgr_payout' AND l.ref_id = t.id), 0) AS payout
    FROM chama_mgr_turn t JOIN chama_member mm ON mm.client_id = t.client_id AND mm.id = t.member_id WHERE t.client_id = ? AND t.mgr_id = ? ORDER BY t.seq`).bind(ctx.c, mgrId).all());
}
A['mgr.status'] = { p: 'member', fn: async (ctx) => {
  const g = await loadGroup(ctx); if (!g.settings.features.mgr) return { mgr: null };
  const m = await ctx.db.prepare("SELECT * FROM chama_mgr WHERE client_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(ctx.c).first();
  if (!m) return { mgr: null, canManage: canMgr(ctx.me), canPay: can(ctx.me, 'money') || canMgr(ctx.me) };
  const staff = canMgr(ctx.me), show = staff || g.settings.privacy.showRecipient;
  const t = await turnRows(ctx, m.id), next = t.find((x) => x.status === 'open') || null;
  const done = t.filter((x) => x.status === 'paid_out').length;
  const now = Date.now(), pool = next ? next.expected_cents : m.per_member_cents * t.length;
  const mine = next ? await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM chama_ledger WHERE client_id = ? AND kind = 'mgr_contribution' AND ref_id = ? AND member_id = ?").bind(ctx.c, next.id, ctx.me.id).first() : null;
  const myPending = next ? await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM chama_report WHERE client_id = ? AND kind = 'mgr' AND status = 'pending' AND member_id = ? AND (target_id = ? OR target_id IS NULL)").bind(ctx.c, ctx.me.id, next.id).first() : null;
  const card = next ? {
    turnId: next.id, name: show || next.member_id === ctx.me.id ? next.name : 'A member', isMe: next.member_id === ctx.me.id,
    expectedCents: pool, collectedCents: next.collected, outstandingCents: Math.max(0, pool - next.collected),
    dueDate: next.due_date, dueText: niceDate(next.due_date, true), originalDueText: next.due_original && next.due_original !== next.due_date ? niceDate(next.due_original, true) : '',
    countdown: countdown(next.due_date, now),
    myShareCents: m.per_member_cents, myPaidCents: mine.t, myPendingCents: myPending.t, myRemainingCents: Math.max(0, m.per_member_cents - mine.t),
  } : null;
  const out = {
    mgr: { id: m.id, name: m.name, perMemberCents: m.per_member_cents, everyDays: m.every_days, everyMonths: m.every_months || 0, lastPayoutDate: m.last_payout_date || '', lastPayoutText: m.last_payout_date ? niceDate(m.last_payout_date, true) : '' },
    completed: done, total: t.length, remaining: t.length - done, waiting: Math.max(0, t.length - done - 1), next: card, now, today: todayKey(now), canManage: staff, canPay: can(ctx.me, 'money') || staff,
    turns: t.map((x) => ({ id: x.id, seq: x.seq, name: show || x.member_id === ctx.me.id ? x.name : 'A member', isMe: x.member_id === ctx.me.id, status: x.status, opening: !!x.opening, dueText: niceDate(x.due_date, true), dueDate: x.due_date, paidText: x.paid_date ? niceDate(x.paid_date, true) : '' })),
  };
  if (staff && next) {
    const mem = await activeMembers(ctx);
    const paid = rows(await ctx.db.prepare("SELECT member_id, COALESCE(SUM(amount_cents),0) AS t FROM chama_ledger WHERE client_id = ? AND kind = 'mgr_contribution' AND ref_id = ? GROUP BY member_id").bind(ctx.c, next.id).all());
    const pend = rows(await ctx.db.prepare("SELECT member_id, COALESCE(SUM(amount_cents),0) AS t FROM chama_report WHERE client_id = ? AND kind = 'mgr' AND status = 'pending' AND (target_id = ? OR target_id IS NULL) GROUP BY member_id").bind(ctx.c, next.id).all());
    const p = {}, q = {}; paid.forEach((x) => { p[x.member_id] = x.t; }); pend.forEach((x) => { q[x.member_id] = x.t; });
    const req = m.per_member_cents;
    out.collection = mem.map((x) => { const pd = p[x.id] || 0, pe = q[x.id] || 0; const st = statusOf(req, pd); return { memberId: x.id, name: x.name, requiredCents: req, paidCents: pd, pendingCents: pe, remainingCents: Math.max(0, req - pd), status: st === 'not_started' && pe > 0 ? 'pending' : st }; });
  }
  return out;
} };

// ===================================================== adjusting the schedule (always with a reason, always audited) ===================================
// body: { field: 'nextDate' | 'recipient' | 'frequency' | 'perMember' | 'order' | 'lastPayoutDate', value..., reason, shiftLater }
A['mgr.adjust'] = { p: 'member', fn: async (ctx) => {
  needMgr(ctx);
  const b = ctx.body, reason = strOf(b, 'reason', 200), field = String(b.field || '');
  if (!reason) fail('Say why you are changing this (for example: "members agreed to postpone the meeting").', 'reason_needed', 400);
  const m = await ctx.db.prepare("SELECT * FROM chama_mgr WHERE client_id = ? AND status = 'active'").bind(ctx.c).first();
  if (!m) fail('There is no merry-go-round running.', 'not_found', 404);
  const t = await turnRows(ctx, m.id), openTurns = t.filter((x) => x.status === 'open'), next = openTurns[0];
  if (!next) fail('Every turn has been paid out.', 'done', 409);
  const stmts = []; let action = '', before = null, after = null;
  const shiftFrom = (list, firstDate) => list.forEach((x, i) => stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET due_date = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(stepDate(firstDate, m.every_months || 0, m.every_days, i), ctx.c, x.id)));
  if (field === 'nextDate') {
    if (!isDate(b.value)) fail('Pick a real date.');
    before = { dueDate: next.due_date, calculated: next.due_original || next.due_date }; after = { dueDate: b.value };
    if (b.shiftLater) shiftFrom(openTurns, b.value); else stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET due_date = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(b.value, ctx.c, next.id));
    action = `${ctx.me.name} moved ${next.name}'s payout from ${niceDate(next.due_date, true)} to ${niceDate(b.value, true)}${b.shiftLater ? ' (later turns moved too)' : ''}`;
  } else if (field === 'recipient') {
    const target = openTurns.find((x) => x.member_id === String(b.value || ''));
    if (!target) fail('Pick a member who has not received yet.');
    if (target.id === next.id) fail('That member is already next.');
    // swap the two turns (their dates stay with the turn, so the calendar does not move)
    before = { next: next.name }; after = { next: target.name };
    stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET member_id = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(target.member_id, ctx.c, next.id), ctx.db.prepare("UPDATE chama_mgr_turn SET member_id = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(next.member_id, ctx.c, target.id));
    const col = Number(next.collected) || 0; if (col > 0) fail(`${kes(col)} has already been collected for ${next.name}. Pay that turn out, or reverse the contributions, before changing who is next.`, 'collected', 409);
    action = `${ctx.me.name} changed the next recipient from ${next.name} to ${target.name}`;
  } else if (field === 'order') {
    const want = (Array.isArray(b.value) ? b.value : []).map(String), ids = openTurns.map((x) => x.member_id);
    if (want.length !== ids.length || !ids.every((x) => want.includes(x))) fail('The new order must list every member who is still waiting, once each.');
    if ((Number(next.collected) || 0) > 0 && want[0] !== next.member_id) fail(`${kes(next.collected)} has already been collected for ${next.name}, so ${next.name} must stay next.`, 'collected', 409);
    before = { order: openTurns.map((x) => x.name) };
    const nameOf = (id) => (openTurns.find((x) => x.member_id === id) || {}).name;
    openTurns.forEach((x, i) => stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET member_id = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(want[i], ctx.c, x.id)));
    after = { order: want.map(nameOf) }; action = `${ctx.me.name} changed the order of the turns still to come`;
  } else if (field === 'frequency') {
    const em = Math.max(0, Math.min(24, Math.round(Number(b.everyMonths) || 0))), ed = em > 0 ? 0 : Math.max(1, Math.min(365, Math.round(Number(b.everyDays) || 7)));
    before = { everyMonths: m.every_months || 0, everyDays: m.every_days }; after = { everyMonths: em, everyDays: ed || 7 };
    stmts.push(ctx.db.prepare('UPDATE chama_mgr SET every_months = ?, every_days = ? WHERE client_id = ? AND id = ?').bind(em, ed || 7, ctx.c, m.id));
    openTurns.forEach((x, i) => stmts.push(ctx.db.prepare("UPDATE chama_mgr_turn SET due_date = ? WHERE client_id = ? AND id = ? AND status = 'open'").bind(stepDate(next.due_date, em, ed || 7, i), ctx.c, x.id)));
    action = `${ctx.me.name} changed how often members receive (${em ? em + ' month(s)' : ed + ' day(s)'})`;
  } else if (field === 'perMember') {
    const c = toCents(b.value); if (!isFinite(c) || c <= 0) fail('Type the amount each member gives.');
    if (t.some((x) => x.status === 'open' && (Number(x.collected) || 0) > 0)) fail('Money has already been collected for the next turn at the old amount. Pay it out first, then change the amount.', 'collected', 409);
    before = { perMemberCents: m.per_member_cents }; after = { perMemberCents: c };
    stmts.push(ctx.db.prepare('UPDATE chama_mgr SET per_member_cents = ? WHERE client_id = ? AND id = ?').bind(c, ctx.c, m.id), ctx.db.prepare("UPDATE chama_mgr_turn SET expected_cents = ? WHERE client_id = ? AND mgr_id = ? AND status = 'open'").bind(c * t.length, ctx.c, m.id));
    action = `${ctx.me.name} changed what each member gives from ${kes(m.per_member_cents)} to ${kes(c)}`;
  } else if (field === 'lastPayoutDate') {
    if (!isDate(b.value)) fail('Pick a real date.');
    before = { lastPayoutDate: m.last_payout_date || null }; after = { lastPayoutDate: b.value };
    stmts.push(ctx.db.prepare('UPDATE chama_mgr SET last_payout_date = ? WHERE client_id = ? AND id = ?').bind(b.value, ctx.c, m.id));
    action = `${ctx.me.name} changed the last payout date to ${niceDate(b.value, true)}`;
  } else fail('That cannot be changed.');
  stmts.push(auditStmt(ctx, `${action}. Reason: ${reason}`, 'mgr:' + m.id, { ...before, reason: undefined }, { ...after, reason, by: ctx.me.name }));
  await runBatches(ctx, stmts, 60);
  return {};
} };

// officials who record or confirm a payout also stamp the real payout date on the turn
const basePayout = A['mgr.payout'];
A['mgr.payout'] = { p: 'member', fn: async (ctx) => {
  needMgr(ctx);
  const out = await basePayout.fn(ctx);
  const b = ctx.body, date = isDate(b.date) ? b.date : todayKey();
  await ctx.db.prepare("UPDATE chama_mgr_turn SET paid_date = ? WHERE client_id = ? AND id = ? AND status = 'paid_out'").bind(date, ctx.c, String(b.turnId || '')).run();
  const left = await ctx.db.prepare("SELECT COUNT(*) AS n FROM chama_mgr_turn WHERE client_id = ? AND status = 'open' AND mgr_id = (SELECT mgr_id FROM chama_mgr_turn WHERE client_id = ? AND id = ?)").bind(ctx.c, ctx.c, String(b.turnId || '')).first();
  await ctx.db.prepare("UPDATE chama_mgr SET last_payout_date = ? WHERE client_id = ? AND id = (SELECT mgr_id FROM chama_mgr_turn WHERE client_id = ? AND id = ?)").bind(date, ctx.c, ctx.c, String(b.turnId || '')).run();
  return { ...out, roundComplete: !!left && left.n === 0 };
} };

// ===================================================== what a member sees under "My contributions" ======================================================
A['contrib.breakdown'] = { p: 'member', fn: async (ctx) => {
  await ensureCycles(ctx);
  const cur = await currentCycle(ctx), today = todayKey();
  if (!cur) return { cycle: null };
  const o = await ctx.db.prepare('SELECT required_cents FROM chama_obligation WHERE client_id = ? AND cycle_id = ? AND member_id = ?').bind(ctx.c, cur.id, ctx.me.id).first();
  const required = o ? o.required_cents : 0;
  const led = rows(await ctx.db.prepare("SELECT l.entry_date, l.amount_cents, l.method, l.reference, l.reversal_of FROM chama_ledger l WHERE l.client_id = ? AND l.member_id = ? AND l.kind = 'contribution' AND l.ref_type = 'cycle' AND l.ref_id = ? ORDER BY l.ts").bind(ctx.c, ctx.me.id, cur.id).all());
  const pend = rows(await ctx.db.prepare("SELECT id, amount_cents, method, mpesa_code, reported_at FROM chama_report WHERE client_id = ? AND member_id = ? AND kind = 'contribution' AND status = 'pending' ORDER BY reported_at").bind(ctx.c, ctx.me.id).all());
  const rej = await ctx.db.prepare("SELECT COUNT(*) AS n FROM chama_report WHERE client_id = ? AND member_id = ? AND kind = 'contribution' AND status = 'rejected' AND reported_at >= ?").bind(ctx.c, ctx.me.id, Date.parse(cur.start_date + 'T00:00:00+03:00')).first();
  const by = { mpesa: 0, cash: 0, other: 0 };
  led.forEach((x) => { const k = x.method === 'mpesa' ? 'mpesa' : x.method === 'cash' ? 'cash' : 'other'; by[k] += x.amount_cents; });
  const paid = led.reduce((s, x) => s + x.amount_cents, 0), pending = pend.reduce((s, x) => s + x.amount_cents, 0), remaining = Math.max(0, required - paid);
  const status = paid >= required && required > 0 ? 'complete' : (cur.end_date < today && remaining > 0) ? 'overdue' : paid > 0 ? 'partial' : pending > 0 ? 'pending' : 'not_started';
  return {
    cycle: { id: cur.id, label: cur.label, dueText: niceDate(cur.end_date, true), endDate: cur.end_date, countdown: countdown(cur.end_date) },
    requiredCents: required, paidCents: paid, pendingCents: pending, remainingCents: remaining, status, hasPending: pending > 0, rejectedCount: rej ? rej.n : 0, byMethod: by,
    payments: led.map((x) => ({ dateText: niceDate(x.entry_date, true), amountCents: x.amount_cents, method: x.method === 'mpesa' ? 'M-Pesa' : x.method === 'cash' ? 'Cash' : x.method === 'opening' ? 'Opening balance' : 'Other', reference: x.reference || '', status: x.reversal_of ? 'Reversed' : 'Verified' }))
      .concat(pend.map((x) => ({ dateText: niceDate(todayKey(x.reported_at), true), amountCents: x.amount_cents, method: x.method === 'cash' ? 'Cash' : 'M-Pesa', reference: x.mpesa_code || '', status: 'Pending' }))),
  };
} };

// officials who can take cash (for the member's "who did you give it to?" list): names only
A['members.officials'] = { p: 'member', fn: async (ctx) => {
  const r = rows(await ctx.db.prepare("SELECT id, name, role, roles, perms FROM chama_member WHERE client_id = ? AND status = 'active' AND id <> ? ORDER BY name").bind(ctx.c, ctx.me.id).all());
  const list = r.filter((x) => { let p = []; try { p = JSON.parse(x.perms || '[]'); } catch (e) { p = []; } return x.role === 'admin' || p.includes('payments') || p.includes('*'); });
  const label = (x) => [x.role].concat(x.roles ? JSON.parse(x.roles || '[]') : []).filter((v, i, a) => v !== 'member' && a.indexOf(v) === i).map((v) => v[0].toUpperCase() + v.slice(1)).join(' + ');
  return { officials: list.map((x) => ({ id: x.id, name: x.name, role: label(x) })) };
} };

// ===================================================== set up a chama that is already running (admin only) =============================================
// "Start tracking from today": the original start date is kept for the record, the current period starts where the chama really is, and nothing from
// before is invented. Money that already exists is entered as OPENING balances, clearly labelled, never as made-up transactions.
// body: { name, startedOn, description, contribution: { amount, freq, currentCycleStart, paid: { memberId: amount already paid this period } },
//         opening: [{ fund: 'main'|'loan'|..., amount, note }] }
A['onboard.save'] = { p: '*', fn: async (ctx) => {
  const b = ctx.body, g = await loadGroup(ctx), before = g.settings;
  const name = strOf(b, 'name', 80) || g.name;
  const startedOn = isDate(b.startedOn) ? b.startedOn : '';
  const c = b.contribution || {}, cents = toCents(c.amount);
  const stmts = [], input = {};
  if (c.amount !== undefined && c.amount !== '') { if (!isFinite(cents) || cents < 0) fail('Type the contribution amount.'); input.contribution = { amountCents: cents }; }
  if (c.freq) { input.contribution = { ...(input.contribution || {}), freq: String(c.freq) }; }
  if (c.currentCycleStart) {
    if (!isDate(c.currentCycleStart)) fail('Pick the date the current contribution period started.');
    if (c.currentCycleStart > todayKey()) fail('The current period cannot start in the future.');
    input.contribution = { ...(input.contribution || {}), startDate: c.currentCycleStart };
  }
  const next = cleanSettings(input, before);
  next.chama = { ...(before.chama || {}), startedOn: startedOn || (before.chama && before.chama.startedOn) || '', description: strOf(b, 'description', 300), ongoing: !!b.ongoing, trackedFrom: (before.chama && before.chama.trackedFrom) || todayKey() };
  stmts.push(ctx.db.prepare('UPDATE chama_group SET name = ?, settings = ? WHERE client_id = ?').bind(name, JSON.stringify(next), ctx.c));
  stmts.push(auditStmt(ctx, `${ctx.me.name} set up the chama${b.ongoing ? ' (already running; tracked from ' + niceDate(next.chama.trackedFrom, true) + ')' : ''}${startedOn ? ', started ' + niceDate(startedOn, true) : ''}`, 'onboarding',
    { startedOn: (before.chama && before.chama.startedOn) || null, contribution: before.contribution }, { startedOn: next.chama.startedOn || null, contribution: next.contribution }));
  await runBatches(ctx, stmts, 40);
  ctx.group = null; await loadGroup(ctx);
  await ensureCycles(ctx);
  // what members have ALREADY paid in the current period (opening, not new transactions)
  const paid = c.paid && typeof c.paid === 'object' ? c.paid : {};
  const cur = await currentCycle(ctx), more = []; let openingPaid = 0;
  if (cur) {
    const ids = new Set(rows(await ctx.db.prepare("SELECT id FROM chama_member WHERE client_id = ? AND status = 'active'").bind(ctx.c).all()).map((x) => x.id));
    for (const [mid, amt] of Object.entries(paid)) {
      if (!ids.has(mid)) continue; const a = toCents(amt); if (!isFinite(a) || a <= 0) continue;
      more.push(ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, method, note, created_by, idem_key) SELECT ?,?,?,?, 'contribution', ?,?,?, 'cycle', ?, 'opening', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chama_ledger WHERE client_id = ? AND idem_key = ?)")
        .bind(ctx.c, uid(), Date.now(), todayKey(), cur.fund_id, mid, a, cur.id, 'Paid before the chama started using the system', ctx.me.id, `onb:c:${cur.id}:${mid}`, ctx.c, `onb:c:${cur.id}:${mid}`));
      openingPaid += a;
    }
  }
  let openingFunds = 0;
  for (const row of Array.isArray(b.opening) ? b.opening : []) {
    const a = toCents(row.amount); if (!isFinite(a) || a === 0) continue;
    const kind = ['main', 'welfare', 'emergency', 'investment', 'development', 'loan', 'mgr', 'fundraising', 'other'].includes(row.fund) ? row.fund : 'main', fund = await fundFor(ctx, kind);
    more.push(ctx.db.prepare("INSERT INTO chama_ledger (client_id, id, ts, entry_date, kind, fund_id, member_id, amount_cents, ref_type, ref_id, method, note, created_by, idem_key) SELECT ?,?,?,?, 'adjustment', ?, NULL, ?, 'opening', NULL, 'opening', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chama_ledger WHERE client_id = ? AND idem_key = ?)")
      .bind(ctx.c, uid(), Date.now(), todayKey(), fund, a, `Opening balance: ${strOf(row, 'note', 100) || 'brought forward from before the system'}`, ctx.me.id, `onb:f:${kind}:${strOf(row, 'note', 40)}:${a}:${todayKey()}`, ctx.c, `onb:f:${kind}:${strOf(row, 'note', 40)}:${a}:${todayKey()}`));
    openingFunds += a;
  }
  if (more.length) {
    more.push(auditStmt(ctx, `${ctx.me.name} entered opening balances (${kes(openingPaid)} already paid this period, ${kes(openingFunds)} in funds)`, 'onboarding', null, { openingPaidCents: openingPaid, openingFundsCents: openingFunds }));
    await runBatches(ctx, more, 40);
  }
  return { cycle: cur ? cur.label : null, openingPaidCents: openingPaid, openingFundsCents: openingFunds };
} };
A['onboard.get'] = { p: '*', fn: async (ctx) => {
  const g = await loadGroup(ctx), s = g.settings, cur = await currentCycle(ctx);
  const mem = rows(await ctx.db.prepare("SELECT id, name, role, roles FROM chama_member WHERE client_id = ? AND status = 'active' ORDER BY name").bind(ctx.c).all());
  return { name: g.name, chama: s.chama || {}, contribution: s.contribution, features: s.features, currentCycle: cur ? { label: cur.label, start: cur.start_date, end: cur.end_date } : null, members: mem.map((x) => ({ id: x.id, name: x.name })), today: todayKey() };
} };
