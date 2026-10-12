// functions/api/shared-demos.js — Cloudflare Pages Function (zip 262)
//
//   GET  /api/shared-demos            the demo gallery list (public, cacheable, no storage read): title, text, features, password, open address
//   GET  /api/shared-demos?open=KEY   makes sure that demo is loaded (at most one seeding per fortnight), then redirects to its fixed address
//   POST { action:'reset', key }      Owner Console only: re-load one demo's sample data now (never touches any other shop)
//   POST { action:'ensure-all' }      Owner Console only: create / refresh every shared demo
//
// Visitors never create anything here: there is no per-visitor shop, account or tenant.

import { SHARED_DEMOS, findSharedDemo, ensureSharedDemo, demoLink } from './_shared-demos.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { requireOwnerAuth } from './_owner-auth.js';
import { corsHeadersFor } from './_cors.js';

function json(body, status, cors, extra) { return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', ...(extra || {}), ...cors } }); }

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) }); }

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const url = new URL(request.url);
  const open = url.searchParams.get('open');
  if (!open) {
    const demos = SHARED_DEMOS.map((d) => ({ key: d.key, title: d.title, tag: d.tag, blurb: d.blurb, features: d.features, password: d.password, image: '/img/demo-' + d.key + '.svg', openUrl: '/api/shared-demos?open=' + d.key, link: demoLink(env, d, url.origin) }));
    return json({ ok: true, demos, login: 'Choose Admin and enter the password 0000. Nothing you do is saved online and payments are simulated.' }, 200, cors, { 'Cache-Control': 'public, max-age=300' });
  }
  const spec = findSharedDemo(open);
  if (!spec) return json({ error: 'Unknown demo.' }, 404, cors);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await checkRateLimit(env, 'demoOpen', ip);
  if (!rl.ok) return rateLimitResponse('opening demos', rl, cors);
  try { await ensureSharedDemo(env, spec); } catch (e) { return json({ error: 'The demo could not be prepared right now. Please try again in a minute.', detail: String(e && e.message || e).slice(0, 160) }, 503, cors); }
  return new Response(null, { status: 302, headers: { Location: demoLink(env, spec, url.origin), 'Cache-Control': 'no-store', ...cors } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  if (!(await requireOwnerAuth(context))) return json({ error: 'Owner sign-in required.' }, 401, cors);
  let body = {}; try { body = await request.json(); } catch (e) { /* none */ }
  const origin = new URL(request.url).origin;
  if (body.action === 'ensure-all') {
    const out = [];
    for (const d of SHARED_DEMOS) { try { const r = await ensureSharedDemo(env, d); out.push({ key: d.key, ok: true, seeded: r.seeded, link: demoLink(env, d, origin) }); } catch (e) { out.push({ key: d.key, ok: false, error: String(e && e.message || e).slice(0, 160) }); } }
    return json({ ok: true, demos: out }, 200, cors);
  }
  if (body.action === 'reset') {
    const spec = findSharedDemo(body.key);
    if (!spec) return json({ error: 'Unknown demo.' }, 404, cors);
    try { const r = await ensureSharedDemo(env, spec, { force: true }); return json({ ok: true, seeded: r.seeded, link: demoLink(env, spec, origin) }, 200, cors); } catch (e) { return json({ error: String(e && e.message || e).slice(0, 160) }, 500, cors); }
  }
  return json({ error: 'Unknown action.' }, 400, cors);
}
