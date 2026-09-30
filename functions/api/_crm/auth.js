// functions/api/_crm/auth.js — CRM identity (NOT a route): owner token -> owner user, staff e-mail+password -> c1 token, permissions read from D1
// on EVERY request, invitations / reset links, password change, login rate limit.
import { requireOwnerAuth, getOwnerAccount, tokenFromRequest } from '../_owner-auth.js';
import { E, HttpError, all, first, run, st, now, newId, text, phoneNorm, phoneDisplay, email as normEmail, sha256Hex, randomHex, clientIp, auditSt, jparse, changes } from './core.js';
import { PERM_KEYS } from './schema.js';

const PBKDF2_ITERS = 100000;                        // the most a Cloudflare Worker allows
const TOKEN_MAX_AGE = 30 * 86400000;
export const INVITE_TTL = 7 * 86400000;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function pbkdf2(password, saltHex, iters = PBKDF2_ITERS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(saltHex), iterations: iters }, key, 256));
}
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export async function hashPassword(password) {
  const salt = randomHex(16);
  return { password_hash: await pbkdf2(password, salt), password_salt: salt, password_iters: PBKDF2_ITERS };
}
export function checkPasswordRules(pw, name = 'password') {
  if (typeof pw !== 'string' || pw.length < 8) throw E.bad(`${name} must be at least 8 characters`, 'weak_password');
  if (pw.length > 200) throw E.bad(`${name} is too long`, 'weak_password');
  return pw;
}

