// functions/api/_messages.js — shared helper, NOT a route. Owner Console ▸ 📣 Messages. zip 148.
//
// Messages the owner sends to shops: announcements, app updates, installation offers, maintenance, security, sync, printing.
// Stored server-side (KV owner-messages:v1), so a device that is offline gets them when it reconnects (the apps ask on start, every
// 10 minutes and whenever the connection comes back — /api/messages). Targeting:
//   * shops: all, or chosen shops (client ids), and/or chosen apps (products) — decided HERE, from the shop's licence record;
//   * platforms (web / android / windows) and app versions — decided on the device (the server cannot see which one is asking).
// Lifecycle: draft → published (shown between startsAt and endsAt) → archived; drafts and archived ones can be deleted.

export const MESSAGES_KEY = 'owner-messages:v1';
export const KINDS = ['announcement', 'install', 'update', 'maintenance', 'security', 'sync', 'printing'];
export const PLATFORMS = ['web', 'android', 'windows'];
export const PRODUCTS = ['shop', 'hotel', 'hospital', 'production', 'pharmacy', 'services', 'water', 'chama'];

export async function listMessages(env) {
  try { const raw = await env.mydukapos_kv.get(MESSAGES_KEY); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
export async function saveMessages(env, list) { await env.mydukapos_kv.put(MESSAGES_KEY, JSON.stringify(list.slice(-500))); }

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
const ts = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };
const ver = (v) => (/^\d+(\.\d+){0,3}$/.test(String(v || '')) ? String(v) : '');

export function cleanMessage(input, prev = {}) {
  const t = input.targets || {};
  const arr = (a, allowed, n) => (Array.isArray(a) ? a.map((x) => cut(x, 60)).filter((x) => !allowed || allowed.includes(x)).slice(0, n) : []);
  return {
    ...prev,
    title: input.title !== undefined ? cut(input.title, 120) : (prev.title || ''),
    body: input.body !== undefined ? cut(input.body, 4000) : (prev.body || ''),
    kind: KINDS.includes(input.kind) ? input.kind : (prev.kind || 'announcement'),
    installPlatform: ['android', 'windows'].includes(input.installPlatform) ? input.installPlatform : (input.installPlatform === '' ? '' : (prev.installPlatform || '')),
    startsAt: input.startsAt !== undefined ? ts(input.startsAt) : (prev.startsAt || 0),
    endsAt: input.endsAt !== undefined ? ts(input.endsAt) : (prev.endsAt || 0),
    targets: {
      all: t.all !== undefined ? !!t.all : (prev.targets ? prev.targets.all : true),
      clients: t.clients !== undefined ? arr(t.clients, null, 2000) : (prev.targets ? prev.targets.clients : []),
      products: t.products !== undefined ? arr(t.products, PRODUCTS, 10) : (prev.targets ? prev.targets.products : []),
      platforms: t.platforms !== undefined ? arr(t.platforms, PLATFORMS, 3) : (prev.targets ? prev.targets.platforms : []),
      minVersion: t.minVersion !== undefined ? ver(t.minVersion) : (prev.targets ? prev.targets.minVersion : ''),
      maxVersion: t.maxVersion !== undefined ? ver(t.maxVersion) : (prev.targets ? prev.targets.maxVersion : ''),
    },
  };
}

// Is this message for this shop now? (platform / version are checked on the device)
export function messageForShop(m, clientId, product, now = Date.now()) {
  if (!m || m.status !== 'published') return false;
  if (m.startsAt && m.startsAt > now) return false;
  if (m.endsAt && m.endsAt <= now) return false;
  const t = m.targets || {};
  if (t.all) return true;
  const byClient = Array.isArray(t.clients) && t.clients.length ? t.clients.includes(clientId) : null;
  const byProduct = Array.isArray(t.products) && t.products.length ? t.products.includes(product) : null;
  if (byClient === null && byProduct === null) return false;
  return byClient !== false && byProduct !== false;
}

export function shopView(m) {
  return { id: m.id, title: m.title, body: m.body, kind: m.kind, installPlatform: m.installPlatform || '', publishedAt: m.publishedAt || m.updatedAt || 0,
    endsAt: m.endsAt || 0, platforms: (m.targets && m.targets.platforms) || [], minVersion: (m.targets && m.targets.minVersion) || '', maxVersion: (m.targets && m.targets.maxVersion) || '' };
}
