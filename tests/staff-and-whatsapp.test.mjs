import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

// ---------- staff listed twice ----------
const SHOP_APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'water/index.html'];
for (const app of SHOP_APPS) {
  test(`${app}: a double tap on "Create my account" (or the same invite on two phones) makes ONE staff member, and exact duplicates already saved are merged`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1500 });
    w.eval("showToast = function () {}");
    w.eval("pendingInvites.push({ token: 'TOK1', name: 'Jane', roles: ['inventory-list-tab'], createdAt: Date.now() })");
    d.getElementById('invite-screen').dataset.token = 'TOK1';
    d.getElementById('invite-pin-input').value = '1234'; d.getElementById('invite-pin-confirm-input').value = '1234';
    await Promise.all([w.eval('submitStaffInvite()'), w.eval('submitStaffInvite()'), w.eval('submitStaffInvite()')]);
    assert.equal(w.eval("staff.filter(s => s.name === 'Jane').length"), 1, 'three taps = one Jane');
    assert.equal(w.eval("staff[0].id"), 'st-TOK1', 'the id comes from the invite, so two phones cannot make two');
    // the old bug already in the data: same name + same PIN under two ids (and a shift on the duplicate); a different person with the same name stays
    const hash = crypto.createHash('sha256').update('1234').digest('hex');
    w.eval(`staff.length = 0; staff.push({ id: 'b-2', name: 'Peter', pinHash: '${hash}', roles: [] }, { id: 'a-1', name: 'peter ', pinHash: '${hash}', roles: ['x'] }, { id: 'c-3', name: 'Peter', pinHash: 'otherpin', roles: [] }); staffShifts.length = 0; staffShifts.push({ id: 's1', staffId: 'b-2', name: 'Peter', clockIn: 1, clockOut: 2 })`);
    w.eval('renderLoginPicker()');
    const names = [...d.querySelectorAll('#login-picker-list .login-picker-btn')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
    assert.equal(names.filter((n) => /Peter/i.test(n)).length, 2, 'the duplicate is gone from the picker; the different Peter (other PIN) remains');
    assert.equal(w.eval("staff.find(s => s.id === 'b-2').removed"), true, 'the record with the larger id is retired');
    assert.ok(!w.eval("staff.find(s => s.id === 'a-1').removed"), 'the smaller id is kept — on every device');
    assert.equal(w.eval("staffShifts[0].staffId"), 'a-1', 'its shift moved to the person kept');
    assert.equal(w.eval("JSON.stringify(staff.find(s => s.id === 'a-1').roles)"), '["x"]');
    assert.deepEqual(errors, []);
    close();
  });
}

test('Owner Console: exact duplicate staff are merged there too (the list is the same "Who\'s logging in?")', async () => {
  const fetch = async (url) => (String(url).includes('/api/owner-auth') ? { ok: true, status: 200, json: async () => ({ authenticated: true, ownerClientId: 'OWN', hasAccount: true }) } : Promise.reject(new Error('offline')));
  const hash = crypto.createHash('sha256').update('4321').digest('hex');
  const staff = [{ id: 'z-9', name: 'Mary', pinHash: hash, roles: [] }, { id: 'm-1', name: 'Mary', pinHash: hash, roles: [] }];
  const { w, errors, close } = await boot('owner/index.html', { fetch, storage: { pos_owner_session_token: 'tok', pos_owner_client_id: 'OWN', pos_staff: JSON.stringify(staff) }, wait: 2500 });
  w.eval('renderLoginPicker && renderLoginPicker(); dedupeStaff()');
  assert.equal(w.eval("staff.filter(s => !s.removed).length"), 1);
  assert.equal(w.eval("staff.find(s => !s.removed).id"), 'm-1');
  await sleep(1500);                                                                          // let the console's own start-up finish before the page is closed
  assert.deepEqual(errors, []);
  close();
});

