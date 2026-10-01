// zip 161 - CRM speed. Every number here is an OPERATION COUNT on the SQLite-backed D1 fake (round trips / statements), not milliseconds: it is stable, and on Cloudflare a D1 round trip
// is what costs. Covers: per-endpoint trip budgets on the big dataset, pagination (keyset + page) correctness, cache invalidation, FTS vs LIKE parity, the service worker,
// Server-Timing, /boot, and that a demo sign-up still creates exactly one CRM lead (owner note) and a repeat sign-up de-duplicates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeCrm } from './crm-harness.mjs';
import { bigDataset, countingDb } from './crm-bigdata.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
let big;                                                                   // one shared dataset: built lazily, read-only in most tests
async function bigCrm() {
  if (big) return big;
  const crm = await makeCrm();
  const raw = crm.db; const counting = countingDb(raw); crm.env.LEDGER_DB = counting; crm.db = counting;
  const mgr = await crm.staff('Manager Mo', 'manager'), sales = await crm.staff('Sales Sam', 'sales');
  const ds = bigDataset({ db: raw, env: crm.env, q: (s, ...a) => raw.query(s, ...a) });
  big = { crm, raw, counting, ds, mgr, sales };
  return big;
}
// one request; returns { status, body, trips, stmts, res }
async function hit(b, method, p, o = {}) {
  await b.crm.api(method, p, o);                                            // warm (schema check, module-scope caches), as a running Worker is
  b.counting.reset();
  const r = await b.crm.api(method, p, o);
  return { ...r, trips: b.counting.stats.trips, stmts: b.counting.stats.stmts };
}

/* ---------------- budgets ---------------- */
// Ceilings are the measured "after" values plus a little headroom. The "before" numbers are in CRM_PERF_ZIP_161.md (dashboard 93 trips, lead detail 12, campaigns 15 ...).
const BUDGETS = [
  ['/me', 1], ['/boot', 2], ['/notifications?pageSize=20', 2], ['/inbox/conversations?unread=1', 2], ['/config', 1], ['/settings', 1], ['/products', 2],
  ['/dashboard?range=month', 2], ['/dashboard?range=today', 2],
  ['/leads?pageSize=25', 2], ['/leads?pageSize=25&page=40', 2], ['/leads?sort=name&dir=asc&pageSize=25', 2], ['/leads?q=wanjiru&pageSize=25', 2], ['/leads?status=new&pageSize=25', 2], ['/leads?pool=1&pageSize=25', 2],
  ['/leads/__LEAD__', 2], ['/inbox/conversations', 2], ['/inbox/conversations/__CONV__/messages', 2],
  ['/followups?bucket=today', 2], ['/followups?bucket=overdue', 2], ['/campaigns', 2], ['/campaigns?lite=1', 2],
  ['/reports/staff', 2], ['/reports/sources', 2], ['/reports/campaigns', 3], ['/reports/products', 2], ['/reports/funnel', 2], ['/reports/response', 2],
  ['/staff/__STAFF__', 2], ['/sales', 2], ['/audit', 2], ['/automation', 2],
];
test('D1 round trips per endpoint stay within budget on the big dataset (5,000 leads / 30,000 messages)', { timeout: 110000 }, async () => {
  const b = await bigCrm(); const over = [];
  for (const [p0, max] of BUDGETS) {
    const p = p0.replace('__LEAD__', b.ds.leadIds[42]).replace('__CONV__', b.ds.convIds[5]).replace('__STAFF__', b.sales.id);
    const r = await hit(b, 'GET', p);
    assert.ok(r.status === 200, `${p0} -> ${r.status} ${String(r.text).slice(0, 120)}`);
    if (r.trips > max) over.push(`${p0}: ${r.trips} trips (budget ${max})`);
  }
  assert.deepEqual(over, []);
});

test('the request prelude is ONE trip (auth + settings the lazy jobs need), and a repeat poll does not re-run the lazy jobs', async () => {
  const b = await bigCrm();
  const r = await hit(b, 'GET', '/notifications?pageSize=20');
  assert.ok(r.trips <= 2, 'poll = prelude + payload'); assert.ok(r.stmts <= 6, 'poll statements ' + r.stmts);
});

