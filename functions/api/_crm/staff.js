// functions/api/_crm/staff.js — staff lifecycle: invite / edit / suspend / restore / deactivate / remove (history kept) / reassign / roles / permissions /
// activity + performance (NOT a route).
import { E, json, batcher, all, first, st, now, newId, text, email as normEmail, phoneNorm, auditSt, oneOf, arr, jparse, changes, optRange, dayStart, nairobiDay, DAY, round2, phoneDisplay } from './core.js';
import { INVITE_TTL, createInvitation, linkFor, publicUser, rolePerms, rolesFromRows, userPerms } from './auth.js';
import { PERM_KEYS } from './schema.js';
import { assignLead, activeUser, LEAD_SELECT } from './leads.js';
import { salesScope } from './scope.js';

const okPhoto = (p) => (typeof p === 'string' && p.length <= 400000 && /^(data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+)$/.test(p) ? p : null);
async function target(ctx, id, { allowSelf = true, allowOwner = false } = {}) {
  const u = typeof id === 'string' ? await first(ctx.db, `SELECT * FROM crm_users WHERE id = ?`, id) : null;
  if (!u) throw E.notFound('Staff member not found', 'user_not_found');
  if (u.role === 'owner' && !allowOwner && !ctx.actor.isOwner) throw E.forbidden('The owner account cannot be changed', 'owner_protected');
  if (u.role === 'owner' && !allowOwner) throw E.forbidden('The owner account cannot be changed this way', 'owner_protected');
  if (!allowSelf && u.id === ctx.actor.id) throw E.forbidden('You cannot do that to your own account', 'self_protected');
  return u;
}
const overridesOf = async (db, id) => {
  const rows = await all(db, `SELECT perm, effect FROM crm_user_perms WHERE user_id = ? ORDER BY perm`, id);
  return { grant: rows.filter((r) => r.effect === 'grant').map((r) => r.perm), deny: rows.filter((r) => r.effect === 'deny').map((r) => r.perm) };
};
const overridesFrom = (rows) => ({ grant: rows.filter((r) => r.effect === 'grant').map((r) => r.perm), deny: rows.filter((r) => r.effect === 'deny').map((r) => r.perm) });
const userDetail = async (db, u) => ({ ...publicUser(u), perms: [...await userPerms(db, u)].sort(), overrides: await overridesOf(db, u.id) });

export async function listStaff(ctx) {
  const { db, actor, query } = ctx;
  const full = actor.has('staff.view');
  if (!full && !actor.has('leads.assign')) throw E.forbidden('Missing permission: staff.view', 'forbidden');
  const where = [], args = [];
  if (query.get('status')) { where.push('u.status = ?'); args.push(query.get('status')); }
  if (query.get('archived') !== '1') where.push('u.archived = 0');
  if (query.get('active') === '1') where.push("u.status = 'active'");
  const rows = await all(db, `SELECT u.*, (SELECT COUNT(*) FROM crm_leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND l.status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)) AS open_leads FROM crm_users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.archived, u.name COLLATE NOCASE`, ...args);
  return { items: rows.map((u) => (full ? { ...publicUser(u), openLeads: u.open_leads } : { id: u.id, name: u.name, role: u.role, status: u.status, photo: u.photo })) };
}

