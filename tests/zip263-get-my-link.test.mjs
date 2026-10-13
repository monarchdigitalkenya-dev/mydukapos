import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { saveGatewayConfig } from '../functions/api/_gateway-config.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { onRequestPost as gml } from '../functions/api/get-my-link.js';

// zip 263 - "Get my own link": nothing is created before payment is confirmed; the shop is found from the address; the buyer's secret never reaches the owner list.
async function world({ stk }) {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const sess = await oa.createOwnerSession(env, acct);
  if (stk) await saveGatewayConfig(env, acct.ownerClientId, { mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p', mpesaEnv: 'production' });
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const call = (body, { as = 'demo_retail', owner = false } = {}) => gml({ env, request: new Request('https://x.pages.dev/api/get-my-link?c=' + as, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + sess } : {}) }, body: JSON.stringify(body) }) }).then(async (r) => ({ r, j: await r.json() }));
  const clients = () => JSON.parse(kv.data.get('license-index:v1').value).filter((c) => c.label && c.label.startsWith('Mary'));
  return { env, kv, acct, call, clients };
}
const buyer = { action: 'start', name: 'Mary Wanjiku', phone: '0712345678', email: 'mary@example.com' };

test('only a sample shop can ask; a normal shop and a bad form are refused', async () => {
  const w = await world({ stk: false });
  seedShop(w.kv, 'REAL1', { type: 'permanent' });
  assert.equal((await w.call({ action: 'options' }, { as: 'REAL1' })).r.status, 403);
  assert.equal((await w.call({ ...buyer, name: 'M' })).r.status, 400);
  assert.equal((await w.call({ ...buyer, phone: '12' })).r.status, 400);
  assert.equal((await w.call({ ...buyer, email: 'nope' })).r.status, 400);
  assert.equal((await w.call({ action: 'status', id: 'x', token: 'y' })).r.status, 404);
});

test('no gateway: "I\'ve made this payment" waits for the owner; the link exists only after Confirm', async () => {
  const w = await world({ stk: false });
  const o = await w.call({ action: 'options' }); assert.equal(o.j.stk, false); assert.equal(o.j.amount, 3000); assert.equal(o.j.product, 'shop');
  const s = await w.call(buyer); assert.equal(s.j.method, 'claim'); assert.ok(s.j.token);
  assert.equal((await w.call({ action: 'claim', id: s.j.id, token: 'wrong' })).r.status, 404, 'wrong secret');
  assert.equal((await w.call({ action: 'claim', id: s.j.id, token: s.j.token })).j.status, 'claimed');
  assert.deepEqual(w.clients(), [], 'nothing created yet');
  assert.equal((await w.call({ action: 'status', id: s.j.id, token: s.j.token })).j.link, undefined);
  assert.equal((await w.call({ action: 'list' })).r.status, 401, 'owner only');
  const list = (await w.call({ action: 'list' }, { owner: true })).j.requests;
  assert.equal(list[0].status, 'claimed'); assert.equal(list[0].token, undefined, 'the buyer secret is not shown to the owner');
  const c = await w.call({ action: 'confirm', id: s.j.id }, { owner: true }); assert.match(c.j.request.link, /^https:\/\/mary-wanjiku\.[^/]+\/\?c=/);
  const done = await w.call({ action: 'status', id: s.j.id, token: s.j.token }); assert.equal(done.j.status, 'paid'); assert.equal(done.j.link, c.j.request.link);
  await w.call({ action: 'confirm', id: s.j.id }, { owner: true });
  assert.equal(w.clients().length, 1, 'confirming twice does not make a second link');
});