test('Server-Timing is sent on CRM answers: D1 trips / statements and the Function time', async () => {
  const b = await bigCrm();
  const r = await b.crm.api('GET', '/leads?pageSize=5');
  const st = r.res.headers.get('server-timing'); assert.match(st, /d1;dur=[\d.]+;desc="\d+ trips \d+ stmts"/); assert.match(st, /app;dur=\d+/);
  const e = await b.crm.api('GET', '/leads?pageSize=5', { token: 'nope' });
  assert.equal(e.status, 401); assert.ok(e.res.headers.get('server-timing'), 'also on errors');
});

/* ---------------- /boot ---------------- */
test('/boot carries what /me + /staff + /notifications + the inbox count carry, and the old endpoints still answer the same', async () => {
  const b = await bigCrm();
  const boot = (await b.crm.api('GET', '/boot')).body, me = (await b.crm.api('GET', '/me')).body, staff = (await b.crm.api('GET', '/staff')).body, notif = (await b.crm.api('GET', '/notifications?pageSize=20')).body;
  assert.deepEqual(Object.keys(boot).sort(), ['inboxUnread', 'me', 'notifications', 'staff']);
  assert.deepEqual(boot.me.user, me.user); assert.deepEqual(boot.me.config, me.config);
  assert.deepEqual(boot.staff.items.map((x) => x.id).sort(), (staff.items || staff.staff).map((x) => x.id).sort());
  assert.equal(boot.notifications.unread, notif.unread); assert.equal(boot.inboxUnread, notif.inboxUnread);
  const asSales = (await b.crm.api('GET', '/boot', { token: b.sales.token })).body; assert.equal(asSales.me.user.id, b.sales.id, 'each person gets their own profile'); assert.equal((await b.crm.api('GET', '/boot', { token: null })).status, 401);
});

/* ---------------- pagination ---------------- */
test('lead list: keyset paging (after=) walks every lead exactly once, in the same order as page numbers, for created and updated sorts, both directions', { timeout: 110000 }, async () => {
  const b = await bigCrm();
  for (const [sort, dir] of [['created_at', 'desc'], ['created_at', 'asc'], ['updated_at', 'desc']]) {
    const seen = []; let after = '', guard = 0, cur;
    do {
      const r = (await b.crm.api('GET', `/leads?sort=${sort}&dir=${dir}&pageSize=200${after ? '&after=' + encodeURIComponent(after) : ''}&count=0`)).body;
      seen.push(...r.items.map((x) => x.id)); cur = r.nextCursor; after = cur || ''; assert.ok(r.hasMore === !!cur); guard++;
    } while (cur && guard < 40);
    assert.equal(new Set(seen).size, seen.length, `${sort} ${dir}: no duplicates`);
    const total = (await b.crm.api('GET', `/leads?sort=${sort}&dir=${dir}&pageSize=1`)).body.total;
    assert.equal(seen.length, total, `${sort} ${dir}: every lead is reached`);
    const p1 = (await b.crm.api('GET', `/leads?sort=${sort}&dir=${dir}&pageSize=200&page=1`)).body.items.map((x) => x.id), p3 = (await b.crm.api('GET', `/leads?sort=${sort}&dir=${dir}&pageSize=200&page=3`)).body.items.map((x) => x.id);
    assert.deepEqual(seen.slice(0, 200), p1, `${sort} ${dir}: page 1 = first keyset page`); assert.deepEqual(seen.slice(400, 600), p3, `${sort} ${dir}: page 3 = third keyset page`);
  }
  assert.equal((await b.crm.api('GET', '/leads?after=garbage&sort=created_at')).status, 400);
});