export async function createStaff(ctx) {
  const { db, actor, env, request } = ctx; actor.require('staff.add');
  const b = await ctx.json();
  const name = text(b.name, 80), mail = normEmail(b.email), phone = phoneNorm(b.phone);
  const errors = {};
  if (!name) errors.name = 'Name is required';
  if (!mail) errors.email = mail === false ? 'This does not look like a valid email address' : 'Email is required';
  if (phone === false) errors.phone = 'This does not look like a valid phone number';
  const roles = await rolePerms(db);
  const role = String(b.role || 'sales');
  if (role === 'owner' || !roles.has(role)) errors.role = 'Unknown role';
  if (Object.keys(errors).length) throw E.bad('Please fix the highlighted fields', 'validation_error', { fields: errors });
  if (role !== 'sales') actor.require('staff.roles');
  for (const p of roles.get(role)) if (!actor.has(p)) throw E.forbidden('You cannot create a role with permissions you do not have', 'escalation');
  if (await first(db, `SELECT id FROM crm_users WHERE email = ?`, mail)) throw E.conflict('A staff member with this email already exists', 'email_taken');
  const ov = normalizeOverrides(b.perms, roles.get(role), actor, !!b.perms);
  if (b.perms) actor.require('staff.roles');
  const t = now(), id = newId();
  await db.batch([
    st(db, `INSERT INTO crm_users (id, name, email, phone, phone_norm, role, department, photo, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'invited',?,?,?)`, id, name, mail, phone ? phoneDisplay(phone) : null, phone || null, role, text(b.department, 60), okPhoto(b.photo), actor.id, t, t),
    ...ov.grant.map((p) => st(db, `INSERT INTO crm_user_perms (user_id, perm, effect, set_by, set_at) VALUES (?,?, 'grant', ?, ?)`, id, p, actor.id, t)),
    ...ov.deny.map((p) => st(db, `INSERT INTO crm_user_perms (user_id, perm, effect, set_by, set_at) VALUES (?,?, 'deny', ?, ?)`, id, p, actor.id, t)),
    auditSt(db, actor, 'staff_create', 'user', id, null, { name, email: mail, role, grant: ov.grant, deny: ov.deny }, t),
  ]);
  const inv = await createInvitation(db, actor, id, 'invite');
  const user = await first(db, `SELECT * FROM crm_users WHERE id = ?`, id);
  return json({ user: await userDetail(db, user), inviteLink: linkFor(env, request, 'invite', inv.token), expiresAt: inv.expiresAt }, 201);
}

// -> { grant, deny } cleaned: known keys only, no-ops against the role dropped, an actor cannot hand out what they lack
function normalizeOverrides(p, rolePermSet, actor, strict) {
  let grant = [], deny = [];
  if (Array.isArray(p)) grant = p; else if (p && typeof p === 'object') { grant = arr(p.grant, 100); deny = arr(p.deny, 100); }
  for (const k of [...grant, ...deny]) if (!PERM_KEYS.includes(k)) throw E.bad(`Unknown permission: ${k}`, 'invalid_permission');
  grant = [...new Set(grant)]; deny = [...new Set(deny)];
  if (grant.some((k) => deny.includes(k))) throw E.bad('A permission cannot be both granted and denied', 'invalid_permission');
  for (const k of grant) if (!actor.has(k)) throw E.forbidden(`You cannot grant a permission you do not have (${k})`, 'escalation');
  return { grant: grant.filter((k) => !rolePermSet.has(k)), deny: deny.filter((k) => rolePermSet.has(k)) };
}

