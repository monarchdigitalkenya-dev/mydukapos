// functions/api/barcode-lookup.js — Cloudflare Pages Function
//
// Called from the "Add New Items" tab when a barcode is scanned and the code
// isn't already in this shop's inventory. Looks the code up against public
// product databases so the item's name (and category, if there is one) can
// be auto-filled — the cashier still has to enter price, quantity, and any
// expiry date themselves, since those are shop-specific.
//
// Runs server-side (not called directly from the browser) for two reasons:
//   1. Some product-lookup APIs don't send CORS headers, so a direct browser
//      fetch would just fail silently.
//   2. If a paid-tier API key is ever added (see UPCITEMDB_API_KEY below), it
//      stays server-side instead of being exposed in the page's JS.
//
// Tries two free, keyless sources in order:
//   1. UPCitemdb "trial" endpoint (100 lookups/day, general retail products)
//   2. Open Food Facts (unlimited, but food/grocery items only)
// Returns { found: false } if neither has the code — the front-end falls
// back to fully manual entry in that case, which is expected to happen
// often for local/unbranded stock that isn't in any public database.

import { requireValidLicense } from './_license.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Optional: set UPCITEMDB_API_KEY + UPCITEMDB_KEY_TYPE as Cloudflare Pages
// environment variables if you upgrade off the free trial plan later (raises
// the 100/day cap). Not required — the trial endpoint works with no signup at all.
async function lookupUpcItemDb(code, env) {
  const apiKey = env.UPCITEMDB_API_KEY;
  const base = apiKey ? 'https://api.upcitemdb.com/prod/v1/lookup' : 'https://api.upcitemdb.com/prod/trial/lookup';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['user_key'] = apiKey;
    headers['key_type'] = env.UPCITEMDB_KEY_TYPE || '3scale';
  }

  const res = await timedFetch(`${base}?upc=${encodeURIComponent(code)}`, { headers });
  if (!res.ok) { if (res.status === 404) return null; throw new Error('lookup source answered ' + res.status); }   // a quota/5xx is not "unknown product"
  const data = await res.json();
  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  if (!item || !item.title) return null;

  return {
    found: true,
    source: 'upcitemdb',
    name: item.title,
    brand: item.brand || '',
    category: item.category || '',
    image: (Array.isArray(item.images) && item.images[0]) || null,
  };
}

async function lookupOpenFoodFacts(code) {
  const res = await timedFetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`);
  if (!res.ok) { if (res.status === 404) return null; throw new Error('lookup source answered ' + res.status); }   // a quota/5xx is not "unknown product"
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;

  const p = data.product;
  const name = p.product_name || p.generic_name;
  if (!name) return null;

  return {
    found: true,
    source: 'openfoodfacts',
    name: p.brands ? `${name} (${p.brands})` : name,
    brand: p.brands || '',
    category: (p.categories || '').split(',')[0] || '',
    image: p.image_front_small_url || p.image_small_url || null,
  };
}

// zip 143: each source gets 4 s — a slow database used to hold the cashier's scan for as long as it liked.
async function timedFetch(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

// zip 143: answers are cached for every shop (a product's name is the same everywhere): a repeat scan is instant, and the free
// UPCitemdb allowance (100 a day, shared by every shop behind this server) is not spent twice on the same code. "Not found" is kept
// for a day only, so a product added to the databases later is found.
const CACHE_HIT_TTL = 30 * 24 * 3600, CACHE_MISS_TTL = 24 * 3600;
const cacheKey = (code) => `barcode-cache:v1:${code}`;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!code) {
    return jsonResponse({ error: 'Missing code' }, 400);
  }
  // Barcodes are short and plain (EAN/UPC digits, Code-128 letters/digits). Anything else is not looked up (zip 143).
  if (code.length > 64 || !/^[A-Za-z0-9._-]+$/.test(code)) return jsonResponse({ found: false, reason: 'not a product barcode' });

  // Resolves to this shop whether they're on their own subdomain
  // (georgehardware.mydukapos.store) or a legacy ?c= link — see _license.js.
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const rll = await checkRateLimit(env, 'lookup', license.clientId);    // zip 273: each miss calls an outside service
  if (!rll.ok) return rateLimitResponse('product lookups', rll);

  const kv = env.mydukapos_kv;
  try {
    const cached = kv ? await kv.get(cacheKey(code)) : null;
    if (cached) return jsonResponse({ ...JSON.parse(cached), cached: true });
  } catch (e) { /* cache is optional */ }
  const remember = async (body, ttl) => { try { if (kv) await kv.put(cacheKey(code), JSON.stringify(body), { expirationTtl: ttl }); } catch (e) { /* optional */ } };

  let sourceFailed = false;
  try {
    const fromUpc = await lookupUpcItemDb(code, env);
    if (fromUpc) { await remember(fromUpc, CACHE_HIT_TTL); return jsonResponse(fromUpc); }
  } catch (e) {
    sourceFailed = true;   // fall through to the next source
  }

  try {
    const fromOff = await lookupOpenFoodFacts(code);
    if (fromOff) { await remember(fromOff, CACHE_HIT_TTL); return jsonResponse(fromOff); }
  } catch (e) {
    sourceFailed = true;   // fall through to "not found"
  }

  // A source that timed out or failed is not proof the product is unknown — only a clean "not found" is remembered.
  if (!sourceFailed) await remember({ found: false }, CACHE_MISS_TTL);
  return jsonResponse({ found: false });
}
