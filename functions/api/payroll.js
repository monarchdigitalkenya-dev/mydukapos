// functions/api/payroll.js — Cloudflare Pages Function: Create Payroll (zip 216). The engine and the rules are in _payroll.js.
//   POST /api/payroll   { action: 'employee.list' | 'employee.save' | 'run.create' | ... , ...fields }  -> { ok: true, ... } | { ok: false, error, code }
//   POST /api/payroll   { action: 'doc.file', docId }   -> the file itself (PDF / image / Word), for preview and download
// Every request needs: a valid licence, a paired device (as every staff action), AND a valid signed-in staff session (X-Staff-Token).
// There is no "off" switch for this: payroll is refused without a session even when the shop has not made staff sessions compulsory.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffTokenOf, verifyToken } from './_staff-auth.js';
import { ledgerDb } from './_ledger.js';
import { ensurePayrollSchema, ACTIONS, SELF_ACTIONS, whoIs, docFile } from './_payroll.js';

const CORS = { headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' };
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ ok: false, error: 'This link is not active.' }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ ok: false, error: 'Invalid request.' }, 400); }
  const action = String(body && body.action || '');

  const tok = staffTokenOf(request);
  const claims = tok ? await verifyToken(env, clientId, tok) : null;
  if (!claims || claims.expired) return reply({ ok: false, code: 'staff_session_required', error: claims && claims.expired ? 'Your staff session has ended — sign in again with your PIN.' : 'Sign in with your staff PIN (while online) to open payroll.' }, 401);

  const db = ledgerDb(env);
  if (!db) return reply({ ok: false, code: 'no_d1', error: 'The transaction database (D1) is not connected to this deployment yet.' }, 503);
  try {
    await ensurePayrollSchema(db);
    const who = await whoIs(env, db, clientId, claims);
    const ctx = { db, c: clientId, env, who, body };
    if (action === 'doc.file') {
      const f = await docFile(ctx);
      return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.type, 'Content-Disposition': `inline; filename="${String(f.name).replace(/[^\w.\- ]+/g, '_')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
    }
    const fn = ACTIONS[action];
    if (!fn) return reply({ ok: false, error: 'Unknown action.' }, 400);
    void SELF_ACTIONS;
    return reply({ ok: true, ...(await fn(ctx)) });
  } catch (e) {
    if (e && e.code && e.status) return reply({ ok: false, code: e.code, error: e.error || e.message, ...(e.problems ? { problems: e.problems } : {}) }, e.status);
    return reply({ ok: false, code: 'busy', error: 'The payroll database did not answer — nothing was changed. Try again.', detail: String((e && e.message) || e).slice(0, 160) }, 503);
  }
}
