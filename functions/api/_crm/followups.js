// functions/api/_crm/followups.js — follow-ups, meetings and the reminder sweep (NOT a route).
import { E, json, all, first, run, st, now, newId, text, tsIn, oneOf, int, auditSt, activitySt, touchLeadSt, notifySt, emitSt, idStr, changes, dayStart, nairobiDay, DAY, optRange } from './core.js';
import { getLeadFor, leadOut, activeUser, PRE_MEETING, inList } from './leads.js';
import { leadScope } from './scope.js';
import { notifyMany, managers } from './notify.js';
import { readSettings } from './config.js';

const FU_TYPES = ['call', 'whatsapp', 'visit', 'meeting', 'demo', 'email', 'task', 'other'];
const MEET_TYPES = ['call', 'video', 'visit', 'office', 'other'];
const MEET_STATUSES = ['scheduled', 'confirmed', 'completed', 'rescheduled', 'cancelled', 'no_show'];
// reschedule_count is incremented inside the UPDATE, so two simultaneous reschedules are both counted
const RESCHEDULE_INC = Symbol('inc');
const assign = (cols, set) => ({ sql: cols.map((c) => (set[c] === RESCHEDULE_INC ? 'reschedule_count = reschedule_count + 1' : c + ' = ?')).join(', '), args: cols.filter((c) => set[c] !== RESCHEDULE_INC).map((c) => set[c]) });
const FINAL = new Set(['completed', 'cancelled', 'no_show']);

export const followupOut = (f) => ({ id: f.id, leadId: f.lead_id, leadName: f.lead_name, leadPhone: f.lead_phone, assignedUserId: f.assigned_user_id, assignedName: f.assigned_name, type: f.type, dueAt: f.due_at, notes: f.notes, remindMinutes: f.remind_minutes, status: f.status, completedAt: f.completed_at, completedBy: f.completed_by, completionNotes: f.completion_notes, createdAt: f.created_at });
export const meetingOut = (m) => ({ id: m.id, leadId: m.lead_id, leadName: m.lead_name, leadPhone: m.lead_phone, userId: m.user_id, userName: m.user_name, startsAt: m.starts_at, durationMin: m.duration_min, type: m.type, location: m.location, link: m.link, notes: m.notes, status: m.status, rescheduleCount: m.reschedule_count, firstStartsAt: m.first_starts_at, createdAt: m.created_at });
const FU_SELECT = `SELECT f.*, l.name AS lead_name, l.phone AS lead_phone, l.owner_id AS lead_owner_id, u.name AS assigned_name FROM crm_followups f JOIN crm_leads l ON l.id = f.lead_id LEFT JOIN crm_users u ON u.id = f.assigned_user_id`;
const M_SELECT = `SELECT m.*, l.name AS lead_name, l.phone AS lead_phone, l.owner_id AS lead_owner_id, u.name AS user_name FROM crm_meetings m JOIN crm_leads l ON l.id = m.lead_id LEFT JOIN crm_users u ON u.id = m.user_id`;

// who a scoped user may touch: the follow-up is theirs, or its lead is theirs
const mine = (actor, a, leadA) => (actor.has('leads.all') ? { sql: '1=1', args: [] } : { sql: `(${a}.${a === 'f' ? 'assigned_user_id' : 'user_id'} = ? OR ${leadA}.owner_id = ?)`, args: [actor.id, actor.id] });
async function ownedFollowup(ctx, id) {
  const { db, actor } = ctx;
  const f = typeof id === 'string' ? await first(db, `${FU_SELECT} WHERE f.id = ? AND l.deleted_at IS NULL`, id) : null;
  if (!f || !(actor.has('leads.all') || f.assigned_user_id === actor.id || f.lead_owner_id === actor.id)) throw E.notFound('Follow-up not found', 'followup_not_found');
  return f;
}
async function ownedMeeting(ctx, id) {
  const { db, actor } = ctx;
  const m = typeof id === 'string' ? await first(db, `${M_SELECT} WHERE m.id = ? AND l.deleted_at IS NULL`, id) : null;
  if (!m || !(actor.has('leads.all') || m.user_id === actor.id || m.lead_owner_id === actor.id)) throw E.notFound('Meeting not found', 'meeting_not_found');
  return m;
}
const checkLink = (v) => { const s = text(v, 500); if (!s) return null; if (!/^https:\/\/[^\s]+$/i.test(s)) throw E.bad('link must be an https:// address', 'invalid_link'); return s; };

