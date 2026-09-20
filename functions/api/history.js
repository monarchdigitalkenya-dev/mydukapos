// functions/api/history.js — Cloudflare Pages Function
//
// Any date range of a big log (sales, stock movements, expenses ...), paged. Devices keep only a recent "hot window" of these logs;
// this is how a report, a customer statement or a new device reaches OLDER history without ever loading all of it.
//
//   GET /api/history?c=<link>&col=salesLog&from=<ISO|ms>&to=<ISO|ms>&limit=500&after=<ts>:<key>
//   -> { records: [...], next: "<ts>:<key>" | null }
//
// Served from the shop's database. A shop still stored as a single record answers from that record (same shape), so callers do not
// need to know which kind of shop they are talking to.

import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { readState, shopMode, shopCall, ARCHIVE_LOG_FIELDS, recordTime } from './_state-store.js';

const ms = (v, d) => { if (v == null || v === '') return d; const n = Number(v); if (Number.isFinite(n) && n > 1e11) return n; const t = Date.parse(v); return Number.isFinite(t) ? t : d; };

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
  const u = new URL(request.url);
  const col = u.searchParams.get('col') || '';
  if (!ARCHIVE_LOG_FIELDS.includes(col)) return reply({ error: 'Unknown log.' }, 400);
  const from = ms(u.searchParams.get('from'), 0), to = ms(u.searchParams.get('to'), Number.MAX_SAFE_INTEGER);
  const limit = Math.min(Math.max(1, Number(u.searchParams.get('limit')) || 500), 2000);
  const afterRaw = u.searchParams.get('after');
  let after = null;
  if (afterRaw) { const i = afterRaw.indexOf(':'); after = { ts: Number(afterRaw.slice(0, i)), rk: afterRaw.slice(i + 1) }; }

  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'history', { col, from, to, limit, after });
    const out = await res.json();
    return reply({ records: out.records, next: out.next ? `${out.next.ts}:${out.next.rk}` : null }, res.status);
  }
  const state = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  const rows = (state[col] || []).map((r) => ({ r, t: recordTime(r), k: String(r && (r.id ?? r.code ?? '')) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= from && x.t < to)
    .sort((a, b) => a.t - b.t || (a.k < b.k ? -1 : 1))
    .filter((x) => !after || x.t > after.ts || (x.t === after.ts && x.k > after.rk));
  const page = rows.slice(0, limit);
  return reply({ records: page.map((x) => x.r), next: rows.length > limit ? `${page[page.length - 1].t}:${page[page.length - 1].k}` : null });
}