// ---------- WhatsApp -> Leads ----------
const SECRET = 'app-secret-123';
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const payload = (msgs, names = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: Object.entries(names).map(([wa_id, name]) => ({ wa_id, profile: { name } })), messages: msgs } }] }] });
const msg = (id, from, body, ts = 1789990000, referral) => ({ id, from, timestamp: String(ts), type: 'text', text: { body }, ...(referral ? { referral } : {}) });
const AD = { source_type: 'ad', source_id: '1200001', source_url: 'https://fb.me/xyz', headline: 'POS for your shop', body: 'Sell smarter', ctwa_clid: 'clid1' };
async function hook(env, body, headers = {}) {
  const m = await load('whatsapp-webhook.js');
  return m.onRequestPost({ request: new Request('https://x.pages.dev/api/whatsapp-webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }), env });
}

test('WhatsApp webhook: the URL handshake works only with the right token', async () => {
  const m = await load('whatsapp-webhook.js');
  const env = { mydukapos_kv: makeKV(), WHATSAPP_VERIFY_TOKEN: 'verify-me' };
  const get = (q) => m.onRequestGet({ request: new Request('https://x.pages.dev/api/whatsapp-webhook?' + q), env });
  let r = await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(r.status, 200); assert.equal(await r.text(), '12345');
  r = await get('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345'); assert.equal(r.status, 403);
  r = await m.onRequestGet({ request: new Request('https://x.pages.dev/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'), env: { mydukapos_kv: makeKV() } });
  assert.equal(r.status, 503, 'not set up yet says so');
});

test('WhatsApp webhook: a message with a good signature is filed; a bad or missing signature is refused; Meta retries do not duplicate', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv, WHATSAPP_APP_SECRET: SECRET };
  const body = JSON.stringify(payload([msg('wamid.A', '254712345678', 'Hi, I want a POS for my shop', 1789990000, AD)], { '254712345678': 'Jane W' }));
  let r = await hook(env, body, { 'x-hub-signature-256': sign(body) });
  assert.equal(r.status, 200);
  r = await hook(env, body, { 'x-hub-signature-256': sign(body) });                                   // Meta re-delivers
  const { readInbox } = await load('_whatsapp.js');
  const inbox = await readInbox(env);
  assert.equal(inbox.length, 1, 'once');
  assert.deepEqual([inbox[0].from, inbox[0].name, inbox[0].text], ['254712345678', 'Jane W', 'Hi, I want a POS for my shop']);
  assert.equal((await hook(env, body, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status, 401, 'wrong signature');
  assert.equal((await hook(env, body)).status, 401, 'no signature');
  assert.equal((await hook({ mydukapos_kv: kv }, body, { 'x-hub-signature-256': sign(body) })).status, 503, 'no app secret configured: refuses everything');
  assert.equal((await readInbox(env)).length, 1, 'nothing extra was stored');
});

test('WhatsApp webhook: ONLY people who came from a Meta ad become leads — ordinary texts are dropped, follow-ups from an ad person are kept', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv, WHATSAPP_APP_SECRET: SECRET };
  const wa = await load('_whatsapp.js');
  const send = async (msgs, names) => { const b = JSON.stringify(payload(msgs, names)); const r = await hook(env, b, { 'x-hub-signature-256': sign(b) }); assert.equal(r.status, 200); };
  await send([msg('w1', '254711111111', 'Hello, do you sell POS?')], { '254711111111': 'Random Person' });                 // an ordinary text: no ad
  assert.equal((await wa.readInbox(env)).length, 0, 'not stored at all');
  await send([msg('w2', '254722222222', 'I saw your ad', 1789990100, AD)], { '254722222222': 'Ad Person' });                 // came from the ad
  assert.equal((await wa.readInbox(env)).length, 1);
  await send([msg('w3', '254722222222', 'How much is it?', 1789990200)], { '254722222222': 'Ad Person' });                    // and writes again (no marker)
  await send([msg('w4', '254711111111', 'Are you there?', 1789990300)], { '254711111111': 'Random Person' });                 // the random person again: still ignored
  const inbox = await wa.readInbox(env);
  assert.deepEqual(inbox.map((m) => [m.from, m.text]), [['254722222222', 'I saw your ad'], ['254722222222', 'How much is it?']]);
  assert.equal(inbox[0].adHeadline, 'POS for your shop'); assert.equal(inbox[0].fromAd, true);
  // a "post" referral (a boosted Facebook post with a WhatsApp button) counts too; a referral of another kind does not
  await send([msg('w5', '254733333333', 'From your post', 1789990400, { source_type: 'post', source_id: 'p1', headline: 'Our post' })]);
  await send([msg('w6', '254744444444', 'random', 1789990500, { source_type: 'something-else' })]);
  assert.deepEqual((await wa.readInbox(env)).map((m) => m.from), ['254722222222', '254722222222', '254733333333']);
});
