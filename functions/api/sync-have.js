// functions/api/sync-have.js — Cloudflare Pages Function (read-only). zip 129.
//
//   POST /api/sync-have?c=<link>   body { col: "salesLog", ids: ["...", ...] }   (up to 5,000 ids a call)
//   -> { have: { "<id>": "<business version>" } }   only the ids the server holds (see businessSig in _merge.js)
//
// Before a device sends its sales / stock changes / returns / expenses, it asks which of them the server ALREADY has in the same
// version (sent earlier by this device, or pushed by another one). Those are not sent again: a device that has been offline, or
// that was reopened, no longer re-uploads its whole history on the first sync — which on a slow line timed out, was retried in full,
// and never finished ("retrying… sending…"). Same licence and paired-device rules as every shop endpoint. Nothing is written.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { readState, shopMode, shopCall, ARCHIVE_LOG_FIELDS } from './_state-store.js';
import { deviceGuard } from './_device-auth.js';
import { businessSig } from './_merge.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  const col = body && body.col;
  if (!ARCHIVE_LOG_FIELDS.includes(col) || !Array.isArray(body.ids)) return reply({ error: 'Give col and ids.' }, 400);
  const ids = body.ids.slice(0, 5000).map(String);
  const mode = await shopMode(env, clientId);
  if (mode === 'migrating') return reply({ error: 'busy', code: 'busy' }, 503);
  if (mode === 'do') {
    const res = await shopCall(env, clientId, 'have', { col, ids });
    if (!res.ok) return reply({ error: 'The shop database cannot answer this yet.', code: 'have_unsupported' }, res.status === 404 ? 501 : 503);
    return reply(await res.json());
  }
  const state = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  const want = new Set(ids);
  const have = {};
  for (const r of state[col] || []) {
    if (r && r.id != null && want.has(String(r.id)) && r._deleted !== true) have[String(r.id)] = businessSig(r);
  }
  return reply({ have });
}
