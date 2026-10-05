// functions/api/chama.js — Cloudflare Pages Function: the Chama module (zip 217). The rules are in _chama.js and its parts.
//   POST /api/chama   { action, ...fields }   -> { ok: true, ... } | { ok: false, error, code }
// Every request needs a valid link (licence) whose product is "chama". Members sign in with phone + PIN (X-Chama-Token); a few actions are public (status, setup, login).
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { ledgerDb } from './_ledger.js';
import { ensureChamaSchema, handle, ChamaError } from './_chama.js';

const CORS = { headers: 'Content-Type, X-Chama-Token' };
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ ok: false, code: 'link_inactive', error: 'This link is not active.' }, 403);
  if (!license.record || license.record.product !== 'chama') return reply({ ok: false, code: 'wrong_product', error: 'This link is not a Chama link.' }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return reply({ ok: false, error: 'Invalid request.' }, 400); }
  if (!body || typeof body !== 'object') return reply({ ok: false, error: 'Invalid request.' }, 400);
  const db = ledgerDb(env);
  if (!db) return reply({ ok: false, code: 'no_d1', error: 'The transaction database (D1) is not connected to this deployment yet.' }, 503);
  try {
    await ensureChamaSchema(db);
    const ctx = { db, c: license.clientId, env, body, me: null, group: null };
    const out = await handle(ctx, String(body.action || ''), request.headers.get('X-Chama-Token') || '');
    return reply({ ok: true, ...(out || {}) });
  } catch (e) {
    if (e instanceof ChamaError || (e && e.code && e.status)) return reply({ ok: false, code: e.code, error: e.error || e.message }, e.status);
    return reply({ ok: false, code: 'busy', error: 'The database did not answer — nothing was changed. Try again.', detail: String((e && e.message) || e).slice(0, 160) }, 503);
  }
}