test('gateway set up: the prompt is sent, the link appears only when the callback says paid', async () => {
  const w = await world({ stk: true });
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('oauth')) return new Response(JSON.stringify({ access_token: 't' })); return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1', CustomerMessage: 'ok' })); };
  try {
    assert.equal((await w.call({ action: 'options' })).j.stk, true);
    const s = await w.call(buyer); assert.equal(s.j.method, 'stk');
    assert.ok(calls.some((c) => c.includes('stkpush')), 'the prompt went out');
    assert.equal((await w.call({ action: 'claim', id: s.j.id, token: s.j.token })).r.status, 400, 'no manual claim when the prompt is available');
    assert.equal((await w.call({ action: 'status', id: s.j.id, token: s.j.token })).j.status, 'pending');
    const key = `mpesa-tx:${w.acct.ownerClientId}:ws_CO_1`;
    const tx = JSON.parse(w.kv.data.get(key).value);
    w.kv.data.set(key, { value: JSON.stringify({ ...tx, status: 'success', receiptNumber: 'ABC' }) });
    const done = await w.call({ action: 'status', id: s.j.id, token: s.j.token });
    assert.equal(done.j.status, 'paid'); assert.match(done.j.link, /mary-wanjiku/);
  } finally { globalThis.fetch = real; }
});

// ---- repeat buyers (phone / email already on a shop), optional email, and the licence PDF ----
import { createClient, getLicense, listClientSummaries } from '../functions/api/_license.js';
const text = async (r) => Buffer.from(await r.arrayBuffer()).toString('latin1');

test('the email is optional and a phone that already exists is never refused', async () => {
  const w = await world({ stk: false });
  const a = await w.call({ ...buyer, email: '' }); assert.equal(a.r.status, 200); assert.ok(a.j.token);
  const b = await w.call({ ...buyer, email: undefined, name: 'Mary Again' }); assert.equal(b.r.status, 200, 'the same phone, no email, asked again: fine');
});

test('a phone or email already on a shop of this product is offered a BRANCH, not blocked; other products are ignored; the shop is never named', async () => {
  const w = await world({ stk: false });
  const mine = await createClient(w.env, 'permanent', 'Maryshardware', 'shop', { clientName: 'Mary', phone: '+254 712 345 678', email: 'Mary@Example.com' });
  await createClient(w.env, 'permanent', 'Hotel Mary', 'hotel', { phone: '0799000111' });
  const first = await w.call({ action: 'start', name: 'Mary W', phone: '0712345678', email: '' });       // phone matches (any spelling)
  assert.equal(first.j.needChoice, true); assert.equal(first.j.branchAmount, 3000, 'a branch costs the same unless the owner sets another price'); assert.equal(first.j.amount, 3000);
  assert.ok(!JSON.stringify(first.j).includes('Maryshardware') && !JSON.stringify(first.j).includes(mine.id), 'nothing about the existing shop is revealed');
  assert.equal((await w.call({ action: 'start', name: 'Mary W', phone: '0700111222', email: 'mary@example.com' })).j.needChoice, true, 'the email matches (any case)');
  assert.equal((await w.call({ action: 'start', name: 'Hotel Man', phone: '0799000111', email: '' })).j.needChoice, undefined, 'a hotel shop does not make a shop-sample buyer a branch');
  // choose a branch: cheaper, and the link joins the existing shop's group only after payment is confirmed
  // zip 267: a phone or email is not proof of owning a shop: joining its group needs that shop's own Admin password (its SHA-256, as the apps send it)
  const pw = (await import('node:crypto')).createHash('sha256').update('maryadmin').digest('hex');
  w.kv.data.set('pos-data:state:' + mine.id, { value: JSON.stringify({ pwHash: pw }) });
  assert.equal((await w.call({ action: 'start', name: 'Mary W', phone: '0712345678', email: '', choice: 'branch' })).r.status, 403, 'no password: not attached');
  assert.equal((await w.call({ action: 'start', name: 'Mary W', phone: '0712345678', email: '', choice: 'branch', branchProof: '0'.repeat(64) })).r.status, 403, 'a wrong password: not attached');
  const br = await w.call({ action: 'start', name: 'Mary W', phone: '0712345678', email: '', choice: 'branch', branchProof: pw });
  assert.equal(br.j.kind, 'branch'); assert.equal(br.j.amount, 3000);
  assert.ok(!(await getLicense(w.env, mine.id)).branchGroupId, 'nothing changed before payment');
  await w.call({ action: 'claim', id: br.j.id, token: br.j.token });
  const ok = await w.call({ action: 'confirm', id: br.j.id }, { owner: true });
  const parent = await getLicense(w.env, mine.id); const branch = await getLicense(w.env, ok.j.request.clientId);
  assert.ok(parent.branchGroupId && parent.isMainBranch); assert.equal(branch.branchGroupId, parent.branchGroupId); assert.equal(branch.isMainBranch, false);
  assert.match(ok.j.request.link, /maryshardware1\./, 'numbered after the main shop like every branch');
  assert.equal(branch.paidAmount, 3000);
  // choose separate: a normal new link at the full price
  const sep = await w.call({ action: 'start', name: 'Mary W', phone: '0712345678', email: '', choice: 'separate' });
  assert.equal(sep.j.kind, 'new'); assert.equal(sep.j.amount, 3000);
});

