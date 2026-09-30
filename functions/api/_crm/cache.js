// functions/api/_crm/cache.js — a tiny per-isolate memory for the CRM's rarely-changing lookups (NOT a route). zip 161.
// What is kept: the labels / colours of statuses, classifications, sources, lost reasons, the product list and the settings — the things every screen needs and that an admin
// changes a few times a year. What is NEVER kept: users, roles, permissions, sessions, leads, anything a person acts on (a suspension or a permission change must bite at once).
// Rules:
//   * keyed by the database object, so two databases (or two tests) never share entries;
//   * a short TTL (30 s, CRM_CACHE_MS to change, 0 switches the memory off), so another Worker instance sees an admin's change within that time;
//   * the instance that WROTE the change drops the entry at once (invalidate), so the admin sees their own edit immediately;
//   * a failing load is never cached, and concurrent loads of the same key share one query.
const stores = new WeakMap();
let TTL = 30000;
let epoch = 0;                                                                    // resetCaches() bumps it: every older entry is ignored
export function configureCache(env) {
  const v = env && env.CRM_CACHE_MS;
  TTL = v == null || v === '' || !Number.isFinite(Number(v)) ? 30000 : Math.max(0, Number(v));
}
export const cacheTtl = () => TTL;
const rawOf = (db) => (db && db._raw) || db;                                       // a request's counting wrapper (core.js countedDb) and the real handle share one memory
const store = (db) => { db = rawOf(db); let s = stores.get(db); if (!s) { s = new Map(); stores.set(db, s); } return s; };
export async function cached(db, key, load) {
  if (!TTL || !db) return load();
  const s = store(db), hit = s.get(key), t = Date.now();
  if (hit && hit.e === epoch && hit.v !== undefined && t - hit.at < TTL) return hit.v;
  if (hit && hit.e === epoch && hit.p && t - hit.at < 5000) return hit.p;                          // another request is loading it right now
  const p = Promise.resolve().then(load).then((v) => { if (s.get(key) === entry) { entry.v = v; entry.p = null; entry.at = Date.now(); } return v; }, (e) => { if (s.get(key) === entry) s.delete(key); throw e; });
  const entry = { at: t, p, v: undefined, e: epoch };
  s.set(key, entry);
  return p;
}
// drop entries whose key starts with any of the prefixes (no prefix = everything)
export function invalidate(db, ...prefixes) {
  const s = stores.get(rawOf(db)); if (!s) return;
  if (!prefixes.length) { s.clear(); return; }
  for (const k of [...s.keys()]) if (prefixes.some((p) => k.startsWith(p))) s.delete(k);
}
export function resetCaches() { epoch++; }
// the value if it is fresh in memory, else undefined (never loads); prime() stores a value the caller loaded itself (boot() loads several things in one round trip)
export function peek(db, key) { if (!TTL) return undefined; const h = store(db).get(key); return h && h.e === epoch && h.v !== undefined && Date.now() - h.at < TTL ? h.v : undefined; }
export function prime(db, key, v) { if (TTL) store(db).set(key, { at: Date.now(), p: null, v, e: epoch }); }
