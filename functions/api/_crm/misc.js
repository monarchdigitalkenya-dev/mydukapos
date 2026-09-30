// functions/api/_crm/misc.js — notifications, audit trail (NOT a route).
import { E, all, first, st, now, jparse, optRange, arr, placeholders, text } from './core.js';
import { sweepReminders } from './followups.js';

export async function listNotifications(ctx) {
  const { db, actor, query } = ctx;
  await sweepReminders(db);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.get('pageSize'), 10) || 30)), page = Math.max(1, parseInt(query.get('page'), 10) || 1);
  const w = ['user_id = ?'], a = [actor.id];
  if (query.get('unread') === '1') w.push('read_at IS NULL');
  const rows = await all(db, `SELECT * FROM crm_notifications WHERE ${w.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...a, pageSize, (page - 1) * pageSize);
  const unread = (await first(db, `SELECT COUNT(*) n FROM crm_notifications WHERE user_id = ? AND read_at IS NULL`, actor.id)).n;
  return { items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, leadId: n.lead_id, entity: n.entity, entityId: n.entity_id, at: n.created_at, read: n.read_at != null })), unread, page, pageSize };
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
  const total = (await first(db, `SELECT COUNT(*) n FROM crm_audit ${where}`, ...a)).n;
  const rows = await all(db, `SELECT * FROM crm_audit ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, ...a, pageSize, (page - 1) * pageSize);
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
