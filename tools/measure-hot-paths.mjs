// tools/measure-hot-paths.mjs — how many Cloudflare operations does each hot request cost? (zip 159)
//   node tools/measure-hot-paths.mjs            prints a table; `--json` prints machine-readable output
// The REAL Pages Functions run against counting wrappers around the same fakes the tests use (kv-fake, d1-fake on real SQLite, do-fake with the real
// ShopStore). Counts are operations, not milliseconds: what one operation costs on real Cloudflare (a few ms from the edge cache, tens of ms to a
// D1 primary in another region) can only be measured there. Nothing here is a benchmark of speed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { makeKV, seedShop } from '../tests/kv-fake.mjs';
import { makeD1 } from '../tests/d1-fake.mjs';
import { makeBinding } from '../tests/do-fake.mjs';
import { countKV, countD1, countDO } from '../tests/ops-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

export const LEGACY_ENV = { LICENSE_CACHE_MS: '0', SHOP_MODE_CACHE_MS: '0', LEDGER_SEEN_MS: '0', LEDGER_OUTBOX_CHECK_MS: '0' };   // every zip-159 memory switched off
export async function setup({ mode = 'do', type = 'permanent', legacy = false } = {}) {
  const kvRaw = makeKV(); seedShop(kvRaw, 'C1', { type, slug: 'shopc1', expiresAt: Date.now() + 86400000, createdAt: Date.now() });
  kvRaw.data.set('slug:shopc1', { value: 'C1' });
  if (mode === 'do') kvRaw.data.set('pos-data:mode:C1', { value: 'do' });
  const kv = countKV(kvRaw);
  const d1 = countD1(makeD1());
  const shop = countDO(await makeBinding());
  const room = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) };
  const env = { mydukapos_kv: kv.kv, LEDGER_DB: d1.db, SHOP_STORE: shop.binding, SYNC_ROOM: room, MEDIA: null, ...(legacy ? LEGACY_ENV : {}) };
  const reset = () => { kv.reset(); d1.reset(); shop.reset(); };
  const call = async (mod, fn, url, { method = 'GET', body, headers = {} } = {}) => {
    const m = await load(mod);
    const req = new Request(url, { method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), headers: { 'content-type': 'application/json', ...headers } });
    return m[fn]({ request: req, env, waitUntil(p) { Promise.resolve(p).catch(() => {}); } });
  };
  return { env, kv, d1, shop, reset, call, kvRaw };
}
export const snapshot = (s) => ({ kv: { get: s.kv.counts.get, put: s.kv.counts.put, list: s.kv.counts.list, delete: s.kv.counts.delete }, d1: { roundTrips: s.d1.counts.roundTrips, statements: s.d1.counts.statements }, do: s.shop.counts.calls });

const URL_SUB = 'https://shopc1.mydukapos.store';
const sale = (id) => ({ id, refNumber: 'R-' + id, timestamp: new Date().toISOString(), paymentMethod: 'cash', cashAmount: 1000, servedBy: 'Jane', items: [{ code: 'A', name: 'Alpha', qty: 2, price: 500, wholesalePrice: 300 }] });

