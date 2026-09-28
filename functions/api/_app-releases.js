// functions/api/_app-releases.js — shared helper, NOT a route. zip 148.
//
// The native apps' releases (Android APK, Windows EXE / MSI) that the Owner Console publishes and every shop can install from
// Settings ▸ Install App. ONE list in KV (app-releases:v1); each release's FILE lives in R2 (the MEDIA bucket) under app-releases/.
// A release is offered to a shop only when: it is PUBLISHED, its file was really uploaded (size + SHA-256 recorded by the server
// while storing it), and its app is the shop's own app — the product comes from the shop's licence record on the server, never from
// the request (a Hotel shop can never be offered or download the Shop APK).

export const RELEASES_KEY = 'app-releases:v1';
export const R2_PREFIX = 'app-releases/';

// app key (native/apps.json) -> licence product
export const APP_PRODUCTS = { shop: 'shop', hotel: 'hotel', hmis: 'hospital', production: 'production', pharmacy: 'pharmacy', services: 'services', aquapos: 'water' };
export const APP_NAMES = { shop: 'MyDukaPOS', hotel: 'MyDukaPOS Hotel', hmis: 'MyDukaPOS HMIS', production: 'MyDukaPOS Production', pharmacy: 'MyDukaPOS Pharmacy', services: 'MyDukaPOS Services', aquapos: 'MyDukaPOS AquaPOS' };
export const PLATFORMS = { android: ['apk'], windows: ['exe', 'msi'] };
export const CONTENT_TYPES = { apk: 'application/vnd.android.package-archive', exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi' };
export const MAX_FILE_BYTES = 95 * 1048576;        // one request (Cloudflare accepts up to 100 MB on every plan)

export async function listReleases(env) {
  try { const raw = await env.mydukapos_kv.get(RELEASES_KEY); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
export async function saveReleases(env, list) {
  await env.mydukapos_kv.put(RELEASES_KEY, JSON.stringify(list));
}

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
export function cleanRelease(input, prev = {}) {
  const app = APP_PRODUCTS[input.app] ? input.app : prev.app;
  const platform = PLATFORMS[input.platform] ? input.platform : prev.platform;
  const kind = platform && PLATFORMS[platform].includes(input.kind) ? input.kind : (prev.kind || (platform ? PLATFORMS[platform][0] : ''));
  const version = /^\d+(\.\d+){0,3}$/.test(String(input.version || '')) ? String(input.version) : prev.version;
  const minVersion = input.minVersion === '' ? '' : (/^\d+(\.\d+){0,3}$/.test(String(input.minVersion || '')) ? String(input.minVersion) : (prev.minVersion || ''));
  return {
    ...prev,
    app, platform, kind, version, minVersion,
    build: Number.isFinite(Number(input.build)) && Number(input.build) > 0 ? Math.floor(Number(input.build)) : (prev.build || 1),
    notes: input.notes !== undefined ? cut(input.notes, 4000) : (prev.notes || ''),
    releasedAt: input.releasedAt ? cut(input.releasedAt, 30) : (prev.releasedAt || new Date().toISOString().slice(0, 10)),
  };
}

// "1.2.10" vs "1.10": numeric, part by part
export function compareVersions(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// What a shop may see: published, file present, its own app. Newest version first, per platform + kind.
export function releasesForProduct(list, product) {
  return list
    .filter((r) => r && r.status === 'published' && r.file && r.file.size > 0 && APP_PRODUCTS[r.app] === (product || 'shop'))
    .sort((a, b) => compareVersions(b.version, a.version) || (b.build || 0) - (a.build || 0));
}

export function publicView(r) {
  return { id: r.id, app: r.app, appName: APP_NAMES[r.app] || r.app, platform: r.platform, kind: r.kind, version: r.version, build: r.build,
    releasedAt: r.releasedAt, notes: r.notes || '', minVersion: r.minVersion || '',
    file: r.file ? { name: r.file.name, size: r.file.size, sha256: r.file.sha256 } : null };
}
