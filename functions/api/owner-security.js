// functions/api/owner-security.js — Cloudflare Pages Function (Owner Console), zip 273.
//
//   GET ?limit=100   (owner signed in) -> { events: [{ t, last, kind, route, shop, who, count, detail }], summary: { <kind>: n } }
//
// The security events the server noted (blocked requests, failed sign-ins, rejected payment callbacks, wrong payment passwords). Read only; never contains
// a password, code, token or key (see _sec-events.js). Not cached.
import { requireOwnerAuth } from './_owner-auth.js';
import { listSecEvents } from './_sec-events.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const limit = Math.max(1, Math.min(200, Number(new URL(request.url).searchParams.get('limit')) || 100));
  const events = await listSecEvents(env, limit);
  const summary = {};
  for (const e of events) summary[e.kind] = (summary[e.kind] || 0) + (e.count || 1);
  return json({ events, summary });
}
