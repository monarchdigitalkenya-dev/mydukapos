// functions/api/_cors.js — shared helper, NOT a route.
//
// The apps call the API on their OWN origin (relative URLs — see apiUrl() in the apps), so they never need CORS at
// all. `Access-Control-Allow-Origin: *` therefore only ever helped OTHER websites read a shop's data through a
// visitor's browser. corsHeadersFor() answers with the caller's origin only when it is this deployment itself, the
// root domain / one of its subdomains (e.g. georgehardware.mydukapos.store), or localhost (wrangler dev). Anything
// else gets no Allow-Origin header, so the browser refuses to hand the response to that site.
//
// This does NOT stop someone calling the API directly (curl, a script) — that needs the server-verified logins in
// SYNC_AUTH_DESIGN.md. It closes the "any web page can read any shop" gap.

import { getRootDomain } from './_license.js';

export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  let u;
  try { u = new URL(origin); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  if (u.host === new URL(request.url).host) return origin;                       // this very deployment
  const root = getRootDomain(env);
  if (root && (host === root || host.endsWith('.' + root))) return origin;         // apex + subdomains
  if (host === 'localhost' || host === '127.0.0.1') return origin;                 // local development
  return null;
}

export function corsHeadersFor(request, env, { methods = 'GET, POST, OPTIONS', headers = 'Content-Type' } = {}) {
  const h = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headers,
    'Vary': 'Origin',
  };
  const allowed = originAllowed(request, env);
  if (allowed) h['Access-Control-Allow-Origin'] = allowed;
  return h;
}
