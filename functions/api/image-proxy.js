// functions/api/image-proxy.js — Cloudflare Pages Function
//
// Fetches an external image server-side and streams it back with permissive
// CORS headers, so the browser can load it into a <canvas> for resizing
// (see readImageAsScaledDataUrl in index.html) without hitting cross-origin
// restrictions that many third-party image hosts don't lift for direct
// browser fetches.
//
// Used specifically for pulling a product photo from a barcode lookup
// (barcode-lookup.js returns an external image URL from UPCitemdb or Open
// Food Facts) into the Add New Items form automatically.
//
// SAFETY: only proxies http(s) URLs, rejects anything pointing at a private/
// internal address (basic SSRF guard), caps the response size, and only
// ever returns image content-types — never arbitrary files.

import { requireValidLicense } from './_license.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB — generous; the frontend downsizes further anyway

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Rejects obviously-private/internal targets. Not exhaustive (a determined
// attacker could still find a redirect chain into an internal address), but
// blocks the easy cases — this proxy only ever forwards a URL that came from
// barcode-lookup.js's own trusted responses in normal use, so the risk is low.
function isSafeUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;   // carrier-grade NAT (zip 143)
  if (host.startsWith('[') || /^\d+$/.test(host)) return false;                  // IPv6 literals and bare-number hosts (zip 143)
  return true;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  // zip 143: only a shop's own app may use this proxy (it was open to the whole internet — free bandwidth for anyone)
  const license = await requireValidLicense(request, env);
  if (!license.valid) return errorResponse('This link is not active.', 403);
  const rll = await checkRateLimit(env, 'lookup', license.clientId);    // zip 273
  if (!rll.ok) return rateLimitResponse('picture lookups', rll);
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get('url');
  if (!target) return errorResponse('Missing url parameter.');

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch (e) {
    return errorResponse('Invalid url.');
  }
  if (!isSafeUrl(parsedTarget)) return errorResponse('That URL is not allowed.');

  // Redirects are followed by hand (at most 3) so every hop is checked by isSafeUrl — a public URL can no longer bounce the
  // proxy to an address it would have refused (zip 143).
  let upstream;
  try {
    let current = parsedTarget;
    for (let hop = 0; ; hop++) {
      upstream = await fetch(current.toString(), { headers: { 'User-Agent': 'MyDukaPOS-ImageProxy/1.0' }, redirect: 'manual' });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const loc = upstream.headers.get('location');
      if (!loc || hop >= 3) return errorResponse('Image not found at that URL.', 404);
      current = new URL(loc, current);
      if (!isSafeUrl(current)) return errorResponse('That URL is not allowed.');
    }
  } catch (e) {
    return errorResponse('Could not fetch that image.', 502);
  }

  if (!upstream.ok) return errorResponse('Image not found at that URL.', 404);

  const contentType = upstream.headers.get('content-type') || '';
  if (!/^image\/(jpeg|jpg|png|webp|gif|avif|bmp)\b/i.test(contentType)) return errorResponse('That URL is not a supported image.', 415); // zip 184: no SVG (script would run on the shop origin)

  const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_IMAGE_BYTES) return errorResponse('Image is too large.', 413);

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return errorResponse('Image is too large.', 413);

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
    },
  });
}
