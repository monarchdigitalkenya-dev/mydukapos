// functions/api/_staff-auth.js — shared helper, NOT a route. Per-staff server sessions (zip 141).
//
// Until now the server knew the SHOP (its link) and the DEVICE (pairing), but not WHICH staff member was working: permissions were
// checked only in the app. Staff still sign in offline with their PIN, exactly as before. In addition, when the device is online:
//
//   * POST /api/staff-session { staffId, proof: SHA-256(PIN) } — the server checks the PIN against the staff record IT holds (the
//     sealed hash, zip 121), and issues a signed session: claims { sid, name, perms, mgr, iat, exp } + a per-session secret. The
//     signing key never leaves the server (env STAFF_SESSION_SECRET if set, else one random key per shop kept in KV).
//   * Every NEW sale made while that staff member is serving is signed on the device with the session secret (staffAuth). The server
//     re-checks that signature on every sync and stamps the sale `_auth` = { ok, sid, name } or { ok: false, reason }. A sale is
//     NEVER refused or dropped for this — an unsigned or badly signed sale is kept and shown as such in the reports.
//   * Staff actions on the server (QR codes, menu publishing, bookings, M-Pesa checks) carry the session (X-Staff-Token). When the
//     shop switches "staff sessions required" on, those actions are refused without a valid session, or without the permission.
//
// Everything is per shop: a session names its shop and is checked against that shop's key only.

import { readState, shopMode, shopCall } from './_state-store.js';
import { randomToken } from './_device-auth.js';

export const SESSION_MS = 16 * 3600 * 1000;                       // one working day (a long shift)
// zip 247: a session is RENEWED silently (no password) while the device holds its token: up to RENEW_GRACE_MS after it ran out (a phone that was
// offline / switched off overnight) and for at most RENEW_MAX_MS since the last typed password. A changed password / PIN, a removed or locked staff
// member ends it at once (the `pf` fingerprint below), so renewal never outlives a change of credentials.
export const RENEW_GRACE_MS = 3 * 24 * 3600 * 1000;
export const RENEW_MAX_MS = 14 * 24 * 3600 * 1000;
const MODE_KEY = (c) => `staff-auth-mode:${c}`;
const KEY_KEY = (c) => `staff-key:${c}`;
const enc = new TextEncoder();
const keyCache = new Map();                                        // clientId -> { at, key }
const modeCache = new Map();

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(String(msg))));
}
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));
const safeEq = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// The shop's signing key. From the environment secret when there is one (derived per shop), else a random key kept in KV.
export async function shopKey(env, clientId) {
  if (env && env.STAFF_SESSION_SECRET) return hmacHex(env.STAFF_SESSION_SECRET, 'shop|' + clientId);
  const hit = keyCache.get(clientId);
  if (hit && Date.now() - hit.at < 600000) return hit.key;
  let key = await env.mydukapos_kv.get(KEY_KEY(clientId));
  if (!key) {
    await env.mydukapos_kv.put(KEY_KEY(clientId), randomToken(32));
    key = await env.mydukapos_kv.get(KEY_KEY(clientId));             // two first logins at once: both use whichever was kept
  }
  keyCache.set(clientId, { at: Date.now(), key });
  return key;
}

// What a staff record may do on the server — the same rules as the app's hospCan(): the Admin and managers everything; staff with
// no hospitality role keep today's behaviour (everything their tabs allow); a hospitality role only its "perm:" markers.
export function permsOf(member) {
  if (!member) return ['*'];
  if (member.isManager) return ['*'];
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  if (!roles.some((r) => r.startsWith('hosp-role:'))) return ['*'];
  return roles.filter((r) => r.startsWith('perm:')).map((r) => r.slice(5));
}
export const hasPerm = (claims, perm) => !!claims && Array.isArray(claims.perms) && (claims.perms.includes('*') || claims.perms.includes(perm));

const SESS_KEY = (c, id) => `staff-sess:${c}:${id}`;
const SESS_KEEP_S = 40 * 24 * 3600;                                // a sale made offline can reach the server up to ~40 days later

