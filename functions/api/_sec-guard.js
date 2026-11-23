// functions/api/_sec-guard.js — shared helper, NOT a route. (zip 185)
//
// Two small guards for destructive / financial shop actions that used to be gated only in the app:
//
//   managerGuard()  a NO-OP for every shop that has not switched "staff sessions required" on (staff-session mode 'off', the default).
//                   When the shop HAS switched it on, the action needs a valid manager (or Admin) staff session — the same X-Staff-Token every
//                   app already sends on every /api/ call (see src/shared/blocks/staff-session.html), so a manager signed in while online passes.
//   secLimit()      a per-shop KV counter (a throttle, not an exact meter — KV is eventually consistent), generous enough that no real shop
//                   reaches it. Never blocks because the limiter itself failed. Limits can be changed with env vars (see callers).
import { staffGuard, readMode } from './_staff-auth.js';
import { atomicHit } from './_atomic-counter.js';

export async function managerGuard(request, env, clientId, cors = {}) {
  const sg = await staffGuard(request, env, clientId, null, cors);
  if (sg.denied) return sg.denied;
  if ((await readMode(env, clientId)) === 'enforce' && !(sg.claims && sg.claims.mgr)) {
    return new Response(JSON.stringify({ error: 'Only the Admin or a manager can do this — sign in as one (while online).', code: 'staff_forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  return null;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

// -> null when allowed, or a 429 Response. `name` namespaces the counter; `limit` is already resolved by the caller.
export async function secLimit(env, name, key, limit, windowSec, what, cors = {}) {
  const now = Date.now();
  const bucket = Math.floor(now / (windowSec * 1000));
  const k = `rl185:${name}:${key}:${bucket}`;
  let used = 0;
  const atomic = await atomicHit(env, k, 1, windowSec * 2);          // zip 273: atomic where the database is bound, KV otherwise
  if (atomic !== null) used = atomic - 1;
  else { try { used = Number(await env.mydukapos_kv.get(k)) || 0; } catch (e) { return null; } }
  if (used >= limit) {
    const retry = Math.max(1, Math.ceil(((bucket + 1) * windowSec * 1000 - now) / 1000));
    return new Response(JSON.stringify({ error: `Too many ${what} from this shop just now (limit ${limit}). Try again in about ${Math.ceil(retry / 60)} minute(s), or contact support if this is expected.`, code: 'rate_limited', limit, retryAfter: retry }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry), ...cors } });
  }
  if (atomic === null) { try { await env.mydukapos_kv.put(k, String(used + 1), { expirationTtl: windowSec * 2 }); } catch (e) { /* ignore */ } }
  return null;
}
export { num as secNum };
