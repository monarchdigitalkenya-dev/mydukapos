// functions/api/sync-diag.js — Cloudflare Pages Function. zip 328 (Prompt 7, Part 3): sync health for the admin.
//
//   POST /api/sync-diag?c=<link>  body { device, name, report }   a device uploads a COMPACT picture of its own sync state:
//        counts, the ids of records waiting / parked with attempt counts and an error CATEGORY, last good push / pull times.
//        Never a PIN, token, password, customer detail or record body. Stored per shop, bounded (MAX_DEVICES, MAX_IDS), expires.
//   GET  /api/sync-diag?c=<link>  -> { devices: [...], serverTime }   managers only when staff sessions are enforced.
//
// Nothing here changes shop data and nothing blocks a sale: a failed upload is simply ignored by the device.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffTokenOf, verifyToken, readMode } from './_staff-auth.js';
import { isManagerClaims } from './_perm-guard.js';

export const MAX_DEVICES = 30, MAX_IDS = 50, TTL_S = 14 * 24 * 3600;
const KEY = (c) => `sync-diag:v1:${c}`;
const CATS = ['network', 'busy', 'auth', 'forbidden', 'validation', 'server', 'conflict', 'other'];
const txt = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

// Reduce whatever a device sent to the allowed shape (also the privacy filter: unknown fields are dropped).
export function cleanReport(r, now = Date.now()) {
  r = r && typeof r === 'object' ? r : {};
  const ids = (a) => (Array.isArray(a) ? a : []).slice(0, MAX_IDS).map((x) => ({
    col: txt(x && x.col, 40), id: txt(x && x.id, 80), n: num(x && x.n), at: num(x && x.at),
    cat: CATS.includes(x && x.cat) ? x.cat : 'other', why: txt(x && x.why, 120),
  })).filter((x) => x.col && x.id);
  const o = {
    at: now,
    version: txt(r.version, 20),
    online: r.online !== false,
    pending: num(r.pending),
    dirty: num(r.dirty),
    parked: ids(r.parked),
    parkedCount: num(r.parkedCount) || ids(r.parked).length,
    retrying: ids(r.retrying),
    lastPush: num(r.lastPush), lastPull: num(r.lastPull), lastOk: num(r.lastOk),
    conflicts: num(r.conflicts), held: num(r.held),
    breaker: !!r.breaker,
  };
  return o;
}
// Plain-words verdict used by the admin view (also tested).
export function healthOf(rep, now = Date.now()) {
  if (!rep) return { level: 'unknown', text: 'No report yet' };
  if (rep.parkedCount > 0) return { level: 'attention', text: `${rep.parkedCount} change${rep.parkedCount === 1 ? '' : 's'} need attention` };
  if (rep.breaker) return { level: 'attention', text: 'Sync is paused after repeated failures' };
  if (rep.pending > 0 && rep.lastOk && now - rep.lastOk > 15 * 60e3) return { level: 'behind', text: `${rep.pending} waiting for over 15 minutes` };
  if (rep.pending > 0 || rep.dirty > 0) return { level: 'syncing', text: `${rep.pending + rep.dirty} waiting to send` };
  if (!rep.online) return { level: 'offline', text: 'Offline — nothing waiting' };
  return { level: 'ok', text: 'Up to date' };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}
async function gate(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return { out: reply({ error: 'This link is not active.', reason: license.reason }, 403) };
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return { out: denied };
  return { reply, clientId: license.clientId, env, request };
}
async function load(env, clientId) {
  try { const raw = await env.mydukapos_kv.get(KEY(clientId)); const o = raw ? JSON.parse(raw) : {}; return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}

export async function onRequestPost(context) {
  const g = await gate(context); if (g.out) return g.out;
  let body; try { body = await g.request.json(); } catch (e) { return g.reply({ error: 'Invalid JSON body' }, 400); }
  const device = txt(body && body.device, 80);
  if (!device) return g.reply({ error: 'Missing device id.' }, 400);
  const all = await load(g.env, g.clientId);
  all[device] = { name: txt(body.name, 60), ...cleanReport(body.report) };
  const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_DEVICES);   // newest devices win the slots
  await g.env.mydukapos_kv.put(KEY(g.clientId), JSON.stringify(Object.fromEntries(keep)), { expirationTtl: TTL_S });
  return g.reply({ ok: true });
}

export async function onRequestGet(context) {
  const g = await gate(context); if (g.out) return g.out;
  const tok = staffTokenOf(g.request);
  const claims = tok ? await verifyToken(g.env, g.clientId, tok) : null;
  if ((await readMode(g.env, g.clientId)) === 'enforce' && !isManagerClaims(claims)) return g.reply({ error: 'Only a manager can see sync health.', code: 'staff_forbidden' }, 403);
  const all = await load(g.env, g.clientId);
  const now = Date.now();
  const devices = Object.entries(all).map(([id, r]) => ({ id, ...r, health: healthOf(r, now) })).sort((a, b) => (b.at || 0) - (a.at || 0));
  return g.reply({ devices, serverTime: now });
}
