// zip 162 - CRM leftovers: the staff profile is 2 round trips, the Sales / Inbox / Leads screens USE the paging the API already had (50 per page + "Load more",
// infinite scroll with a button fallback on the lead list), and crm-admin-more.js (reports, staff, settings, audit) is fetched only when one of those screens opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { makeCrm } from './crm-harness.mjs';
import { bigDataset, countingDb } from './crm-bigdata.mjs';
import { makeStub } from './crm-ui-stub.mjs';
import { bootCrm } from './crm-ui-boot.mjs';

const OWNER = { pos_owner_session_token: 'o2.tok', crm_mode: 'owner' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- server ---------------- */
let shared;
async function small() {
  if (shared) return shared;
  const crm = await makeCrm(); const raw = crm.db; const counting = countingDb(raw); crm.env.LEDGER_DB = counting; crm.db = counting;
  const mgr = await crm.staff('Manager Mo', 'manager'), sales = await crm.staff('Sales Sam', 'sales');
  const ds = bigDataset({ db: raw, env: crm.env, q: (s, ...a) => raw.query(s, ...a) }, { leads: 600, activities: 100, conversations: 130, messages: 260, followups: 10, meetings: 5 });
  // 130 sales that share ONE sold_at (ties across the page boundary) + the ones the dataset made
  const ins = raw._db.prepare(`INSERT INTO crm_sales (id, lead_id, product_id, product_label, quantity, unit_price, discount, total, payment_status, amount_paid, closed_by, closed_by_name, source_key, sold_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const lead = raw.query('select id from crm_leads limit 1')[0].id, prod = raw.query('select id from crm_products limit 1')[0].id, owner = crm.ownerId, T = Date.now() - 86400000;
  raw._db.exec('PRAGMA foreign_keys = OFF');
  for (let i = 0; i < 130; i++) ins.run('tie' + String(i).padStart(3, '0'), lead, prod, 'Tie product', 1, 100, 0, 100, 'unpaid', 0, owner, 'Owner', 'website', T, T, T);
  // conversations that never had a message (last_message_at NULL) - they sort last
  const ic = raw._db.prepare(`INSERT INTO crm_conversations (id, channel, wa_id, contact_name, lead_id, last_message_at, last_message_text, last_direction, unread_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 70; i++) ic.run('nul' + String(i).padStart(3, '0'), 'whatsapp', '25470' + String(1000000 + i), 'Empty ' + i, null, null, null, null, 0, T);
  shared = { crm, raw, counting, ds, mgr, sales };
  return shared;
}

test('staff profile: 2 round trips in all (was 6), same answer, a permission change is visible on the very next request', { timeout: 60000 }, async () => {
  const b = await small();
  const get = async (id, o) => { await b.crm.api('GET', `/staff/${id}`, o); b.counting.reset(); const r = await b.crm.api('GET', `/staff/${id}`, o); return { ...r, trips: b.counting.stats.trips }; };
  const r = await get(b.sales.id);
  assert.equal(r.status, 200); assert.ok(r.trips <= 2, 'trips ' + r.trips);
  assert.equal(r.body.user.id, b.sales.id); assert.ok(Array.isArray(r.body.user.perms) && r.body.user.perms.includes('leads.view'));
  assert.deepEqual(Object.keys(r.body.user.overrides).sort(), ['deny', 'grant']);
  for (const k of ['leadsOwned', 'openLeads', 'lostLeads', 'contactAttempts', 'followupsOpen', 'meetings', 'dealsClosed', 'revenue']) assert.ok(k in r.body.stats, k);
  assert.ok((await get(b.ownerId || b.crm.ownerId)).trips <= 2, 'the owner profile too');
  assert.equal((await b.crm.api('GET', '/staff/does-not-exist')).status, 404);
  // an override written through the API shows at once
  await b.crm.ok('PUT', `/staff/${b.sales.id}/permissions`, { body: { grant: ['reports.team'], deny: [] } });
  const r2 = await get(b.sales.id); assert.ok(r2.body.user.perms.includes('reports.team')); assert.deepEqual(r2.body.user.overrides.grant, ['reports.team']);
  // the viewer without staff.view can only see their own
  assert.equal((await b.crm.api('GET', `/staff/${b.mgr.id}`, { token: b.sales.token })).status, 403);
  assert.equal((await b.crm.api('GET', `/staff/${b.sales.id}`, { token: b.sales.token })).status, 200);
});

test('GET /sales pages with limit + before: every sale exactly once, same order as the full list, totals on every page, ties at the same sold_at are not lost', { timeout: 60000 }, async () => {
  const b = await small();
  const full = (await b.crm.api('GET', '/sales')).body;
  assert.ok(full.items.length >= 130); assert.equal(full.hasMore, false); assert.equal(full.nextCursor, null);
  const seen = []; let before = '', pages = 0, cur, totals0;
  do {
    const r = (await b.crm.api('GET', `/sales?limit=50${before ? '&before=' + encodeURIComponent(before) : ''}`)).body;
    assert.ok(r.items.length <= 50); seen.push(...r.items.map((x) => x.id)); cur = r.nextCursor; before = cur || ''; pages++;
    assert.equal(r.hasMore, !!cur); if (!totals0) totals0 = r.totals; assert.deepEqual(r.totals, totals0, 'the totals describe the whole period on every page');
  } while (cur && pages < 40);
  assert.ok(pages >= 3); assert.deepEqual(seen, full.items.map((x) => x.id), 'same rows, same order');
  assert.equal(new Set(seen).size, seen.length); assert.equal(totals0.count, full.items.length);
  assert.equal((await b.crm.api('GET', '/sales?limit=50&before=garbage')).status, 200, 'a malformed cursor just means the first page');
});

test('GET /inbox/conversations pages with limit + before through the never-messaged tail too (no repeats, no endless loop)', { timeout: 60000 }, async () => {
  const b = await small();
  const total = b.raw.query('select count(*) n from crm_conversations')[0].n;
  const seen = []; let before = '', n = 0, cur;
  do { const r = (await b.crm.api('GET', `/inbox/conversations?limit=40${before ? '&before=' + encodeURIComponent(before) : ''}`)).body; seen.push(...r.items.map((x) => x.id)); cur = r.nextCursor; before = cur || ''; n++; } while (cur && n < 40);
  assert.ok(n < 40, 'it ends'); assert.equal(new Set(seen).size, seen.length, 'no repeats'); assert.equal(seen.length, total, 'every conversation is reached');
  assert.ok(seen.slice(-70).every((id) => id.startsWith('nul')), 'the never-messaged ones come last');
});

/* ---------------- screens ---------------- */
const sale = (i) => ({ id: 's' + i, leadId: 'L2', leadName: 'Lead ' + i, productLabel: 'Product', quantity: 1, total: 100 + i, closedByName: 'Staff', paymentStatus: 'paid', soldAt: 2e12 - i * 1000 });
function salesStub(N = 120) {
  const all = Array.from({ length: N }, (_, i) => sale(i)); const seen = [];
  const handler = ({ p, q, json }) => {
    if (p !== '/sales') return null;
    seen.push({ ...q });
    const limit = Number(q.limit || 1000); let start = 0; if (q.before) start = all.findIndex((s) => s.id === q.before) + 1;
    const items = all.slice(start, start + limit); const more = start + limit < all.length;
    return json(200, { items, totals: { count: N, revenue: all.reduce((a, s) => a + s.total, 0) }, hasMore: more, nextCursor: more ? items[items.length - 1].id : null });
  };
  return { handler, seen, N };
}

test('Sales screen: the list shows 50, "Load more" adds the next 50 (using the cursor) until everything is shown; the "by ..." tabs still add up the whole period', { timeout: 30000 }, async () => {
  const s = salesStub(); const stub = makeStub({ handler: s.handler });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/sales' });
  await b.until(() => b.q('table.t tbody tr'));
  assert.equal(b.qa('table.t tbody tr').length, 50); assert.match(b.text(), /Showing 50 of 120 sales/);
  assert.equal(s.seen[0].limit, '50', 'asked for 50 rows');
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('table.t tbody tr').length === 100);
  assert.equal(s.seen[1].before, 's49'); assert.match(b.text(), /Showing 100 of 120 sales/);
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('table.t tbody tr').length === 120);
  assert.ok(!b.byText('.loadmore button', 'Load more'), 'nothing more to load'); assert.match(b.text(), /Showing 120 of 120 sales/);
  b.click(b.byText('button', 'By staff') || b.byText('[role=tab]', 'By staff')); await b.until(() => s.seen.length >= 4);
  assert.equal(s.seen[s.seen.length - 1].limit, undefined, 'a grouped tab adds up every sale, so it does not page');
  assert.deepEqual(b.errors, []); b.close();
});