// ---------- follow-ups ----------
export async function listFollowups(ctx) {
  const { db, actor, query } = ctx; actor.require('followups.manage');
  await sweepReminders(db, ctx.actor && ctx.actor.meta);
  const bucket = query.get('bucket') || 'today';
  const t = now(), todayEnd = dayStart(nairobiDay(t)) + DAY;
  const where = ['l.deleted_at IS NULL'], args = [];
  const b = { overdue: ["f.status = 'open' AND f.due_at < ?", [t], 'f.due_at ASC'], today: ["f.status = 'open' AND f.due_at >= ? AND f.due_at < ?", [t, todayEnd], 'f.due_at ASC'], upcoming: ["f.status = 'open' AND f.due_at >= ?", [todayEnd], 'f.due_at ASC'], completed: ["f.status = 'done'", [], 'f.completed_at DESC'] }[bucket];
  if (!b) throw E.bad('bucket must be today, overdue, upcoming or completed', 'invalid_bucket');
  where.push(b[0]); args.push(...b[1]);
  const staff = query.get('staff');
  if (staff && staff !== 'me') {
    if (!actor.has('leads.all') && staff !== actor.id) throw E.forbidden('You can only see your own follow-ups', 'forbidden');
    where.push('f.assigned_user_id = ?'); args.push(staff);
  } else if (staff === 'me') { where.push('f.assigned_user_id = ?'); args.push(actor.id); }
  const m = mine(actor, 'f', 'l'); where.push(m.sql); args.push(...m.args);
  const rows = await all(db, `${FU_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${b[2]} LIMIT 500`, ...args);
  return { items: rows.map(followupOut), bucket };
}
export async function createFollowup(ctx) {
  const { db, actor } = ctx; actor.require('followups.manage');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json();
  const dueAt = tsIn(b.dueAt, 'dueAt');
  if (dueAt < now() - DAY) throw E.bad('dueAt is in the past', 'invalid_time');
  const type = b.type == null ? 'call' : oneOf(String(b.type), FU_TYPES, 'type');
  const settings = await readSettings(db);
  const remind = b.remindMinutes == null ? settings.defaultRemindMinutes : int(b.remindMinutes, 'remindMinutes', { min: 0, max: 10080 });
  let assignee = lead.owner_id || actor.id;
  if (b.assignedUserId != null && b.assignedUserId !== '' && b.assignedUserId !== assignee) { if (!actor.has('leads.all')) throw E.forbidden('Follow-ups are for the lead\'s owner', 'forbidden'); assignee = (await activeUser(db, b.assignedUserId)).id; }
  const t = now(), id = newId(), notes = text(b.notes, 1000);
  const stmts = [
    st(db, `INSERT INTO crm_followups (id, lead_id, assigned_user_id, type, due_at, notes, remind_minutes, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'open',?,?,?)`, id, lead.id, assignee, type, dueAt, notes, remind, actor.id, t, t),
    activitySt(db, actor, lead.id, 'followup', `Follow-up set (${type}) for ${new Date(dueAt + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}${notes ? ': ' + notes.slice(0, 120) : ''}`, { followupId: id, dueAt, type }, t),
    auditSt(db, actor, 'followup_create', 'followup', id, null, { leadId: lead.id, dueAt, type, assignee }, t),
    touchLeadSt(db, lead.id, t),
    emitSt(db, actor, 'followup.created', { entity: 'followup', entityId: id, leadId: lead.id, data: { type, dueAt, assignee } }, t),
  ];
  if (assignee !== actor.id) stmts.push(notifySt(db, assignee, 'followup_assigned', `Follow-up for ${lead.name}`, null, { leadId: lead.id, entity: 'followup', entityId: id, at: t }));
  await db.batch(stmts);
  return json({ followup: followupOut(await first(db, `${FU_SELECT} WHERE f.id = ?`, id)) }, 201);
}
export async function patchFollowup(ctx) {
  const { db, actor } = ctx; actor.require('followups.manage');
  const f = await ownedFollowup(ctx, ctx.params.id);
  if (f.status !== 'open') throw E.conflict('This follow-up is already closed', 'followup_closed');
  const b = await ctx.json();
  const set = {}, prev = {};
  if ('dueAt' in b) { set.due_at = tsIn(b.dueAt, 'dueAt'); set.reminded_at = null; set.overdue_notified_at = null; }
  if ('type' in b) set.type = oneOf(String(b.type), FU_TYPES, 'type');
  if ('notes' in b) set.notes = text(b.notes, 1000);
  if ('remindMinutes' in b) { set.remind_minutes = int(b.remindMinutes, 'remindMinutes', { min: 0, max: 10080 }); set.reminded_at = null; }
  if (b.status === 'cancelled') set.status = 'cancelled';
  else if ('status' in b && b.status !== 'open') throw E.bad('use /complete to finish a follow-up', 'invalid_status');
  if (b.assignedUserId != null && b.assignedUserId !== '' && b.assignedUserId !== f.assigned_user_id) { if (!actor.has('leads.all')) throw E.forbidden('Only a manager can reassign a follow-up', 'forbidden'); set.assigned_user_id = (await activeUser(db, b.assignedUserId)).id; }
  const cols = Object.keys(set);
  if (!cols.length) throw E.bad('nothing to change', 'no_changes');
  cols.forEach((c) => { prev[c] = f[c]; });
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_followups SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => set[c]), t, f.id),
    activitySt(db, actor, f.lead_id, 'followup', set.status === 'cancelled' ? 'Follow-up cancelled' : 'Follow-up changed', { followupId: f.id, set }, t),
    auditSt(db, actor, set.status === 'cancelled' ? 'followup_cancel' : 'followup_update', 'followup', f.id, prev, set, t),
    touchLeadSt(db, f.lead_id, t),
    emitSt(db, actor, set.status === 'cancelled' ? 'followup.cancelled' : 'followup.updated', { entity: 'followup', entityId: f.id, leadId: f.lead_id, data: { set } }, t),
    ...(set.assigned_user_id && set.assigned_user_id !== actor.id ? [notifySt(db, set.assigned_user_id, 'followup_assigned', `Follow-up for ${f.lead_name}`, null, { leadId: f.lead_id, entity: 'followup', entityId: f.id, at: t })] : []),
  ]);
  return { followup: followupOut(await first(db, `${FU_SELECT} WHERE f.id = ?`, f.id)) };
}
export async function completeFollowup(ctx) {
  const { db, actor } = ctx; actor.require('followups.manage');
  const f = await ownedFollowup(ctx, ctx.params.id);
  if (f.status === 'done') return { followup: followupOut(f), unchanged: true };
  if (f.status !== 'open') throw E.conflict('This follow-up was cancelled', 'followup_closed');
  const b = await ctx.json(); const notes = text(b.notes, 1000), t = now();
  const r = await st(db, `UPDATE crm_followups SET status = 'done', completed_at = ?, completed_by = ?, completion_notes = ?, updated_at = ? WHERE id = ? AND status = 'open'`, t, actor.id, notes, t, f.id).run();
  if (changes(r) === 1) await db.batch([
    activitySt(db, actor, f.lead_id, 'followup', `Follow-up done${notes ? ': ' + notes.slice(0, 200) : ''}`, { followupId: f.id }, t),
    auditSt(db, actor, 'followup_complete', 'followup', f.id, { status: 'open' }, { status: 'done' }, t),
    emitSt(db, actor, 'followup.completed', { entity: 'followup', entityId: f.id, leadId: f.lead_id, data: { type: f.type } }, t),
    touchLeadSt(db, f.lead_id, t),
  ]);
  return { followup: followupOut(await first(db, `${FU_SELECT} WHERE f.id = ?`, f.id)) };
}

