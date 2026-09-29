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
import { readState, shopMode, shopCall, ARCHIVE_LOG_FIELDS, recordTime, archivedLogRecords } from './_state-store.js';
import { recordKey } from './_merge.js';
import { deviceGuard } from './_device-auth.js';

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
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;
  const u = new URL(request.url);
  const col = u.searchParams.get('col') || '';
  if (!ARCHIVE_LOG_FIELDS.includes(col)) return reply({ error: 'Unknown log.' }, 400);
  const from = ms(u.searchParams.get('from'), 0), to = ms(u.searchParams.get('to'), Number.MAX_SAFE_INTEGER);
  const limit = Math.min(Math.max(1, Number(u.searchParams.get('limit')) || 500), 2000);
  const afterRaw = u.searchParams.get('after');
  let after = null;
  if (afterRaw) { const i = afterRaw.indexOf(':'); after = { ts: Number(afterRaw.slice(0, i)), rk: afterRaw.slice(i + 1) }; }

  // Records in the shop's archives (zip 128) join the live ones; the live copy of a record wins. Same ordering and cursor as before.
  // (zip 156: deleted-record tombstones are never returned — every other read strips them. A record archived twice, because a later edit
  // brought it back into the live shop and it was archived again, is listed once: its newest copy.)
  const isLive = (r) => !(r && r._deleted === true);
  const newest = new Map();
  (await archivedLogRecords(env, clientId, col, from, to)).forEach((r) => {
    const k = String(recordKey(r) || '');
    const prev = newest.get(k);
    if (!k || !prev || (Number(r && r.updatedAt) || 0) >= (Number(prev && prev.updatedAt) || 0)) newest.set(k || Symbol(), r);
  });
  const archived = [...newest.values()].filter(isLive).map((r) => ({ r, t: recordTime(r), k: String(recordKey(r) || '') }));
  const byOrder = (a, b) => a.t - b.t || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const afterCursor = (x) => !after || x.t > after.ts || (x.t === after.ts && x.k > after.rk);
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'history', { col, from, to, limit, after });
    const out = await res.json();
    if (res.ok && Array.isArray(out.records)) out.records = out.records.filter(isLive);   // (a shop database from before this fix still returns them)
    if (!res.ok || !archived.length) return reply({ records: out.records, next: out.next ? `${out.next.ts}:${out.next.rk}` : null }, res.status);
    const live = (out.records || []).map((r) => ({ r, t: recordTime(r), k: String(recordKey(r) || '') }));
    const liveKeys = new Set(live.map((x) => x.k));
    // archived records not in the database (a record the database has is found there; one it lost is served from the archive)
    let extra = archived.filter((x) => Number.isFinite(x.t) && !liveKeys.has(x.k) && afterCursor(x)).sort(byOrder);
    const lastLive = live[live.length - 1];
    if (out.next && lastLive) extra = extra.filter((x) => byOrder(x, lastLive) <= 0);          // later ones belong to later pages
    const all = live.concat(extra).sort(byOrder);
    const page = all.slice(0, limit);
    const lastShown = page[page.length - 1];
    const hasMore = !!out.next || all.length > limit
      || (!!lastShown && archived.some((x) => Number.isFinite(x.t) && !liveKeys.has(x.k) && byOrder(x, lastShown) > 0));
    return reply({ records: page.map((x) => x.r), next: hasMore && page.length ? `${page[page.length - 1].t}:${page[page.length - 1].k}` : null });
  }
  const state = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  const liveRows = (state[col] || []).filter(isLive).map((r) => ({ r, t: recordTime(r), k: String(recordKey(r) || '') }));
  const have = new Set((state[col] || []).map((r) => String(recordKey(r) || '')));      // a deleted record's tombstone also keeps its archived copy out
  const rows = liveRows.concat(archived.filter((x) => !have.has(x.k)))
    .filter((x) => Number.isFinite(x.t) && x.t >= from && x.t < to)
    .sort(byOrder)
    .filter(afterCursor);
  const page = rows.slice(0, limit);
  return reply({ records: page.map((x) => x.r), next: rows.length > limit ? `${page[page.length - 1].t}:${page[page.length - 1].k}` : null });
}