function inboxStub(N = 120) {
  const all = Array.from({ length: N }, (_, i) => ({ id: 'cv' + i, name: 'Chat ' + i, phone: '2547' + i, lastMessage: 'hi ' + i, lastAt: 2e12 - i * 1000, unread: 0 })); const seen = [];
  const handler = ({ p, q, json }) => {
    if (p !== '/inbox/conversations') return null;
    seen.push({ ...q }); const limit = Number(q.limit || 200); let start = 0; if (q.before) start = all.findIndex((c) => c.id === q.before) + 1;
    const items = all.slice(start, start + limit); const more = start + limit < all.length;
    return json(200, { items, apiConfigured: false, nextCursor: more ? items[items.length - 1].id : null });
  };
  return { handler, seen };
}
test('Inbox: the conversation list shows 50, "Load more" appends the next 50 without losing the open chat list, and a search starts again from the first page', { timeout: 30000 }, async () => {
  const s = inboxStub(); const stub = makeStub({ handler: s.handler });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/inbox' });
  await b.until(() => b.qa('.convs .conv').length === 50); assert.equal(s.seen[0].limit, '50');
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('.convs .conv').length === 100); assert.ok(s.seen.some((c) => c.before === 'cv49' && c.limit === '50'), 'the cursor of the last row shown was sent');
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('.convs .conv').length === 120); assert.ok(!b.byText('.loadmore button', 'Load more'));
  b.type(b.q('input[type=search]'), 'Chat'); await b.until(() => s.seen.some((c) => c.q === 'Chat')); await b.until(() => b.qa('.convs .conv').length === 50);
  assert.equal(s.seen.find((c) => c.q === 'Chat').before, undefined, 'a new search is a new first page');
  assert.deepEqual(b.errors, []); b.close();
});

