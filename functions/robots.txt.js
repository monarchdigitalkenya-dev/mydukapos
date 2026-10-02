// functions/robots.txt.js — GET /robots.txt. Zip 177.
//
// Host-aware on purpose: the marketing site (the apex) is meant to be found; every client's own subdomain is a private POS and must not be.
// robots.txt is a courtesy to well-behaved crawlers, not access control — the POS is protected by sign-in, and its pages also carry
// `X-Robots-Tag: noindex` (middleware + _headers) and a noindex meta tag.
import { isApexRequest, PRIVATE_PATHS } from './_site.js';

export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
  const lines = isApexRequest(request, env)
    ? ['User-agent: *', 'Allow: /', ...PRIVATE_PATHS.map((p) => 'Disallow: ' + p), '', `Sitemap: ${origin}/sitemap.xml`]
    : ['User-agent: *', 'Disallow: /'];
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
