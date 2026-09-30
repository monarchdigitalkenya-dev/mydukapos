// functions/api/_crm/notify.js — notification recipients + statements (NOT a route).
import { notifySt } from './core.js';
import { usersWith } from './auth.js';

// statements that notify every user in `users` (deduped by id), never `exceptId` (the person who did it)
export function notifyMany(db, users, exceptId, kind, title, body, o = {}) {
  const seen = new Set(), out = [];
  for (const u of users) {
    const id = typeof u === 'string' ? u : u && u.id;
    if (!id || id === exceptId || seen.has(id)) continue;
    seen.add(id);
    out.push(notifySt(db, id, kind, title, body, { ...o, dedupe: o.dedupe ? o.dedupe + ':' + id : null }));
  }
  return out;
}
export const managers = (db, exceptId) => usersWith(db, 'leads.assign', exceptId);
// everyone who can act on an unassigned lead: the people who may assign it and the people who may claim it (each once, never `exceptId`)
export async function poolWatchers(db, exceptId) {
  const [a, b] = await Promise.all([usersWith(db, 'leads.assign', exceptId), usersWith(db, 'leads.claim', exceptId)]);
  return [...new Map([...a, ...b].map((u) => [u.id, u])).values()];
}