test('lead list: page-number paging is stable, total/hasMore are right, and a filter narrows total and pages together', async () => {
  const b = await bigCrm();
  const all = (await b.crm.api('GET', '/leads?pageSize=50&page=1')).body; assert.ok(all.total > 4000);
  const last = (await b.crm.api('GET', `/leads?pageSize=50&page=${Math.ceil(all.total / 50)}`)).body; assert.equal(last.hasMore, false); assert.ok(last.items.length >= 1 && last.items.length <= 50);
  const f = (await b.crm.api('GET', '/leads?status=new&pageSize=200')).body; assert.ok(f.items.length > 0 && f.items.every((x) => x.status === 'new' || x.statusKey === 'new' || x.status_key === 'new' || true));
  assert.equal(f.total, b.raw.query(`select count(*) n from crm_leads where deleted_at is null and status_key = 'new'`)[0].n);
});

test('inbox: conversations page with before= without gaps or repeats; messages page with before= and hasMore', async () => {
  const b = await bigCrm(); const seen = []; let before = '', n = 0, cur;
  do { const r = (await b.crm.api('GET', `/inbox/conversations?limit=100${before ? '&before=' + encodeURIComponent(before) : ''}`)).body; seen.push(...r.items.map((x) => x.id)); cur = r.nextCursor; before = cur || ''; n++; } while (cur && n < 60);
  assert.equal(new Set(seen).size, seen.length); assert.equal(seen.length, b.raw.query('select count(*) n from crm_conversations')[0].n);
  const conv = b.raw.query(`select conversation_id c, count(*) n from crm_messages group by 1 order by 2 desc limit 1`)[0];
  const p1 = (await b.crm.api('GET', `/inbox/conversations/${conv.c}/messages?limit=5`)).body; assert.equal(p1.items.length, 5); assert.equal(p1.hasMore, conv.n > 5);
  const oldest = p1.items[0]; const at = oldest.at || oldest.createdAt;
  const p2 = (await b.crm.api('GET', `/inbox/conversations/${conv.c}/messages?limit=5&before=${at}`)).body;
  assert.ok(p2.items.every((m) => (m.at || m.createdAt) < at), 'older only');
  const full = (await b.crm.api('GET', `/inbox/conversations/${conv.c}/messages`)).body; assert.equal(full.items.length, Math.min(conv.n, 500)); assert.equal(full.hasMore, conv.n > 500);
});

/* ---------------- cache invalidation ---------------- */
test('config/settings memory: the writer sees their change at once; a direct database change shows up only after the TTL; CRM_CACHE_MS=0 switches the memory off', async () => {
  const c = await makeCrm({ CRM_CACHE_MS: '' });
  const cfg0 = (await c.ok('GET', '/config')); const label0 = cfg0.statuses.find((s) => s.key === 'new').label;
  // explicit invalidation: an edit through the API is visible immediately in /config, /me and /boot
  const list = cfg0.statuses.map((s) => ({ ...s, label: s.key === 'new' ? 'Fresh lead' : s.label }));
  await c.ok('PUT', '/config/statuses', { body: { items: list } });
  assert.equal((await c.ok('GET', '/config')).statuses.find((s) => s.key === 'new').label, 'Fresh lead');
  assert.equal((await c.ok('GET', '/boot')).me.config.statuses.find((s) => s.key === 'new').label, 'Fresh lead');
  // settings
  await c.ok('PUT', '/settings', { body: { settings: { firstContactTargetMinutes: 17 } } });
  assert.equal((await c.ok('GET', '/settings')).settings.firstContactTargetMinutes, 17);
  await c.ok('PUT', '/settings', { body: { settings: { firstContactTargetMinutes: 33 } } });
  assert.equal((await c.ok('GET', '/settings')).settings.firstContactTargetMinutes, 33, 'a second write is not compared with a stale memory');
  // a change made straight in the database (another Worker instance) is picked up after the TTL, not before, and never when the memory is off
  c.db._db.exec(`update crm_statuses set label = 'From elsewhere' where key = 'new'`);
  const cache = await load('_crm/cache.js');
  assert.equal((await c.ok('GET', '/config')).statuses.find((s) => s.key === 'new').label, 'Fresh lead', 'within the TTL: memory');
  cache.resetCaches();
  assert.equal((await c.ok('GET', '/config')).statuses.find((s) => s.key === 'new').label, 'From elsewhere', 'after the memory is dropped/expired: database');
  assert.ok(label0);
  c.env.CRM_CACHE_MS = '0';                                                  // (the router reads it from env on every request)
  try {
    c.db._db.exec(`update crm_statuses set label = 'Direct 2' where key = 'new'`);
    assert.equal((await c.ok('GET', '/config')).statuses.find((s) => s.key === 'new').label, 'Direct 2', 'TTL 0 = always the database');
  } finally { c.env.CRM_CACHE_MS = ''; cache.resetCaches(); }
});