test('licence PDF: only after full payment, only for the buyer (secret) or the owner, with the link and money paid', async () => {
  const w = await world({ stk: false });
  const s = await w.call(buyer);
  assert.equal((await w.call({ action: 'licence', id: s.j.id, token: s.j.token })).r.status, 400, 'no licence before payment');
  await w.call({ action: 'claim', id: s.j.id, token: s.j.token });
  const c = await w.call({ action: 'confirm', id: s.j.id }, { owner: true });
  const r = await gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', body: JSON.stringify({ action: 'licence', id: s.j.id, token: s.j.token }) }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'application/pdf'); assert.match(r.headers.get('Content-Disposition'), /MyDukaPOS-licence-L\d{4}-[A-Z0-9]{5}\.pdf/);
  const pdf = await text(r);
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  for (const want of ['Mary Wanjiku', 'KES 3,000', 'PAID IN FULL', c.j.request.link, c.j.request.licenceNo]) assert.ok(pdf.includes(want), 'the PDF carries: ' + want);
  const wrong = await gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', body: JSON.stringify({ action: 'licence', id: s.j.id, token: 'nope' }) }) });
  assert.equal(wrong.status, 404);
  const o = await gml({ env: w.env, request: new Request('https://x.pages.dev/api/get-my-link', { method: 'POST', headers: { Authorization: 'Bearer ' + (await oa.createOwnerSession(w.env, w.acct)) }, body: JSON.stringify({ action: 'licence', id: s.j.id }) }) });
  assert.equal(o.status, 200); assert.equal(o.headers.get('Content-Type'), 'application/pdf');
});

// ---- typed web address, and Paywave Express (the owner's gateway): a link only after money is RECEIVED ----
test('the buyer types the web address: checked as free, or offered name-1; unusable names are refused; the link uses it', async () => {
  const w = await world({ stk: false });
  await createClient(w.env, 'permanent', 'Maryshop', 'shop', {});                     // maryshop is taken
  assert.deepEqual((await w.call({ action: 'slug', slug: 'Georges Hardware' })).j, { ok: true, slug: 'georges-hardware', taken: false });
  assert.deepEqual((await w.call({ action: 'slug', slug: 'maryshop.mydukapos.store' })).j, { ok: true, slug: 'maryshop-1', taken: true }, 'typing the whole address works too');
  assert.equal((await w.call({ action: 'slug', slug: 'ab' })).j.ok, false);
  assert.equal((await w.call({ action: 'slug', slug: 'demo-mine' })).j.ok, false, 'never a demo- address');
  assert.equal((await w.call({ action: 'slug', slug: 'www' })).j.slug, 'www-1', 'reserved names get the suffix too');
  assert.equal((await w.call({ ...buyer, slug: 'x' })).r.status, 400, 'a bad address stops the request before anything is sent');
  const s = await w.call({ ...buyer, slug: 'maryshop' }); await w.call({ action: 'claim', id: s.j.id, token: s.j.token });
  const c = await w.call({ action: 'confirm', id: s.j.id }, { owner: true });
  assert.match(c.j.request.link, /^https:\/\/maryshop-1\./, 'taken, so -1');
  const t = await w.call({ ...buyer, name: 'Other Person', phone: '0722111222', email: '', slug: 'maryshop' }); await w.call({ action: 'claim', id: t.j.id, token: t.j.token });
  assert.match((await w.call({ action: 'confirm', id: t.j.id }, { owner: true })).j.request.link, /^https:\/\/maryshop-2\./, 'and the next one -2');
  const free = await w.call({ ...buyer, name: 'Third Person', phone: '0733111222', email: '', slug: 'Brand New Name' }); await w.call({ action: 'claim', id: free.j.id, token: free.j.token });
  assert.match((await w.call({ action: 'confirm', id: free.j.id }, { owner: true })).j.request.link, /^https:\/\/brand-new-name\./);
});

