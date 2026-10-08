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
  // device pairing attempts per shop per hour (zip 120) — stops a password/code being guessed by brute force
  pair: (env) => num(env && env.PAIR_HOURLY_LIMIT, 20),
  // QR ordering (zip 136): per shop per hour, and per single table / room code per hour (keyed by the code itself)
  qr: (env) => num(env && env.QR_HOURLY_LIMIT, 600),
  qrtok: (env) => num(env && env.QR_CODE_HOURLY_LIMIT, 15),
  // staff server sessions (zip 141): PIN attempts per staff member per hour, and sign-ins per shop per hour
  staffPin: (env) => num(env && env.STAFF_PIN_HOURLY_LIMIT, 20),
  staffShop: (env) => num(env && env.STAFF_SIGNIN_HOURLY_LIMIT, 400),
  // zip 177: public contact form, per caller IP per hour
  // zip 177: verification codes sent, per account per hour
  otp: (env) => num(env && env.OTP_HOURLY_LIMIT, 6),
  contact: (env) => num(env && env.CONTACT_HOURLY_LIMIT, 5),
  // zip 247: typed Admin password / manager PIN checks when changing payment or SMS credentials, per shop per hour (a guessing brake)
  payProof: (env) => num(env && env.PAY_PROOF_HOURLY_LIMIT, 12),
  // zip 247: payment prompts to ONE phone number (per shop + number), per hour — stops a leaked link being used to pester a customer
  stkPhone: (env) => num(env && env.STK_PHONE_HOURLY_LIMIT, 6),
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

// zip 143 — password guessing. The owner sign-in (one account that controls every shop), the website/demo account sign-in and the
// recovery-password checks had no limit at all. Only FAILED attempts are counted, per caller IP and per account, per hour — someone
// who knows their password is never slowed down. Limits: LOGIN_FAILS_PER_IP (default 30) and LOGIN_FAILS_PER_ACCOUNT (default 20).
const LOGIN_WINDOW_SEC = 3600;
function loginKeys(request, account) {
  const ip = (request && request.headers && (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For'))) || 'unknown';
  const bucket = Math.floor(Date.now() / (LOGIN_WINDOW_SEC * 1000));
  return [
    { key: `rl:loginfail:ip:${ip}:${bucket}`, limit: (env) => num(env && env.LOGIN_FAILS_PER_IP, 30) },
    ...(account ? [{ key: `rl:loginfail:acct:${String(account).toLowerCase().slice(0, 200)}:${bucket}`, limit: (env) => num(env && env.LOGIN_FAILS_PER_ACCOUNT, 20) }] : []),
  ];
}
// -> null when allowed, or a 429 Response to send back
export async function loginBlocked(env, request, account, headers = {}) {
  for (const k of loginKeys(request, account)) {
    let used = 0;
    try { used = Number(await env.mydukapos_kv.get(k.key)) || 0; } catch (e) { return null; }   // never lock anyone out because the limiter failed
    if (used >= k.limit(env)) {
      return new Response(JSON.stringify({ error: 'Too many wrong passwords. Wait an hour and try again, or use "Forgot password".', code: 'rate_limited' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(LOGIN_WINDOW_SEC), ...headers } });
    }
  }
  return null;
}
export async function noteLoginFailure(env, request, account) {
  for (const k of loginKeys(request, account)) {
    try {
      const used = Number(await env.mydukapos_kv.get(k.key)) || 0;
      await env.mydukapos_kv.put(k.key, String(used + 1), { expirationTtl: LOGIN_WINDOW_SEC * 2 });
    } catch (e) { /* ignore */ }
  }
}
