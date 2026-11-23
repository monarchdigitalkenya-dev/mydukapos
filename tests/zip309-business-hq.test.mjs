import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 309: Business HQ - branches, staff across branches, HQ administrators, audit. The REAL org.js / branches.js against the real shop databases
// (ShopStore on SQLite) and the transaction database (D1 fake on SQLite). Every check the brief asks for that this phase covers.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

async function business() {
  const kv = makeKV(), shop = await makeBinding();
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), SHOP_STORE: shop, LICENSE_CACHE_MS: '0', EDGE_CACHE_MS: '0' };
  const G = 'GRP1';
  const lic = (id, slug, extra) => { kv.data.set('license:' + id, { value: JSON.stringify({ id, type: 'permanent', slug, label: slug, branchGroupId: G, createdAt: 1, ...extra }) }); kv.data.set('slug:' + slug, { value: id }); kv.data.set('pos-data:mode:' + id, { value: 'do' }); };
  lic('M', 'main', { isMainBranch: true }); lic('B', 'westlands'); lic('T', 'thika');
  kv.data.set('branch-group:' + G, { value: JSON.stringify(['M', 'B', 'T']) });
  kv.data.set('license-index:v1', { value: JSON.stringify([]) });
  const push = (id, body) => shop.get(id).fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body, serverNow: Date.now(), _shop: id }) });
  await push('M', { businessName: 'Biz', adminPwHash: sha('ownerpass'), pwHash: sha('ownerpass'), staff: [
    { id: 's-jane', name: 'Jane', pinHash: sha('1111'), roles: ['sales-tab'], updatedAt: 1 },
    { id: 's-otis', name: 'Otis', pinHash: sha('2222'), roles: ['sales-tab', 'inventory-tab'], isManager: true, updatedAt: 1 }] });
  await push('B', { businessName: 'Westlands', staff: [{ id: 's-wanja', name: 'Wanja', pinHash: sha('3333'), roles: ['sales-tab'], updatedAt: 1 }] });
  await push('T', { businessName: 'Thika', staff: [] });
  const org = await load('org.js');
  const call = async (slug, body, token) => {
    const res = await org.onRequestPost({ request: new Request(`https://${slug}.mydukapos.store/api/org`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'X-HQ-Token': token } : {}) }, body: JSON.stringify(body) }), env, waitUntil() {} });
    return { status: res.status, ...(await res.json()) };
  };
  const staffAt = async (id) => JSON.parse(await (await shop.get(id).fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text()).staff || [];
  const owner = (await call('main', { action: 'login', proof: sha('ownerpass') })).token;
  return { env, kv, shop, call, staffAt, owner, push };
}

test('owner sign-in: only the main branch\'s management password; everything else is denied by default', { skip: !hasSqlite }, async () => {
  const b = await business();
  assert.ok(b.owner, 'owner signed in');
  assert.equal((await b.call('main', { action: 'login', proof: sha('wrong') })).status, 401);
  assert.equal((await b.call('main', { action: 'overview' })).status, 401, 'no token, no HQ');
  assert.equal((await b.call('main', { action: 'overview' }, 'h1.forged.sig')).status, 401);
  const o = await b.call('westlands', { action: 'overview' }, b.owner);
  assert.equal(o.status, 200, 'the owner token works from any branch of the business');
  assert.deepEqual(o.branches.map((x) => x.clientId).sort(), ['B', 'M', 'T']);
  // a staff/device token of the shop can never pass as an HQ token
  const staffTok = 's1.' + Buffer.from(JSON.stringify({ c: 'M', sid: 'hq-owner' })).toString('base64url') + '.00';
  assert.equal((await b.call('main', { action: 'overview' }, staffTok)).status, 401);
});