test('Paywave Express: the prompt does not make a link; "accepted" without a receipt does not either; a receipt does', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  await saveGatewayConfig(env, acct.ownerClientId, { paywaveApiKey: 'k', paywaveEmail: 'o@example.com' });
  await ensureSharedDemo(env, SHARED_DEMOS.find((d) => d.key === 'retail'));
  const call = (body) => gml({ env, request: new Request('https://x.pages.dev/api/get-my-link?c=demo_retail', { method: 'POST', body: JSON.stringify(body) }) }).then((r) => r.json());
  let tstatus = { ResponseCode: '0', TransactionStatus: 'Pending' };
  const real = globalThis.fetch; const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response(JSON.stringify(String(u).includes('tstatus') ? tstatus : { ResponseCode: '0', CheckoutRequestID: 'ws1', transaction_request_id: 'tr1', message: 'sent' })); };
  try {
    assert.equal((await call({ action: 'options' })).stk, true);
    const s = await call({ ...buyer }); assert.equal(s.method, 'stk');
    const key = `mpesa-tx:${acct.ownerClientId}:ws1`;
    assert.equal(JSON.parse(kv.data.get(key).value).provider, 'paywave');
    const before = async () => (await listClientSummaries(env)).filter((c) => c.label && c.label.startsWith('Mary')).length;
    assert.equal((await call({ action: 'status', id: s.id, token: s.token })).status, 'pending'); assert.equal(await before(), 0, 'prompt sent: no link');
    const old = JSON.parse(kv.data.get(key).value); kv.data.set(key, { value: JSON.stringify({ ...old, createdAt: Date.now() - 60000 }) });
    assert.equal((await call({ action: 'status', id: s.id, token: s.token })).status, 'pending', 'asked, and still not paid'); assert.equal(await before(), 0);
    assert.ok(urls.some((u) => u.includes('/v1/tstatus')), 'Paywave was asked for the result');
    kv.data.set(key, { value: JSON.stringify({ ...JSON.parse(kv.data.get(key).value), checkedAt: 0 }) });
    tstatus = { ResponseCode: '0', TransactionStatus: 'Completed', TransactionReceipt: 'QAB1234XYZ', TransactionAmount: '3000' };
    const done = await call({ action: 'status', id: s.id, token: s.token });
    assert.equal(done.status, 'paid'); assert.match(done.link, /^https:\/\/mary-wanjiku\./); assert.equal(await before(), 1);
    const list = (await gml({ env, request: new Request('https://x.pages.dev/api/get-my-link', { method: 'POST', headers: { Authorization: 'Bearer ' + (await oa.createOwnerSession(env, acct)) }, body: JSON.stringify({ action: 'list' }) }) }).then((r) => r.json())).requests;
    assert.equal(list[0].receipt, 'QAB1234XYZ', 'the M-Pesa receipt is kept (it is on the licence)');
  } finally { globalThis.fetch = real; }
});
