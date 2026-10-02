import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeCrm, makeEnv } from './crm-harness.mjs';
import { makeKV } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function demo(env, body, { ip = '1.1.1.1', referer } = {}) {
  const m = await load('demo-account.js');
  const res = await m.onRequestPost({ request: new Request('https://mydukapos.store/api/demo-account', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(referer ? { Referer: referer } : {}) }, body: JSON.stringify(body) }), env });
  return { status: res.status, body: await res.json() };
}
const reg = (o = {}) => ({ action: 'register', acceptTerms: true, fullName: 'Grace Njeri', phone: '0722 333 444', email: 'grace@example.com', password: 'secret99', confirmPassword: 'secret99', ...o });

test('demo signup -> CRM: a registration with a demo becomes ONE website lead (product, business, attribution); signup response is unchanged', async () => {
  const c = await makeCrm();
  const r = await demo(c.env, reg({ product: 'shop', businessName: 'Grace Duka', utm_source: 'google', utm_campaign: 'brand', password: 'secret99' }), { referer: 'https://google.com/' });
  assert.equal(r.status, 200); assert.ok(r.body.token && r.body.link, 'the demo is provisioned as before');
  const l = c.q(`select * from crm_leads where email = 'grace@example.com'`);
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].name, l[0].phone, l[0].source_key, l[0].status_key, l[0].business_name, l[0].legacy_id, l[0].first_utm_source, l[0].first_utm_campaign], ['Grace Njeri', '+254722333444', 'signup', 'new', 'Grace Duka', 'demo:grace@example.com', 'google', 'brand']);
  assert.match(l[0].notes, /Website demo request[\s\S]*Product: shop[\s\S]*Grace Duka/);
  assert.equal(c.q('select count(*) n from crm_lead_products p join crm_products x on x.id = p.product_id where p.lead_id = ? and x.key = ?', l[0].id, 'shop')[0].n, 1);
  assert.ok(!JSON.stringify(c.q('select * from crm_leads')).includes('secret99'), 'no password anywhere in the CRM');
});

test('demo signup -> CRM: registered-only then a demo request = same lead + product; a person already in the CRM (same phone) gets an attribution touch, not a duplicate', async () => {
  const c = await makeCrm();
  const existing = (await c.ok('POST', '/leads', { body: { name: 'Existing Person', phone: '0700123123' } })).lead;
  let r = await demo(c.env, reg({ email: 'a@example.com', phone: '0700 123 123', utm_source: 'facebook' }));
  assert.equal(r.status, 200); assert.equal(r.body.link, null);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1, 'no duplicate lead for the same phone');
  const ev = c.q('select utm_source from crm_attribution_events where lead_id = ? order by at, rowid', existing.id);
  assert.equal(ev.length >= 2, true, 'the touch is recorded'); assert.equal(ev[ev.length - 1].utm_source, 'facebook');
  assert.equal(c.q('select first_utm_source s from crm_leads where id = ?', existing.id)[0].s, null, 'the first attribution is kept');
  // registered only -> its own lead, marked; then generate-demo adds the product to it
  r = await demo(c.env, reg({ email: 'b@example.com', phone: '0711999888', fullName: 'Bee' }), { ip: '2.2.2.2' });
  const b = c.q(`select * from crm_leads where email = 'b@example.com'`)[0];
  assert.match(b.notes, /registered, no demo yet/);
  const gd = await demo(c.env, { action: 'generate-demo', token: r.body.token, product: 'hotel', businessName: 'Bee Hotel' });
  assert.equal(gd.status, 200); assert.ok(gd.body.link);
  assert.equal(c.q(`select count(*) n from crm_leads where email = 'b@example.com'`)[0].n, 1);
  assert.equal(c.q('select count(*) n from crm_lead_products p join crm_products x on x.id = p.product_id where p.lead_id = ? and x.key = ?', b.id, 'hotel')[0].n, 1);
  assert.ok(c.q('select summary from crm_activities where lead_id = ?', b.id).some((a) => /demo of hotel for Bee Hotel/.test(a.summary)));
});