async function hmac(keyText, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function serverSecret(env) {
  if (env.CRM_SESSION_SECRET) return String(env.CRM_SESSION_SECRET);
  const acct = env.mydukapos_kv ? await getOwnerAccount(env) : null;
  if (!acct) throw new HttpError(503, 'crm_secret_missing', 'The CRM has no signing secret yet: set CRM_SESSION_SECRET, or create the owner account.');
  return 'owner|' + acct.salt + '|' + acct.passwordHash;
}
const tokenKey = async (env, user) => sha256Hex('crm-session-v1|' + await serverSecret(env) + '|' + user.id + '|' + user.session_epoch);
export async function issueToken(env, user) {
  const iat = Date.now().toString(36);
  return `c1.${user.id}.${iat}.${await hmac(await tokenKey(env, user), user.id + '.' + iat)}`;
}

// ---------- permissions ----------
export async function rolePerms(db) {
  const rows = await all(db, `SELECT key, perms FROM crm_roles`);
  const m = new Map();
  for (const r of rows) m.set(r.key, new Set((jparse(r.perms, []) || []).filter((p) => PERM_KEYS.includes(p))));
  return m;
}
export async function userPerms(db, user, roles) {
  roles = roles || await rolePerms(db);
  if (user.role === 'owner') return new Set(PERM_KEYS);              // the owner can never lose a permission
  const set = new Set(roles.get(user.role) || []);
  for (const o of await all(db, `SELECT perm, effect FROM crm_user_perms WHERE user_id = ?`, user.id)) {
    if (!PERM_KEYS.includes(o.perm)) continue;
    if (o.effect === 'grant') set.add(o.perm); else set.delete(o.perm);
  }
  return set;
}
export function makeActor(user, perms, request) {
  const a = { id: user.id, name: user.name, role: user.role, department: user.department || null, user, perms, isOwner: user.role === 'owner', ip: request ? clientIp(request) : null };
  a.has = (p) => perms.has(p);
  a.require = (...ps) => { if (!ps.some((p) => perms.has(p))) throw E.forbidden(`Missing permission: ${ps.join(' or ')}`, 'forbidden'); };
  return a;
}
export async function actorFor(db, userId, request) {
  const user = await first(db, `SELECT * FROM crm_users WHERE id = ?`, userId);
  return user ? makeActor(user, await userPerms(db, user), request) : null;
}
// every active user that currently holds `perm` (for notifications)
export async function usersWith(db, perm, exceptId) {
  const roles = await rolePerms(db);
  const users = await all(db, `SELECT * FROM crm_users WHERE status = 'active' AND archived = 0`);
  const out = [];
  for (const u of users) if (u.id !== exceptId && (await userPerms(db, u, roles)).has(perm)) out.push(u);
  return out;
}

export async function ensureOwnerUser(env, db) {
  let u = await first(db, `SELECT * FROM crm_users WHERE owner_ref = 'owner'`);
  if (u) return u;
  let name = 'Owner', mail = null;
  try { const acct = env.mydukapos_kv ? await getOwnerAccount(env) : null; if (acct && acct.identifier) { name = String(acct.identifier).slice(0, 80); if (normEmail(acct.identifier)) mail = normEmail(acct.identifier); } } catch (e) { /* keep defaults */ }
  const t = now();
  if (mail && await first(db, `SELECT id FROM crm_users WHERE email = ?`, mail)) mail = null;
  await run(db, `INSERT OR IGNORE INTO crm_users (id, owner_ref, name, email, role, status, login_disabled, created_at, updated_at) VALUES (?, 'owner', ?, ?, 'owner', 'active', 1, ?, ?)`, newId(), name, mail, t, t);
  return first(db, `SELECT * FROM crm_users WHERE owner_ref = 'owner'`);
}

export async function authenticate(context, db) {
  const { request, env } = context;
  const token = tokenFromRequest(request);
  if (!token || token.length > 400) throw E.unauthorized();
  if (token.startsWith('c1.')) {
    const p = token.split('.');
    if (p.length !== 4 || !/^[0-9a-z]{1,12}$/.test(p[2]) || !/^[0-9a-f]{64}$/.test(p[3])) throw E.unauthorized();
    const user = await first(db, `SELECT * FROM crm_users WHERE id = ?`, p[1]);
    if (!user || user.login_disabled || user.archived || user.status !== 'active') throw E.unauthorized('This account cannot sign in', 'account_disabled');
    const iat = parseInt(p[2], 36);
    if (!Number.isFinite(iat) || Date.now() - iat > TOKEN_MAX_AGE || iat > Date.now() + 60000) throw E.unauthorized('Session expired', 'session_expired');
    if (!same(await hmac(await tokenKey(env, user), user.id + '.' + p[2]), p[3])) throw E.unauthorized('Session ended, sign in again', 'session_revoked');
    return makeActor(user, await userPerms(db, user), request);
  }
  let ok = false;
  try { ok = await requireOwnerAuth(context); } catch (e) { ok = false; }
  if (!ok) throw E.unauthorized();
  const owner = await ensureOwnerUser(env, db);
  return makeActor(owner, await userPerms(db, owner), request);
}
export async function requireOwnerOnly(context, db) {
  const actor = await authenticate(context, db);
  if (!actor.isOwner) throw E.forbidden('Only the owner can do that', 'owner_only');
  return actor;
}

export const publicUser = (u, extra = {}) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, department: u.department, photo: u.photo, status: u.status, archived: !!u.archived, loginDisabled: !!u.login_disabled, createdAt: u.created_at, lastLoginAt: u.last_login_at, ...extra });
export const meUser = (actor) => ({ ...publicUser(actor.user), perms: [...actor.perms].sort() });

