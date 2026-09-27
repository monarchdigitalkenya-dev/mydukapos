// functions/api/facility-book.js — Cloudflare Pages Function. zip 137.
//
//   POST /api/facility-book?c=<link>   { booking: { id, resourceId, start, end, status, ... } }
//     -> { ok: true }                       booked (database shops: stored in the same step)
//     -> { ok: false, conflict: {...} }     that resource is already booked for an overlapping time (409)
//
// Reservations (pool tables, cabanas, conference rooms, private pool sessions …) are checked against every booking the SERVER
// holds — not only the ones this till happens to have — before a till confirms one. For a shop with its own database the check
// and the insert are one atomic step. For a shop still on the single-record store the check is made here and the booking follows
// with the normal sync (and every till resolves any clash the same way: the earlier booking stands). Same licence and paired-device
// rules as every staff action.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';
import { readState, shopMode, shopCall } from './_state-store.js';
import { bookingConflict } from './_merge.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return denied;
  const sg = await staffGuard(request, env, license.clientId, null, cors);     // zip 141: a signed-in staff member, when required
  if (sg.denied) return sg.denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  const b = body && body.booking;
  if (!b || typeof b !== 'object' || !/^[A-Za-z0-9_:-]{4,80}$/.test(String(b.id || '')) || !b.resourceId || !(Number(b.end) > Number(b.start))) return reply({ error: 'Give the resource, start and end.' }, 400);
  const mode = await shopMode(env, license.clientId);
  if (mode === 'migrating') return reply({ error: 'busy', code: 'busy' }, 503);
  if (mode === 'do') {
    const res = await shopCall(env, license.clientId, 'book', { record: { ...b, updatedAt: Number(b.updatedAt) || Date.now() }, serverNow: Date.now() });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && res.status === 404) return reply({ error: 'The shop database cannot book yet.', code: 'book_unsupported' }, 501);
    return reply(d, d.ok ? 200 : 409);
  }
  const state = (await readState(env, 'pos-data:state:' + license.clientId, {})) || {};
  const clash = bookingConflict(state.facilityBookings, b);
  return clash ? reply({ ok: false, conflict: clash }, 409) : reply({ ok: true, checkedOnly: true });
}