// zip 162: `statsQueue` only QUEUES the figures on a batcher the caller runs (so a screen that also needs the user row / roles / overrides gets them all in ONE trip);
// it returns the function that turns the settled answers into the figures. `stats` (used alone elsewhere) is the same thing with its own batch.
function statsQueue(ctx, u, q, bx) {
  const { db, actor } = ctx;
  const r = optRange(q.get('from'), q.get('to'));
  const tr = (col) => ({ sql: `${r.from != null ? ` AND ${col} >= ?` : ''}${r.to != null ? ` AND ${col} < ?` : ''}`, args: [...(r.from != null ? [r.from] : []), ...(r.to != null ? [r.to] : [])] });
  const done = `l.status_key IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`;
  const t = now();
  const ownedLeads_ = bx.first( `SELECT COUNT(*) total, SUM(CASE WHEN ${done} THEN 0 ELSE 1 END) open, SUM(CASE WHEN l.status_key IN (SELECT key FROM crm_statuses WHERE is_lost = 1) THEN 1 ELSE 0 END) lost FROM crm_leads l WHERE l.owner_id = ? AND l.deleted_at IS NULL`, u.id);
  const ca = tr('at'); const contacts_ = bx.first( `SELECT COUNT(*) n, MAX(at) last FROM crm_contact_attempts WHERE user_id = ?${ca.sql}`, u.id, ...ca.args);
  const resp_ = bx.first( `SELECT AVG(first_contact_at - COALESCE(assigned_at, created_at)) avg_ms, COUNT(*) n FROM crm_leads WHERE owner_id = ? AND deleted_at IS NULL AND first_contact_at IS NOT NULL AND first_contact_at >= COALESCE(assigned_at, created_at)`, u.id);
  const fu_ = bx.first( `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) open, SUM(CASE WHEN status = 'open' AND due_at < ? THEN 1 ELSE 0 END) overdue, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done FROM crm_followups WHERE assigned_user_id = ?`, t, u.id);
  const mt_ = bx.first( `SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) no_show, COUNT(*) n FROM crm_meetings WHERE user_id = ?`, u.id);
  const last_ = bx.first( `SELECT MAX(created_at) last FROM crm_activities WHERE user_id = ?`, u.id);
  const sc = salesScope(actor, 's'), s2 = tr('s.sold_at');
  const sales_ = sc ? bx.first(`SELECT COUNT(*) n, COALESCE(SUM(total),0) rev, COALESCE(SUM(amount_paid),0) paid FROM crm_sales s WHERE s.closed_by = ? AND ${sc.sql}${s2.sql}`, u.id, ...sc.args, ...s2.args) : null;
  return async () => {
  const [ownedLeads, contacts, resp, fu, mt, last] = await Promise.all([ownedLeads_, contacts_, resp_, fu_, mt_, last_]);
  const out = {
    leadsOwned: ownedLeads.total || 0, openLeads: ownedLeads.open || 0, lostLeads: ownedLeads.lost || 0,
    contactAttempts: contacts.n || 0, avgFirstContactMinutes: resp.n ? round2(resp.avg_ms / 60000) : null,
    followupsOpen: fu.open || 0, followupsOverdue: fu.overdue || 0, followupsDone: fu.done || 0,
    meetings: mt.n || 0, meetingsCompleted: mt.completed || 0, meetingsNoShow: mt.no_show || 0, lastActivityAt: last.last || null,
    dealsClosed: null, revenue: null, collected: null,
  };
  if (sc) {                                                     // revenue only through the viewer's own revenue scope
    const s = await sales_;
    out.dealsClosed = s.n; out.revenue = round2(s.rev); out.collected = round2(s.paid);
  }
    return out;
  };
}
async function stats(ctx, u, q) {
  const bx = batcher(ctx.db);                                       // zip 161: the six figures in ONE round trip (before: six)
  const fin = statsQueue(ctx, u, q, bx);
  await bx.run();
  return fin();
}

export async function getStaff(ctx) {
  const { db, actor } = ctx;
  const id = ctx.params.id;
  if (id !== actor.id) actor.require('staff.view');
  // zip 162: the user row, the roles table, this user's permission overrides and the six figures travel in ONE batch (1 trip; with the auth prelude that is 2 for the
  // whole request). Before: 6. Nothing is cached - a permission change is visible on the very next request.
  const bx = batcher(db);
  const user_ = typeof id === 'string' ? bx.first(`SELECT * FROM crm_users WHERE id = ?`, id) : Promise.resolve(null);
  const roles_ = bx.all(`SELECT key, perms FROM crm_roles`);
  const ov_ = bx.all(`SELECT perm, effect FROM crm_user_perms WHERE user_id = ? ORDER BY perm`, typeof id === 'string' ? id : '');
  const fin = statsQueue(ctx, { id: typeof id === 'string' ? id : '' }, ctx.query, bx);
  await bx.run();
  const u = await user_;
  if (!u) throw E.notFound('Staff member not found', 'user_not_found');
  const ov = await ov_;
  const perms = await userPerms(db, u, rolesFromRows(await roles_), ov);
  const user = { ...publicUser(u), perms: [...perms].sort(), overrides: overridesFrom(ov) };
  return { user, stats: await fin() };
}