test('demo signup still works with no D1, and when the CRM push fails', async () => {
  const env = makeEnv(); delete env.LEDGER_DB;
  const r = await demo(env, reg({ product: 'shop', businessName: 'No Db Duka' }));
  assert.equal(r.status, 200); assert.ok(r.body.token && r.body.link);
  // D1 present but broken: the signup is not affected
  const env2 = makeEnv(); env2.LEDGER_DB = { prepare() { throw new Error('d1 down'); }, batch() { throw new Error('d1 down'); }, exec() { throw new Error('d1 down'); } };
  const r2 = await demo(env2, reg({ email: 'z@example.com', product: 'shop', businessName: 'Z' }), { ip: '3.3.3.3' });
  assert.equal(r2.status, 200); assert.ok(r2.body.link);
  // and with waitUntil, the response does not wait for the CRM
  const c = await makeCrm(); let pending = null;
  const m = await load('demo-account.js');
  const res = await m.onRequestPost({ request: new Request('https://mydukapos.store/api/demo-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reg({ email: 'w@example.com' })) }), env: c.env, waitUntil: (p) => { pending = p; } });
  assert.equal(res.status, 200); assert.ok(pending, 'the push was handed to waitUntil'); await pending;
  assert.equal(c.q(`select count(*) n from crm_leads where email = 'w@example.com'`)[0].n, 1);
});

test('legacy migration: web signups (demo-account index) -> website leads; real vs registered-only counted separately; idempotent; KV untouched; verify checks them', async () => {
  const c = await makeCrm();
  const put = (k, v) => c.kv.data.set(k, { value: JSON.stringify(v) });
  const t = Date.parse('2026-08-10T08:00:00Z');
  const idx = [
    { fullName: 'Active Amos', phone: '0722000111', email: 'amos@x.co.ke', product: 'shop', branchName: 'Amos Duka', demoStatus: 'active', createdAt: t, generatedAt: t + 1000, expiresAt: t + 7 * 864e5, demoClientId: 'CLA' },
    { fullName: 'Expired Eve', phone: '+254733000222', email: 'Eve@X.co.ke', product: 'hotel', branchName: 'Eve Hotel', demoStatus: 'expired', createdAt: t - 864e5, generatedAt: t - 864e5, expiresAt: t - 1000 },
    { fullName: 'Deleted Dan', phone: '0744000333', email: 'dan@x.co.ke', product: 'unknownprod', demoStatus: 'deleted', createdAt: t - 2 * 864e5 },
    { fullName: 'Only Olive', phone: '12', email: 'olive@x.co.ke', demoStatus: 'none', createdAt: t - 3 * 864e5 },
    { fullName: 'No Contact', demoStatus: 'none' },
  ];
  put('demo-account-index:v1', idx);
  put('demo-account:amos@x.co.ke', { fullName: 'Active Amos', email: 'amos@x.co.ke', salt: 'SALT', passwordHash: 'HASH', approvalStatus: 'pending', createdAt: t });
  const kvBefore = JSON.stringify([...c.kv.data.entries()].sort());
  const dry = await c.ok('POST', '/legacy/migrate', { body: { dryRun: true } });
  assert.deepEqual(dry.counts.websiteLeads, { found: 4, real: 3, registeredOnly: 1, created: 4, createdReal: 3, createdRegisteredOnly: 1, skipped: 0, failed: 0 });
  assert.equal(c.q(`select count(*) n from crm_leads where legacy_id like 'demo:%'`)[0].n, 0);
  const r = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.deepEqual(r.errors, []); assert.deepEqual([r.counts.websiteLeads.created, r.counts.websiteLeads.createdReal, r.counts.websiteLeads.createdRegisteredOnly, r.counts.websiteLeads.failed], [4, 3, 1, 0]);
  assert.equal(JSON.stringify([...c.kv.data.entries()].sort()), kvBefore, 'KV (demo accounts, index, sessions) untouched');
  const a = c.q(`select * from crm_leads where legacy_id = 'demo:amos@x.co.ke'`)[0];
  assert.deepEqual([a.name, a.phone, a.email, a.source_key, a.status_key, a.business_name, a.created_at, a.updated_at], ['Active Amos', '+254722000111', 'amos@x.co.ke', 'signup', 'new', 'Amos Duka', t, t + 1000], 'original timestamps');
  assert.match(a.notes, /Product: shop[\s\S]*Amos Duka[\s\S]*Demo status: active[\s\S]*Demo expires: 2026-08-17/);
  const lj = JSON.parse(a.legacy_json); assert.equal(lj.index.demoClientId, 'CLA'); assert.equal(lj.account.approvalStatus, 'pending'); assert.ok(!JSON.stringify(lj).includes('HASH') && !JSON.stringify(lj).includes('SALT'), 'password material never copied');
  assert.equal(c.q('select count(*) n from crm_lead_products p join crm_products x on x.id = p.product_id where p.lead_id = ? and x.key = ?', a.id, 'shop')[0].n, 1);
  const eve = c.q(`select * from crm_leads where legacy_id = 'demo:eve@x.co.ke'`)[0]; assert.match(eve.notes, /Demo status: expired/);
  const dan = c.q(`select * from crm_leads where legacy_id = 'demo:dan@x.co.ke'`)[0]; assert.match(dan.notes, /Demo status: deleted/); assert.equal(c.q('select count(*) n from crm_lead_products where lead_id = ?', dan.id)[0].n, 0, 'an unknown product key maps to no product but stays in the notes');
  assert.match(dan.notes, /Product: unknownprod/);
  const ol = c.q(`select * from crm_leads where legacy_id = 'demo:olive@x.co.ke'`)[0];
  assert.deepEqual([ol.status_key, ol.phone], ['new', null]); assert.match(ol.notes, /registered, no demo yet/); assert.match(ol.notes, /Legacy phone \(not a valid number\): 12/);
  // idempotent + verify
  const again = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.deepEqual([again.counts.websiteLeads.created, again.counts.websiteLeads.skipped], [0, 4]);
  assert.equal(c.q(`select count(*) n from crm_leads where legacy_id like 'demo:%'`)[0].n, 4);
  const v = await c.ok('GET', '/legacy/verify');
  assert.equal(v.ok, true, JSON.stringify(v.match)); assert.deepEqual([v.kv.websiteLeads, v.kv.websiteReal, v.kv.websiteRegisteredOnly, v.crm.websiteLeads, v.crm.websiteRegisteredOnly], [4, 3, 1, 4, 1]);
  put('demo-account-index:v1', [{ fullName: 'Late Lola', phone: '0755000444', email: 'lola@x.co.ke', demoStatus: 'active', product: 'shop', createdAt: t }, ...idx]);
  const v2 = await c.ok('GET', '/legacy/verify'); assert.equal(v2.ok, false); assert.deepEqual(v2.missingWebsiteLeads.map((x) => x.name), ['Late Lola']);
  await c.ok('POST', '/legacy/migrate', { body: {} }); assert.equal((await c.ok('GET', '/legacy/verify')).ok, true);
  // a person pushed live by the demo signup is not migrated a second time
  const live = await demo(c.env, reg({ email: 'live@x.co.ke', fullName: 'Live Lucy', phone: '0766000555' }), { ip: '4.4.4.4' }); assert.equal(live.status, 200);
  const idx2 = JSON.parse(c.kv.data.get('demo-account-index:v1').value);
  assert.ok(idx2.some((e) => e.email === 'live@x.co.ke'));
  const m3 = await c.ok('POST', '/legacy/migrate', { body: {} }); assert.equal(m3.counts.websiteLeads.created, 0);
  assert.equal(c.q(`select count(*) n from crm_leads where email = 'live@x.co.ke'`)[0].n, 1);
});