function leadsStub(N = 80) {
  const all = Array.from({ length: N }, (_, i) => ({ id: 'L' + (1000 + i), name: 'Lead ' + String(i).padStart(3, '0'), phone: '07' + (10000000 + i), status: 'new', ownerId: 'u1', ownerName: 'Wanjiru', source: 'whatsapp', createdAt: 2e12 - i * 1000 })); const seen = [];
  const handler = ({ p, q, json }) => {
    if (p !== '/leads') return null;
    seen.push({ ...q }); const size = Number(q.pageSize || 25); let start, total = all.length;
    if (q.after) start = all.findIndex((l) => l.id === q.after) + 1; else start = (Number(q.page || 1) - 1) * size;
    const items = all.slice(start, start + size); const more = start + size < all.length;
    const keyset = ['created', 'created_at', 'updated', 'updated_at'].includes(q.sort);
    return json(200, { items, total: q.count === '0' || q.after ? null : total, page: Number(q.page || 1), pageSize: size, hasMore: more, nextCursor: more && keyset ? items[items.length - 1].id : null });
  };
  return { handler, seen };
}
class FakeIO { constructor(cb) { this.cb = cb; FakeIO.all.push(this); this.targets = []; } observe(el) { this.targets.push(el); } disconnect() { this.dead = true; } unobserve() {} }
FakeIO.all = [];

test('Leads: sorted by Created the list scrolls - the bottom coming into view loads the next 25 with after=<cursor>&count=0; the button does the same; other sorts keep page numbers', { timeout: 40000 }, async () => {
  const s = leadsStub(); const stub = makeStub({ handler: s.handler });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/dashboard' });
  b.w.IntersectionObserver = FakeIO; FakeIO.all.length = 0;
  b.go('#/leads'); await b.until(() => b.qa('table.t tbody tr').length === 25);
  assert.match(b.text(), /Showing 25 of 80 leads/); assert.equal(s.seen[0].after, undefined); assert.ok(!b.q('.pager'), 'no page numbers while it scrolls');
  const io = FakeIO.all.filter((o) => !o.dead).pop(); assert.ok(io && io.targets.length === 1, 'the bottom is watched');
  io.cb([{ isIntersecting: false }]); await sleep(50); assert.equal(s.seen.length, 1, 'not visible: nothing is loaded');
  io.cb([{ isIntersecting: true }]); await b.until(() => b.qa('table.t tbody tr').length === 50);
  const more = s.seen[1]; assert.equal(more.after, 'L1024'); assert.equal(more.count, '0');
  assert.equal(b.qa('table.t tbody tr')[25].textContent.includes('Lead 025'), true, 'appended after the first page, in order');
  const io2 = FakeIO.all.filter((o) => !o.dead).pop(); io2.cb([{ isIntersecting: true }]); io2.cb([{ isIntersecting: true }]);          // a double trigger loads ONE page
  await b.until(() => b.qa('table.t tbody tr').length === 75); await sleep(80); assert.equal(s.seen.filter((c) => c.after).length, 2);
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('table.t tbody tr').length === 80);
  assert.ok(!b.byText('.loadmore button', 'Load more'), 'the end'); assert.match(b.text(), /Showing 80( of 80)? leads/);
  // another sort: page numbers, no keyset
  b.click(b.byText('th.sortable', 'Name')); await b.until(() => b.q('.pager') || b.qa('table.t tbody tr').length <= 25);
  await b.until(() => s.seen[s.seen.length - 1].sort === 'name'); const last = s.seen[s.seen.length - 1]; assert.equal(last.after, undefined); assert.equal(last.page, '1');
  assert.deepEqual(b.errors, []); b.close();
});

