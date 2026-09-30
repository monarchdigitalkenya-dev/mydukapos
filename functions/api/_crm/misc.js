// functions/api/_crm/misc.js — notifications, audit trail (NOT a route).
import { E, all, first, st, many, now, jparse, optRange, arr, placeholders, text } from './core.js';
import { sweepReminders } from './followups.js';
import { unreadConversationsSt } from './inbox.js';
import { configStatements, configFromRows, integrationStatus } from './config.js';
import { peek, prime } from './cache.js';
import { meUser } from './auth.js';

const notifOut = (n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, leadId: n.lead_id, entity: n.entity, entityId: n.entity_id, at: n.created_at, read: n.read_at != null });

export async function listNotifications(ctx) {
  const { db, actor, query } = ctx;
  await sweepReminders(db, actor.meta);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.get('pageSize'), 10) || 30)), page = Math.max(1, parseInt(query.get('page'), 10) || 1);
  const w = ['user_id = ?'], a = [actor.id];
  if (query.get('unread') === '1') w.push('read_at IS NULL');
  // zip 161: the page, the unread count and (for the bell + the Inbox badge that the app polls) the number of unread chats: ONE round trip. Before: 2 trips here + a second request
  // to /inbox/conversations?unread=1 (up to 200 conversations, ~78 KB) only to count them.
  const stmts = [st(db, `SELECT * FROM crm_notifications WHERE ${w.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...a, pageSize, (page - 1) * pageSize), st(db, `SELECT COUNT(*) n FROM crm_notifications WHERE user_id = ? AND read_at IS NULL`, actor.id)];
  const wantInbox = actor.has('inbox.view');
  if (wantInbox) stmts.push(unreadConversationsSt(db, actor));
  const [rows, cnt, ib] = await many(db, stmts);
  return { items: rows.map(notifOut), unread: cnt[0].n, page, pageSize, ...(wantInbox ? { inboxUnread: ib[0].n } : {}) };
}
// GET /boot — everything the app needs to draw its first screen, in ONE request and ONE database round trip after the sign-in check: who I am + permissions + the
// config lists (/me), the staff names (for the filters), the first notifications + unread counts (the polls). It replaces /me + /staff (twice) + /notifications +
// /inbox/conversations?unread=1 at start-up; every one of those endpoints still exists and answers as before.
export async function boot(ctx) {
  const { db, actor } = ctx;
  await sweepReminders(db, actor.meta);
  const stmts = [], at = {};
  const add = (k, list) => { at[k] = [stmts.length, list.length]; stmts.push(...list); };
  const cfg = peek(db, 'cfg:active');
  if (!cfg) add('cfg', configStatements(db, false));
  const staffOk = actor.has('staff.view') || actor.has('leads.assign');
  if (staffOk) add('staff', [st(db, `SELECT id, name, role, status, department FROM crm_users WHERE archived = 0 ORDER BY name COLLATE NOCASE`)]);
  add('notif', [st(db, `SELECT * FROM crm_notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`, actor.id), st(db, `SELECT COUNT(*) n FROM crm_notifications WHERE user_id = ? AND read_at IS NULL`, actor.id)]);
  if (actor.has('inbox.view')) add('inbox', [unreadConversationsSt(db, actor)]);
  const rows = await many(db, stmts);
  const part = (k) => rows.slice(at[k][0], at[k][0] + at[k][1]);
  let config = cfg;
  if (!config) { config = configFromRows(part('cfg')); prime(db, 'cfg:active', config); }
  const [nrows, ncnt] = part('notif');
  return {
    me: { user: meUser(actor), config, integrations: integrationStatus(ctx.env) },
    staff: staffOk ? { items: part('staff')[0].map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status, department: u.department })) } : null,
    notifications: { items: nrows.map(notifOut), unread: ncnt[0].n, page: 1, pageSize: 20 },
    inboxUnread: at.inbox ? part('inbox')[0][0].n : null,
  };
}
export async function markNotificationsRead(ctx) {
  const { db, actor } = ctx;
  const b = await ctx.json(); const t = now();
  if (b.all === true) { await st(db, `UPDATE crm_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, t, actor.id).run(); return { ok: true }; }
  const ids = arr(b.ids, 100).map(String);
  if (!ids.length) throw E.bad('ids or all is required', 'invalid_ids');
  await st(db, `UPDATE crm_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders(ids.length)})`, t, actor.id, ...ids).run();      // only your own
  return { ok: true };
}
export async function listAudit(ctx) {
  const { db, actor, query } = ctx; actor.require('audit.view');
  const w = [], a = [];
  if (query.get('entity')) { w.push('entity = ?'); a.push(query.get('entity')); }
  if (query.get('entityId')) { w.push('entity_id = ?'); a.push(query.get('entityId')); }
  if (query.get('user')) { w.push('user_id = ?'); a.push(query.get('user')); }
  if (query.get('action')) { w.push('action = ?'); a.push(query.get('action')); }
  const r = optRange(query.get('from'), query.get('to'));
  if (r.from != null) { w.push('at >= ?'); a.push(r.from); } if (r.to != null) { w.push('at < ?'); a.push(r.to); }
  const pageSize = Math.min(200, Math.max(1, parseInt(query.get('pageSize'), 10) || 50)), page = Math.max(1, parseInt(query.get('page'), 10) || 1);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const [[cnt], rows] = await many(db, [st(db, `SELECT COUNT(*) n FROM crm_audit ${where}`, ...a), st(db, `SELECT * FROM crm_audit ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, ...a, pageSize, (page - 1) * pageSize)]);   // zip 161: one trip
  const total = cnt.n;
  return { items: rows.map((x) => ({ id: x.id, userId: x.user_id, userName: x.user_name, action: x.action, entity: x.entity, entityId: x.entity_id, previous: jparse(x.prev), next: jparse(x.next), at: x.at })), total, page, pageSize };
}

// ---------- automation hook (spec section 50): the business events, oldest first, for an automation to poll and acknowledge ----------
export async function listEvents(ctx) {
  const { db, actor, query } = ctx; actor.require('settings.integrations');
  const w = [], a = [];
  const after = parseInt(query.get('after'), 10);
  if (Number.isFinite(after) && after > 0) { w.push('id > ?'); a.push(after); }
  if (query.get('name')) { w.push('name = ?'); a.push(String(query.get('name')).slice(0, 60)); }
  if (query.get('pending') === '1') w.push('processed_at IS NULL');
  const limit = Math.min(500, Math.max(1, parseInt(query.get('limit'), 10) || 100));
  const rows = await all(db, `SELECT * FROM crm_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id LIMIT ?`, ...a, limit);
  return { items: rows.map((e) => ({ id: e.id, name: e.name, entity: e.entity, entityId: e.entity_id, leadId: e.lead_id, actorId: e.actor_id, actorName: e.actor_name, data: jparse(e.data), at: e.at, processedAt: e.processed_at })), next: rows.length ? rows[rows.length - 1].id : after || 0 };
}
export async function ackEvents(ctx) {
  const { db, actor } = ctx; actor.require('settings.integrations');
  const b = await ctx.json();
  const ids = arr(b.ids, 500).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) throw E.bad('ids is required', 'invalid_ids');
  await st(db, `UPDATE crm_events SET processed_at = ? WHERE processed_at IS NULL AND id IN (${placeholders(ids.length)})`, now(), ...ids).run();
  return { ok: true };
}
