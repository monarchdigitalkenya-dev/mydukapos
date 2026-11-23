import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 310 Phase 3: the HQ dashboard, consolidated / per-branch reports with CSV, role templates and custom roles. Real org.js against real shop
// databases and the transaction database (the sales come from ledger_sales, as the branches' own reports).
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function business() {
  const kv = makeKV(), shop = await makeBinding(), db = makeD1();
  const env = { mydukapos_kv: kv, LEDGER_DB: db, SHOP_STORE: shop, LICENSE_CACHE_MS: '0', EDGE_CACHE_MS: '0' };
  const lic = (id, slug, extra) => { kv.data.set('license:' + id, { value: JSON.stringify({ id, type: 'permanent', slug, label: slug, branchGroupId: 'G', createdAt: 1, ...extra }) }); kv.data.set('slug:' + slug, { value: id }); kv.data.set('pos-data:mode:' + id, { value: 'do' }); };
  lic('M', 'main', { isMainBranch: true }); lic('B', 'westlands');
  kv.data.set('branch-group:G', { value: JSON.stringify(['M', 'B']) });
  kv.data.set('license-index:v1', { value: JSON.stringify([]) });
  const push = (id, body) => shop.get(id).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body, serverNow: Date.now(), _shop: id }) });
  await push('M', { businessName: 'Biz', adminPwHash: sha('ownerpass'), pwHash: sha('ownerpass'), lowStockThreshold: 5,
    staff: [{ id: 's-otis', name: 'Otis', pinHash: sha('2222'), roles: ['sales-tab'], updatedAt: 1 }, { id: 's-jane', name: 'Jane', pinHash: sha('1111'), roles: ['sales-tab'], updatedAt: 1 }],
    inventory: [{ code: 'SUG', name: 'Sugar', qty: 100, wholesalePrice: 150, updatedAt: 1 }, { code: 'OIL', name: '=Oil', qty: 2, wholesalePrice: 300, updatedAt: 1 }, { code: 'SALT', name: 'Salt', qty: 0, reorderLevel: 10, updatedAt: 1 }] });
  await push('B', { businessName: 'Westlands', staff: [{ id: 's-wanja', name: 'Wanja', pinHash: sha('3333'), roles: ['sales-tab'], updatedAt: 1 }], inventory: [{ code: 'SUG', name: 'Sugar', qty: 8, reorderLevel: 10, wholesalePrice: 150, updatedAt: 1 }] });
  // sales in the transaction database
  const { LEDGER_SCHEMA } = await load('_ledger-schema.js');
  for (const q of LEDGER_SCHEMA) { try { await db.prepare(q).run(); } catch (e) { /* triggers etc. */ } }
  const sale = (cid, id, day, total, cost, status = 'COMPLETED') => db.prepare(`INSERT INTO ledger_sales (client_id, sale_id, ts, business_date, total, cost, cash_amount, status, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`).bind(cid, id, Date.now(), day, total, cost, total, status, Date.now(), Date.now()).run();
  await sale('M', 's1', today, 1000, 600); await sale('M', 's2', today, 500, 300); await sale('B', 's3', today, 200, 150); await sale('B', 's4', today, 999, 1, 'VOIDED');
  const org = await load('org.js');
  const call = async (body, token) => { const res = await org.onRequestPost({ request: new Request('https://main.mydukapos.store/api/org', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'X-HQ-Token': token } : {}) }, body: JSON.stringify(body) }), env, waitUntil() {} }); return { status: res.status, ...(await res.json()) }; };
  const owner = (await call({ action: 'login', proof: sha('ownerpass') })).token;
  const staffAt = async (id) => JSON.parse(await (await shop.get(id).fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text()).staff || [];
  return { env, call, owner, O: (b) => call(b, owner), staffAt };
}

test('dashboard: branches, staff, sales today (completed only), low stock with the till\'s own rule, transfers waiting', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.O({ action: 'inv.settings', save: { approval_mode: 'always' } });
  await b.O({ action: 'xfer.create', fromClient: 'M', toClient: 'B', lines: [{ code: 'SUG', qty: 5 }] });
  const d = (await b.O({ action: 'hq.dashboard' })).dashboard;
  assert.equal(d.branches.total, 2); assert.equal(d.branches.active, 2);
  assert.equal(d.staff, 3);
  assert.equal(d.sales.today, 1700, 'the voided sale is not counted');
  const m = d.byBranch.find((x) => x.clientId === 'M'), w = d.byBranch.find((x) => x.clientId === 'B');
  assert.equal(m.todaySales, 1500); assert.equal(w.todaySales, 200);
  assert.equal(m.low, 2, 'oil (2 <= shop level 5) and salt (0 <= its own 10)'); assert.equal(m.out, 1);
  assert.equal(w.low, 1, 'sugar 8 <= its reorder level 10');
  assert.equal(d.transfers.pending, 1);
  assert.equal(m.stockValue, 100 * 150 + 2 * 300);
});

