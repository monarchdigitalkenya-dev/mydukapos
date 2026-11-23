// functions/api/media.js — Cloudflare Pages Function. zip 133. Pictures for every module, kept in R2 (see _media.js).
//
//   POST /api/media?c=<link>   { k: 'p'|'r'|'ref', id, dataUrl }   -> { ok, id, k, url, bytes, backend }   store (idempotent)
//   POST /api/media?c=<link>   { action: 'delete', k, id }          -> { ok }
//   GET  /api/media?c=<link>&k=p&id=<id>                            -> the image itself (immutable, cacheable: used in <img>)
//   GET  /api/media?c=<link>&k=r&id=<id>                            -> the image itself, only for a paired device of the shop
//
// Writes always need the shop's licence and (where the shop requires it) a paired device. Product photos are read by <img> tags,
// which cannot send the device headers: they are readable with the shop link and the file's unguessable id — the same people who
// can already see the menu. Clinical and reference images are private (paired device only).
import { requireValidLicense } from './_license.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { MEDIA_KINDS, MEDIA_ID_RE, mediaKey, mediaPut, mediaGet, mediaOpen, mediaDelete, mediaExists, mediaBackend, decodeImageDataUrl } from './_media.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}
const json = (b, s, cors) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const u = new URL(request.url);
  const k = u.searchParams.get('k') || 'p', id = u.searchParams.get('id') || '';
  if (!MEDIA_KINDS[k] || !MEDIA_ID_RE.test(id)) return json({ error: 'Give k and id.' }, 400, cors);
  const license = await requireValidLicense(request, env);
  if (!license.valid) return json({ error: 'This link is not active.' }, 403, cors);
  if (MEDIA_KINDS[k].private) { const denied = await deviceGuard(request, env, license.clientId, cors); if (denied) return denied; }
  const key = mediaKey(license.clientId, k, id);
  const isPrivate = !!MEDIA_KINDS[k].private;
  const heads = (type, etag, size) => ({ 'Content-Type': type, 'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable', ...(etag ? { ETag: etag } : {}), ...(size != null ? { 'Content-Length': String(size) } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", ...cors });
  const inm = request.headers.get('If-None-Match') || '';
  // zip 159 — the edge cache (Cache API) for PUBLIC product photos only: the licence was already checked above, so a hit skips only the R2 read.
  // Private clinical / reference images are never put in a shared cache. Small pictures only; anything else streams straight from R2.
  const edge = !isPrivate && typeof caches !== 'undefined' && caches.default && env.MEDIA_EDGE_CACHE !== '0' ? caches.default : null;
  const edgeKey = edge ? new Request('https://media.cache.internal/' + encodeURIComponent(license.clientId) + '/' + k + '/' + encodeURIComponent(id)) : null;
  if (edge) {
    try {
      const hit = await edge.match(edgeKey);
      if (hit) {
        const etag = hit.headers.get('ETag') || '';
        if (inm && etag && inm.split(',').map((x) => x.trim().replace(/^W\//, '')).includes(etag)) return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': heads('', '', null)['Cache-Control'], ...cors } });
        return new Response(hit.body, { status: 200, headers: heads(hit.headers.get('Content-Type') || 'image/jpeg', etag, hit.headers.get('Content-Length')) });
      }
    } catch (e) { /* the cache is an optimisation only */ }
  }
  const f = await mediaOpen(env, key, { ifNoneMatch: inm });
  if (!f) return json({ error: 'Not found.' }, 404, cors);
  if (f.notModified) return new Response(null, { status: 304, headers: { ...(f.etag ? { ETag: f.etag } : {}), 'Cache-Control': heads('', '', null)['Cache-Control'], ...cors } });
  if (edge && f.size != null && f.size <= 1.5 * 1048576) {
    const buf = f.body instanceof Uint8Array ? f.body : new Uint8Array(await new Response(f.body).arrayBuffer());
    try { context.waitUntil && context.waitUntil(edge.put(edgeKey, new Response(buf, { headers: { 'Content-Type': f.type, ETag: f.etag || '', 'Content-Length': String(buf.length), 'Cache-Control': 'public, max-age=86400' } })).catch(() => {})); } catch (e) { /* optimisation only */ }
    return new Response(buf, { status: 200, headers: heads(f.type, f.etag, buf.length) });
  }
  return new Response(f.body, { status: 200, headers: heads(f.type, f.etag, f.size) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const license = await requireValidLicense(request, env);
  if (!license.valid) return json({ error: 'This link is not active.' }, 403, cors);
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return denied;
  const rlu = await checkRateLimit(env, 'upload', license.clientId);   // zip 273: uploads cost storage, per shop
  if (!rlu.ok) return rateLimitResponse('picture uploads', rlu, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, cors); }
  const k = String(body.k || 'p'), id = String(body.id || '');
  if (!MEDIA_KINDS[k] || !MEDIA_ID_RE.test(id)) return json({ error: 'Give k and id.' }, 400, cors);
  const key = mediaKey(license.clientId, k, id);
  const purge = async () => { try { if (typeof caches !== 'undefined' && caches.default) await caches.default.delete(new Request('https://media.cache.internal/' + encodeURIComponent(license.clientId) + '/' + k + '/' + encodeURIComponent(id))); } catch (e) { /* optimisation only */ } };
  if (body.action === 'delete') { await mediaDelete(env, key); await purge(); return json({ ok: true }, 200, cors); }
  const url = `/api/media?k=${k}&id=${encodeURIComponent(id)}`;
  if (await mediaExists(env, key)) return json({ ok: true, id, k, url, existed: true, backend: mediaBackend(env) }, 200, cors);   // a retry stores nothing twice
  const dataUrl = String(body.dataUrl || '');
  if (dataUrl.length > MEDIA_KINDS[k].maxBytes * 1.4) return json({ error: `The ${MEDIA_KINDS[k].label} is too large.`, code: 'too_large' }, 413, cors);
  const img = decodeImageDataUrl(dataUrl);
  if (!img) return json({ error: 'Not a JPEG, PNG or WebP image.', code: 'not_image' }, 400, cors);
  if (img.bytes.length > MEDIA_KINDS[k].maxBytes) return json({ error: `The ${MEDIA_KINDS[k].label} is too large.`, code: 'too_large' }, 413, cors);
  const backend = await mediaPut(env, key, img.bytes, img.type, { orderId: String(body.orderId || '').slice(0, 80), at: Date.now() });
  return json({ ok: true, id, k, url, bytes: img.bytes.length, backend }, 200, cors);
}
