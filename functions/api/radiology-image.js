// functions/api/radiology-image.js — Cloudflare Pages Function. zip 132.
//
//   POST /api/radiology-image?c=<link>   body { id, orderId, dataUrl }         -> { ok: true, id, bytes }      (store one image)
//   POST /api/radiology-image?c=<link>   body { action: 'delete', id }         -> { ok: true }                  (remove one image)
//   GET  /api/radiology-image?c=<link>&id=<id>                                  -> { id, orderId, dataUrl, at }
//
// Zip 133: stored in Cloudflare R2 through the shared media store (_media.js; KV until the bucket exists). Images uploaded by
// zip 132 (plain KV records) are still read.
// Radiology images (X-ray, ultrasound … exported or photographed) are compressed ON THE DEVICE before upload (JPEG, at most
// 1600 px and ~350 KB). Each is kept under its own key in the shop's media store, never inside the synced shop state, so they
// do not slow down every device's sync; the imaging order only carries a small list of image ids. Same licence and
// paired-device rules as every shop endpoint; one shop can never read another shop's images (the key carries the shop id).
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { mediaKey, mediaPut, mediaGet, mediaDelete, mediaExists, decodeImageDataUrl, bytesToDataUrl } from './_media.js';

export const IMG_PREFIX = 'pos-radimg:';
export const MAX_DATAURL_CHARS = 1_500_000;          // ~1.1 MB of JPEG: the device sends ~350 KB; this only stops abuse
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
const DATA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

async function guard(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200, extra = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return { res: reply({ error: 'This link is not active.', reason: license.reason }, 403) };
  const denied = await deviceGuard(request, env, license.clientId, cors);
  if (denied) return { res: denied };
  return { clientId: license.clientId, reply };
}

export async function onRequestGet(context) {
  const g = await guard(context);
  if (g.res) return g.res;
  const id = new URL(context.request.url).searchParams.get('id') || '';
  if (!ID_RE.test(id)) return g.reply({ error: 'Give the image id.' }, 400);
  const f = await mediaGet(context.env, mediaKey(g.clientId, 'r', id));
  let rec = f ? { orderId: f.meta.orderId || '', dataUrl: bytesToDataUrl(f.bytes, f.type), at: Number(f.meta.at) || 0 } : null;
  if (!rec) { const raw = await context.env.mydukapos_kv.get(IMG_PREFIX + g.clientId + ':' + id); if (raw) rec = JSON.parse(raw); }   // zip 132 upload
  if (!rec) return g.reply({ error: 'Image not found.' }, 404);
  // an image never changes once stored (a new upload gets a new id): the device may keep it
  return g.reply({ id, orderId: rec.orderId, dataUrl: rec.dataUrl, at: rec.at }, 200, { 'Cache-Control': 'private, max-age=31536000, immutable' });
}

export async function onRequestPost(context) {
  const g = await guard(context);
  if (g.res) return g.res;
  let body;
  try { body = await context.request.json(); } catch (e) { return g.reply({ error: 'Invalid JSON body' }, 400); }
  const id = String((body && body.id) || '');
  if (!ID_RE.test(id)) return g.reply({ error: 'Give the image id.' }, 400);
  const key = mediaKey(g.clientId, 'r', id);
  if (body.action === 'delete') {
    await mediaDelete(context.env, key);
    await context.env.mydukapos_kv.delete(IMG_PREFIX + g.clientId + ':' + id);
    return g.reply({ ok: true });
  }
  const dataUrl = String(body.dataUrl || '');
  if (dataUrl.length > MAX_DATAURL_CHARS) return g.reply({ error: 'The image is too large — it is compressed on the device before upload; try again.', code: 'too_large' }, 413);
  if (!DATA_RE.test(dataUrl)) return g.reply({ error: 'Not an image.' }, 400);
  const img = decodeImageDataUrl(dataUrl);
  if (!img) return g.reply({ error: 'Not a JPEG, PNG or WebP image.' }, 400);
  const orderId = String(body.orderId || '').slice(0, 80);
  if (!(await mediaExists(context.env, key))) await mediaPut(context.env, key, img.bytes, img.type, { orderId, at: Date.now() });   // idempotent: a retried upload stores nothing twice
  return g.reply({ ok: true, id, bytes: img.bytes.length });
}
