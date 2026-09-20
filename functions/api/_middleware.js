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

export async function onRequest(context) {
  const res = await context.next();
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
