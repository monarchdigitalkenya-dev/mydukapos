// functions/api/_device-auth.js — shared helper, NOT a route.
//
// DEVICE PAIRING (zip 120). Until now a shop was identified ONLY by its link: anyone who knew it could read and change the whole shop.
// Tills must keep signing in with no internet (owner's decision — SYNC_AUTH_DESIGN.md), so the check is on SYNC, not on sign-in:
//
//   * Each device gets its own secret token once — by proving the shop password (its SHA-256, the same value the apps already use
//     to sign in offline) or with a 6-digit pairing code shown on a device that is already paired. The server keeps only the
//     token's SHA-256. The device sends it on every API call (X-Device-Id / X-Device-Token headers; `di` / `dt` on the WebSocket).
//   * Per shop, `mode` is 'open' (the default — exactly the old behaviour; devices still pair themselves in the background so they
//     are ready) or 'paired' (the shop's data endpoints refuse a device without a valid token: HTTP 401, code 'device_not_paired').
//   * Signing in, selling, stock — everything on the device keeps working offline either way; an unpaired device simply cannot
//     sync until it is paired, and keeps its data meanwhile.
//
// Stored in KV as `device-auth:<clientId>` = { mode, devices: { <deviceId>: { h, name, pairedAt, pairedBy, revoked } } }. Written only
// when something changes (pair / revoke / rename / mode) — never on an ordinary request.

const KEY = (clientId) => `device-auth:${clientId}`;
const CACHE_MS = 20000;
const caches = new WeakMap();                                       // KV binding -> Map(clientId -> { at, rec }) (per isolate, short-lived)
const cacheFor = (env) => { const kv = (env && env.mydukapos_kv) || cacheFor; if (!caches.has(kv)) caches.set(kv, new Map()); return caches.get(kv); };

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Salted password hashes (zip 121 — sealHash in src/shared/functions.js): "p2$<iterations>$<salt>$<PBKDF2-SHA256(sha256(password), salt)>".
async function pbkdf2Hex(secret, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations: Math.min(100000, Number(iterations) || 100000) }, key, 256);
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const parseSealed = (h) => { const p = String(h || '').split('$'); return p.length === 4 && p[0] === 'p2' ? { iter: p[1], salt: p[2], hex: p[3] } : null; };

// Does a pairing proof match a stored shop password hash? Either side may be the plain SHA-256 or the sealed form:
//   same string -> yes;  plain proof vs sealed stored -> PBKDF2 it with the stored salt;  sealed proof vs plain stored -> seal the stored
//   hash with the proof's salt. (Two sealed values with different salts cannot be compared — every device of a shop uses the same salt.)
export async function proofMatches(proof, stored) {
  if (!proof || !stored || typeof proof !== 'string' || typeof stored !== 'string') return false;
  if (proof === stored) return true;
  try {
    const s = parseSealed(stored), p = parseSealed(proof);
    if (s && !p) return (await pbkdf2Hex(proof, s.salt, s.iter)) === s.hex;
    if (p && !s) return (await pbkdf2Hex(stored, p.salt, p.iter)) === p.hex;
  } catch (e) { /* no match */ }
  return false;
}
export const isSealedProof = (proof) => !!parseSealed(proof);

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function readDeviceAuth(env, clientId, { fresh = false } = {}) {
  const cache = cacheFor(env);
  const hit = cache.get(clientId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.rec;
  let rec = { mode: 'open', devices: {} };
  try {
    const raw = await env.mydukapos_kv.get(KEY(clientId));
    if (raw) { const r = JSON.parse(raw); rec = { mode: r.mode === 'paired' ? 'paired' : 'open', devices: r.devices && typeof r.devices === 'object' ? r.devices : {} }; }
  } catch (e) { /* unreadable: treated as open (never lock a shop out because of a read error) */ }
  cache.set(clientId, { at: Date.now(), rec });
  return rec;
}

export async function writeDeviceAuth(env, clientId, rec) {
  await env.mydukapos_kv.put(KEY(clientId), JSON.stringify(rec));
  cacheFor(env).set(clientId, { at: Date.now(), rec });
}

export function deviceCredentials(request) {
  let id = request.headers.get('X-Device-Id') || '';
  let token = request.headers.get('X-Device-Token') || '';
  if (!id || !token) {
    try { const u = new URL(request.url); id = id || u.searchParams.get('di') || ''; token = token || u.searchParams.get('dt') || ''; } catch (e) { /* none */ }
  }
  return { id: String(id).slice(0, 80), token: String(token).slice(0, 200) };
}

// -> { paired: bool, deviceId, mode }
export async function checkDevice(request, env, clientId) {
  const rec = await readDeviceAuth(env, clientId);
  const { id, token } = deviceCredentials(request);
  let paired = false;
  if (id && token && rec.devices[id] && !rec.devices[id].revoked) paired = (await sha256hex(token)) === rec.devices[id].h;
  return { paired, deviceId: id, mode: rec.mode };
}

// The guard every shop-data endpoint calls right after the license check. Returns null (go ahead) or the 401 Response.
export async function deviceGuard(request, env, clientId, cors = {}) {
  let r = await checkDevice(request, env, clientId);
  if (r.mode !== 'paired' || r.paired) return null;
  // zip 127: never refuse on a cached copy — a device paired a moment ago (possibly through another server instance) is not in it yet.
  if (r.deviceId) {
    await readDeviceAuth(env, clientId, { fresh: true });
    r = await checkDevice(request, env, clientId);
    if (r.mode !== 'paired' || r.paired) return null;
  }
  return new Response(JSON.stringify({ error: 'This device is not paired with the shop yet. Enter the shop password (or a pairing code) on this device to pair it.', code: 'device_not_paired' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...cors },
  });
}
