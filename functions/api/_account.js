// functions/api/_account.js — shared helper, NOT a route.
//
// The single account store behind demo-account.js (website registration,
// login, password reset, demo dashboard) AND pos-account-auth.js (direct
// POS login/signup, business-name linking). Pulled out of demo-account.js
// so there is exactly ONE place that reads/writes an account record and
// hashes a password — the spec's "password set during initial signup
// becomes the single unified password for both web account management and
// POS administration" only holds if both entry points share this file
// instead of each keeping their own copy that could drift apart.
//
// Storage (same mydukapos_kv namespace as _license.js):
//   demo-account:<lowercased email>   -> account record (JSON)
//   demo-account-session:<token>      -> email (session lookup)
//   demo-account-index:v1             -> array of lead summaries, newest first

import { hashPassword, checkPassword, upgradeOnLogin, passwordProblem } from './_password.js';

export const ACCOUNT_PREFIX = 'demo-account:';
export const SESSION_PREFIX = 'demo-account-session:';
export const INDEX_KEY = 'demo-account-index:v1';
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export function randomToken(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// zip 179: WhatsApp number is the one required contact; email is optional. Same Kenyan-number rules as verify.js (copied: verify.js imports this file).
export function intlPhone(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^[17]\d{8}$/.test(d)) return '254' + d;
  if (/^254[17]\d{8}$/.test(d)) return d;
  return /^\d{10,15}$/.test(d) && String(p).trim().startsWith('+') ? d : '';
}
export const PHONE_PREFIX = 'demo-account-phone:';
export const PHONE_KEY_DOMAIN = '@phone.mydukapos.invalid';       // an account with no email is stored under <number>@phone... (never mailed)
export const isPhoneKey = (k) => String(k || '').endsWith(PHONE_KEY_DOMAIN);
export const realEmailOf = (account) => (account && account.email && !isPhoneKey(account.email) ? account.email : '');

// Turns whatever a person typed on a sign-in / reset form (an email OR a WhatsApp number) into the account key.
export async function resolveLoginId(env, raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (t.includes('@')) return normalizeEmail(t);
  const intl = intlPhone(t);
  if (!intl) return normalizeEmail(t);
  try { const k = await env.mydukapos_kv.get(PHONE_PREFIX + intl); if (k) return k; } catch (e) { /* fall back */ }
  try { const hit = (await readIndex(env)).find((e) => intlPhone(e.phone) === intl); if (hit) return hit.email; } catch (e) { /* fall back */ }
  return intl + PHONE_KEY_DOMAIN;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getAccount(env, email) {
  const raw = await env.mydukapos_kv.get(ACCOUNT_PREFIX + normalizeEmail(email));
  return raw ? JSON.parse(raw) : null;
}

export async function readIndex(env) {
  const raw = await env.mydukapos_kv.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function summaryFromAccount(account) {
  return {
    fullName: account.fullName,
    phone: account.phone,
    email: account.email,
    product: account.product || '',
    demoClientId: account.demoClientId || null,
    demoStatus: account.demoStatus || 'none', // 'none' | 'active' | 'expired' | 'deleted'
    approvalStatus: account.approvalStatus || 'pending',
    branchName: account.branchName || '',
    createdAt: account.createdAt,
    generatedAt: account.generatedAt || null,
    expiresAt: account.expiresAt || null,
  };
}

export async function upsertIndexSummary(env, account) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.email === account.email);
  const summary = summaryFromAccount(account);
  if (idx === -1) list.unshift(summary);
  else list[idx] = summary;
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
}

export async function saveAccount(env, account) {
  await env.mydukapos_kv.put(ACCOUNT_PREFIX + account.email, JSON.stringify(account));
  const intl = intlPhone(account.phone);
  if (intl) { try { await env.mydukapos_kv.put(PHONE_PREFIX + intl, account.email); } catch (e) { /* the index lookup still finds it */ } }
  await upsertIndexSummary(env, account);
}

