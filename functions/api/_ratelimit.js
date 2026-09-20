// functions/api/_ratelimit.js — shared helper, NOT a route.
//
// Per-shop hourly caps on the two endpoints that cost real money if a shop's link leaks: SMS sending (spends the
// shop's SMS credit) and M-Pesa STK prompts (spams customers' phones). Backed by KV counters, so it is a throttle,
// not an exact meter (KV is eventually consistent and a get-then-put is not atomic) — good enough to turn "unlimited"
// into "a few hundred", and every blocked call is recorded for the Owner Console's 💾 Storage & safety tab.
//
// Limits are per SHOP per hour and can be changed without a code change (Pages -> Settings -> Environment variables):
//   SMS_HOURLY_LIMIT   default 1500 recipients      STK_HOURLY_LIMIT   default 60 prompts

export const RL_HIT_PREFIX = 'ratelimit-hit:';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export const LIMITS = {
  sms: (env) => num(env && env.SMS_HOURLY_LIMIT, 1500),
  stk: (env) => num(env && env.STK_HOURLY_LIMIT, 60),
};

// -> { ok, used, limit, retryAfter }   `cost` = how many units this request would consume (e.g. recipients).
export async function checkRateLimit(env, name, clientId, cost = 1) {
  const limit = LIMITS[name](env);
  const windowSec = 3600;
  const now = Date.now();
  const bucket = Math.floor(now / (windowSec * 1000));
  const key = `rl:${name}:${clientId}:${bucket}`;
  let used = 0;
  try {
    used = Number(await env.mydukapos_kv.get(key)) || 0;
  } catch (e) {
    return { ok: true, used: 0, limit, retryAfter: 0 };   // never block a shop because the limiter itself failed
  }
  const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowSec * 1000 - now) / 1000));
  if (used + cost > limit) {
    await recordHit(env, name, clientId, limit, now);
    return { ok: false, used, limit, retryAfter };
  }
  try {
    await env.mydukapos_kv.put(key, String(used + cost), { expirationTtl: windowSec * 2 });
  } catch (e) { /* ignore */ }
  return { ok: true, used: used + cost, limit, retryAfter };
}

// One small record per shop+kind: { count, last, first, limit } — written at most once a minute so a flood of
// blocked calls cannot itself hammer KV.
async function recordHit(env, name, clientId, limit, now) {
  const key = `${RL_HIT_PREFIX}${name}:${clientId}`;
  try {
    const raw = await env.mydukapos_kv.get(key);
    const prev = raw ? JSON.parse(raw) : null;
    if (prev && now - prev.last < 60 * 1000) return;
    await env.mydukapos_kv.put(key, JSON.stringify({
      name, clientId, limit, first: prev ? prev.first : now, last: now, count: (prev ? prev.count : 0) + 1,
    }), { expirationTtl: 7 * 24 * 3600 });
  } catch (e) { /* ignore */ }
}

export function rateLimitResponse(what, r, headers = {}) {
  return new Response(JSON.stringify({
    error: `Too many ${what} from this shop in the last hour (limit ${r.limit}). Try again in about ${Math.ceil(r.retryAfter / 60)} minute(s), or contact support if this is expected.`,
    code: 'rate_limited', limit: r.limit, retryAfter: r.retryAfter,
  }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfter), ...headers } });
}
