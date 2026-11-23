// functions/api/_pay-guard.js — shared helper, NOT a route. (zip 247)
//
// STRONGER PROOF TO CHANGE WHERE A SHOP'S MONEY GOES. A shop's link is enough to read its data and ring sales, but it must NOT be enough to
// swap the shop's Daraja / Paystack / KCB / SMS keys (that would send its customers' payments to someone else's till). Changing those settings
// is an ONLINE action anyway, so it can ask for a server-checked proof every single time — selling and signing in offline are untouched.
//
// The proof travels in the header  X-Pay-Proof: base64(JSON)   JSON = { a: true, p: SHA-256(Admin / management password) }
//                                                                   or { s: <staffId>, p: SHA-256(that manager's PIN) }
// (the same SHA-256-of-what-was-typed the app already sends to /api/staff-session; the sealed hash a device keeps is NOT accepted).
// Checked against the Admin / management password hash, or a staff member who is a MANAGER, held by the server. Brute force is throttled
// (payProof in _ratelimit.js). A shop that has no password at all has nothing to prove with: it passes (and is still alerted).
import { proofMatches, isSealedProof } from './_device-auth.js';
import { readState, shopMode, shopCall } from './_state-store.js';
import { staffRecord } from './_staff-auth.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { secEvent } from './_sec-events.js';

async function shopSecrets(env, clientId) {
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'secrets', {});
    if (!res.ok) throw new Error('shop database unavailable');                // fail CLOSED: an unanswered question is never "no password"
    return res.json();
  }
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  return { pwHash: st.pwHash || '', adminPwHash: st.adminPwHash || '' };
}

function reply(cors, status, code, error) {
  return new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
}

export function parseProofHeader(request) {
  const raw = request.headers.get('X-Pay-Proof') || '';
  if (!raw || raw.length > 700) return null;
  try {
    const o = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    if (!o || typeof o !== 'object' || typeof o.p !== 'string') return null;
    if (o.p.length < 32 || o.p.length > 300 || isSealedProof(o.p)) return null;
    if (o.a === true) return { a: true, p: o.p };
    if (typeof o.s === 'string' && o.s && o.s.length <= 80) return { s: o.s, p: o.p };
  } catch (e) { /* not a proof */ }
  return null;
}

// -> { denied: Response|null, who: { kind: 'admin'|'manager'|'unprotected', name } }
export async function requirePayProof(request, env, clientId, cors = {}) {
  const busy = () => ({ denied: reply(cors, 503, 'busy', 'Could not check right now — try again in a moment.'), who: null });
  let secrets;
  try { secrets = await shopSecrets(env, clientId); } catch (e) { return busy(); }
  const hasPassword = !!(secrets && (secrets.pwHash || secrets.adminPwHash));

  const proof = parseProofHeader(request);
  if (!proof) {
    // a shop that has NO password at all has nothing to prove with (anyone holding its link is already its Admin in the app): it passes, and is still alerted
    if (!hasPassword) return { denied: null, who: { kind: 'unprotected', name: 'Admin (no password set)' } };
    return { denied: reply(cors, 401, 'pay_confirm_required', 'Type the Admin password (or a manager PIN) to change payment settings.'), who: null };
  }
  const rl = await checkRateLimit(env, 'payProof', clientId);
  if (!rl.ok) return { denied: rateLimitResponse('password checks for payment settings', rl, cors), who: null };

  if (proof.a) {
    if (!hasPassword) return { denied: null, who: { kind: 'unprotected', name: 'Admin (no password set)' } };
    const ok = (secrets.pwHash && await proofMatches(proof.p, secrets.pwHash)) || (secrets.adminPwHash && await proofMatches(proof.p, secrets.adminPwHash));
    if (!ok) { await secEvent(env, 'pay_proof_failed', { route: 'payment-settings', shop: clientId }); return { denied: reply(cors, 403, 'pay_confirm_failed', 'Incorrect password.'), who: null }; }
    return { denied: null, who: { kind: 'admin', name: 'Admin' } };
  }

  let m = null;
  try { m = await staffRecord(env, clientId, proof.s); } catch (e) { return busy(); }
  if (!m || m.outdated || m.removed || !m.isManager || !m.pinHash || !(await proofMatches(proof.p, m.pinHash))) {
    await secEvent(env, 'pay_proof_failed', { route: 'payment-settings', shop: clientId });
    return { denied: reply(cors, 403, 'pay_confirm_failed', 'Incorrect PIN, or that person is not a manager. Use the Admin password or a manager PIN.'), who: null };
  }
  return { denied: null, who: { kind: 'manager', name: String(m.name || 'Manager').slice(0, 60) } };
}
