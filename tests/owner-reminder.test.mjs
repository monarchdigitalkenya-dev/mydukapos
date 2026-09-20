import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot, APPS } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function setup(extra = {}) {
  const kv = makeKV(); seedShop(kv, 'C1', extra);
  kv.data.set('owner-session:tok', { value: '1' });
  const env = { mydukapos_kv: kv };
  const lock = async (body) => { const m = await load('owner-lock.js'); const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-lock', { method: 'POST', body: JSON.stringify({ c: 'C1', ...body }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env }); return { status: r.status, body: await r.json() }; };
  const status = async () => (await (await load('license-status.js')).onRequestGet({ request: new Request('https://x.pages.dev/api/license-status?c=C1'), env })).json();
  const ack = async (id) => (await load('owner-notice.js')).onRequestPost({ request: new Request('https://x.pages.dev/api/owner-notice?c=C1', { method: 'POST', body: JSON.stringify({ id }), headers: { 'content-type': 'application/json' } }), env });
  const summary = () => JSON.parse(kv.data.get('license-index:v1').value).find((e) => e.id === 'C1');
  return { kv, lock, status, ack, summary };
}

test('recordRevenue: recorded once for a permanent link, validated, and shown in the link\'s summary', async () => {
  const s = await setup();
  assert.equal((await s.lock({ action: 'recordRevenue', agreedAmount: 3000, paidAmount: 3500 })).status, 400, 'paid cannot exceed agreed');
  assert.equal((await s.lock({ action: 'recordRevenue', agreedAmount: 0, paidAmount: 0 })).status, 400);
  assert.equal((await s.lock({ action: 'recordRevenue', agreedAmount: 3000, paidAmount: -1 })).status, 400);
  const ok = await s.lock({ action: 'recordRevenue', agreedAmount: 3000, paidAmount: 2000, method: 'cash' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.client.revenue.agreed, ok.body.client.revenue.paid, ok.body.client.revenue.method], [3000, 2000, 'cash']);
  assert.equal(ok.body.client.balanceOwed, 1000);
  assert.equal(s.summary().revenue.agreed, 3000, 'the owner\'s list shows it');
  assert.equal((await s.lock({ action: 'recordRevenue', agreedAmount: 100, paidAmount: 100 })).status, 409, 'cannot be recorded twice');
});

test('recordRevenue is refused for a demo link', async () => {
  const s = await setup({ type: 'demo', expiresAt: Date.now() + 1e6 });
  assert.equal((await s.lock({ action: 'recordRevenue', agreedAmount: 3000, paidAmount: 0 })).status, 400);
});

test('a reminder reaches that link through license-status, stops once dismissed, and a newer reminder is never swallowed by an old dismissal', async () => {
  const s = await setup();
  assert.equal((await s.status()).notice, null, 'nothing yet');
  assert.equal((await s.lock({ action: 'remind', message: '   ' })).status, 400, 'a message is required');
  const sent = await s.lock({ action: 'remind', message: 'Please pay KES 1,000', balance: 1000 });
  assert.equal(sent.status, 200);
  const first = (await s.status()).notice;
  assert.equal(first.message, 'Please pay KES 1,000'); assert.equal(first.balance, 1000); assert.ok(first.id);
  assert.equal(s.summary().notice.ackAt, null, 'the owner sees "not seen yet"');
  await s.ack('some-other-id');
  assert.ok((await s.status()).notice, 'a wrong id dismisses nothing');
  await s.ack(first.id);
  assert.equal((await s.status()).notice, null, 'dismissed: gone for every device');
  assert.ok(s.summary().notice.ackAt > 0, 'the owner sees "seen"');
  await s.lock({ action: 'remind', message: 'Second reminder', balance: 900 });
  assert.equal((await s.status()).notice.message, 'Second reminder', 'a new reminder shows again');
  await s.ack(first.id);
  assert.equal((await s.status()).notice.message, 'Second reminder', 'the OLD id cannot dismiss the new one');
});

const SHOPS = APPS.filter((a) => a !== 'owner/index.html');
for (const app of SHOPS) {
  test(`${app}: the owner's reminder shows as a banner for the ADMIN only, OK dismisses it here and tells the server`, async () => {
    const calls = [];
    const notice = { id: 'n1', message: 'Payment reminder: KES 1,000 outstanding', at: Date.now(), balance: 1000 };
    const fetch = async (url, opts = {}) => {
      const u = String(url); if (opts.body) calls.push({ url: u.split('?')[0], body: JSON.parse(opts.body) });
      if (u.includes('/api/license-status')) return { ok: true, status: 200, json: async () => ({ serverNow: Date.now(), valid: true, reason: 'permanent', clientId: 'C1', slug: 's', type: 'permanent', expiresAt: null, remainingMs: null, notice }) };
      if (u.includes('/api/owner-notice')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return Promise.reject(new Error('offline'));
    };
    const { w, d, errors, close } = await boot(app, { fetch, wait: 1200 });
    w.eval("currentServer = null");                                         // the admin is signed in
    d.getElementById('login-screen').style.display = 'none'; d.getElementById('registration-screen').style.display = 'none';
    await w.eval('checkLicenseStatus()');
    const banner = d.getElementById('owner-notice-banner');
    assert.ok(banner, 'shown to the admin');
    assert.match(banner.textContent, /Payment reminder from mydukapos/); assert.match(banner.textContent, /KES 1,000 outstanding/);
    // a staff member signed in as themselves does not see it
    d.getElementById('owner-notice-banner').remove();
    w.eval("currentServer = { id: 'staff1', name: 'Ann' }");
    await w.eval('checkLicenseStatus()');
    assert.equal(d.getElementById('owner-notice-banner'), null, 'not shown to staff');
    // back to admin: OK dismisses and acknowledges
    w.eval("currentServer = null");
    await w.eval('checkLicenseStatus()');
    d.querySelector('#owner-notice-banner button').click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(d.getElementById('owner-notice-banner'), null, 'gone');
    assert.ok(calls.some((c) => c.url.includes('/api/owner-notice') && c.body.id === 'n1'), 'the server is told it was seen');
    await w.eval('checkLicenseStatus()');
    assert.equal(d.getElementById('owner-notice-banner'), null, 'and it does not come back on this device');
    assert.deepEqual(errors, []);
    close();
  });
}
