// functions/api/_media.js — one place where every module keeps its pictures (zip 133).
//
// Storage: Cloudflare R2 (binding MEDIA, bucket "mydukapos-media") — built for files, far larger and cheaper than KV for images.
// Until the bucket exists (or on a deployment without the binding) the same calls fall back to the shop's KV namespace, so nothing
// breaks; files written to KV are still read after R2 is switched on (reads try R2 first, then KV).
//
// Keys always carry the shop: shop/<clientId>/<kind>/<id>. One shop can never name another shop's file.
export const MEDIA_KINDS = {
  p: { label: 'product photo', maxBytes: 600 * 1024, private: false },        // menu / product / item photos (shown with <img>)
  r: { label: 'radiology image', maxBytes: 1100 * 1024, private: true },      // clinical: only a paired device of the shop reads it
  ref: { label: 'reference image', maxBytes: 1100 * 1024, private: true },    // custom orders (cake designs …), service requests
};
export const MEDIA_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function mediaKey(clientId, kind, id) { return `shop/${clientId}/${kind}/${id}`; }
export function mediaBackend(env) { return env && env.MEDIA && typeof env.MEDIA.put === 'function' ? 'r2' : 'kv'; }

// data:image/jpeg;base64,... -> { bytes: Uint8Array, type } or null (only real JPEG / PNG / WebP pass: checked by the file's own signature)
export function decodeImageDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin;
  try { bin = atob(m[2]); } catch (e) { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const sig = (i, arr) => arr.every((b, k) => bytes[i + k] === b);
  const real = sig(0, [0xff, 0xd8, 0xff]) ? 'jpeg' : sig(0, [0x89, 0x50, 0x4e, 0x47]) ? 'png' : (sig(0, [0x52, 0x49, 0x46, 0x46]) && sig(8, [0x57, 0x45, 0x42, 0x50])) ? 'webp' : null;
  if (!real) return null;                                   // says "image" but is not one: refused
  return { bytes, type: TYPES[real] };
}
function toBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function fromBase64(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

export async function mediaPut(env, key, bytes, type, meta = {}) {
  if (mediaBackend(env) === 'r2') {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'private, max-age=31536000, immutable' }, customMetadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])) });
    return 'r2';
  }
  await env.mydukapos_kv.put('media:' + key, JSON.stringify({ type, b64: toBase64(bytes), meta, at: Date.now() }));
  return 'kv';
}
export async function mediaExists(env, key) {
  if (mediaBackend(env) === 'r2' && await env.MEDIA.head(key)) return true;
  return !!(await env.mydukapos_kv.get('media:' + key));
}
// -> { bytes, type, meta } or null
export async function mediaGet(env, key) {
  if (mediaBackend(env) === 'r2') {
    const obj = await env.MEDIA.get(key);
    if (obj) return { bytes: new Uint8Array(await obj.arrayBuffer()), type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', meta: obj.customMetadata || {} };
  }
  const raw = await env.mydukapos_kv.get('media:' + key);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  return { bytes: fromBase64(rec.b64), type: rec.type, meta: rec.meta || {} };
}
// zip 159 — STREAMING READ WITH A VALIDATOR. -> { notModified: true, etag } | { body, size, type, etag } | null.
// R2 answers a conditional request itself (`onlyIf`), so a browser or the edge revalidating a picture costs a metadata read, not the bytes,
// and the picture is streamed to the client instead of being buffered in the Worker first. The KV fallback keeps its old buffered path.
export async function mediaOpen(env, key, { ifNoneMatch = '' } = {}) {
  if (mediaBackend(env) === 'r2') {
    const tag = String(ifNoneMatch || '').replace(/^W\//, '').split(',')[0].trim().replace(/^"|"$/g, '');
    const obj = await env.MEDIA.get(key, tag ? { onlyIf: { etagDoesNotMatch: tag } } : undefined);
    if (obj) {
      const etag = obj.httpEtag || (obj.etag ? `"${obj.etag}"` : '');
      if (!obj.body) {
        if (tag) return { notModified: true, etag };                   // R2: precondition failed = the caller's copy is current
        if (typeof obj.arrayBuffer === 'function') {                   // no validator was sent and no stream came back: read the bytes
          const buf = new Uint8Array(await obj.arrayBuffer());
          return { body: buf, size: buf.length, type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', etag };
        }
      } else return { body: obj.body, size: obj.size, type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', etag };
    }
  }
  const f = await mediaGet(env, key);                                   // KV fallback (or an R2 miss that a KV copy still answers)
  if (!f) return null;
  const etag = `"kv-${f.bytes.length}-${f.type.length}"`;
  if (ifNoneMatch && String(ifNoneMatch).replace(/^W\//, '').split(',').map((x) => x.trim()).includes(etag)) return { notModified: true, etag };
  return { body: f.bytes, size: f.bytes.length, type: f.type, etag };
}
export async function mediaDelete(env, key) {
  if (mediaBackend(env) === 'r2') await env.MEDIA.delete(key);
  await env.mydukapos_kv.delete('media:' + key);
}
export function bytesToDataUrl(bytes, type) { return `data:${type};base64,${toBase64(bytes)}`; }
