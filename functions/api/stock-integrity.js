// functions/api/stock-integrity.js — Cloudflare Pages Function (read-only)
//
// Phase 19 "does everything agree?": runs ledgerIntegrity (functions/api/_merge.js) on THIS shop's stored data — every item's applied
// stock movements must chain, end at today's figure, and no movement may be applied twice — and returns the server's own figures so
// the app can compare what its screen shows with the database (see stockIntegrityCheck in src/shared/functions.js).
//
//   GET /api/stock-integrity?c=<link>  ->  { ok, checked, problems: [{ what, detail }], figures: { "<item or cell>": n } }
//
// The shop is the one the link names (requireValidLicense), exactly like pos-sync: nothing in the request can point it at another shop.

import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { readState, shopMode, shopCall } from './_state-store.js';
import { ledgerIntegrity, CELL_SPECS, recordKey } from './_merge.js';
import { deviceGuard } from './_device-auth.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

// The server's current figure for every item / Aqua cell, keyed the way the app keys them (item code, or "c|k|f|s").
export function stockFigures(state) {
  const out = {};
  (Array.isArray(state.inventory) ? state.inventory : []).forEach((r) => {
    if (!r || r.code == null || r._deleted) return;
    const list = r.hasVariants && Array.isArray(r.variants) && r.variants.length ? r.variants : [r];
    list.forEach((x) => { if (x && x.code != null) { out[String(x.code)] = Number(x.qty) || 0; if (typeof x.pieceQty === 'number') out[`${x.code}|pieceQty`] = x.pieceQty; } });
  });
  for (const [col, spec] of Object.entries(CELL_SPECS)) {
    (Array.isArray(state[col]) ? state[col] : []).forEach((r) => {
      const k = recordKey(r);
      if (k == null || r._deleted) return;
      (spec.maps || []).forEach((f) => { if (r[f] && typeof r[f] === 'object') Object.keys(r[f]).forEach((s) => { out[`${col}|${k}|${f}|${s}`] = Number(r[f][s]) || 0; }); });
      (spec.scalars || []).forEach((f) => { if (typeof r[f] === 'number') out[`${col}|${k}|${f}|`] = r[f]; });
    });
  }
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;
  let state;
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'export', {});
    if (!res.ok) return reply({ error: 'Could not read the shop database.' }, 502);
    state = JSON.parse(await res.text());
  } else {
    state = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  }
  const r = ledgerIntegrity(state);
  return reply({ ...r, problems: r.problems.slice(0, 200), figures: stockFigures(state) });
}