test('reports: consolidated and per branch, CSV safe for spreadsheets, scope enforced for administrators', { skip: !hasSqlite }, async () => {
  const b = await business();
  const all = await b.O({ action: 'report.sales', clientId: 'all', from: today, to: today, format: 'csv' });
  assert.equal(all.totals.total, 1700); assert.equal(all.totals.perBranch.length, 2);
  assert.match(all.csv, /^Date,Branch,Sales,Total/); assert.equal(all.csv.trim().split('\r\n').length, 3);
  const one = await b.O({ action: 'report.sales', clientId: 'B', from: today, to: today });
  assert.equal(one.totals.total, 200);
  const st = await b.O({ action: 'report.stock', clientId: 'M', format: 'csv' });
  assert.ok(st.csv.includes("'=Oil"), 'a cell that looks like a formula is neutralised');
  assert.equal(st.totals.low, 1); assert.equal(st.totals.out, 1);
  assert.equal((await b.O({ action: 'report.sales', from: '2026-05-02', to: '2026-05-01' })).status, 400);
  // an administrator with reports over Westlands only
  await b.O({ action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['reports.view'], branches: ['B'] });
  const otis = (await b.call({ action: 'login', personId: 's-otis', proof: sha('2222') })).token;
  const mine = await b.call({ action: 'report.sales', clientId: 'all', from: today, to: today }, otis);
  assert.equal(mine.totals.total, 200, 'consolidated = only the branches they manage');
  assert.equal((await b.call({ action: 'report.sales', clientId: 'M' }, otis)).status, 403);
  await b.O({ action: 'admin.save', personId: 's-jane', homeClientId: 'M', perms: ['inventory.manage'], branches: ['*'] });
  const jane = (await b.call({ action: 'login', personId: 's-jane', proof: sha('1111') })).token;
  assert.equal((await b.call({ action: 'report.sales' }, jane)).status, 403, 'no reports permission');
  const jd = (await b.call({ action: 'hq.dashboard' }, jane)).dashboard;
  assert.equal(jd.sales, null, 'no sales figures on the dashboard without the reports permission'); assert.equal(jd.byBranch[0].todaySales, null);
  assert.equal(typeof jd.lowStock, 'number');
  assert.ok((await b.O({ action: 'audit.list' })).audit.some((a) => a.action === 'report.view'));
});

test('roles: templates + custom roles; applied per person per branch; no self-change; managers only by the owner', { skip: !hasSqlite }, async () => {
  const b = await business();
  const lst = await b.O({ action: 'role.list' });
  assert.ok(lst.templates.find((t) => t.key === 'store_keeper'));
  assert.equal((await b.O({ action: 'role.save', name: 'Store keeper', tabs: [] })).status, 400);
  const r = await b.O({ action: 'role.save', name: 'Store keeper', tabs: ['inventory-list-tab', 'stock-take-tab', 'staff-tab'], template: 'store_keeper' });
  assert.equal(r.ok, true); assert.deepEqual(r.role.tabs, ['inventory-list-tab', 'stock-take-tab'], 'the Staff screen is never part of a role');
  assert.equal((await b.O({ action: 'role.save', name: 'store KEEPER', tabs: ['sales-tab'] })).status, 400, 'unique names');
  const mgr = await b.O({ action: 'role.save', name: 'Branch manager', tabs: ['sales-tab', 'reports-tab'], isManager: true });
  // Jane: store keeper at Main; at Westlands (where she also works) she stays a cashier
  await b.O({ action: 'staff.assign', personId: 's-jane', fromClientId: 'M', toClientId: 'B', kind: 'additional', reason: 'weekends' });
  assert.equal((await b.O({ action: 'staff.role', personId: 's-jane', clientId: 'M', roleId: r.role.roleId, reason: 'promoted' })).ok, true);
  const atM = (await b.staffAt('M')).find((s) => s.id === 's-jane'), atB = (await b.staffAt('B')).find((s) => s.id === 's-jane');
  assert.deepEqual(atM.roles, ['inventory-list-tab', 'stock-take-tab']); assert.equal(atM.hqRole, 'Store keeper'); assert.equal(atM.pinHash, sha('1111'), 'PIN kept');
  assert.deepEqual(atB.roles, ['sales-tab'], 'other branch unchanged');
  // a scoped administrator: can apply ordinary roles in scope, never a manager role, never to themselves
  await b.O({ action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['staff.manage'], branches: ['M'] });
  const otis = (await b.call({ action: 'login', personId: 's-otis', proof: sha('2222') })).token;
  assert.equal((await b.call({ action: 'staff.role', personId: 's-otis', clientId: 'M', roleId: r.role.roleId }, otis)).status, 403);
  assert.equal((await b.call({ action: 'staff.role', personId: 's-jane', clientId: 'M', roleId: mgr.role.roleId }, otis)).status, 403);
  assert.equal((await b.call({ action: 'staff.role', personId: 's-wanja', clientId: 'B', roleId: r.role.roleId }, otis)).status, 403, 'out of scope');
  assert.equal((await b.call({ action: 'role.save', name: 'Boss', tabs: ['sales-tab'], isManager: true }, otis)).status, 403);
  assert.equal((await b.O({ action: 'role.archive', roleId: r.role.roleId })).ok, true);
  assert.equal((await b.O({ action: 'role.list' })).roles.length, 1);
  const au = (await b.O({ action: 'audit.list' })).audit.map((a) => a.action);
  for (const x of ['role.create', 'staff.role', 'role.archive']) assert.ok(au.includes(x), x);
});
