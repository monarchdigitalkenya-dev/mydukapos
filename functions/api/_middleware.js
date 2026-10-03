// functions/api/_middleware.js — runs in front of EVERY /api endpoint.
//
// Most endpoints were written with `Access-Control-Allow-Origin: *`, which lets any other website read a shop's data through a
// visitor's browser. The apps only ever call the API on their own origin (relative URLs), so nothing legitimate needs "*".
// This rewrites that header on the way out: the caller's origin is echoed only when it is this deployment, the root domain or one of
// its subdomains, or localhost (see _cors.js); otherwise the header is removed and the browser refuses to expose the response.
//
// It does not stop someone calling the API directly (curl, a script, a payment provider's webhook — none of those send an Origin
// and none are affected). WebSocket upgrades are passed through untouched.

import { originAllowed } from './_cors.js';

// zip 159: an /api answer that says nothing about caching must never be kept by a browser, a proxy or the edge — these are live shop data. Endpoints
// that DO say something (media: immutable photos; the public catalogue's own headers) are left exactly as they set it. `Server-Timing` lets
// the browser's Network panel show how long the Function itself took (no data, one number).
function withDefaultsSafe(res, t0) { try { return !res || res.status === 101 || res.webSocket ? res : withDefaults(res, t0); } catch (e) { return res; } }
function withDefaults(res, t0) {
  const needCache = res.headers.get('Cache-Control') == null && res.status !== 101 && res.status !== 304;
  if (!needCache && res.headers.get('Server-Timing') != null && res.headers.get('X-Content-Type-Options') != null) return res;
  const apply = (r) => { if (r.headers.get('X-Content-Type-Options') == null) r.headers.set('X-Content-Type-Options', 'nosniff'); if (needCache) r.headers.set('Cache-Control', 'no-store'); if (r.headers.get('Server-Timing') == null) r.headers.set('Server-Timing', `app;dur=${Date.now() - t0}`); return r; };
  try { return apply(res); }                                       // a Response built in this Worker has mutable headers: no copy, same object
  catch (e) { return apply(new Response(res.body, res)); }         // one that came from fetch() / another handler has immutable headers: copy
}

export async function onRequest(context) {
  const t0 = Date.now();
  const res = withDefaultsSafe(await context.next(), t0);
  if (!res || res.status === 101 || res.webSocket) return res;
  if (res.headers.get('Access-Control-Allow-Origin') == null) return res;
  const allowed = originAllowed(context.request, context.env);
  const out = new Response(res.body, res);
  if (allowed) {
    out.headers.set('Access-Control-Allow-Origin', allowed);
    out.headers.append('Vary', 'Origin');
  } else {
    out.headers.delete('Access-Control-Allow-Origin');
    out.headers.delete('Access-Control-Allow-Methods');
    out.headers.delete('Access-Control-Allow-Headers');
  }
  return out;
}
