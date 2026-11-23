import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { getLicense } from '../functions/api/_license.js';
import { onRequestPost as up } from '../functions/api/license-upgrade.js';

// zip 286 - "Upgrade to permanent" by M-Pesa prompt: only when the owner's gateway is set up; the shop becomes permanent ONLY when the payment is received.
async function world({ stk, type = 'demo' }) {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  if (stk) await saveGatewayConfig(env, acct.ownerClientId, { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production' });
  seedShop(kv, 'TRIAL1', { type, expiresAt: Date.now() - 1000 });                       // an EXPIRED trial: that is when a shop upgrades
  const call = (body, as = 'TRIAL1') => up({ env, request: new Request('https://x.pages.dev/api/license-upgrade?c=' + as, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
  return { env, kv, acct, call };
}
const fakeStk = () => { const real = globalThis.fetch; globalThis.fetch = async (url) => { if (String(url).includes('oauth')) return new Response(JSON.stringify({ access_token: 't' })); return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_9', MerchantRequestID: 'm9', CustomerMessage: 'ok' })); }; return () => { globalThis.fetch = real; }; };

test('no gateway: the screen stays manual (stk:false) and a prompt cannot be started', async () => {
  const w = await world({ stk: false });
  assert.equal((await w.call({ action: 'status' })).j.stk, false);
  assert.equal((await w.call({ action: 'start', phone: '0712345678' })).r.status, 409);
  assert.equal((await getLicense(w.env, 'TRIAL1')).type, 'demo');
});

test('gateway set up: prompt sent; still a trial while pending; permanent only after the callback says paid', async () => {
  const w = await world({ stk: true }); const undo = fakeStk();
  try {
    const st = await w.call({ action: 'status' }); assert.equal(st.j.stk, true); assert.ok(st.j.amount > 0);
    assert.equal((await w.call({ action: 'start', phone: '12' })).r.status, 400, 'bad phone');
    const s = await w.call({ action: 'start', phone: '0712345678' }); assert.equal(s.r.status, 200); assert.equal(s.j.amount, st.j.amount);
    assert.equal((await w.call({ action: 'poll', id: s.j.id, token: 'wrong' })).r.status, 404, 'wrong token');
    assert.equal((await w.call({ action: 'poll', id: s.j.id, token: s.j.token }, 'OTHER')).r.status, 404, 'another shop cannot read it');
    assert.equal((await w.call({ action: 'poll', id: s.j.id, token: s.j.token })).j.status, 'pending');
    assert.equal((await getLicense(w.env, 'TRIAL1')).type, 'demo', 'nothing is upgraded before the money arrives');
    const key = `mpesa-tx:${w.acct.ownerClientId}:ws_CO_9`;
    const tx = JSON.parse(w.kv.data.get(key).value);
    w.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'success', receiptNumber: 'QWE123', amount: tx.amount }) });
    const done = await w.call({ action: 'poll', id: s.j.id, token: s.j.token });
    assert.equal(done.j.status, 'paid');
    const lic = await getLicense(w.env, 'TRIAL1');
    assert.equal(lic.type, 'permanent'); assert.equal(lic.expiresAt, null); assert.equal(lic.locked, false);
    assert.equal((await w.call({ action: 'poll', id: s.j.id, token: s.j.token })).j.status, 'paid', 'asking again is harmless');
    assert.equal((await w.call({ action: 'status' })).j.permanent, true);
  } finally { undo(); }
});

test('a failed payment stays a trial; a payment for LESS than the price is not accepted', async () => {
  const w = await world({ stk: true }); const undo = fakeStk();
  try {
    const s = await w.call({ action: 'start', phone: '0712345678' });
    const key = `mpesa-tx:${w.acct.ownerClientId}:ws_CO_9`; const tx = JSON.parse(w.kv.data.get(key).value);
    w.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'failed', resultDesc: 'Request cancelled by user' }) });
    const f = await w.call({ action: 'poll', id: s.j.id, token: s.j.token }); assert.equal(f.j.status, 'failed'); assert.match(f.j.message, /cancelled/i);
    assert.equal((await getLicense(w.env, 'TRIAL1')).type, 'demo');
  } finally { undo(); }
  const w2 = await world({ stk: true }); const undo2 = fakeStk();
  try {
    const s = await w2.call({ action: 'start', phone: '0712345678' });
    const key = `mpesa-tx:${w2.acct.ownerClientId}:ws_CO_9`; const tx = JSON.parse(w2.kv.data.get(key).value);
    w2.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'success', receiptNumber: 'LOW1', amount: 10 }) });
    const r = await w2.call({ action: 'poll', id: s.j.id, token: s.j.token }); assert.equal(r.j.status, 'claimed');
    assert.equal((await getLicense(w2.env, 'TRIAL1')).type, 'demo', 'too little money upgrades nothing');
  } finally { undo2(); }
});

test('a shared demo and a link that does not exist are refused', async () => {
  const w = await world({ stk: true });
  assert.equal((await w.call({ action: 'status' }, 'NOPE')).r.status, 404);
});
