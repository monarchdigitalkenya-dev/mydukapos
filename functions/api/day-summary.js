// functions/api/day-summary.js — Cloudflare Pages Function (read-only). #8 (zip 120): the SERVER's view of a trading day.
//
//   GET /api/day-summary?c=<link>&from=<ms>&to=<ms>[&site=<siteId>]
//   -> { count, gross, voidedCount, ids: [...], byMethod: { cash: { n, v } }, byTill: { "1": { n, v } } }
//
// X / Z Reports are built on the device (from its synced copy). This lets the device check that copy against the server by sale
// id — "this device is missing 2 sales from till 3" — and a Z Report is only finalized when they agree (see serverDayCheck in
// src/shared/functions.js). The day's bounds come from the device (its own local midnight). Gross = sum of price x qty, the same
// sum reportSaleTotal uses. Voided sales are counted apart. Paired devices only when the shop requires it; the shop is the link's.

import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { readState, shopMode, shopCall, archivedLogRecords } from './_state-store.js';
import { deviceGuard } from './_device-auth.js';

const saleTotal = (s) => (Array.isArray(s.items) ? s.items : []).reduce((sum, it) => sum + (Number(it && it.price) || 0) * (Number(it && it.qty) || 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;

export function summarizeDay(sales, from, to, site) {
  const out = { count: 0, gross: 0, voidedCount: 0, ids: [], byMethod: {}, byTill: {} };
  (Array.isArray(sales) ? sales : []).forEach((s) => {
    if (!s || s._deleted) return;
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t) || t < from || t > to) return;
    if (site && s.siteId && s.siteId !== site) return;
    if (s.voided) { out.voidedCount++; return; }
    const v = saleTotal(s);
    out.count++; out.gross += v; out.ids.push(String(s.id));
    const m = s.paymentMethod || 'other';
    out.byMethod[m] = out.byMethod[m] || { n: 0, v: 0 }; out.byMethod[m].n++; out.byMethod[m].v += v;
    const till = s.ctx && s.ctx.till ? String(s.ctx.till) : '?';
    out.byTill[till] = out.byTill[till] || { n: 0, v: 0 }; out.byTill[till].n++; out.byTill[till].v += v;
  });
  out.gross = r2(out.gross);
  Object.values(out.byMethod).forEach((x) => { x.v = r2(x.v); });
  Object.values(out.byTill).forEach((x) => { x.v = r2(x.v); });
  return out;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  const u = new URL(request.url);
  const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 3 * 86400000) return reply({ error: 'Give from/to (ms) for one day.' }, 400);
  const site = u.searchParams.get('site') || '';
  let sales = [];
  if ((await shopMode(env, clientId)) === 'do') {
    let after = null;
    for (let page = 0; page < 50; page++) {                             // up to 100,000 sales in a day
      const res = await shopCall(env, clientId, 'history', { col: 'salesLog', from, to: to + 1, limit: 2000, after });
      const out = await res.json();
      sales = sales.concat(out.records || []);
      if (!out.next) break;
      after = out.next;
    }
  } else {
    sales = ((await readState(env, 'pos-data:state:' + clientId, {})) || {}).salesLog || [];
  }
  // sales moved into the shop's archives count too (zip 128); the live copy of a sale wins
  const have = new Set(sales.map((s) => s && String(s.id)));
  (await archivedLogRecords(env, clientId, 'salesLog', from, to + 1)).forEach((s) => { if (s && !have.has(String(s.id))) { have.add(String(s.id)); sales.push(s); } });
  return reply(summarizeDay(sales, from, to, site));
}