export async function issueSession(env, clientId, who, now = Date.now()) {
  // `since`: when the PIN was checked on the device (signed in offline, confirmed here once online) — the session then also covers the
  // sales made since that sign-in, at most one working day back.
  const since = Number(who.since);
  const iat = Number.isFinite(since) && since < now && since > now - SESSION_MS ? Math.floor(since) : now;
  const key = await shopKey(env, clientId);
  const pf = who.pfSrc ? (await hmacHex(key, 'pf|' + who.pfSrc)).slice(0, 12) : '';
  const claims = { v: 1, c: clientId, sid: String(who.id), name: String(who.name || '').slice(0, 60), perms: who.perms, mgr: !!who.mgr, iat, exp: now + SESSION_MS, orig: Number(who.orig) || now, ...(pf ? { pf } : {}) };
  const body = b64u(JSON.stringify(claims));
  const sig = await hmacHex(key, 'tok|' + body);
  const sessionId = sig.slice(0, 20);
  // Sales carry only this short id (not the whole token), so the server keeps the claims for the time a sale may take to arrive.
  await env.mydukapos_kv.put(SESS_KEY(clientId, sessionId), JSON.stringify(claims), { expirationTtl: SESS_KEEP_S });
  return { token: `s1.${body}.${sig}`, sessionId, secret: await hmacHex(key, 'sec|' + sessionId), claims };
}

// -> claims, or null. Expired claims come back with `expired: true`.
export async function verifyToken(env, clientId, token, { at = Date.now(), key = null } = {}) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || p[0] !== 's1' || p[1].length > 2000) return null;
  const k = key || await shopKey(env, clientId);
  if (!safeEq(await hmacHex(k, 'tok|' + p[1]), p[2])) return null;
  let claims;
  try { claims = JSON.parse(unb64u(p[1])); } catch (e) { return null; }
  if (!claims || claims.c !== clientId) return null;
  return validAt(claims, at);
}
function validAt(claims, at) {
  if (!(at >= claims.iat - 300000 && at <= claims.exp)) return Object.assign({}, claims, { expired: true });
  return claims;
}

// The message a device signs for a sale (the same on the device — see src/shared/blocks/staff-session.html).
export function saleMessage(r) {
  let s = 0;
  (Array.isArray(r.items) ? r.items : []).forEach((it) => { if (it) s += (+it.price || 0) * (+it.qty || 0); });
  return `${r.id}|${r.deviceTimestamp || r.timestamp || ''}|${Math.round(s * 100)}`;
}
const stampMac = (key, r, a) => hmacHex(key, `auth|${saleMessage(r)}|${a.ok ? 1 : 0}|${a.sid || ''}|${a.name || ''}|${a.reason || ''}`).then((h) => h.slice(0, 32));

// Stamp every sale in a push with what the server found. A stamp the SERVER made earlier (it is signed) is kept as long as the sale
// is unchanged; anything else a device sent in `_auth` is thrown away. So the same sale always ends with the same stamp, whichever
// device sends it and however often — and a sale is never refused or dropped because of it.
export async function stampSales(env, clientId, body) {
  const list = body && Array.isArray(body.salesLog) ? body.salesLog : null;
  if (!list || !list.length) return 0;
  let key = null, n = 0;
  const sessions = new Map();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const prior = r._auth;
    delete r._auth;
    const sa = r.staffAuth;
    if (!sa || typeof sa !== 'object' || typeof sa.s !== 'string' || typeof sa.m !== 'string' || !/^[0-9a-f]{20}$/.test(sa.s)) continue;
    if (!key) key = await shopKey(env, clientId);
    if (prior && typeof prior === 'object' && typeof prior.h === 'string') {
      const keep = { ok: !!prior.ok, ...(prior.sid ? { sid: String(prior.sid) } : {}), ...(prior.name ? { name: String(prior.name) } : {}), ...(prior.reason ? { reason: String(prior.reason) } : {}) };
      if (safeEq(await stampMac(key, r, keep), prior.h)) { r._auth = { ...keep, h: prior.h }; n++; continue; }
    }
    if (!sessions.has(sa.s)) {
      let c = null;
      try { const raw = await env.mydukapos_kv.get(SESS_KEY(clientId, sa.s)); c = raw ? JSON.parse(raw) : null; } catch (e) { c = null; }
      sessions.set(sa.s, c && c.c === clientId ? c : null);
    }
    const claims0 = sessions.get(sa.s);
    const at = Date.parse(r.timestamp) || 0;                       // the server-corrected time of the sale
    const claims = claims0 ? validAt(claims0, at) : null;
    let out;
    if (!claims) out = { ok: false, reason: 'unknown-session' };
    else if (claims.expired) out = { ok: false, reason: 'session-expired', sid: claims.sid, name: claims.name };
    else if (!safeEq((await hmacHex(await hmacHex(key, 'sec|' + sa.s), saleMessage(r))).slice(0, 32), sa.m)) out = { ok: false, reason: 'changed-after-signing', sid: claims.sid, name: claims.name };
    else if (!hasPerm(claims, 'payments')) out = { ok: false, reason: 'no-payment-permission', sid: claims.sid, name: claims.name };
    else out = { ok: true, sid: claims.sid, name: claims.name };
    out.h = await stampMac(key, r, out);
    r._auth = out; n++;
  }
  return n;
}

