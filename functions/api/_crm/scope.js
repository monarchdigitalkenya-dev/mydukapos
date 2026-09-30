// functions/api/_crm/scope.js — who may see which rows (NOT a route). Object-level rules are applied in SQL, so a changed id can never widen access.
import { E, all, placeholders } from './core.js';

// Leads: leads.all sees everything; everyone else sees their own leads + the unassigned pool.
export function leadScope(actor, a = 'l') {
  if (actor.has('leads.all')) return { sql: `${a}.deleted_at IS NULL`, args: [] };
  return { sql: `${a}.deleted_at IS NULL AND (${a}.owner_id = ? OR ${a}.owner_id IS NULL)`, args: [actor.id] };
}
export const canWriteLead = (actor, lead) => actor.has('leads.all') || lead.owner_id === actor.id;

// Revenue (crm_sales): company = all; team = the closing staff share the viewer's department (or, with no department, any staff-closed sale); own = closed by me.
export function salesScope(actor, a = 's') {
  if (actor.has('revenue.company')) return { sql: '1=1', args: [] };
  if (actor.has('revenue.team')) {
    if (actor.department) return { sql: `(${a}.closed_by = ? OR EXISTS (SELECT 1 FROM crm_users cu WHERE cu.id = ${a}.closed_by AND cu.department = ?))`, args: [actor.id, actor.department] };
    return { sql: `${a}.closed_by IS NOT NULL`, args: [] };
  }
  if (actor.has('revenue.own')) return { sql: `${a}.closed_by = ?`, args: [actor.id] };
  return null;
}
export const revenueLevel = (actor) => (actor.has('revenue.company') ? 'company' : actor.has('revenue.team') ? 'team' : actor.has('revenue.own') ? 'own' : null);
export const reportLevel = (actor) => (actor.has('reports.company') ? 'company' : actor.has('reports.team') ? 'team' : actor.has('reports.own') ? 'own' : null);

// staff ids a viewer may look at for a level: null = everyone
export async function staffIdsFor(db, actor, level) {
  if (level === 'company') return null;
  if (level === 'own') return [actor.id];
  const rows = actor.department ? await all(db, `SELECT id FROM crm_users WHERE department = ?`, actor.department) : await all(db, `SELECT id FROM crm_users WHERE role != 'owner'`);
  const ids = new Set(rows.map((r) => r.id)); ids.add(actor.id);
  return [...ids];
}
export const inClause = (col, ids) => (ids.length ? { sql: `${col} IN (${placeholders(ids.length)})`, args: ids } : { sql: '0=1', args: [] });
// the staff filter of a request, checked against what the viewer may see -> array of ids or null
export function staffFilter(allowed, requested) {
  if (!requested) return allowed;
  if (allowed && !allowed.includes(requested)) throw E.forbidden('You cannot look at that person\'s figures', 'forbidden');
  return [requested];
}
