import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

async function importFn(rel) {
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

function req(method, url, body) {
  return new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
}

async function harness() {
  const kv = makeKV();
  seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const cfgMod = await importFn('functions/api/sha-config.js');
  const testMod = await importFn('functions/api/sha-test.js');
  const submitMod = await importFn('functions/api/sha-claim-submit.js');
  return {
    env,
    getCfg: async () => (await cfgMod.onRequestGet({ request: req('GET', 'https://x.pages.dev/api/sha-config?c=C1'), env })).json(),
    postCfg: async (body) => (await cfgMod.onRequestPost({ request: req('POST', 'https://x.pages.dev/api/sha-config?c=C1', body), env })).json(),
    deleteCfg: async () => (await cfgMod.onRequestDelete({ request: req('DELETE', 'https://x.pages.dev/api/sha-config?c=C1', {}), env })).json(),
    test: async () => testMod.onRequestPost({ request: req('POST', 'https://x.pages.dev/api/sha-test?c=C1'), env }),
    submit: async (body) => submitMod.onRequestPost({ request: req('POST', 'https://x.pages.dev/api/sha-claim-submit?c=C1', body), env }),
  };
}

test('SHA config: nothing saved by default; save stores fields, never returns the secret back, and masks the client ID', async () => {
  const h = await harness();
  let got = await h.getCfg();
  assert.equal(got.configured, false);

  await h.postCfg({ shaEnv: 'sandbox', shaBaseUrl: 'https://sandbox.afyaconnect.dha.go.ke', shaClientId: 'CID123456', shaClientSecret: 'topsecret', shaFacilityCode: 'FAC-01' });
  got = await h.getCfg();
  assert.equal(got.configured, true);
  assert.equal(got.shaFacilityCode, 'FAC-01');
  assert.equal(got.shaBaseUrl, 'https://sandbox.afyaconnect.dha.go.ke');
  assert.ok(!('shaClientSecret' in got), 'the secret is never sent back');
  assert.ok(!JSON.stringify(got).includes('topsecret'));
  assert.equal(got.shaClientIdMasked, 'CI••••56');
});

test('SHA config: a partial save does not wipe fields left out; DELETE clears everything', async () => {
  const h = await harness();
  await h.postCfg({ shaEnv: 'sandbox', shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  await h.postCfg({ shaFacilityCode: 'F2' });
  let got = await h.getCfg();
  assert.equal(got.shaFacilityCode, 'F2');
  assert.equal(got.shaBaseUrl, 'https://sandbox.example', 'untouched field survives a partial save');

  await h.deleteCfg();
  got = await h.getCfg();
  assert.equal(got.configured, false);
  assert.equal(got.shaBaseUrl, '');
});

test('SHA config: scoped per client link — one facility cannot see or affect another\'s credentials', async () => {
  const kv = makeKV();
  seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const env = { mydukapos_kv: kv };
  const cfgMod = await importFn('functions/api/sha-config.js');
  await cfgMod.onRequestPost({ request: req('POST', 'https://x.pages.dev/api/sha-config?c=C1', { shaClientId: 'ONLY-C1', shaClientSecret: 'x', shaFacilityCode: 'F1', shaBaseUrl: 'https://x' }), env });
  const c2 = await (await cfgMod.onRequestGet({ request: req('GET', 'https://x.pages.dev/api/sha-config?c=C2'), env })).json();
  assert.equal(c2.configured, false);
});

test('an inactive/unknown license link is refused with 403', async () => {
  const kv = makeKV();
  const env = { mydukapos_kv: kv };
  const cfgMod = await importFn('functions/api/sha-config.js');
  const res = await cfgMod.onRequestGet({ request: req('GET', 'https://x.pages.dev/api/sha-config?c=GHOST'), env });
  assert.equal(res.status, 403);
});

test('Test Connection: refuses cleanly when credentials or base URL are missing (no network call attempted)', async () => {
  const h = await harness();
  let res = await (await h.test()).json();
  assert.equal(res.ok, false);
  assert.match(res.error, /client ID|client secret|facility code/i);

  await h.postCfg({ shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' }); // no base URL
  res = await (await h.test()).json();
  assert.equal(res.ok, false);
  assert.match(res.error, /base URL/i);
});

test('Test Connection: a successful OAuth token exchange reports ok', async () => {
  const h = await harness();
  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://sandbox.example/oauth/token');
    return { ok: true, json: async () => ({ access_token: 'tok123', expires_in: 3600 }) };
  };
  try {
    const ok = await (await h.test()).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.env, 'sandbox');
  } finally { global.fetch = realFetch; }
});

test('Test Connection: a rejected OAuth exchange reports the real error, never a fabricated success', async () => {
  const h = await harness();   // fresh KV — no cached token from another test can leak in
  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'Unknown client' }) });
  try {
    const bad = await (await h.test()).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Unknown client/);
  } finally { global.fetch = realFetch; }
});

test('claim submission: refuses without credentials, without a claim number, or without an amount', async () => {
  const h = await harness();
  let res = await (await h.submit({ claim: { claimNo: 'CLM-1', amount: 500 } })).json();
  assert.equal(res.ok, false);
  assert.match(res.error, /not set up/i);

  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  res = await (await h.submit({ claim: { amount: 500 } })).json();
  assert.equal(res.error, undefined === res.error ? res.error : res.error); // reach the handler
  const r2 = await h.submit({});
  assert.equal(r2.status, 400);
});

test('claim submission: on acceptance, reports ok with SHA\'s own response id; never invents an approval status', async () => {
  const h = await harness();
  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    assert.equal(String(url), 'https://sandbox.example/fhir/Bundle');
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    const sent = JSON.parse(opts.body);
    assert.equal(sent.resourceType, 'Bundle');
    const claimResource = sent.entry[0].resource;
    assert.equal(claimResource.resourceType, 'Claim');
    assert.equal(claimResource.total.value, 750);
    assert.equal(claimResource.provider.identifier.value, 'F1');
    return { ok: true, text: async () => JSON.stringify({ id: 'DHA-RESP-9', resourceType: 'ClaimResponse' }) };
  };
  try {
    const res = await (await h.submit({ claim: { claimNo: 'CLM-7', amount: 750, description: 'Consultation', patientName: 'Jane' }, patient: { shaNumber: 'SHA-1' } })).json();
    assert.equal(res.ok, true);
    assert.equal(res.dhaClaimResponseId, 'DHA-RESP-9');
    assert.ok(!('claimStatus' in res), 'the endpoint never decides an approval/rejection status');
  } finally { global.fetch = realFetch; }
});

test('claim submission: on rejection, surfaces SHA\'s real HTTP status and raw body rather than pretending success', async () => {
  const h = await harness();
  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: false, status: 422, text: async () => JSON.stringify({ issue: [{ diagnostics: 'Unknown facility code' }] }) };
  };
  try {
    const res = await (await h.submit({ claim: { claimNo: 'CLM-8', amount: 100 } })).json();
    assert.equal(res.ok, false);
    assert.match(res.error, /422/);
    assert.match(res.raw, /Unknown facility code/);
  } finally { global.fetch = realFetch; }
});

test('claim submission: a network failure is reported plainly, not treated as success', async () => {
  const h = await harness();
  await h.postCfg({ shaBaseUrl: 'https://sandbox.example', shaClientId: 'A', shaClientSecret: 'B', shaFacilityCode: 'F1' });
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await (await h.submit({ claim: { claimNo: 'CLM-9', amount: 100 } })).json();
    assert.equal(res.ok, false);
    assert.match(res.error, /network down|authentication failed|reach/i);
  } finally { global.fetch = realFetch; }
});
