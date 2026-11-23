import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { createClient, getLicense, requireValidLicense, evaluateLicense } from '../functions/api/_license.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';
import { onRequestPost as renew } from '../functions/api/billing-renew.js';
import { onRequestPost as ownerBilling } from '../functions/api/owner-billing.js';
import { onRequestPost as ownerConfirm } from '../functions/api/owner-confirm.js';
import { onRequestPost as terms } from '../functions/api/billing-terms.js';
import { onRequestGet as termsGet } from '../functions/api/billing-terms.js';
import { saveSettings, getSettings, saveOffer, refCodeFor, reversePayment, claimRef } from '../functions/api/_billing.js';
import { DAY_MS } from '../functions/api/_billing-core.js';
import { createHash } from 'node:crypto';
import { listEvents } from '../functions/api/_billing.js';
const PW = createHash('sha256').update('maryadmin').digest('hex');
const setPw = (w, id) => w.kv.data.set('pos-data:state:' + id, { value: JSON.stringify({ pwHash: PW }) });

// zip 267 - subscriptions, offers, referrals: the money, date and idempotency rules, end to end over the real handlers.
async function world({ stk = false } = {}) {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  if (stk) await saveGatewayConfig(env, acct.ownerClientId, { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production' });
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const req = (url, body, owner) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + sess } : {}) }, body: JSON.stringify(body) });
  const buy = (body, owner = false) => gml({ env, request: req('https://x.pages.dev/api/get-my-link?c=demo_retail', body, owner) }).then(async (r) => ({ r, j: await r.json() }));
  const ob = (body) => ownerBilling({ env, request: req('https://x.pages.dev/api/owner-billing', body, true) }).then(async (r) => ({ r, j: await r.json() }));
  const my = (id, body) => renew({ env, request: req('https://x.pages.dev/api/billing-renew?c=' + id, body) }).then(async (r) => ({ r, j: await r.json() }));
  const launch = (extra = {}) => saveSettings(env, { launchAt: Date.now() - 1000, ...extra });
  return { kv, env, acct, sess, buy, ob, my, launch };
}
const buyer = { action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: '' };
const shopOf = async (w, name = 'Mary Wanjiku') => { const l = JSON.parse(w.kv.data.get('license-index:v1').value).find((c) => c.label === name); return l ? getLicense(w.env, l.id) : null; };
async function bought(w, over = {}) {                       // a purchase paid by "I've made this payment" and confirmed by the owner
  const s = await w.buy({ ...buyer, ...over }); await w.buy({ action: 'claim', id: s.j.id, token: s.j.token });
  const c = await w.buy({ action: 'confirm', id: s.j.id }, true);
  return { s, c, rec: await shopOf(w, over.name || 'Mary Wanjiku') };
}

const oc = (w, body) => ownerConfirm({ env: w.env, request: new Request('https://x.pages.dev/api/owner-confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + w.sess }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
const flags = async (w) => (await listEvents(w.env, { limit: 100 })).rows.filter((e) => e.kind === 'flag');


// zip 269 - guards found in the pre-migration review.
test('a manual renewal pressed a second time (after the first used up the shop\'s pending claim) is refused, not applied twice', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w); const first = rec.billing.paidThrough;
  const a = await w.ob({ action: 'manual-renewal', id: rec.id, cycles: 1 }); assert.equal(a.r.status, 200);
  const b = await w.ob({ action: 'manual-renewal', id: rec.id, cycles: 1 }); assert.equal(b.r.status, 400); assert.match(b.j.error, /less than a minute ago/);
  assert.equal((await getLicense(w.env, rec.id)).billing.paidThrough, first + 31 * DAY_MS, 'one cycle');
  const c = await w.ob({ action: 'manual-renewal', id: rec.id, cycles: 1, key: 'second-real-payment' });
});

test('a storage error during "confirm add-on" does not leave a marker that makes the retry say "done" with nothing applied', async () => {
  const w = await world(); await w.launch();
  const { rec } = await bought(w);
  const put = w.kv.put; let boom = true;
  w.kv.put = async (k, v, o) => { if (boom && String(k).startsWith('license:')) { boom = false; throw new Error('KV hiccup'); } return put(k, v, o); };
  let failed = false; try { const r = await oc(w, { c: rec.id, action: 'confirm-addon' }); failed = r.r.status >= 500; } catch (e) { failed = true; }
  assert.ok(failed, 'the first attempt failed');
  const r2 = await oc(w, { c: rec.id, action: 'confirm-addon' }); w.kv.put = put;
  assert.equal(r2.r.status, 200);
  const after = await getLicense(w.env, rec.id); assert.equal(after.billing.addons.branches, 1, 'the retry really applied it'); assert.equal(after.branchAllowance, (rec.branchAllowance || 0) + 1);
});
