// functions/api/owner-releases.js — Owner Console ▸ 📦 Apps & versions. Owner only (requireOwnerAuth). zip 148.
//
//   GET                                   -> { releases: [...all, including drafts], bucket: true|false }
//   POST { action: 'save', release }      -> create (no id) or edit a release's details        -> { release }
//   PUT  ?id=<id>&name=<file name>        -> body = the file itself (APK / EXE / MSI), streamed into R2; size and SHA-256 are measured
//                                            HERE while storing, so what is recorded is what was really stored  -> { release }
//   POST { action: 'publish' | 'withdraw' | 'delete', id }
// A release cannot be published without a stored file: the apps never offer an installer that does not exist.
import { requireOwnerAuth } from './_owner-auth.js';
import { listReleases, saveReleases, cleanRelease, R2_PREFIX, CONTENT_TYPES, MAX_FILE_BYTES, APP_PRODUCTS, PLATFORMS } from './_app-releases.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const hasBucket = (env) => !!(env.MEDIA && typeof env.MEDIA.put === 'function');

export async function onRequestGet(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  return json({ releases: await listReleases(context.env), bucket: hasBucket(context.env), apps: Object.keys(APP_PRODUCTS), platforms: PLATFORMS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400); }
  const list = await listReleases(env);
  if (body.action === 'save') {
    const input = body.release || {};
    if (input.id) {
      const i = list.findIndex((r) => r.id === input.id);
      if (i < 0) return json({ error: 'That release no longer exists.' }, 404);
      const next = cleanRelease(input, list[i]);
      if (next.status === 'published' && (next.app !== list[i].app || next.platform !== list[i].platform || next.kind !== list[i].kind)) return json({ error: 'Withdraw the release before changing its app or platform.' }, 409);
      list[i] = { ...next, updatedAt: Date.now() };
      await saveReleases(env, list);
      return json({ release: list[i] });
    }
    const r = cleanRelease(input);
    if (!r.app || !r.platform || !r.kind || !r.version) return json({ error: 'Choose the app, the platform and the file type, and give a version like 1.0.0.' }, 400);
    if (list.some((x) => x.app === r.app && x.platform === r.platform && x.kind === r.kind && x.version === r.version && x.build === r.build)) return json({ error: 'That version already exists for this app — give a new version or build number (releases are never overwritten).' }, 409);
    const rel = { ...r, id: 'rel_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), status: 'draft', file: null, createdAt: Date.now(), updatedAt: Date.now() };
    list.push(rel);
    await saveReleases(env, list);
    return json({ release: rel });
  }
  const i = list.findIndex((r) => r.id === body.id);
  if (i < 0) return json({ error: 'That release no longer exists.' }, 404);
  const r = list[i];
  if (body.action === 'publish') {
    if (!r.file || !(r.file.size > 0)) return json({ error: 'Upload the installer file first — a release is only offered when its file really exists.' }, 409);
    r.status = 'published'; r.publishedAt = Date.now();
  } else if (body.action === 'withdraw') {
    r.status = 'withdrawn'; r.withdrawnAt = Date.now();
  } else if (body.action === 'delete') {
    if (r.status === 'published') return json({ error: 'Withdraw it first.' }, 409);
    if (r.file && r.file.key && hasBucket(env)) { try { await env.MEDIA.delete(r.file.key); } catch (e) { /* the list entry still goes */ } }
    list.splice(i, 1);
    await saveReleases(env, list);
    return json({ ok: true });
  } else {
    return json({ error: 'Unknown action.' }, 400);
  }
  r.updatedAt = Date.now();
  await saveReleases(env, list);
  return json({ release: r });
}

// The file itself. Streamed into R2 while its size and SHA-256 are measured.
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  if (!hasBucket(env)) return json({ error: 'File storage (the R2 bucket "mydukapos-media") is not set up on this deployment.' }, 501);
  const u = new URL(request.url);
  const list = await listReleases(env);
  const r = list.find((x) => x.id === u.searchParams.get('id'));
  if (!r) return json({ error: 'That release no longer exists.' }, 404);
  if (r.status === 'published') return json({ error: 'A published release is never overwritten — create a new version.' }, 409);
  const name = String(u.searchParams.get('name') || '').replace(/[^\w.\- ]+/g, '').slice(0, 120);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext !== r.kind) return json({ error: `This release is a .${r.kind} — choose the .${r.kind} file.` }, 400);
  const declared = Number(request.headers.get('content-length')) || 0;
  if (declared > MAX_FILE_BYTES) return json({ error: `The file is larger than ${Math.round(MAX_FILE_BYTES / 1048576)} MB.` }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ error: 'The file is empty.' }, 400);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: 'The file is too large.' }, 413);
  // a quick sanity check of the format, so a wrong file is not published under an app's name
  const magic = (a) => a.every((v, k) => bytes[k] === v);
  const okFormat = r.kind === 'apk' ? magic([0x50, 0x4b, 0x03, 0x04]) : r.kind === 'exe' ? magic([0x4d, 0x5a]) : magic([0xd0, 0xcf, 0x11, 0xe0]);
  if (!okFormat) return json({ error: `That file is not a real .${r.kind} (its contents do not match).` }, 400);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `${R2_PREFIX}${r.app}/${r.platform}/${r.version}-${r.build}/${name}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[r.kind] } });
  if (r.file && r.file.key && r.file.key !== key) { try { await env.MEDIA.delete(r.file.key); } catch (e) { /* replaced */ } }
  r.file = { key, name, size: bytes.length, sha256, uploadedAt: Date.now() };
  r.updatedAt = Date.now();
  await saveReleases(env, list);
  return json({ release: r });
}