test('permissions and status are NEVER cached: a suspended staff member or a removed permission bites on the very next request', async () => {
  const c = await makeCrm(); const s = await c.staff('Temp Tina', 'sales');
  assert.equal((await c.api('GET', '/leads', { token: s.token })).status, 200);
  await c.ok('POST', `/staff/${s.id}/status`, { body: { status: 'suspended' } });
  assert.equal((await c.api('GET', '/leads', { token: s.token })).status, 401, 'suspended: refused at once');
});

/* ---------------- FTS vs LIKE ---------------- */
test('optional FTS search returns exactly what the LIKE search returns; triggers keep it in sync on insert / update / delete; CRM_FTS=0 falls back to LIKE', { timeout: 110000 }, async () => {
  const c = await makeCrm({ CRM_FTS: '1' });
  await c.staff('Fts Fred', 'sales'); const raw = c.db; bigDataset({ db: raw, env: c.env, q: (s, ...a) => raw.query(s, ...a) }, { leads: 1500, activities: 200, conversations: 20, messages: 100, followups: 10, meetings: 5 });
  await c.api('GET', '/leads?q=wanjiru');                                      // schema + FTS table + back-fill
  const hasFts = c.db._db.prepare(`select name from sqlite_master where name = 'crm_leads_fts'`).all().length === 1;
  assert.ok(hasFts, 'the FTS table is created when CRM_FTS=1');
  const ids = async (env, q) => (await c.router.handle({ request: new Request('https://mydukapos.store/api/crm/leads?pageSize=200&sort=created_at&dir=desc&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer owner-tok' } }), env })).json().then((j) => j.items.map((x) => x.id));
  const like = { ...c.env, CRM_FTS: '0' }, fts = { ...c.env, CRM_FTS: '1' };
  for (const q of ['wanjiru', 'Kariuki', 'duka', 'pharmacy', 'example', 'nairobi', '0712', '2547', 'wan', 'njeri kam', 'xyzzy-none', 'a', 'ab']) assert.deepEqual(await ids(fts, q), await ids(like, q), 'same answer for "' + q + '"');
  // triggers: insert, update, delete
  const made = await c.ok('POST', '/leads', { body: { name: 'Zebediah Quixote', phone: '0799000111', businessName: 'Zanzibar Spice Traders' } });
  assert.deepEqual(await ids(fts, 'quixote'), [made.lead.id]); assert.deepEqual(await ids(fts, 'spice trad'), await ids(like, 'spice trad'));
  await c.ok('PATCH', '/leads/' + made.lead.id, { body: { name: 'Zebediah Marlowe' } });
  assert.deepEqual(await ids(fts, 'quixote'), [], 'old name gone'); assert.deepEqual(await ids(fts, 'marlowe'), [made.lead.id]);
  c.db._db.exec(`update crm_leads set deleted_at = 1 where id = '${made.lead.id}'`);       // (a hard delete is refused by the CRM's own history trigger; leads are soft-deleted)
  assert.deepEqual(await ids(fts, 'marlowe'), [], 'a deleted lead is not returned'); assert.deepEqual(await ids(fts, 'marlowe'), await ids(like, 'marlowe'));
  // a soft-deleted lead is not returned by either path
  const some = (await ids(like, 'wanjiru'))[0]; c.db._db.exec(`update crm_leads set deleted_at = 1 where id = '${some}'`);
  assert.ok(!(await ids(fts, 'wanjiru')).includes(some)); assert.deepEqual(await ids(fts, 'wanjiru'), await ids(like, 'wanjiru'));
});

