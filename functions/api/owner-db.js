// functions/api/owner-db.js — Cloudflare Pages Function (Owner Console, owner session required). zip 187.
//
//   GET                       -> status of the OWNER_DB read model: { bound, rows, kvRows, drift, driftDetail, syncedAt, healthy, reading, dirty, ... }
//   POST { action: 'rebuild' } -> copies the whole KV licence index + person ledger into OWNER_DB (idempotent), then the console list reads from it.
//
// KV stays the source of truth; this database is only an index for the Owner Console list (see _owner-db.js). Without the OWNER_DB binding both
// answer { bound: false } and nothing else happens.
import { requireOwnerAuth } from './_owner-auth.js';
import { ownerDbStatus, rebuildOwnerDb, ownerDb } from './_owner-db.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export async function onRequestGet(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  return json(await ownerDbStatus(context.env));
}

export async function onRequestPost(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400); }
  if (!body || body.action !== 'rebuild') return json({ error: 'Unknown action.' }, 400);
  if (!ownerDb(context.env)) return json({ error: 'OWNER_DB is not bound on this project. Run: node tools/setup-owner-db.mjs', bound: false }, 409);
  const r = await rebuildOwnerDb(context.env);
  return json({ ...r, status: await ownerDbStatus(context.env) }, r.ok ? 200 : 500);
}