test('branches: profile with a unique code, suspend keeps history and stops the branch, the main branch cannot be suspended', { skip: !hasSqlite }, async () => {
  const b = await business();
  assert.equal((await b.call('main', { action: 'branch.save', clientId: 'B', code: 'wld', name: 'Westlands', location: 'Westlands, Nairobi' }, b.owner)).ok, true);
  const dup = await b.call('main', { action: 'branch.save', clientId: 'T', code: 'WLD', name: 'Thika' }, b.owner);
  assert.equal(dup.status, 400); assert.match(dup.error, /already used by Westlands/);
  assert.equal((await b.call('main', { action: 'branch.status', clientId: 'M', status: 'suspended', reason: 'x' }, b.owner)).status, 400);
  assert.equal((await b.call('main', { action: 'branch.status', clientId: 'B', status: 'suspended' }, b.owner)).status, 400, 'a reason is required');
  assert.equal((await b.call('main', { action: 'branch.status', clientId: 'B', status: 'suspended', reason: 'renovation' }, b.owner)).ok, true);
  const lic = await load('_license.js');
  assert.equal(lic.evaluateLicense(JSON.parse(b.kv.data.get('license:B').value)).reason, 'branch_suspended', 'the branch stops syncing / opening');
  assert.equal((await b.staffAt('B')).length, 1, 'nothing deleted');
  await b.call('main', { action: 'branch.status', clientId: 'B', status: 'active' }, b.owner);
  assert.equal(lic.evaluateLicense(JSON.parse(b.kv.data.get('license:B').value)).valid, true);
  const audit = (await b.call('main', { action: 'audit.list' }, b.owner)).audit.map((a) => a.action);
  for (const x of ['branch.profile', 'branch.suspend', 'branch.activate']) assert.ok(audit.includes(x), x);
});

test('staff: one person, several branches; a permanent move removes them at the old branch WITHOUT a duplicate, and sync cannot bring them back', { skip: !hasSqlite }, async () => {
  const b = await business();
  let r = await b.call('main', { action: 'staff.assign', personId: 's-jane', fromClientId: 'M', toClientId: 'B', kind: 'additional', reason: 'covers weekends' }, b.owner);
  assert.equal(r.ok, true);
  assert.ok((await b.staffAt('B')).find((s) => s.id === 's-jane' && !s.removed), 'Jane now works at Westlands too');
  assert.ok((await b.staffAt('M')).find((s) => s.id === 's-jane' && !s.removed), '... and still at Main');
  const people = (await b.call('main', { action: 'staff.list' }, b.owner)).people;
  const jane = people.filter((p) => p.personId === 's-jane');
  assert.equal(jane.length, 1, 'one person, not two');
  assert.deepEqual(jane[0].branches.filter((x) => x.active).map((x) => x.clientId).sort(), ['B', 'M']);
  assert.ok(!JSON.stringify(people).includes(sha('1111')), 'the PIN hash is never sent to HQ');
  // permanent move Otis Main -> Thika
  r = await b.call('main', { action: 'staff.assign', personId: 's-otis', fromClientId: 'M', toClientId: 'T', kind: 'permanent', reason: 'new manager for Thika' }, b.owner);
  assert.equal(r.ok, true); assert.equal(r.partial, null);
  assert.ok((await b.staffAt('T')).find((s) => s.id === 's-otis' && !s.removed && s.isManager));
  const atMain = (await b.staffAt('M')).find((s) => s.id === 's-otis');
  assert.equal(atMain.removed, true, 'marked removed at Main (kept, not deleted)');
  // a device at Main that still holds the old copy pushes it: the newer removal wins
  await b.push('M', { staff: [{ id: 's-otis', name: 'Otis', pinHash: sha('2222'), roles: ['sales-tab'], isManager: true, updatedAt: 5 }] });
  assert.equal((await b.staffAt('M')).find((s) => s.id === 's-otis').removed, true, 'a stale device cannot bring him back');
  assert.equal((await b.call('main', { action: 'staff.assign', personId: 's-jane', fromClientId: 'M', toClientId: 'B', kind: 'additional' }, b.owner)).status, 400, 'already works there');
});