// ---------- meetings ----------
// who hears about a change to a meeting: the person it is with and the lead's owner (and the managers for cancellations / no-shows), never the person who made the change
async function meetingAudience(db, actor, m, withManagers) {
  const ids = new Set([m.user_id, m.lead_owner_id].filter(Boolean));
  if (withManagers) for (const u of await managers(db, actor.id)) ids.add(u.id);
  ids.delete(actor.id);
  return [...ids];
}
export async function listMeetings(ctx) {
  const { db, actor, query } = ctx; actor.require('meetings.manage');
  const r = optRange(query.get('from'), query.get('to'));
  const where = ['l.deleted_at IS NULL'], args = [];
  const from = r.from != null ? r.from : dayStart(nairobiDay());
  where.push('m.starts_at >= ?'); args.push(from);
  if (r.to != null) { where.push('m.starts_at < ?'); args.push(r.to); }
  const staff = query.get('staff');
  if (staff) {
    if (!actor.has('leads.all') && staff !== actor.id && staff !== 'me') throw E.forbidden('You can only see your own meetings', 'forbidden');
    where.push('m.user_id = ?'); args.push(staff === 'me' ? actor.id : staff);
  }
  const m = mine(actor, 'm', 'l'); where.push(m.sql); args.push(...m.args);
  const rows = await all(db, `${M_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.starts_at ASC LIMIT 1000`, ...args);
  return { items: rows.map(meetingOut) };
}
function meetingFields(b, partial) {
  const o = {};
  if (!partial || 'startsAt' in b) o.starts_at = tsIn(b.startsAt, 'startsAt');
  if (!partial || 'durationMin' in b) o.duration_min = int(b.durationMin, 'durationMin', { min: 5, max: 1440, dflt: 30 });
  if (!partial || 'type' in b) o.type = b.type == null ? 'call' : oneOf(String(b.type), MEET_TYPES, 'type');
  if ('location' in b) o.location = text(b.location, 200);
  if ('link' in b) o.link = checkLink(b.link);
  if ('notes' in b) o.notes = text(b.notes, 1000);
  return o;
}
export async function createMeeting(ctx) {
  const { db, actor } = ctx; actor.require('meetings.manage');
  const lead = await getLeadFor(ctx, ctx.params.id, { write: true });
  const b = await ctx.json(); const f = meetingFields(b, false);
  if (f.starts_at < now() - DAY) throw E.bad('startsAt is in the past', 'invalid_time');
  let assignee = lead.owner_id || actor.id;
  if (b.userId != null && b.userId !== '' && b.userId !== assignee) { if (!actor.has('leads.all')) throw E.forbidden('Meetings are for the lead\'s owner', 'forbidden'); assignee = (await activeUser(db, b.userId)).id; }
  const t = now(), id = newId();
  const stmts = [
    st(db, `INSERT INTO crm_meetings (id, lead_id, user_id, starts_at, duration_min, type, location, link, notes, status, first_starts_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?)`, id, lead.id, assignee, f.starts_at, f.duration_min, f.type, f.location ?? null, f.link ?? null, f.notes ?? null, f.starts_at, actor.id, t, t),
    activitySt(db, actor, lead.id, 'meeting', `Meeting scheduled (${f.type}) for ${new Date(f.starts_at + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}`, { meetingId: id, startsAt: f.starts_at }, t),
    auditSt(db, actor, 'meeting_create', 'meeting', id, null, { leadId: lead.id, ...f, userId: assignee }, t),
    st(db, `UPDATE crm_leads SET status_key = 'meeting', updated_at = ?, last_activity_at = ? WHERE id = ? AND status_key IN (${inList(PRE_MEETING)}) AND EXISTS (SELECT 1 FROM crm_statuses WHERE key = 'meeting' AND active = 1)`, t, t, lead.id),
    emitSt(db, actor, 'meeting.created', { entity: 'meeting', entityId: id, leadId: lead.id, data: { startsAt: f.starts_at, userId: assignee } }, t),
  ];
  if (PRE_MEETING.includes(lead.status_key)) {
    const won = { sql: `EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND status_key = 'meeting' AND updated_at = ?)`, args: [lead.id, t] };
    stmts.push(activitySt(db, actor, lead.id, 'status', `Status: ${lead.status_key} → Meeting (meeting booked)`, { from: lead.status_key, to: 'meeting', auto: true }, t, won));
    stmts.push(auditSt(db, actor, 'lead_status', 'lead', lead.id, { status: lead.status_key }, { status: 'meeting', auto: 'meeting_booked' }, t, won));
  }
  const targets = [assignee, ...(await managers(db, actor.id)).map((u) => u.id)];
  stmts.push(...notifyMany(db, targets, actor.id, 'meeting', `Meeting scheduled with ${lead.name}`, new Date(f.starts_at + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' (Nairobi)', { leadId: lead.id, entity: 'meeting', entityId: id, at: t }));
  await db.batch(stmts);
  return json({ meeting: meetingOut(await first(db, `${M_SELECT} WHERE m.id = ?`, id)) }, 201);
}
export async function patchMeeting(ctx) {
  const { db, actor } = ctx; actor.require('meetings.manage');
  const m = await ownedMeeting(ctx, ctx.params.id);
  const b = await ctx.json(); const f = meetingFields(b, true);
  if (FINAL.has(m.status) && Object.keys(f).some((k) => k !== 'notes')) throw E.conflict('This meeting is closed; only its notes can change', 'meeting_closed');
  const set = { ...f };
  let rescheduled = false;
  if ('starts_at' in f && f.starts_at !== m.starts_at) { rescheduled = true; set.status = 'rescheduled'; set.reschedule_count = RESCHEDULE_INC; set.reminded_at = null; }
  else delete set.starts_at;
  const cols = Object.keys(set);
  if (!cols.length) throw E.bad('nothing to change', 'no_changes');
  const prev = {}; cols.forEach((c) => { prev[c] = m[c]; });
  const t = now(), asg = assign(cols, set);
  const audSet = { ...set }; if (audSet.reschedule_count === RESCHEDULE_INC) audSet.reschedule_count = m.reschedule_count + 1;
  await db.batch([
    st(db, `UPDATE crm_meetings SET ${asg.sql}, updated_at = ? WHERE id = ?`, ...asg.args, t, m.id),
    activitySt(db, actor, m.lead_id, 'meeting', rescheduled ? `Meeting rescheduled to ${new Date(set.starts_at + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}` : 'Meeting details changed', { meetingId: m.id, set: audSet }, t),
    auditSt(db, actor, rescheduled ? 'meeting_reschedule' : 'meeting_update', 'meeting', m.id, prev, audSet, t),
    touchLeadSt(db, m.lead_id, t),
    emitSt(db, actor, rescheduled ? 'meeting.rescheduled' : 'meeting.updated', { entity: 'meeting', entityId: m.id, leadId: m.lead_id, data: { startsAt: set.starts_at || m.starts_at } }, t),
    ...(await meetingAudience(db, actor, m, false)).map((id) => notifySt(db, id, 'meeting', rescheduled ? `Meeting rescheduled: ${m.lead_name}` : `Meeting changed: ${m.lead_name}`, null, { leadId: m.lead_id, entity: 'meeting', entityId: m.id, at: t })),
  ]);
  return { meeting: meetingOut(await first(db, `${M_SELECT} WHERE m.id = ?`, m.id)) };
}
export async function meetingStatus(ctx) {
  const { db, actor } = ctx; actor.require('meetings.manage');
  const m = await ownedMeeting(ctx, ctx.params.id);
  const b = await ctx.json();
  const status = oneOf(String(b.status || ''), MEET_STATUSES, 'status');
  if (status === m.status && status !== 'rescheduled') return { meeting: meetingOut(m), unchanged: true };
  if (FINAL.has(m.status)) throw E.conflict('This meeting is already closed', 'meeting_closed');
  const set = { status };
  if (status === 'rescheduled') {
    if (b.startsAt == null) throw E.bad('startsAt is required to reschedule', 'invalid_time');
    const ts = tsIn(b.startsAt, 'startsAt');
    if (ts === m.starts_at) throw E.bad('The new time is the same as the old one', 'invalid_time');
    set.starts_at = ts; set.reschedule_count = RESCHEDULE_INC; set.reminded_at = null;
  } else if (status === 'no_show' && m.starts_at > now()) throw E.bad('A meeting that has not started cannot be a no-show', 'meeting_in_future');
  const cols = Object.keys(set), prev = {}; cols.forEach((c) => { prev[c] = m[c]; });
  const t = now(), asg = assign(cols, set);
  const audSet = { ...set }; if (audSet.reschedule_count === RESCHEDULE_INC) audSet.reschedule_count = m.reschedule_count + 1;
  const label = { scheduled: 'Meeting set back to scheduled', confirmed: 'Meeting confirmed', completed: 'Meeting completed', rescheduled: `Meeting rescheduled to ${set.starts_at ? new Date(set.starts_at + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : ''}`, cancelled: 'Meeting cancelled', no_show: 'Client did not show up' }[status];
  await db.batch([
    st(db, `UPDATE crm_meetings SET ${asg.sql}, updated_at = ? WHERE id = ?`, ...asg.args, t, m.id),
    activitySt(db, actor, m.lead_id, 'meeting', label, { meetingId: m.id, status, startsAt: set.starts_at }, t),
    auditSt(db, actor, 'meeting_' + status, 'meeting', m.id, prev, audSet, t),
    touchLeadSt(db, m.lead_id, t),
    emitSt(db, actor, 'meeting.' + status, { entity: 'meeting', entityId: m.id, leadId: m.lead_id, data: { startsAt: set.starts_at || m.starts_at } }, t),
    ...(['rescheduled', 'cancelled', 'no_show'].includes(status) ? (await meetingAudience(db, actor, m, status !== 'rescheduled')).map((id) => notifySt(db, id, 'meeting', `${{ rescheduled: 'Meeting rescheduled', cancelled: 'Meeting cancelled', no_show: 'Client did not show up' }[status]}: ${m.lead_name}`, null, { leadId: m.lead_id, entity: 'meeting', entityId: m.id, at: t })) : []),
  ]);
  return { meeting: meetingOut(await first(db, `${M_SELECT} WHERE m.id = ?`, m.id)) };
}

// ---------- reminder sweep ----------
// There is no scheduler on Pages, so due / overdue follow-ups and meeting reminders are turned into notifications whenever the CRM is used
// (at most once a minute — one conditional upsert decides who runs it). Each notification has a dedupe key, so it is never sent twice.
export async function sweepReminders(db, seen) {
  const t = now();
  if (seen && Number.isFinite(seen.sweep) && seen.sweep >= t - 60000) return 0;      // zip 161: this request's first round trip already showed the sweep ran within the minute
  const r = await run(db, `INSERT INTO crm_meta (k, v) VALUES ('sweep', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(crm_meta.v AS INTEGER) < ?`, String(t), t - 60000);
  if (changes(r) !== 1) return 0;
  let sent = 0;
  const open = `f.status = 'open' AND l.deleted_at IS NULL AND l.status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`;
  const recipients = async (userId, leadOwner) => {
    for (const id of [userId, leadOwner]) if (id) { const u = await first(db, `SELECT id FROM crm_users WHERE id = ? AND status = 'active' AND archived = 0`, id); if (u) return [u.id]; }
    return (await managers(db, null)).map((u) => u.id);
  };
  const due = await all(db, `${FU_SELECT} WHERE ${open} AND f.reminded_at IS NULL AND f.due_at - f.remind_minutes * 60000 <= ? LIMIT 200`, t);
  for (const f of due) {
    const ids = await recipients(f.assigned_user_id, f.lead_owner_id);
    await db.batch([...ids.map((id) => notifySt(db, id, 'followup_due', `Follow-up due: ${f.lead_name}`, f.notes, { leadId: f.lead_id, entity: 'followup', entityId: f.id, dedupe: `fu-due:${f.id}:${f.due_at}:${id}`, at: t })), st(db, `UPDATE crm_followups SET reminded_at = ? WHERE id = ?`, t, f.id)]);
    sent += ids.length;
  }
  const lateMin = Number((await readSettings(db)).autoFollowupOverdueMinutes);      // zip 158: the Automation rule (0 = off; default 15 as before)
  const late = lateMin > 0 ? await all(db, `${FU_SELECT} WHERE ${open} AND f.overdue_notified_at IS NULL AND f.due_at < ? LIMIT 200`, t - lateMin * 60000) : [];
  for (const f of late) {
    const ids = await recipients(f.assigned_user_id, f.lead_owner_id);
    const mg = (await managers(db, null)).map((u) => u.id);
    const all_ = [...new Set([...ids, ...(t - f.due_at > 24 * 3600000 ? mg : [])])];
    await db.batch([...all_.map((id) => notifySt(db, id, 'followup_overdue', `Overdue follow-up: ${f.lead_name}`, f.notes, { leadId: f.lead_id, entity: 'followup', entityId: f.id, dedupe: `fu-late:${f.id}:${f.due_at}:${id}`, at: t })), st(db, `UPDATE crm_followups SET overdue_notified_at = ? WHERE id = ?`, t, f.id)]);
    sent += all_.length;
  }
  const meets = await all(db, `${M_SELECT} WHERE l.deleted_at IS NULL AND m.status IN ('scheduled','confirmed','rescheduled') AND m.reminded_at IS NULL AND m.starts_at - 3600000 <= ? AND m.starts_at > ?`, t, t - 1800000);
  for (const m of meets) {
    const ids = await recipients(m.user_id, m.lead_owner_id);
    await db.batch([...ids.map((id) => notifySt(db, id, 'meeting_reminder', `Meeting soon: ${m.lead_name}`, new Date(m.starts_at + 3 * 3600000).toISOString().slice(11, 16) + ' (Nairobi)', { leadId: m.lead_id, entity: 'meeting', entityId: m.id, dedupe: `mt-rem:${m.id}:${m.starts_at}:${id}`, at: t })), st(db, `UPDATE crm_meetings SET reminded_at = ? WHERE id = ?`, t, m.id)]);
    sent += ids.length;
  }
  return sent;
}