export async function patchStaff(ctx) {
  const { db, actor } = ctx;
  const self = ctx.params.id === actor.id;
  if (!self) actor.require('staff.edit');
  const u = await target(ctx, ctx.params.id, { allowOwner: self });
  const b = await ctx.json();
  const set = {}, errors = {};
  if ('name' in b) { const n = text(b.name, 80); if (!n) errors.name = 'Name is required'; else set.name = n; }
  if ('phone' in b) { const p = phoneNorm(b.phone); if (p === false) errors.phone = 'This does not look like a valid phone number'; else { set.phone = p ? phoneDisplay(p) : null; set.phone_norm = p || null; } }
  if ('photo' in b) { if (b.photo == null || b.photo === '') set.photo = null; else { const p = okPhoto(b.photo); if (!p) errors.photo = 'Photo must be a small image'; else set.photo = p; } }
  if (!self || actor.has('staff.edit')) {
    if ('department' in b) set.department = text(b.department, 60);
    if ('email' in b) {
      const m = normEmail(b.email);
      if (!m) errors.email = 'A valid email is required';
      else if (m !== u.email) { if (await first(db, `SELECT id FROM crm_users WHERE email = ? AND id != ?`, m, u.id)) errors.email = 'Another staff member already uses this email'; else set.email = m; }
    }
  }
  if (Object.keys(errors).length) throw E.bad('Please fix the highlighted fields', 'validation_error', { fields: errors });
  const cols = Object.keys(set).filter((c) => (set[c] ?? null) !== (u[c] ?? null));
  if (!cols.length) return { user: await userDetail(db, u), unchanged: true };
  const prev = {}, next = {}; cols.forEach((c) => { prev[c] = c === 'photo' ? (u[c] ? '[image]' : null) : u[c]; next[c] = c === 'photo' ? (set[c] ? '[image]' : null) : set[c]; });
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_users SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => set[c]), t, u.id),
    auditSt(db, actor, 'staff_update', 'user', u.id, prev, next, t),
  ]);
  return { user: await userDetail(db, await first(db, `SELECT * FROM crm_users WHERE id = ?`, u.id)) };
}

export async function setStatus(ctx) {
  const { db, actor } = ctx; actor.require('staff.deactivate');
  const u = await target(ctx, ctx.params.id, { allowSelf: false });
  const b = await ctx.json();
  const status = oneOf(String(b.status || ''), ['active', 'suspended', 'inactive'], 'status');
  if (status === u.status && !(status === 'inactive' && u.archived)) return { user: await userDetail(db, u), unchanged: true };
  if (status === 'active' && !u.password_hash) throw E.conflict('This person has not accepted their invitation yet; send them a new invite link instead', 'not_accepted');
  const t = now();
  const revoke = status !== 'active';
  await db.batch([
    st(db, `UPDATE crm_users SET status = ?, archived = 0, ${revoke ? 'session_epoch = session_epoch + 1, ' : ''}updated_at = ? WHERE id = ?`, status, t, u.id),
    ...(revoke ? [st(db, `UPDATE crm_invitations SET used_at = COALESCE(used_at, ?) WHERE user_id = ?`, t, u.id)] : []),
    auditSt(db, actor, status === 'active' ? 'staff_restore' : status === 'suspended' ? 'staff_suspend' : 'staff_deactivate', 'user', u.id, { status: u.status, archived: !!u.archived }, { status, archived: false }, t),
  ]);
  const open = await first(db, `SELECT COUNT(*) n FROM crm_leads WHERE owner_id = ? AND deleted_at IS NULL AND status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`, u.id);
  return { user: await userDetail(db, await first(db, `SELECT * FROM crm_users WHERE id = ?`, u.id)), openLeads: open.n };
}