export async function measureAll({ legacy = false } = {}) {
  const out = [];
  const add = (name, s, extra = {}) => out.push({ name, ...snapshot(s), ...extra });

  // --- shop on the per-shop database (every permanent shop) ---
  let s = await setup({ mode: 'do', legacy });
  // first push warms up (schema, moving in) — measured pushes come after
  await s.call('pos-sync.js', 'onRequestPost', URL_SUB + '/api/pos-sync', { method: 'POST', body: { businessName: 'Biz', updatedAt: Date.now(), inventory: [{ code: 'A', name: 'Alpha', qty: 100, price: 500, updatedAt: 1 }] } });
  s.reset();
  let r = await s.call('pos-sync.js', 'onRequestGet', URL_SUB + '/api/pos-sync?since=1');
  const ua = (await r.json()).updatedAt;
  s.reset();
  r = await s.call('pos-sync.js', 'onRequestGet', URL_SUB + '/api/pos-sync?since=' + ua);
  await r.text();
  add('sync poll, nothing changed (GET pos-sync?since=)', s);
  { const { clearLicenseCache } = await load('_license.js'); const { forgetShopMode } = await load('_state-store.js') ; clearLicenseCache?.(s.env); forgetShopMode?.(s.env, 'C1'); s.reset();
    const rc = await s.call('pos-sync.js', 'onRequestGet', URL_SUB + '/api/pos-sync?since=' + ua); await rc.text();
    add('  same poll on a cold Worker instance (first request after it starts)', s); }
  s.reset();
  r = await s.call('pos-sync.js', 'onRequestPost', URL_SUB + '/api/pos-sync', { method: 'POST', body: { businessName: 'Biz', salesLog: [sale('s1')], stockMovementLog: [] } });
  await r.text();
  add('sync push, 1 sale (POST pos-sync)', s);
  const T0 = Date.now();
  const openTabs = () => ({ businessName: 'Biz', tabs: Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, billNo: 'B' + i, openedAt: T0, status: 'OPEN', label: 'T' + i, orders: [] })), bills: Array.from({ length: 100 }, (_, i) => ({ id: 'b' + i, timestamp: new Date(T0).toISOString(), items: [{ code: 'A', qty: 1, price: 10 }] })) });
  s.reset();
  r = await s.call('pos-sync.js', 'onRequestPost', URL_SUB + '/api/pos-sync', { method: 'POST', body: openTabs() });
  await r.text();
  add('sync push, 40 open tabs + 100 bills (first time)', s);
  s.reset();
  r = await s.call('pos-sync.js', 'onRequestPost', URL_SUB + '/api/pos-sync', { method: 'POST', body: openTabs() });
  await r.text();
  add('sync push, same 40 tabs + 100 bills again (unchanged)', s);
  s.reset();
  const changed = openTabs(); changed.tabs[3].orders = [{ id: 'o1', entries: [{ price: 50, qty: 1 }] }]; changed.tabs[3].updatedAt = T0 + 5;
  r = await s.call('pos-sync.js', 'onRequestPost', URL_SUB + '/api/pos-sync', { method: 'POST', body: changed });
  await r.text();
  add('sync push, same list but ONE tab changed', s);
  s.reset();
  r = await s.call('license-status.js', 'onRequestGet', URL_SUB + '/api/license-status');
  await r.text();
  add('licence check (GET license-status, every 30 s per device)', s);

  // --- media ---
  const s2 = await setup({ mode: 'do', legacy });
  const store = new Map();
  s2.env.MEDIA = {
    async put(k, v, o) { store.set(k, { v: new Uint8Array(v), o }); },
    async head(k) { return store.has(k) ? {} : null; },
    async get(k) { const x = store.get(k); return x ? { arrayBuffer: async () => x.v.buffer.slice(x.v.byteOffset, x.v.byteOffset + x.v.byteLength), body: new Blob([x.v]).stream(), httpMetadata: { contentType: 'image/jpeg' }, customMetadata: {}, size: x.v.length, httpEtag: '"abc"', etag: 'abc' } : null; },
    async delete(k) { store.delete(k); },
  };
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(2000).fill(7)]).toString('base64');
  await s2.call('media.js', 'onRequestPost', URL_SUB + '/api/media', { method: 'POST', body: { k: 'p', id: 'p-abcdef123456', dataUrl: jpeg } });
  s2.reset();
  r = await s2.call('media.js', 'onRequestGet', URL_SUB + '/api/media?k=p&id=p-abcdef123456');
  await r.arrayBuffer();
  add('product photo (GET media, per image, per device first view)', s2);

  // --- CRM ---
  const crmH = await import(pathToFileURL(path.join(ROOT, 'tests/crm-harness.mjs')).href);
  const crm = await crmH.makeCrm(legacy ? LEGACY_ENV : {});
  const d1c = countD1(crm.env.LEDGER_DB); crm.env.LEDGER_DB = d1c.db;
  const kvc = countKV(crm.env.mydukapos_kv); crm.env.mydukapos_kv = kvc.kv;
  const st = await crm.staff('Sam', 'sales');
  d1c.reset(); kvc.reset();
  await crm.api('GET', '/leads?limit=25', { token: st.token });
  out.push({ name: 'CRM list leads as staff (GET /api/crm/leads)', kv: { get: kvc.counts.get, put: kvc.counts.put, list: 0, delete: 0 }, d1: { roundTrips: d1c.counts.roundTrips, statements: d1c.counts.statements }, do: 0 });
  d1c.reset(); kvc.reset();
  await crm.api('GET', '/leads?limit=25');
  out.push({ name: 'CRM list leads as owner (GET /api/crm/leads)', kv: { get: kvc.counts.get, put: kvc.counts.put, list: 0, delete: 0 }, d1: { roundTrips: d1c.counts.roundTrips, statements: d1c.counts.statements }, do: 0 });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await measureAll({ legacy: process.argv.includes('--legacy') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('operation'.padEnd(66) + 'KV get/put/list'.padEnd(18) + 'D1 trips/stmts'.padEnd(17) + 'DO calls');
    for (const r of rows) console.log(r.name.padEnd(66) + `${r.kv.get}/${r.kv.put}/${r.kv.list}`.padEnd(18) + `${r.d1.roundTrips}/${r.d1.statements}`.padEnd(17) + r.do);
  }
  process.exit(0);
}
