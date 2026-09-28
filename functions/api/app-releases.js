// functions/api/app-releases.js — what THIS shop may install (Settings ▸ Install App). zip 148.
//
//   GET  /api/app-releases?c=<link>            -> { product, app, releases: [...] }   only this shop's own app, published, file present
//   GET  /api/app-releases?c=<link>&download=<id> -> the file (attachment)            the same checks, done again on the download itself
// The shop is identified by its link (licence), exactly like every other shop endpoint; its product comes from the licence record on
// the server. A release of another app is answered 404 — as if it did not exist — whatever id is asked for.
import { resolveClientId, getLicense, evaluateLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { listReleases, releasesForProduct, publicView, APP_PRODUCTS, CONTENT_TYPES } from './_app-releases.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const clientId = await resolveClientId(request, env);
  const record = clientId ? await getLicense(env, clientId) : null;
  if (!record) return json({ error: 'This link is not active.' }, 403);
  const lic = evaluateLicense(record);
  // an expired demo may still see / install its app (it shows the upgrade screen); a locked or deleted link may not
  if (!lic.valid && lic.reason !== 'expired') return json({ error: 'This link is not active.', reason: lic.reason }, 403);
  const product = record.product || 'shop';
  const mine = releasesForProduct(await listReleases(env), product);
  const id = new URL(request.url).searchParams.get('download');
  if (!id) {
    return json({ product, app: Object.keys(APP_PRODUCTS).find((k) => APP_PRODUCTS[k] === product) || 'shop', releases: mine.map(publicView) });
  }
  const r = mine.find((x) => x.id === id);
  if (!r) return json({ error: 'Not found.' }, 404);
  if (!env.MEDIA || typeof env.MEDIA.get !== 'function') return json({ error: 'File storage is not available.' }, 503);
  const obj = await env.MEDIA.get(r.file.key);
  if (!obj) return json({ error: 'The installer file is missing — the owner has been told.' }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[r.kind] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${r.file.name.replace(/"/g, '')}"`,
      'Content-Length': String(r.file.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-MyDukaPOS-SHA256': r.file.sha256,
      ...cors,
    },
  });
}