export async function resetLink(ctx) {
  const { db, actor, env, request } = ctx; actor.require('staff.edit');
  const u = await target(ctx, ctx.params.id, { allowSelf: false });
  if (u.status === 'suspended' || u.status === 'inactive' || u.archived) throw E.conflict('Restore this account before sending a link', 'account_disabled');
  const kind = u.password_hash ? 'reset' : 'invite';
  const inv = await createInvitation(db, actor, u.id, kind);
  await db.batch([auditSt(db, actor, kind === 'reset' ? 'staff_reset_link' : 'staff_invite_link', 'user', u.id, null, { expiresAt: inv.expiresAt })]);
  return { link: linkFor(env, request, kind, inv.token), kind, expiresAt: inv.expiresAt };
}

export async function reassign(ctx) {
  const { db, actor } = ctx; actor.require('leads.assign'); actor.require('leads.all');
  const from = await target(ctx, ctx.params.id, { allowOwner: true });
  const b = await ctx.json();
  if (!('toUserId' in b)) throw E.bad('toUserId is required (null returns the leads to the pool)', 'invalid_user');
  return doReassign(ctx, from, b);
}
async function doReassign(ctx, from, b) {
  const { db } = ctx;
  const to = b.toUserId ? await activeUser(db, b.toUserId) : null;
  if (to && to.id === from.id) throw E.bad('Choose someone else', 'invalid_user');
  const done = `l.status_key IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`;
  let rows;
  if (Array.isArray(b.leadIds) && b.leadIds.length) {
    const ids = [...new Set(b.leadIds.map(String))].slice(0, 500);
    rows = [];
    for (let i = 0; i < ids.length; i += 80) { const part = ids.slice(i, i + 80); rows.push(...await all(db, `${LEAD_SELECT} WHERE l.owner_id = ? AND l.deleted_at IS NULL AND l.id IN (${part.map(() => '?').join(',')})`, from.id, ...part)); }
  } else if (b.all === true) rows = await all(db, `${LEAD_SELECT} WHERE l.owner_id = ? AND l.deleted_at IS NULL${b.includeClosed ? '' : ` AND NOT (${done})`} LIMIT 5000`, from.id);
  else throw E.bad('give leadIds or all: true', 'invalid_leads');
  let moved = 0; const failed = [];
  for (const lead of rows) { try { await assignLead(ctx, lead, to, { reason: 'reassigned from ' + from.name }); moved++; } catch (e) { failed.push({ id: lead.id, code: e.code || 'error' }); } }
  const requested = Array.isArray(b.leadIds) ? new Set(b.leadIds.map(String)).size : rows.length;
  return { moved, failed, skipped: Math.max(0, requested - rows.length) };
}
export async function removeStaff(ctx) {
  const { db, actor } = ctx; actor.require('staff.deactivate');
  const u = await target(ctx, ctx.params.id, { allowSelf: false });
  const b = await ctx.json();
  let reassigned = null;
  if ('toUserId' in b) { actor.require('leads.assign'); actor.require('leads.all'); reassigned = await doReassign(ctx, u, { toUserId: b.toUserId, all: true }); }
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_users SET status = 'inactive', archived = 1, session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`, t, u.id),
    st(db, `UPDATE crm_invitations SET used_at = COALESCE(used_at, ?) WHERE user_id = ?`, t, u.id),
    auditSt(db, actor, 'staff_remove', 'user', u.id, { status: u.status, archived: !!u.archived }, { status: 'inactive', archived: true }, t),
  ]);
  const open = await first(db, `SELECT COUNT(*) n FROM crm_leads WHERE owner_id = ? AND deleted_at IS NULL AND status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)`, u.id);
  return { ok: true, openLeads: open.n, reassigned, note: 'History is kept: the account is archived, not deleted.' };
}

export async function staffActivity(ctx) {
  const { db, actor, query } = ctx;
  if (ctx.params.id !== actor.id) actor.require('staff.view');
  const u = await target(ctx, ctx.params.id, { allowOwner: true });
  const r = optRange(query.get('from'), query.get('to'));
  const where = ['a.user_id = ?'], args = [u.id];
  if (r.from != null) { where.push('a.created_at >= ?'); args.push(r.from); }
  if (r.to != null) { where.push('a.created_at < ?'); args.push(r.to); }
  if (!actor.has('leads.all')) { where.push('(a.lead_id IS NULL OR l.owner_id = ? OR l.owner_id IS NULL)'); args.push(actor.id); }
  const pageSize = Math.min(100, Math.max(1, parseInt(query.get('pageSize'), 10) || 50)), page = Math.max(1, parseInt(query.get('page'), 10) || 1);
  const total = (await first(db, `SELECT COUNT(*) n FROM crm_activities a LEFT JOIN crm_leads l ON l.id = a.lead_id WHERE ${where.join(' AND ')}`, ...args)).n;
  const rows = await all(db, `SELECT a.*, l.name AS lead_name FROM crm_activities a LEFT JOIN crm_leads l ON l.id = a.lead_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
  return { items: rows.map((a) => ({ id: a.id, leadId: a.lead_id, leadName: a.lead_name, userName: a.user_name, type: a.type, summary: a.summary, at: a.created_at })), total, page, pageSize };
}

