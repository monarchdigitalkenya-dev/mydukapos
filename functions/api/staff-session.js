// functions/api/staff-session.js — Cloudflare Pages Function: per-staff server sessions (zip 141, see _staff-auth.js).
//
//   POST { staffId, proof, since? }    proof = SHA-256 of the staff member's PIN (typed now — never the sealed hash a device keeps)
//        -> { ok, token, sessionId, secret, exp, sid, name, perms }
//   POST { admin: true, proof }        proof = SHA-256 of the management (admin) password -> a session with every permission
//   POST { action: 'mode', mode: 'enforce'|'off' }   (header X-Staff-Token of the Admin or a manager) -> { ok, mode }
//   GET                                 -> { mode, me: claims | null }   (who the X-Staff-Token belongs to)
// Licence + paired-device rules as every staff action. PIN attempts are rate-limited per staff member and per shop.

import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard, proofMatches, isSealedProof } from './_device-auth.js';
import { readState, shopMode, shopCall } from './_state-store.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { issueSession, permsOf, staffRecord, readMode, writeMode, verifyToken, staffTokenOf, hasPerm } from './_staff-auth.js';

const CORS = { headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' };

async function shopSecrets(env, clientId) {
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'secrets', {});
    return res.ok ? res.json() : {};
  }
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  return { pwHash: st.pwHash || '', adminPwHash: st.adminPwHash || '' };
}
// Kenya business day, as the app's isStaffLockedToday uses it
const kenyaDay = (t = Date.now()) => new Date(t + 3 * 3600000).toISOString().slice(0, 10);

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return denied;
  const tok = staffTokenOf(request);
  const me = tok ? await verifyToken(env, license.clientId, tok) : null;
  return reply({ mode: await readMode(env, license.clientId), me: me && !me.expired ? { sid: me.sid, name: me.name, perms: me.perms, exp: me.exp } : null });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object') return reply({ error: 'Invalid request.' }, 400);

  if (body.action === 'mode') {
    const tok = staffTokenOf(request);
    const me = tok ? await verifyToken(env, clientId, tok) : null;
    if (!me || me.expired || !me.mgr) return reply({ error: 'Only the Admin or a manager (signed in while online) can change this.', code: 'staff_forbidden' }, 403);
    await writeMode(env, clientId, body.mode === 'enforce' ? 'enforce' : 'off');
    return reply({ ok: true, mode: body.mode === 'enforce' ? 'enforce' : 'off' });
  }

  const proof = String(body.proof || '');
  // Only the typed PIN / password proves who is here. The sealed hash every device keeps is NOT accepted (it is not the PIN).
  if (proof.length < 32 || proof.length > 300 || isSealedProof(proof)) return reply({ error: 'Enter your PIN.', code: 'bad_proof' }, 400);
  const rlShop = await checkRateLimit(env, 'staffShop', clientId);
  if (!rlShop.ok) return rateLimitResponse('staff sign-ins', rlShop, cors);

  if (body.admin === true) {
    const rl = await checkRateLimit(env, 'staffPin', clientId + ':admin');
    if (!rl.ok) return rateLimitResponse('Admin sign-ins', rl, cors);
    const s = await shopSecrets(env, clientId);
    // the shop password (what the Admin signs in with) or the management password
    if (!((s.pwHash && (await proofMatches(proof, s.pwHash))) || (s.adminPwHash && (await proofMatches(proof, s.adminPwHash))))) return reply({ error: 'Incorrect password.', code: 'wrong_pin' }, 401);
    const out = await issueSession(env, clientId, { id: 'admin', name: 'Admin', perms: ['*'], mgr: true, since: body.since });
    return reply({ ok: true, token: out.token, sessionId: out.sessionId, secret: out.secret, exp: out.claims.exp, sid: 'admin', name: 'Admin', perms: ['*'] });
  }

  const staffId = String(body.staffId || '').slice(0, 80);
  if (!staffId) return reply({ error: 'Pick your name.' }, 400);
  const rl = await checkRateLimit(env, 'staffPin', clientId + ':' + staffId);
  if (!rl.ok) return rateLimitResponse('PIN attempts for this staff member', rl, cors);
  let m;
  try { m = await staffRecord(env, clientId, staffId); } catch (e) { return reply({ error: 'busy', code: 'busy' }, 503); }
  if (m && m.outdated) return reply({ error: 'The shop database needs the latest router update (npm run deploy:router).', code: 'router_outdated' }, 501);
  // The server may not have this staff member yet (added offline on this device): the app keeps working and asks again later.
  if (!m || !m.pinHash) return reply({ error: 'The server does not have this staff member yet — try again after the next sync.', code: 'unknown_staff' }, 404);
  if (m.removed) return reply({ error: 'This account has been removed.', code: 'removed' }, 403);
  if (Array.isArray(m.lockedDates) && m.lockedDates.includes(kenyaDay()) && m.openAccountOverrideDate !== kenyaDay()) return reply({ error: 'This account is locked for today.', code: 'locked' }, 403);
  if (!(await proofMatches(proof, m.pinHash))) return reply({ error: 'Incorrect PIN.', code: 'wrong_pin' }, 401);
  const perms = permsOf(m);
  const out = await issueSession(env, clientId, { id: m.id, name: m.name, perms, mgr: !!m.isManager, since: body.since });
  return reply({ ok: true, token: out.token, sessionId: out.sessionId, secret: out.secret, exp: out.claims.exp, sid: String(m.id), name: m.name, perms, mgr: !!m.isManager, canPay: hasPerm(out.claims, 'payments') });
}