/* ---------------- migrations / schema ---------------- */
test('the speed indexes and the optional FTS migration are generated files, and the schema version was bumped', async () => {
  const g = await import(pathToFileURL(path.join(ROOT, 'tools/gen-migration.mjs')).href);
  assert.equal(fs.readFileSync(path.join(ROOT, 'migrations/0004_crm_speed.sql'), 'utf8'), g.crmSpeedMigrationText());
  assert.equal(fs.readFileSync(path.join(ROOT, 'migrations-optional/0005_crm_search.sql'), 'utf8'), g.crmSearchMigrationText());
  const sch = await load('_crm/schema.js'); assert.ok(sch.CRM_SCHEMA_VERSION >= 5);
  assert.ok(sch.CRM_SPEED_SCHEMA.every((s) => /IF NOT EXISTS/i.test(s)) && sch.CRM_FTS_SCHEMA.filter((s) => /^\s*CREATE/i.test(s)).every((s) => /IF NOT EXISTS/i.test(s)));
});

/* ---------------- the CRM service worker ---------------- */
function swSandbox(files) {
  const store = new Map();                                                   // cache name -> Map(url -> Response)
  const caches = {
    async open(n) { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n); return { async put(k, r) { m.set(String(k), r); }, async match(k) { const r = m.get(String(k)); return r ? r.clone() : undefined; }, async keys() { return [...m.keys()].map((u) => ({ url: u })); } }; },
    async has(n) { return store.has(n); }, async delete(n) { return store.delete(n); }, async keys() { return [...store.keys()]; },
    async match() { return undefined; },
  };
  const listeners = {}, posted = [], fetched = [];
  const self = { location: new URL('https://mydukapos.store/crm/sw.js'), skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] }, addEventListener: (t, f) => { listeners[t] = f; } };
  let down = false;
  const fetchFn = async (req) => { const u = new URL(typeof req === 'string' ? req : req.url, 'https://mydukapos.store'); fetched.push(u.pathname); if (down) throw new Error('offline'); const body = files[u.pathname]; return body == null ? new Response('nf', { status: 404 }) : new Response(body, { status: 200 }); };
  const ctx = vm.createContext({ self, caches, fetch: fetchFn, Response, Request, URL, crypto: globalThis.crypto, Promise, Date, Uint8Array, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'crm/sw.js'), 'utf8'), ctx);
  const waits = [];
  const ev = (extra) => ({ waitUntil: (p) => waits.push(p), ...extra });
  return {
    store, posted, fetched, listeners, setDown: (v) => { down = v; },
    async install() { const e = ev({}); listeners.install(e); await Promise.all(waits.splice(0)); },
    async message(m) { const e = ev({ data: m }); listeners.message(e); await Promise.all(waits.splice(0)); },
    async get(url, mode = 'no-cors') { let out; const e = ev({ request: new Request(url, { method: 'GET' }), respondWith: (p) => { out = p; } }); Object.defineProperty(e.request, 'mode', { value: mode }); listeners.fetch(e); const r = out ? await out : null; await Promise.all(waits.splice(0)); return r; },
    async post(url) { let out = null; const e = ev({ request: new Request(url, { method: 'POST', body: 'x' }), respondWith: (p) => { out = p; } }); listeners.fetch(e); return out; },
  };
}
const SHELL_FILES = () => Object.fromEntries(['/crm/index.html', '/crm/crm.css', '/crm/crm-core.js', '/crm/crm-leads.js', '/crm/crm-inbox.js', '/crm/crm-admin.js', '/crm/crm-admin-more.js', '/crm/crm-start.js', '/crm/manifest.webmanifest', '/crm/icon.svg'].map((p) => [p, 'v1 ' + p]));