export async function permissionsCatalogue(ctx) {
  ctx.actor.require('staff.view');
  const roles = await rolePerms(ctx.db);
  return { keys: PERM_KEYS, roles: Object.fromEntries([...roles].map(([k, v]) => [k, [...v].sort()])) };
}
export async function putPermissions(ctx) {
  const { db, actor } = ctx; actor.require('staff.roles');
  const u = await target(ctx, ctx.params.id, { allowSelf: false });
  const roles = await rolePerms(db);
  const b = await ctx.json();
  const ov = normalizeOverrides(b, roles.get(u.role) || new Set(), actor, true);
  // an actor cannot deny away a permission from someone above them either: owner is protected by target(); nothing more to check
  const prev = await overridesOf(db, u.id), t = now();
  await db.batch([
    st(db, `DELETE FROM crm_user_perms WHERE user_id = ?`, u.id),
    ...ov.grant.map((p) => st(db, `INSERT INTO crm_user_perms (user_id, perm, effect, set_by, set_at) VALUES (?,?, 'grant', ?, ?)`, u.id, p, actor.id, t)),
    ...ov.deny.map((p) => st(db, `INSERT INTO crm_user_perms (user_id, perm, effect, set_by, set_at) VALUES (?,?, 'deny', ?, ?)`, u.id, p, actor.id, t)),
    auditSt(db, actor, 'staff_permissions', 'user', u.id, prev, ov, t),
  ]);
  return { user: await userDetail(db, u) };
}
export async function putRole(ctx) {
  const { db, actor } = ctx; actor.require('staff.roles');
  const u = await target(ctx, ctx.params.id, { allowSelf: false });
  const roles = await rolePerms(db);
  const b = await ctx.json(); const role = String(b.role || '');
  if (role === 'owner' || !roles.has(role)) throw E.bad('Unknown role', 'invalid_role');
  if (role === u.role) return { user: await userDetail(db, u), unchanged: true };
  for (const p of roles.get(role)) if (!actor.has(p)) throw E.forbidden('You cannot give a role with permissions you do not have', 'escalation');
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_users SET role = ?, updated_at = ? WHERE id = ?`, role, t, u.id),
    auditSt(db, actor, 'staff_role', 'user', u.id, { role: u.role }, { role }, t),
  ]);
  return { user: await userDetail(db, await first(db, `SELECT * FROM crm_users WHERE id = ?`, u.id)) };
}
