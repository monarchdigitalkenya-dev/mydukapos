// functions/api/_owner-auth.js — shared helper, NOT a route.
//
// Replaces the old master.html admin dashboard + MASTER_ADMIN_PASSWORD.
// There is exactly ONE owner account for this whole deployment. It's
// created the first time anyone completes the sign-up form (see
// owner-auth.js) — after that, sign-up is permanently disabled and only
// sign-in works, using that same email/phone + password for as long as the
// account exists ("sign in once, for life" — see README-MASTER.md).
//
// The password is never stored in plain text — only a salted SHA-256 hash.
//
// On sign-up, a normal PERMANENT client license record is also created
// (see _license.js) for the owner's own device/browser, product "shop".
// This is the trick that makes the rest of the app "just work" for the
// owner without touching every other function: index.html redirects the
// owner's tab to /?c=<that id> after login, so from then on it's treated
// exactly like any licensed shop (inventory, M-Pesa, cloud sync, etc. all
// keep working via the existing ?c= mechanism). The owner's EXTRA admin
// powers — generating/managing links for other shops — are gated
// separately, by the session token below, never by that license token.

import { createClient, deleteClient } from './_license.js';
import { hashPassword, checkPassword, upgradeOnLogin } from './_password.js';

const OWNER_KEY = 'owner-account:v1';
const SESSION_PREFIX = 'owner-session:';
// Sessions effectively never expire on their own — logging out (or clearing
// the browser) is the only way to end one, matching "sign in for life".
const SESSION_TTL_SECONDS = 20 * 365 * 24 * 60 * 60; // ~20 years  (sessions issued BEFORE zip 185 keep this lifetime — see below)
// zip 185: a session issued from now on lasts 30 days (a stolen token no longer works for 20 years). Sessions issued before this deploy
// are grandfathered: their token's own issue time (iat, signed) is earlier than the cutoff, so they are accepted exactly as before.
const NEW_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_EXPIRY_FROM_MS = Date.UTC(2026, 9, 3);       // tokens issued on/after this instant expire NEW_SESSION_TTL_SECONDS after issue
const sessionExpired = (iatMs) => iatMs >= SESSION_EXPIRY_FROM_MS && Date.now() - iatMs > NEW_SESSION_TTL_SECONDS * 1000;

function randomToken(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOwnerAccount(env) {
  const raw = await env.mydukapos_kv.get(OWNER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function createOwnerAccount(env, identifier, password) {
  const existing = await getOwnerAccount(env);
  if (existing) {
    throw new Error('An owner account already exists for this deployment. Please sign in instead.');
  }

  const { salt, passwordHash } = await hashPassword(password);
  const ownerClient = await createClient(env, 'permanent', 'Owner Console (you)', 'shop');

  const account = {
    identifier: identifier.trim(),
    salt,
    passwordHash,
    ownerClientId: ownerClient.id,
    createdAt: Date.now(),
  };
  // zip 185: creating the licence above takes a moment; two simultaneous first sign-ups both passed the check at the top. Look again right before
  // writing so the second one loses (KV has no compare-and-set, so this narrows the window to a single read-then-write, it cannot close it).
  if (await getOwnerAccount(env)) {
    try { await deleteClient(env, ownerClient.id); } catch (e) { /* the unused licence stays in the trash list */ }
    throw new Error('An owner account already exists for this deployment. Please sign in instead.');
  }
  await env.mydukapos_kv.put(OWNER_KEY, JSON.stringify(account));
  return account;
}

export async function verifyOwnerLogin(env, identifier, password) {
  const account = await getOwnerAccount(env);
  if (!account) return null;
  if (account.identifier.trim().toLowerCase() !== String(identifier || '').trim().toLowerCase()) return null;
  if (!(await checkPassword(account, password))) return null;
  try {                                                  // zip 177: old one-round SHA-256 record -> PBKDF2, now that the owner proved the password
    const up = await upgradeOnLogin(account, String(password));
    if (up) { account.salt = up.salt; account.passwordHash = up.passwordHash; await env.mydukapos_kv.put(OWNER_KEY, JSON.stringify(account)); }
  } catch (e) { /* retried at the next sign-in */ }
  return account;
}

// SESSIONS (zip 127). A session used to exist ONLY as a KV record written at sign-in. KV is eventually consistent: a request that reached
// another Cloudflare location in the first minute after signing in (or one whose "not found" answer was cached there) did not see the
// record yet, so the Owner Console said "Sign in as the owner" to an owner who had just signed in. A session token is now SIGNED
// (HMAC-SHA256 with a key derived from the owner account's own salt + password hash, which never changes between sign-ins and never
// leaves the server): any location can verify it on the spot. Signing out writes a revocation record (checked on every request); a
// password change changes the key, which ends every older session. The KV record is still written, so a token is also accepted while
// the account record itself is still spreading (e.g. right after a password change), and older plain tokens keep working.
const REVOKED_PREFIX = 'owner-session-revoked:';
async function hmacHex(keyText, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sessionKey(account) {
  return sha256Hex('owner-session-v2|' + account.salt + '|' + account.passwordHash + '|' + (account.ownerClientId || ''));
}
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function parseSigned(token) {
  const p = String(token || '').split('.');
  return p.length === 4 && p[0] === 'o2' && /^[0-9a-f]{64}$/.test(p[1]) && /^[0-9a-z]{1,12}$/.test(p[2]) && /^[0-9a-f]{64}$/.test(p[3]) ? { rand: p[1], iat: p[2], sig: p[3] } : null;
}

export async function createOwnerSession(env, account) {
  const rand = randomToken();
  await env.mydukapos_kv.put(SESSION_PREFIX + rand, '1', { expirationTtl: NEW_SESSION_TTL_SECONDS });   // zip 185: was ~20 years
  const acct = account || (await getOwnerAccount(env));
  if (!acct) return rand;                                   // no account to sign with (should not happen): a plain KV session
  const iat = Date.now().toString(36);
  return `o2.${rand}.${iat}.${await hmacHex(await sessionKey(acct), rand + '.' + iat)}`;
}

export async function destroyOwnerSession(env, token) {
  if (!token) return;
  const s = parseSigned(token);
  if (s) {
    await env.mydukapos_kv.put(REVOKED_PREFIX + s.rand, '1', { expirationTtl: SESSION_TTL_SECONDS });
    await env.mydukapos_kv.delete(SESSION_PREFIX + s.rand);
    return;
  }
  await env.mydukapos_kv.delete(SESSION_PREFIX + token);
}

function tokenFromRequest(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// The ONE check every owner-only endpoint uses (client-log, owner-health, owner-storage, owner-clients, owner-lock, leads, website...).
export async function requireOwnerAuth(context) {
  const { request, env } = context;
  const token = tokenFromRequest(request);
  if (!token || token.length > 300) return false;
  const s = parseSigned(token);
  if (s) {
    if (sessionExpired(parseInt(s.iat, 36))) return false;    // zip 185: a 30-day session (issued from the cutoff on) that has run out; older tokens are unaffected
    if (await env.mydukapos_kv.get(REVOKED_PREFIX + s.rand)) return false;
    const account = await getOwnerAccount(env);
    if (account && sameText(await hmacHex(await sessionKey(account), s.rand + '.' + s.iat), s.sig)) return true;
    return !!(await env.mydukapos_kv.get(SESSION_PREFIX + s.rand));
  }
  const raw = await env.mydukapos_kv.get(SESSION_PREFIX + token);
  return !!raw;
}

export { tokenFromRequest, sessionExpired as _sessionExpired };