// ---------- login (rate limited per e-mail + IP; only FAILED attempts count) ----------
const LOGIN_WINDOW = 3600;
async function loginKeys(env, request, mail) {
  const b = Math.floor(Date.now() / (LOGIN_WINDOW * 1000));
  const ip = clientIp(request);
  return [
    { key: `crm-rl:login:${await sha256Hex(mail + '|' + ip)}:${b}`, limit: Number(env.CRM_LOGIN_FAILS_PER_ACCOUNT_IP) || 8 },
    { key: `crm-rl:login-ip:${await sha256Hex(ip)}:${b}`, limit: Number(env.CRM_LOGIN_FAILS_PER_IP) || 40 },
  ];
}
async function loginBlocked(env, keys) {
  if (!env.mydukapos_kv) return false;
  for (const k of keys) { try { if ((Number(await env.mydukapos_kv.get(k.key)) || 0) >= k.limit) return true; } catch (e) { return false; } }
  return false;
}
async function noteFailure(env, keys) {
  if (!env.mydukapos_kv) return;
  for (const k of keys) { try { await env.mydukapos_kv.put(k.key, String((Number(await env.mydukapos_kv.get(k.key)) || 0) + 1), { expirationTtl: LOGIN_WINDOW * 2 }); } catch (e) { /* ignore */ } }
}
const DUMMY_SALT = '00'.repeat(16);
export async function login(ctx) {
  const { env, db, request } = ctx;
  const body = await ctx.json();
  const mail = normEmail(body.email);
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!mail || !pw || pw.length > 200) throw E.bad('email and password are required', 'invalid_credentials');
  const keys = await loginKeys(env, request, mail);
  if (await loginBlocked(env, keys)) throw E.tooMany('Too many wrong passwords. Wait an hour and try again, or ask your admin for a reset link.');
  const user = await first(db, `SELECT * FROM crm_users WHERE email = ?`, mail);
  const can = user && user.password_hash && !user.login_disabled;
  const h = await pbkdf2(pw, can ? user.password_salt : DUMMY_SALT, can ? user.password_iters || PBKDF2_ITERS : PBKDF2_ITERS);   // same work either way
  if (!can || !same(h, user.password_hash)) { await noteFailure(env, keys); throw E.unauthorized('Wrong email or password', 'invalid_credentials'); }
  if (user.status !== 'active' || user.archived) { throw E.unauthorized(user.status === 'suspended' ? 'This account is suspended' : 'This account is not active', 'account_disabled'); }
  const t = now();
  await db.batch([st(db, `UPDATE crm_users SET last_login_at = ? WHERE id = ?`, t, user.id), auditSt(db, { id: user.id, name: user.name, ip: clientIp(request) }, 'login', 'user', user.id, null, null, t)]);
  const fresh = await first(db, `SELECT * FROM crm_users WHERE id = ?`, user.id);
  return { token: await issueToken(env, fresh), user: meUser(makeActor(fresh, await userPerms(db, fresh))) };
}