test('Leads: without IntersectionObserver the "Load more" button is the way (old browsers), and selecting rows / cards still works on loaded rows', { timeout: 30000 }, async () => {
  const s = leadsStub(60); const stub = makeStub({ handler: s.handler });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' });
  await b.until(() => b.qa('table.t tbody tr').length === 25);
  b.click(b.byText('.loadmore button', 'Load more')); await b.until(() => b.qa('table.t tbody tr').length === 50);
  const boxes = b.qa('table.t tbody input[type=checkbox]'); b.click(boxes[30]); await b.until(() => /1 selected/.test(b.text()));
  assert.deepEqual(b.errors, []); b.close();
});

/* ---------------- lazy admin ---------------- */
test('crm-admin-more.js: not fetched for the dashboard / leads / inbox / sales; fetched ONCE on the first Reports / Team / Settings / Audit visit; the menu is unchanged', { timeout: 40000 }, async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/dashboard' });
  await b.until(() => b.q('.kpis'));
  assert.ok(b.w.CRM.adminKit && !b.w.CRM.adminMore, 'the shared helpers are there, the big part is not');
  for (const h of ['#/leads', '#/sales', '#/inbox', '#/products']) { b.go(h); await sleep(150); }
  assert.equal((b.w.__lazyLoads || []).length, 0, 'nothing lazy was requested');
  const labels = b.qa('.side .navlink').map((a) => a.textContent.trim()); for (const l of ['Dashboard', 'Reports', 'Team', 'Settings', 'Audit log']) assert.ok(labels.some((x) => x.includes(l)), l + ' is still in the menu');
  b.go('#/settings'); await b.until(() => b.w.CRM.adminMore && /Settings/.test(b.text()) && b.q('.tabs, [role=tablist], .card'));
  assert.deepEqual(b.w.__lazyLoads, ['crm-admin-more.js']);
  b.go('#/staff'); await b.until(() => /Olivia|Otieno|Team|Invite|Add staff/i.test(b.text()));
  b.go('#/reports'); await sleep(200); b.go('#/audit'); await sleep(200);
  assert.deepEqual(b.w.__lazyLoads, ['crm-admin-more.js'], 'fetched once, reused by every later screen');
  assert.deepEqual(b.errors, []); b.close();
});

test('crm-admin-more.js: opening Settings straight from a bookmark works, and a failed fetch shows a retry instead of a blank page', { timeout: 40000 }, async () => {
  const b = await bootCrm({ stub: makeStub(), storage: OWNER, hash: '#/settings' });
  await b.until(() => b.w.CRM.adminMore && b.qa('.card, .tabs').length); assert.deepEqual(b.errors, []);
  b.close();
  const b2 = await bootCrm({ stub: makeStub(), storage: OWNER, hash: '#/dashboard' }); await b2.until(() => b2.q('.kpis'));
  const real = b2.w.HTMLHeadElement.prototype.appendChild;
  b2.w.HTMLHeadElement.prototype.appendChild = function (el) { if (el && el.tagName === 'SCRIPT') { setTimeout(() => el.onerror && el.onerror(new Error('offline')), 5); return el; } return real.call(this, el); };
  b2.go('#/reports'); await b2.until(() => /could not be loaded/i.test(b2.text()) && b2.byText('button', 'Try again') || b2.byText('button', 'Retry'));
  b2.w.HTMLHeadElement.prototype.appendChild = real;                                 // back online
  b2.click(b2.byText('button', 'Try again') || b2.byText('button', 'Retry')); await b2.until(() => b2.w.CRM.adminMore);
  b2.close();
});

test('service worker + page: the lazy file is part of the cached set, answers carry X-Crm-Set, and a page started on an older set reloads once instead of mixing releases', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'crm/sw.js'), 'utf8'), core = fs.readFileSync(path.join(ROOT, 'crm/crm-core.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'crm/index.html'), 'utf8');
  assert.match(sw, /SW_VERSION = 'crm-sw-2'/); assert.match(sw, /'\/crm\/crm-admin-more\.js'/); assert.match(sw, /X-Crm-Set/); assert.match(sw, /stamped\(hit, name\)/);
  assert.match(core, /X-Crm-Set/); assert.match(core, /crm_reloaded_for/); assert.match(core, /crm-admin-more\.js/);
  assert.ok(!/crm-admin-more/.test(html), 'the page does not load it up front');
  for (const f of ['crm-core.js', 'crm-leads.js', 'crm-inbox.js', 'crm-admin.js', 'crm-admin-more.js']) assert.ok(fs.existsSync(path.join(ROOT, 'crm', f)), f);
  const eager = fs.statSync(path.join(ROOT, 'crm/crm-admin.js')).size, lazy = fs.statSync(path.join(ROOT, 'crm/crm-admin-more.js')).size; assert.ok(lazy > eager, 'the bigger part is the lazy one');
});