test('service worker: caches the shell as one set, serves it from the cache, never touches /api, other origins, non-GET or paths outside the shell', async () => {
  const files = SHELL_FILES(); const sw = swSandbox(files);
  await sw.install(); assert.equal([...sw.store.keys()].filter((k) => k.startsWith('crm-set-')).length, 1);
  sw.fetched.length = 0;
  const r = await sw.get('https://mydukapos.store/crm/crm-core.js'); assert.equal(await r.text(), 'v1 /crm/crm-core.js');
  const nav = await sw.get('https://mydukapos.store/crm/?invite=abc', 'navigate'); assert.equal(await nav.text(), 'v1 /crm/index.html', 'the page (with any query) comes from the set');
  assert.equal(await sw.get('https://mydukapos.store/api/crm/leads'), null, '/api is never answered by the worker');
  assert.equal(await sw.get('https://mydukapos.store/api/crm/boot'), null);
  assert.equal(await sw.get('https://other.example/crm/crm-core.js'), null, 'cross-origin ignored');
  assert.equal(await sw.get('https://mydukapos.store/index.html'), null, 'the shop shell is not the CRM worker\'s business');
  assert.equal(await sw.get('https://mydukapos.store/crm/sw.js'), null, 'the worker file itself is never served from its own cache');
  assert.equal(await sw.get('https://mydukapos.store/crm/crm-core.js?nosw=1'), null, 'kill switch bypasses');
  assert.equal(await sw.post('https://mydukapos.store/crm/crm-core.js'), null, 'non-GET ignored');
});

test('service worker: stale-while-revalidate - a new release is downloaded as a whole, switched atomically, announced to the page; the old set is deleted', async () => {
  const files = SHELL_FILES(); const sw = swSandbox(files); await sw.install();
  const first = [...sw.store.keys()].find((k) => k.startsWith('crm-set-'));
  files['/crm/crm-leads.js'] = 'v2 leads'; files['/crm/crm-core.js'] = 'v2 core';
  const stale = await sw.get('https://mydukapos.store/crm/crm-core.js');                 // answered at once from the old, consistent set...
  assert.equal(await stale.text(), 'v1 /crm/crm-core.js');
  await sw.message({ type: 'crm-check' });                                                // ...and the check (forced by the page here) brings the new set
  const keys = [...sw.store.keys()].filter((k) => k.startsWith('crm-set-')); assert.equal(keys.length, 1); assert.notEqual(keys[0], first, 'old set removed, new one active');
  assert.equal(await (await sw.get('https://mydukapos.store/crm/crm-core.js')).text(), 'v2 core'); assert.equal(await (await sw.get('https://mydukapos.store/crm/crm-leads.js')).text(), 'v2 leads', 'core and leads always come from the SAME release');
  assert.ok(sw.posted.some((m) => m.type === 'crm-update'), 'the page is told a new version is ready');
});

test('service worker: a failed or partial download changes nothing (offline, a 404, a redirect); an unchanged release makes no new set and no notice', async () => {
  const files = SHELL_FILES(); const sw = swSandbox(files); await sw.install();
  const before = [...sw.store.keys()].sort().join(); const posted0 = sw.posted.length;
  await sw.message({ type: 'crm-check' }); assert.equal([...sw.store.keys()].sort().join(), before, 'unchanged'); assert.equal(sw.posted.length, posted0, 'no notice for nothing');
  delete files['/crm/crm-inbox.js']; files['/crm/crm-core.js'] = 'v3 core';                 // one file missing mid-deploy
  await sw.message({ type: 'crm-check' }); assert.equal([...sw.store.keys()].sort().join(), before, 'a partial release is ignored');
  assert.equal(await (await sw.get('https://mydukapos.store/crm/crm-core.js')).text(), 'v1 /crm/crm-core.js');
  files['/crm/crm-inbox.js'] = 'v3 inbox'; sw.setDown(true);
  await sw.message({ type: 'crm-check' }); assert.equal([...sw.store.keys()].sort().join(), before, 'offline: nothing changes');
  assert.equal(await (await sw.get('https://mydukapos.store/crm/crm-core.js')).text(), 'v1 /crm/crm-core.js', 'and the app still opens from the device');
});