// Permanently removes a Web Signups account record and its entry in the
// index — used by demo-account.js's 'owner-delete' action (the Owner
// Console's "🗑️ Delete" button on the Web Signups sub-tab). This does NOT
// touch any license/demo link the account may still have live — callers
// that need that gone too should deleteClient()+removeClientLink() it
// FIRST, same as demo-account.js's own 'delete-demo' action already does,
// before calling this. There's no undo.
export async function deleteAccount(env, email) {
  const normalized = normalizeEmail(email);
  const old = await getAccount(env, normalized).catch(() => null);
  await env.mydukapos_kv.delete(ACCOUNT_PREFIX + normalized);
  const intl = old && intlPhone(old.phone);
  if (intl) { try { if ((await env.mydukapos_kv.get(PHONE_PREFIX + intl)) === normalized) await env.mydukapos_kv.delete(PHONE_PREFIX + intl); } catch (e) { /* harmless */ } }
  const list = await readIndex(env);
  const next = list.filter((e) => e.email !== normalized);
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(next));
}

// SESSIONS (zip 130). A session used to exist ONLY as a KV record written at sign-in. KV takes up to a minute to reach every Cloudflare
// location (and caches "not found"), so a request landing elsewhere right after signing in could be told the session does not
// exist — the same false "please sign in" the Owner Console had (fixed in zip 127). The token is now SIGNED with a key derived from
// the account's own salt + password hash (never leaves the server), so any location verifies it at once; a password change ends
// older sessions. The KV record is still written, and plain tokens from before keep working until they expire.
async function hmacHex(keyText, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const b64u = (t) => btoa(unescape(encodeURIComponent(t))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (t) => decodeURIComponent(escape(atob(String(t).replace(/-/g, '+').replace(/_/g, '/'))));
async function sessionKey(account) { return sha256Hex('demo-session-v2|' + (account.salt || '') + '|' + (account.passwordHash || '')); }
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function createSession(env, email) {
  const rand = randomToken();
  const normalized = normalizeEmail(email);
  await env.mydukapos_kv.put(SESSION_PREFIX + rand, email, { expirationTtl: SESSION_TTL_SECONDS });
  let account = null;
  try { account = await getAccount(env, normalized); } catch (e) { account = null; }
  if (!account || !account.passwordHash) return rand;
  const exp = (Date.now() + SESSION_TTL_SECONDS * 1000).toString(36);
  const body = b64u(normalized) + '.' + rand + '.' + exp;
  return 'd2.' + body + '.' + (await hmacHex(await sessionKey(account), body));
}

export async function emailFromToken(env, token) {
  if (!token || String(token).length > 600) return '';
  const p = String(token).split('.');
  if (p.length === 5 && p[0] === 'd2') {
    let email = '';
    try { email = unb64u(p[1]); } catch (e) { return ''; }
    if (!(parseInt(p[3], 36) > Date.now())) return '';
    let account = null;
    try { account = await getAccount(env, email); } catch (e) { account = null; }
    const body = p[1] + '.' + p[2] + '.' + p[3];
    if (account && account.passwordHash && sameText(await hmacHex(await sessionKey(account), body), p[4])) return email;
    // zip 185: this KV fallback exists because the account record can still be spreading between locations right after sign-in, and
    // because a PBKDF2 upgrade-on-login changes the hash (and so the signing key) without the password changing. It used to let a session
    // outlive a password RESET. A reset now stamps account.sessionsValidFrom; the fallback refuses a session issued before that stamp.
    if (account && account.sessionsValidFrom && (parseInt(p[3], 36) - SESSION_TTL_SECONDS * 1000) < account.sessionsValidFrom) return '';
    return (await env.mydukapos_kv.get(SESSION_PREFIX + p[2])) || '';      // the account record itself is still spreading
  }
  // zip 185: an old plain token carries no issue time, so after a reset it cannot prove it was issued afterwards.
  const plain = await env.mydukapos_kv.get(SESSION_PREFIX + token);
  if (plain) {
    let acct = null;
    try { acct = await getAccount(env, plain); } catch (e) { acct = null; }
    if (acct && acct.sessionsValidFrom) return '';
  }
  return plain || '';
}

// zip 185: call when a password is RESET (forgotten-password flow): every session issued before this moment stops working, even through the KV fallback.
export function revokeSessionsBefore(account, at = Date.now()) {
  account.sessionsValidFrom = at;
  return account;
}

// Verifies a plaintext password against a stored account. Returns the
// account on success, null on any failure (unknown email, wrong password) —
// deliberately not distinguishing the two in the return value so callers
// can give the same generic "incorrect email or password" message rather
// than confirming which emails exist.
export async function verifyPassword(env, email, password) {
  const account = await getAccount(env, email);
  if (!account) return null;
  if (!(await checkPassword(account, password))) return null;
  // zip 177: an account still on the old one-round SHA-256 hash is rewritten as PBKDF2 now that its owner proved the password
  try {
    const up = await upgradeOnLogin(account, String(password || ''));
    if (up) { account.salt = up.salt; account.passwordHash = up.passwordHash; await saveAccount(env, account); }
  } catch (e) { /* the sign-in itself succeeded; the upgrade is retried next time */ }
  return account;
}

// Creates a brand-new account with a hashed password. Throws with a short
// message (caller wraps in jsonResponse) on validation failure or if the
// email is already taken — same rules demo-account.js's 'register' action
// already enforced, kept identical here so POS-side signup can't create an
// account that's weaker than a website signup would allow.
export async function createAccount(env, { fullName, phone, email, password, confirmPassword }, opts = {}) {
  fullName = String(fullName || '').trim();
  phone = String(phone || '').trim();
  email = normalizeEmail(email);
  password = String(password || '');
  confirmPassword = String(confirmPassword || '');

  if (!fullName) throw new Error('Enter your full name.');
  if (!phone) throw new Error('Enter your WhatsApp number.');
  const intl = intlPhone(phone);
  if (!intl) throw new Error('Enter a valid WhatsApp number, for example 0712 345 678 (outside Kenya, start with + and the country code).');
  if (email && !isValidEmail(email)) throw new Error('That email address does not look right. Fix it or leave it blank — only the WhatsApp number is required.');
  const contactEmail = email;
  if (!email) email = intl + PHONE_KEY_DOMAIN;
  if (opts.strongPassword) { const bad = passwordProblem(password); if (bad) throw new Error(bad); }   // zip 177: the website sign-up asks for a real password
  else if (password.length < 4) throw new Error('Password must be at least 4 characters (a 4-digit PIN works fine).');
  if (password !== confirmPassword) throw new Error('Passwords do not match.');

  const existing = await getAccount(env, email);
  if (existing) throw new Error(contactEmail ? 'An account already exists for that email. Please sign in instead.' : 'An account already exists for that WhatsApp number. Please sign in instead.');
  const byPhone = await resolveLoginId(env, intl);
  if (byPhone && !isPhoneKey(byPhone) && byPhone !== email && await getAccount(env, byPhone)) throw new Error('An account already exists for that WhatsApp number. Please sign in instead.');
  if (isPhoneKey(byPhone) && byPhone !== email && await getAccount(env, byPhone)) throw new Error('An account already exists for that WhatsApp number. Please sign in instead.');

  const { salt, passwordHash } = await hashPassword(password);
  const now = Date.now();
  const account = {
    fullName, phone, email, salt, passwordHash, createdAt: now,
    ...(opts.extra || {}),
    demoUsed: false, demoClientId: null, demoStatus: 'none',
    approvalStatus: 'pending', branchName: '', product: '',
    generatedAt: null, expiresAt: null,
  };
  await saveAccount(env, account);
  return account;
}