test('temporary assignment ends by itself after its end date; deactivation removes the person everywhere and ends their HQ access', { skip: !hasSqlite }, async () => {
  const b = await business();
  const endsAt = Date.now() + 2 * 3600000;
  assert.equal((await b.call('main', { action: 'staff.assign', personId: 's-wanja', fromClientId: 'B', toClientId: 'T', kind: 'temporary', endsAt }, b.owner)).ok, true);
  assert.ok((await b.staffAt('T')).find((s) => s.id === 's-wanja' && !s.removed));
  // the end date passes
  const db = b.env.LEDGER_DB;
  await db.prepare("UPDATE org_assignment SET ends_at = ? WHERE person_id = 's-wanja' AND kind = 'temporary'").bind(Date.now() - 1000).run();
  await b.call('main', { action: 'overview' }, b.owner);
  assert.equal((await b.staffAt('T')).find((s) => s.id === 's-wanja').removed, true, 'expired: removed at Thika');
  assert.ok((await b.staffAt('B')).find((s) => s.id === 's-wanja' && !s.removed), 'still at home branch');
  // make Jane an HQ admin, then deactivate her
  assert.equal((await b.call('main', { action: 'admin.save', personId: 's-jane', homeClientId: 'M', perms: ['staff.assign'], branches: ['*'] }, b.owner)).ok, true);
  const jt = (await b.call('main', { action: 'login', personId: 's-jane', proof: sha('1111') })).token;
  assert.ok(jt);
  assert.equal((await b.call('main', { action: 'staff.deactivate', personId: 's-jane' }, b.owner)).status, 400, 'reason required');
  const d = await b.call('main', { action: 'staff.deactivate', personId: 's-jane', reason: 'left the company' }, b.owner);
  assert.equal(d.ok, true);
  assert.equal((await b.staffAt('M')).find((s) => s.id === 's-jane').removed, true);
  assert.equal((await b.call('main', { action: 'staff.list' }, jt)).status, 403, 'her HQ session stops at once');
  const audit = (await b.call('main', { action: 'audit.list' }, b.owner)).audit.map((a) => a.action);
  for (const x of ['staff.assign.temporary', 'staff.temporary.expired', 'admin.add', 'staff.deactivate']) assert.ok(audit.includes(x), x);
});

test('delegated administrators: only the permissions and branches given; cannot raise their own rights, manage admins, or change themselves', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.call('main', { action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['staff.assign', 'branches.manage'], branches: ['M', 'B'] }, b.owner);
  const t = (await b.call('main', { action: 'login', personId: 's-otis', proof: sha('2222') })).token;
  assert.equal((await b.call('main', { action: 'login', personId: 's-otis', proof: sha('9999') })).status, 401, 'wrong PIN');
  const ov = await b.call('main', { action: 'overview' }, t);
  assert.deepEqual(ov.branches.map((x) => x.clientId).sort(), ['B', 'M'], 'Thika is not in his scope, so not even listed');
  assert.equal((await b.call('main', { action: 'branch.save', clientId: 'T', code: 'THK', name: 'Thika' }, t)).status, 403, 'another branch by changing the id: refused');
  assert.equal((await b.call('main', { action: 'staff.assign', personId: 's-wanja', fromClientId: 'B', toClientId: 'T', kind: 'additional' }, t)).status, 403);
  assert.equal((await b.call('main', { action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['staff.assign', 'branches.manage', 'audit.view'], branches: ['*'] }, t)).status, 403, 'cannot grant himself more');
  assert.equal((await b.call('main', { action: 'staff.deactivate', personId: 's-otis', reason: 'x' }, t)).status, 403);
  assert.equal((await b.call('main', { action: 'staff.assign', personId: 's-otis', fromClientId: 'M', toClientId: 'B', kind: 'additional' }, t)).status, 403, 'cannot change his own assignment');
  assert.equal((await b.call('main', { action: 'audit.list' }, t)).status, 403, 'no audit permission given');
  assert.equal((await b.call('main', { action: 'staff.assign', personId: 's-jane', fromClientId: 'M', toClientId: 'B', kind: 'additional' }, t)).ok, true, 'what he WAS given works');
  // the owner narrows his rights: the next request already follows the new rights (no new sign-in needed)
  await b.call('main', { action: 'admin.save', personId: 's-otis', homeClientId: 'M', perms: ['branches.manage'], branches: ['M'] }, b.owner);
  assert.equal((await b.call('main', { action: 'staff.list' }, t)).status, 403, 'staff permission removed: refused at once');
  // his PIN changes at his branch: his HQ session ends
  await b.push('M', { staff: [{ id: 's-otis', name: 'Otis', pinHash: sha('7777'), roles: ['sales-tab'], isManager: true, updatedAt: Date.now() + 5 }] });
  assert.equal((await b.call('main', { action: 'overview' }, t)).status, 401);
});