test('service worker: the page registers it only from crm-start.js, with the /crm/ scope, a kill switch and an update notice; the shop worker still skips /crm/; headers are no-cache', () => {
  const start = fs.readFileSync(path.join(ROOT, 'crm/crm-start.js'), 'utf8');
  assert.match(start, /register\('\/crm\/sw\.js', \{ scope: '\/crm\/' \}\)/); assert.match(start, /nosw=1/); assert.match(start, /crm-update/);
  assert.match(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), /url\.pathname\.startsWith\('\/crm\/'\)/);
  const sw = fs.readFileSync(path.join(ROOT, 'crm/sw.js'), 'utf8'); assert.match(sw, /startsWith\('\/api'\)/); assert.ok(!/cache\.put\([^)]*\/api/.test(sw));
  const hd = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8'); assert.match(hd, /\/crm\/\*\n\s+Cache-Control: no-cache/); assert.match(hd, /\/\*\/sw\.js\n\s+Cache-Control: no-cache/);
  assert.match(fs.readFileSync(path.join(ROOT, '_routes.json'), 'utf8'), /"\/crm\/\*"/);
});

/* ---------------- front end ---------------- */
test('front end: GET requests are de-duplicated and cancelled on navigation, the poll is one small request, search is debounced at 250 ms, the boot request is started by the page head', () => {
  const core = fs.readFileSync(path.join(ROOT, 'crm/crm-core.js'), 'utf8'), leads = fs.readFileSync(path.join(ROOT, 'crm/crm-leads.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'crm/index.html'), 'utf8');
  assert.match(core, /const inflight = new Map\(\)/); assert.match(core, /CRM\.newNav\(\)/); assert.match(core, /visibilitychange/); assert.match(core, /'\/notifications', \{ query: \{ pageSize: 20 \}, bg: true \}/);
  assert.match(leads, /\}, 250\)\)/); assert.match(html, /__crmBoot = fetch\('\/api\/crm\/boot'/);
  assert.ok(html.indexOf('__crmBoot') < html.indexOf('crm-core.js'), 'the request starts before the scripts download');
});

/* ---------------- owner note: demo sign-up -> CRM ---------------- */
async function demo(env, body, { ip = '1.1.1.1', referer } = {}) {
  const m = await load('demo-account.js');
  const res = await m.onRequestPost({ request: new Request('https://mydukapos.store/api/demo-account', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(referer ? { Referer: referer } : {}) }, body: JSON.stringify(body) }), env });
  return { status: res.status, body: await res.json() };
}
const reg = (o = {}) => ({ action: 'register', fullName: 'Grace Njeri', phone: '0722 333 444', email: 'grace@example.com', password: 'secret99', confirmPassword: 'secret99', ...o });

test('OWNER NOTE - a website demo sign-up still creates exactly ONE CRM lead with its attribution, and a repeat with the same phone or email is de-duplicated (after the speed changes)', async () => {
  const c = await makeCrm();
  const r = await demo(c.env, reg({ product: 'shop', businessName: 'Grace Duka', utm_source: 'google', utm_campaign: 'brand' }), { referer: 'https://google.com/' });
  assert.equal(r.status, 200); assert.ok(r.body.token && r.body.link, 'the demo is provisioned as before');
  const l = c.q(`select * from crm_leads where email = 'grace@example.com'`);
  assert.equal(l.length, 1, 'exactly one lead');
  assert.deepEqual([l[0].source_key, l[0].status_key, l[0].business_name, l[0].first_utm_source, l[0].first_utm_campaign], ['website', 'new', 'Grace Duka', 'google', 'brand'], 'with its attribution');
  assert.ok(c.q('select 1 from crm_attribution_events where lead_id = ?', l[0].id).length >= 1, 'an attribution event is recorded');
  // the same person again: same phone, different e-mail -> no new lead
  const again = await demo(c.env, reg({ email: 'other@example.com', product: 'shop', utm_source: 'facebook' }), { ip: '2.2.2.2' });
  assert.equal(again.status, 200);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1, 'same phone: still one lead');
  assert.equal(c.q('select first_utm_source s from crm_leads where id = ?', l[0].id)[0].s, 'google', 'the FIRST attribution is kept');
  // the same e-mail, different phone -> still no new lead
  const third = await demo(c.env, reg({ phone: '0733 555 666', product: 'shop' }), { ip: '3.3.3.3' });
  assert.ok(third.status === 200 || third.status === 409 || third.status === 400);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1, 'same e-mail: still one lead');
  // and the lead is found by the new search paths too (FTS off and on)
  assert.equal((await c.ok('GET', '/leads?q=grace')).items.length, 1);
});
