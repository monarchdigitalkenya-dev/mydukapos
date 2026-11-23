// functions/robots.txt.js — GET /robots.txt. Zip 177; reworked zip 288.
//
// Host-aware on purpose: the marketing site (the apex) is meant to be found; every client's own subdomain is a private POS and must not be.
// robots.txt is a courtesy to well-behaved crawlers, not access control — the POS is protected by sign-in, and its pages also carry
// `X-Robots-Tag: noindex` (middleware + _headers) and a noindex meta tag. It is NOT how a page is removed from Google: a blocked page can still
// be listed by URL, so private pages rely on noindex + sign-in, and robots only keeps well-behaved crawlers from wasting requests on them.
// The Sitemap line uses the canonical origin, so www or a preview host never advertises a different address.
import { isApexRequest, PRIVATE_PATHS, canonicalOrigin } from './_site.js';

export function robotsText(origin, apex) {
  const lines = apex
    ? ['User-agent: *', 'Allow: /', ...PRIVATE_PATHS.map((p) => 'Disallow: ' + p), '', `Sitemap: ${origin}/sitemap.xml`]
    : ['User-agent: *', 'Disallow: /'];
  return lines.join('\n') + '\n';
}

export async function onRequestGet({ request, env }) {
  const apex = isApexRequest(request, env);
  return new Response(robotsText(canonicalOrigin(env), apex), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