// ---------- invitations / reset ----------
export async function createInvitation(db, actor, userId, kind) {
  const token = randomHex(32), t = now();
  await db.batch([
    st(db, `UPDATE crm_invitations SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, t, userId),          // an older unused link stops working
    st(db, `INSERT INTO crm_invitations (id, user_id, kind, token_hash, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)`, newId(), userId, kind, await sha256Hex(token), t + INVITE_TTL, actor && actor.id || null, t),
  ]);
  return { token, expiresAt: t + INVITE_TTL };
}
export function linkFor(env, request, kind, token) {
  const base = String(env.CRM_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
  return `${base}/crm/?${kind === 'invite' ? 'invite' : 'reset'}=${token}`;
}
async function findInvitation(db, token, kind) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw E.bad('This link is not valid', 'invalid_token');
  const inv = await first(db, `SELECT * FROM crm_invitations WHERE token_hash = ?`, await sha256Hex(token));
  if (!inv || (kind && inv.kind !== kind)) throw E.bad('This link is not valid', 'invalid_token');
  if (inv.used_at) throw E.bad('This link has already been used', 'token_used');
  if (inv.expires_at < now()) throw E.bad('This link has expired, ask your admin for a new one', 'token_expired');
  const user = await first(db, `SELECT * FROM crm_users WHERE id = ?`, inv.user_id);
  if (!user || user.archived || user.status === 'inactive' || user.status === 'suspended') throw E.bad('This account is not active', 'account_disabled');
  return { inv, user };
}
export async function inviteInfo(ctx) {
  const { inv, user } = await findInvitation(ctx.db, ctx.query.get('token'), 'invite');
  return { name: user.name, email: user.email, role: user.role, expiresAt: inv.expires_at };
}
export async function inviteAccept(ctx) {
  const { db, env } = ctx; const b = await ctx.json();
  const { inv, user } = await findInvitation(db, b.token, 'invite');
  checkPasswordRules(b.password);
  const name = text(b.name, 80) || user.name, pn = phoneNorm(b.phone);
  if (pn === false) throw E.bad('This does not look like a valid phone number', 'validation_error', { fields: { phone: 'Invalid phone number' } });
  const phone = pn ? phoneDisplay(pn) : null;
  const photo = typeof b.photo === 'string' && b.photo.length <= 400000 && /^(data:image\/(png|jpe?g|webp|gif);base64,|https:\/\/)/.test(b.photo) ? b.photo : user.photo;
  const t = now(), h = await hashPassword(b.password);
  const upd = st(db, `UPDATE crm_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL`, t, inv.id);
  const r = await upd.run();
  if (changes(r) !== 1) throw E.bad('This link has already been used', 'token_used');
  await db.batch([
    st(db, `UPDATE crm_users SET name = ?, phone = COALESCE(?, phone), phone_norm = COALESCE(?, phone_norm), photo = ?, password_hash = ?, password_salt = ?, password_iters = ?, status = 'active', session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`, name, phone, pn || null, photo, h.password_hash, h.password_salt, h.password_iters, t, user.id),
    auditSt(db, { id: user.id, name }, 'invite_accept', 'user', user.id, { status: user.status }, { status: 'active' }, t),
  ]);
  const fresh = await first(db, `SELECT * FROM crm_users WHERE id = ?`, user.id);
  return { token: await issueToken(env, fresh), user: meUser(makeActor(fresh, await userPerms(db, fresh))) };
}
export async function resetAccept(ctx) {
  const { db } = ctx; const b = await ctx.json();
  const { inv, user } = await findInvitation(db, b.token, 'reset');
  checkPasswordRules(b.password);
  const t = now(), h = await hashPassword(b.password);
  const r = await st(db, `UPDATE crm_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL`, t, inv.id).run();
  if (changes(r) !== 1) throw E.bad('This link has already been used', 'token_used');
  await db.batch([
    st(db, `UPDATE crm_users SET password_hash = ?, password_salt = ?, password_iters = ?, session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`, h.password_hash, h.password_salt, h.password_iters, t, user.id),
    auditSt(db, { id: user.id, name: user.name }, 'password_reset', 'user', user.id, null, null, t),
  ]);
  return { ok: true };
}
export async function passwordChange(ctx) {
  const { db, env, actor } = ctx; const b = await ctx.json();
  const u = actor.user;
  if (!u.password_hash || u.login_disabled) throw E.bad('This account signs in another way (owner console)', 'no_password');
  if (typeof b.current !== 'string' || !same(await pbkdf2(b.current, u.password_salt, u.password_iters || PBKDF2_ITERS), u.password_hash)) throw E.forbidden('Current password is wrong', 'wrong_password');
  checkPasswordRules(b.next, 'new password');
  if (b.next === b.current) throw E.bad('The new password must be different', 'weak_password');
  const t = now(), h = await hashPassword(b.next);
  await db.batch([
    st(db, `UPDATE crm_users SET password_hash = ?, password_salt = ?, password_iters = ?, session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`, h.password_hash, h.password_salt, h.password_iters, t, u.id),
    auditSt(db, actor, 'password_change', 'user', u.id, null, null, t),
  ]);
  const fresh = await first(db, `SELECT * FROM crm_users WHERE id = ?`, u.id);
  return { ok: true, token: await issueToken(env, fresh) };
}