test('the Staff tab "Move to branch" (branches.js) is now a real move: same id, removed at the old branch, history recorded', { skip: !hasSqlite }, async () => {
  const b = await business();
  const br = await load('branches.js');
  const res = await br.onRequestPost({ request: new Request('https://main.mydukapos.store/api/branches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'migrateStaff', staffId: 's-jane', targetClientId: 'B' }) }), env: b.env, waitUntil() {} });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await b.staffAt('M')).find((s) => s.id === 's-jane').removed, true);
  assert.ok((await b.staffAt('B')).find((s) => s.id === 's-jane' && !s.removed));
  const audit = (await b.call('main', { action: 'audit.list' }, b.owner)).audit;
  assert.ok(audit.some((a) => a.action === 'staff.assign.permanent' && a.target === 'person:s-jane'));
  // and the switcher's summary carries the HQ code / status, and no longer lists people who moved away
  await b.call('main', { action: 'branch.save', clientId: 'B', code: 'WLD', name: 'Westlands' }, b.owner);
  const sres = await br.onRequestPost({ request: new Request('https://main.mydukapos.store/api/branches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'summary' }) }), env: b.env, waitUntil() {} });
  const sum = await sres.json();
  const west = sum.branches.find((x) => x.id === 'B'), main = sum.branches.find((x) => x.id === 'M');
  assert.equal(west.code, 'WLD'); assert.equal(west.status, 'active');
  assert.ok(!main.staff.some((s) => s.name === 'Jane'), 'Jane left Main');
});

test('add a branch from HQ: guided (name + code), no duplicate names or codes, joins the same business', { skip: !hasSqlite }, async () => {
  const b = await business();
  await b.call('main', { action: 'branch.save', clientId: 'B', code: 'WLD', name: 'Westlands' }, b.owner);
  assert.equal((await b.call('main', { action: 'branch.create', name: 'Kisumu', code: 'WLD' }, b.owner)).status, 400, 'code already used');
  assert.equal((await b.call('main', { action: 'branch.create', name: 'westlands', code: 'KSM' }, b.owner)).status, 400, 'name already used');
  const r = await b.call('main', { action: 'branch.create', name: 'Kisumu', code: 'KSM' }, b.owner);
  assert.equal(r.ok, true, JSON.stringify(r));
  const members = JSON.parse(b.kv.data.get('branch-group:GRP1').value);
  assert.equal(members.length, 4); assert.ok(members.includes(r.branch.clientId));
  const ov = await b.call('main', { action: 'overview' }, b.owner);
  const k = ov.branches.find((x) => x.clientId === r.branch.clientId);
  assert.equal(k.code, 'KSM'); assert.equal(k.name, 'Kisumu');
  const audit = (await b.call('main', { action: 'audit.list' }, b.owner)).audit;
  assert.ok(audit.some((a) => a.action === 'branch.profile' && a.target === 'branch:' + r.branch.clientId));
});

test('zip 325: no password - the Admin on the MAIN branch opens HQ; a sub-branch is refused; a password is never needed', { skip: !hasSqlite }, async () => {
  const b = await business();
  const a = await b.call('main', { action: 'login', auto: true });
  assert.equal(a.status, 200); assert.ok(a.token); assert.equal(a.who.kind, 'owner');
  assert.equal((await b.call('main', { action: 'overview' }, a.token)).status, 200, 'the passwordless session works like the old owner session');
  const sub = await b.call('westlands', { action: 'login', auto: true });
  assert.equal(sub.status, 403); assert.equal(sub.code, 'not_main'); assert.ok(!sub.token, 'a sub-branch admin is not the owner of the business');
  assert.equal((await b.call('main', { action: 'login', proof: sha('wrong') })).status, 401, 'the password route still refuses a wrong password');
});