export async function readMode(env, clientId) {
  const hit = modeCache.get(clientId);
  if (hit && Date.now() - hit.at < 20000) return hit.mode;
  let mode = 'off';
  try { mode = (await env.mydukapos_kv.get(MODE_KEY(clientId))) === 'enforce' ? 'enforce' : 'off'; } catch (e) { /* off */ }
  modeCache.set(clientId, { at: Date.now(), mode });
  return mode;
}
export async function writeMode(env, clientId, mode) {
  await env.mydukapos_kv.put(MODE_KEY(clientId), mode === 'enforce' ? 'enforce' : 'off');
  modeCache.set(clientId, { at: Date.now(), mode: mode === 'enforce' ? 'enforce' : 'off' });
}
export function staffTokenOf(request) {
  return request.headers.get('X-Staff-Token') || '';
}

// For a staff action on the server. -> { claims, denied } — `denied` is the Response to send back (only when the shop requires staff
// sessions). When it does not, the action goes ahead exactly as before and `claims` (if any) only records who did it.
export async function staffGuard(request, env, clientId, perm, cors = {}) {
  const tok = staffTokenOf(request);
  const claims = tok ? await verifyToken(env, clientId, tok) : null;
  const ok = claims && !claims.expired;
  const mode = await readMode(env, clientId);
  if (mode !== 'enforce') return { claims: ok ? claims : null, denied: null };
  const deny = (code, error, status) => new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json', ...cors } });
  if (!ok) return { claims: null, denied: deny('staff_session_required', claims && claims.expired ? 'Your staff session has ended — sign in again with your PIN.' : 'Sign in with your staff PIN (while online) to do this.', 401) };
  if (perm && !hasPerm(claims, perm)) return { claims, denied: deny('staff_forbidden', `${claims.name || 'This staff member'} is not allowed to do this — ask a supervisor.`, 403) };
  return { claims, denied: null };
}

// The staff record the server holds (for a PIN check). Database shops answer from their own database.
export async function staffRecord(env, clientId, staffId) {
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'staff-member', { id: staffId });
    if (res.status === 404) { const d = await res.json().catch(() => ({})); if (d && d.error === 'Unknown operation.') return { outdated: true }; return null; }
    if (!res.ok) throw new Error('shop database unavailable');
    const d = await res.json().catch(() => ({}));
    return d && d.member ? d.member : null;
  }
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  return (Array.isArray(st.staff) ? st.staff : []).find((s) => s && String(s.id) === String(staffId)) || null;
}

// A fingerprint source for a credential (what the key-bound `pf` claim is made from): changes whenever the password / PIN does.
export const pfSourceOf = (...hashes) => hashes.filter(Boolean).join('|');
export async function pfMatches(env, clientId, claims, src) {
  if (!claims || !claims.pf) return false;
  return safeEq((await hmacHex(await shopKey(env, clientId), 'pf|' + src)).slice(0, 12), claims.pf);
}
