// functions/_middleware.js — Cloudflare Pages Function, runs on EVERY request
//
// Distinguishes the bare apex domain (mydukapos.store, no subdomain) from
// every client's own subdomain (georgehardware.mydukapos.store) — both
// reach this same Pages deployment, but should show completely different
// content. A client subdomain must keep showing that client's Shop POS app
// exactly as it always has; only the bare apex (or www) gets the new public
// marketing site instead.
//
// Deliberately reuses the EXACT SAME hostname/subdomain-detection logic
// already used by every API route (see api/_license.js's resolveClientId)
// rather than a second, separately-written copy that could drift out of
// sync and misclassify a request differently than the API layer does — the
// definition of "is this the apex" must never disagree between the two.
//
// Scoped as narrowly as possible on purpose: only a plain GET at the exact
// root path "/" is ever considered for interception. Every API call (under
// /api/), every static asset, every other path, and — critically — every
// client subdomain's own "/" falls straight through to next() completely
// untouched. Getting this condition wrong in either direction either hides
// the new public site or, far worse, breaks an existing client's link.

import { getRootDomain, hostnameFromRequest, subdomainLabel } from './api/_license.js';

// `wrangler pages deploy .` uploads the WHOLE project folder as public files, so without this the live site would serve the source of the
// tests, the shared code, the tools, the design notes (SYNC_AUTH_DESIGN.md describes exactly which endpoints a leaked link exposes),
// package.json and wrangler.toml to anyone who asks. None of those are needed by a browser, so they answer 404. The apps, icons,
// manifests, service workers and the public site are untouched.
const INTERNAL_DIRS = /^\/(tests|src|tools|wildcard-router|functions|node_modules|\.git|\.wrangler)(\/|$)/i;
const INTERNAL_FILES = /^\/(?:[^/]+\.md|package(?:-lock)?\.json|wrangler(?:\.[a-z]+)?\.toml|\.gitignore|\.gitattributes|\.dev\.vars|\.env.*)$/i;
export function isInternalPath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch (e) { /* keep as is */ }
  return INTERNAL_DIRS.test(p) || INTERNAL_FILES.test(p);
}

export async function onRequest(context) {
  const { request, env, next } = context;

  if (isInternalPath(new URL(request.url).pathname)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  if (request.method !== 'GET') return next();

  const url = new URL(request.url);
  if (url.pathname !== '/') return next();

  const hostname = hostnameFromRequest(request, env);
  const rootDomain = getRootDomain(env);
  const label = subdomainLabel(hostname, rootDomain);

  // subdomainLabel() returns '' for both the bare apex/www AND for any
  // hostname that isn't under this root domain at all (e.g. a *.pages.dev
  // preview URL) — the explicit hostname === rootDomain / www check below
  // is what narrows this down to specifically the apex case, not just
  // "not a recognized client subdomain".
  const isApex = !label && (hostname === rootDomain || hostname === `www.${rootDomain}`);
  if (!isApex) return next();

  // Served as a plain static-asset fetch, not a redirect — the address bar
  // keeps showing the clean apex URL rather than jumping to /public-site/.
  const publicUrl = new URL('/public-site/index.html', url);
  return env.ASSETS.fetch(new Request(publicUrl, request));
}
