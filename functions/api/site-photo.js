// functions/api/site-photo.js — Cloudflare Pages Function, zip 278. The portrait on /portfolio, changeable from the Owner Console (Website tab).
//
//   GET                                   -> the photo (public, cached 5 min); until one is uploaded, the built-in /img/samuel-mogue.jpg
//   POST { dataUrl }  (owner signed in)   -> store a new photo (the console has already resized + compressed it)
//   POST { action: 'reset' } (owner)      -> back to the built-in photo
import { requireOwnerAuth } from './_owner-auth.js';

const KEY = 'site:portrait';
const MAX_BYTES = 400 * 1024;                       // the console sends ~100-200 KB; anything bigger is refused, not stored
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

export async function onRequestGet({ request, env }) {
  let rec = null; try { rec = JSON.parse((await env.mydukapos_kv.get(KEY)) || 'null'); } catch (e) { rec = null; }
  if (!rec || !rec.b64) return new Response(null, { status: 302, headers: { Location: '/img/samuel-mogue.jpg', 'Cache-Control': 'public, max-age=300' } });
  const etag = '"' + rec.at + '"';
  if ((request.headers.get('If-None-Match') || '') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  const bin = Uint8Array.from(atob(rec.b64), (c) => c.charCodeAt(0));
  return new Response(bin, { status: 200, headers: { 'Content-Type': rec.type, 'Cache-Control': 'public, max-age=300', ETag: etag, 'X-Content-Type-Options': 'nosniff' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'Send JSON.' }, 400); }
  if (body && body.action === 'reset') { await env.mydukapos_kv.delete(KEY); return json({ ok: true }); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body && body.dataUrl || ''));
  if (!m) return json({ error: 'Choose a JPG, PNG or WebP picture.' }, 400);
  let bin; try { bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch (e) { return json({ error: 'That picture could not be read.' }, 400); }
  if (bin.length > MAX_BYTES) return json({ error: 'That picture is still too large after compressing. Try a smaller one.' }, 413);
  if (!MAGIC[m[1]].every((b, i) => bin[i] === b)) return json({ error: 'That file is not a real picture.' }, 400);
  await env.mydukapos_kv.put(KEY, JSON.stringify({ type: m[1], b64: m[2], at: Date.now() }));
  return json({ ok: true, bytes: bin.length });
}
