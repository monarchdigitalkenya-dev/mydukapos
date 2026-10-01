import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

test('convertToDemo + resetAllIncome (server)', async () => {
  const kv = makeKV(); seedShop(kv, 'C1', { revenue: { at: 1, agreed: 100, paid: 50 }, agreedAmount: 100, paidAmount: 50, balanceOwed: 50 });
  kv.data.set('owner-session:tok', { value: '1' });
  kv.data.set('owner-group-income:v1', { value: '{"a":{"entries":[1]}}' });
  const env = { mydukapos_kv: kv };
  const lock = async (body) => { const m = await load('owner-lock.js'); const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-lock', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env }); return { status: r.status, body: await r.json() }; };
  const reset = await lock({ action: 'resetAllIncome' });
  assert.equal(reset.status, 200); assert.equal(reset.body.cleared, 1);
  const rec = JSON.parse(kv.data.get('license:C1').value);
  assert.ok(!rec.revenue); assert.equal(rec.paidAmount, 0); assert.equal(rec.balanceOwed, 0);
  assert.ok(!kv.data.get('owner-group-income:v1'), 'person ledger cleared');
  const c = await lock({ c: 'C1', action: 'convertToDemo' });
  assert.equal(c.status, 200); assert.equal(c.body.client.type, 'demo'); assert.ok(c.body.client.expiresAt > Date.now());
  assert.equal((await lock({ c: 'C1', action: 'convertToDemo' })).status, 400, 'a demo cannot be converted again');
});

test('owner-clients: staff with the Generate Link tab create a link with their PIN; others refused', async () => {
  const kv = makeKV();
  const pin = await sha('1234');
  kv.data.set('owner-account:v1', { value: JSON.stringify({ identifier: 'o', ownerClientId: 'OWN' }) });
  const m0 = await load('_owner-auth.js');
  seedShop(kv, 'OWN');
  const stateKey = 'pos-data:state:OWN';
  kv.data.set(stateKey, { value: JSON.stringify({ staff: [
    { id: 'a', name: 'Ann', pinHash: pin, roles: ['sales-tab'] },
    { id: 'b', name: 'Bob', pinHash: pin, roles: [] },
    { id: 'c', name: 'Cy', pinHash: pin, roles: ['sales-tab'], removed: true },
  ] }) });
  const env = { mydukapos_kv: kv };
  const post = async (staff) => { const m = await load('owner-clients.js'); const r = await m.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-clients', { method: 'POST', body: JSON.stringify({ type: 'demo', label: 'Zed Shop', product: 'shop', clientName: 'Zed', staff }), headers: { 'content-type': 'application/json' } }), env }); return { status: r.status, body: await r.json() }; };
  const acct = await m0.getOwnerAccount(env);
  assert.ok(acct, "owner account found");
  assert.equal((await post(null)).status, 401);
  assert.equal((await post({ id: 'a', proof: await sha('9999') })).status, 403, 'wrong PIN');
  assert.equal((await post({ id: 'b', proof: pin })).status, 403, 'no Generate Link tab');
  assert.equal((await post({ id: 'c', proof: pin })).status, 403, 'removed staff');
  const ok = await post({ id: 'a', proof: pin });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.body.link);
});

test('owner console: one way to count money; removed staff stay gone', async () => {
  const b = await boot('owner/index.html', { wait: 800 });
  const { w } = b;
  const r = (s) => w.eval(s);
  r(`salesLog = [
    { id:'1', timestamp:new Date().toISOString(), items:[{name:'x',price:100,qty:2}], paid:true },
    { id:'2', timestamp:new Date().toISOString(), items:[{name:'x',price:500,qty:1}], paid:false },
    { id:'3', timestamp:new Date().toISOString(), items:[{name:'x',price:700,qty:1}], paid:true, voided:true },
    { id:'4', timestamp:new Date().toISOString(), items:[{name:'x',price:300,qty:1}], paid:true, amountReceived:120 } ]`);
  assert.equal(r('salesLog.reduce((s,x)=>s+saleReceived(x),0)'), 320);
  assert.equal(r('revenueForDate(dayKeyOf(Date.now()))'), 320);
  r('staff = [{id:"s1",name:"A",pinHash:"x",roles:[]}]; performRemoveStaffMember("s1")');
  assert.equal(r('staff.find(s=>s.id==="s1").removed'), true);
  b.close();
});
