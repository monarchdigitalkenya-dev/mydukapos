// functions/api/cash-register.js — Cloudflare Pages Function: the Sales Counter's Cash Register (zip 234). Rules are in _cash.js, tables in _cash-schema.js.
//   POST /api/cash-register  { action: status|open|move|close|history|detail, ...fields }  -> { ok: true, ... } | { ok: false, error, code }
// Needs a valid link (licence) — the link IS the shop / branch, so one branch's sessions can never be read or changed by another. Paired devices only when the shop requires it.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { ledgerDb } from './_ledger.js';
import { ensureCashSchema, handleCash, CashError } from './_cash.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ ok: false, code: 'link_inactive', error: 'This link is not active.' }, 403);
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ ok: false, error: 'Invalid request.' }, 400); }
  if (!body || typeof body !== 'object') return reply({ ok: false, error: 'Invalid request.' }, 400);
  const db = ledgerDb(env);
  if (!db) return reply({ ok: false, code: 'no_d1', error: 'The transaction database (D1) is not connected to this deployment yet.' }, 503);
  try {
    await ensureCashSchema(db);
    const out = await handleCash({ db, c: license.clientId, env, body });
    return reply({ ok: true, ...(out || {}) });
  } catch (e) {
    if (e instanceof CashError) return reply({ ok: false, code: e.code, error: e.error, ...(e.extra || {}) }, e.status);
    return reply({ ok: false, code: 'busy', error: 'The database did not answer — nothing was changed. Try again.', detail: String((e && e.message) || e).slice(0, 160) }, 503);
  }
}
