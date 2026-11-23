import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot, APPS } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 269 - a PERMANENT shop is never told "your free trial has ended"; and an EXPIRED TRIAL address that belongs to someone who already has a permanent
// shop (a typo'd sign-up address: imuru-textiles / limuru-textiles) points them to it instead of asking for KES 3,000 again.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function world() {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const L = await load('_license.js');
  const mk = async (type, label, extra = {}) => L.createClient(env, type, label, extra.product || 'shop', extra);
  const status = async (rec) => (await (await load('license-status.js')).onRequestGet({ request: new Request('https://x.pages.dev/api/license-status?c=' + rec.id), env })).json();
  const expire = async (rec) => { const r = await L.getLicense(env, rec.id); r.expiresAt = Date.now() - 1000; await L.saveLicense(env, r); };
  return { kv, env, L, mk, status, expire };
}

test('a permanent record is valid whatever else is on it (expiry date in the past, stale trial fields, no billing)', async () => {
  const { L } = await world();
  for (const rec of [{ type: 'permanent', expiresAt: 1 }, { type: 'permanent', expiresAt: null }, { type: 'permanent', expiresAt: Date.now() - 9e9, paymentClaimed: true, confirmedAt: null }]) {
    const r = L.evaluateLicense({ id: 'a', slug: 's', ...rec });
    assert.equal(r.valid, true); assert.equal(r.reason, 'permanent');
  }
});

test('imuru-textiles (expired trial) points to limuru-textiles (permanent, same person): no payment demand', async () => {
  const w = await world();
  const demo = await w.mk('demo', 'Imuru textiles', { clientName: 'Cc Jecinta', phone: '0712 345 678' });
  const perm = await w.mk('permanent', 'Limuru textiles', { clientName: 'Cc Jecinta', phone: '+254712345678' });
  await w.expire(demo);
  const d = await w.status(demo);
  assert.equal(d.valid, false); assert.equal(d.reason, 'expired');
  assert.match(d.permanentUrl, /^https:\/\/limuru-textiles\./); assert.ok(d.permanentUrl.includes('c=' + perm.id));
  const p = await w.status(perm);
  assert.equal(p.valid, true); assert.equal(p.permanentUrl, null);
});

test('no pointer when it cannot be sure: no identity, other phone, other app, locked or deleted permanent shop, or two equally close shops', async () => {
  const w = await world();
  const bare = await w.mk('demo', 'Bare trial'); await w.expire(bare);
  await w.mk('permanent', 'Other shop', { clientName: 'Someone', phone: '0700000001' });
  assert.equal((await w.status(bare)).permanentUrl, null, 'a trial with no name / phone / e-mail is never matched');
  const a = await w.mk('demo', 'Trial a', { clientName: 'Mary W', phone: '0700000002' }); await w.expire(a);
  assert.equal((await w.status(a)).permanentUrl, null, 'a different person');
  const hotel = await w.mk('permanent', 'Mary hotel', { clientName: 'Mary W', phone: '0700000002', product: 'hotel' });
  assert.equal((await w.status(a)).permanentUrl, null, 'a different app');
  const shop = await w.mk('permanent', 'Mary shop', { clientName: 'Mary W', phone: '0700000002' });
  assert.match((await w.status(a)).permanentUrl, /mary-shop/);
  const r = await w.L.getLicense(w.env, shop.id); r.locked = true; await w.L.saveLicense(w.env, r);
  assert.equal((await w.status(a)).permanentUrl, null, 'a locked shop is not suggested');
  r.locked = false; await w.L.saveLicense(w.env, r);
  const two = await w.mk('permanent', 'Mary shop two', { clientName: 'Mary W', phone: '0700000002' });
  const b = await w.mk('demo', 'Mary sho', { clientName: 'Mary W', phone: '0700000002' }); await w.expire(b);
  assert.match((await w.status(b)).permanentUrl, /mary-shop/, 'two shops: the one with the closest address');
});

const SHOPS = APPS.filter((a) => a !== 'owner/index.html');
for (const app of SHOPS) {
  test(`${app}: an expired trial that has a permanent shop shows "Open my shop", not the payment instructions; a plain expired trial still asks to pay`, async () => {
    const reply = (extra) => ({ ok: true, status: 200, json: async () => ({ serverNow: Date.now(), valid: false, reason: 'expired', clientId: 'D1', slug: 'imuru-textiles', type: 'demo', expiresAt: 1, remainingMs: 0, ...extra }) });
    let extra = { permanentUrl: 'https://limuru-textiles.mydukapos.store/?c=P1' };
    const fetch = async (url) => { if (String(url).includes('/api/license-status')) return reply(extra); return Promise.reject(new Error('offline')); };
    const { w, d, close } = await boot(app, { fetch, wait: 1500 });
    await w.eval('checkLicenseStatus()'); await new Promise((r) => setTimeout(r, 300));
    const lock = d.getElementById('license-lock-screen');
    assert.equal(lock.style.display, 'flex');
    const btn = d.getElementById('license-permanent-btn');
    assert.ok(btn, 'an Open my shop button'); assert.equal(btn.getAttribute('href'), 'https://limuru-textiles.mydukapos.store/?c=P1'); assert.notEqual(btn.style.display, 'none');
    assert.match(d.getElementById('license-lock-title').textContent, /new address/); assert.match(d.getElementById('license-lock-reason').textContent, /Nothing needs to be paid/);
    assert.equal(d.getElementById('license-claim-payment-btn').style.display, 'none'); assert.equal(d.querySelector('.license-lock-hint').style.display, 'none');
    extra = {}; await w.eval('checkLicenseStatus()'); await new Promise((r) => setTimeout(r, 300));
    assert.equal(d.getElementById('license-permanent-btn').style.display, 'none', 'gone when there is no permanent shop');
    assert.match(d.getElementById('license-lock-reason').textContent, /free trial has ended/); assert.equal(d.getElementById('license-claim-payment-btn').style.display, 'block');
    close();
  });
}
