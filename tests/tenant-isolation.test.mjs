import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// PHASE 16 / 24 (zip 118): try to reach another tenant by changing ids in the request. The shop is decided by the LINK
// (subdomain, or ?c= on the apex) — never by anything in the body — and a movement can only ever touch the shop it was sent to.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
async function twoShops() {
  const sync = await load('functions/api/pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const env = { mydukapos_kv: kv };
  const req = (url, method, body, headers = {}) => new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
  const post = async (url, body, headers) => (await sync.onRequestPost({ request: req(url, 'POST', { businessName: 'B', updatedAt: Date.now(), ...body }, headers), env, waitUntil() {} })).json();
  const get = async (url) => (await sync.onRequestGet({ request: req(url, 'GET'), env })).json();
  const state = (id) => JSON.parse(kv.data.get(`pos-data:state:${id}`)?.value || '{}');
  return { post, get, state };
}
const inv = (code, qty) => ({ code, name: code, qty, price: 10, updatedAt: 1 });

test('ids in the BODY (clientId, c, tenantId, shopId, branchId) cannot redirect a push to another shop', async () => {
  const s = await twoShops();
  await s.post('https://x.pages.dev/api/pos-sync?c=C2', { inventory: [inv('V', 50)] });
  await s.post('https://x.pages.dev/api/pos-sync?c=C1', { clientId: 'C2', c: 'C2', tenantId: 'C2', shopId: 'C2', branchId: 'C2',
    inventory: [inv('V', 0)], stockMovementLog: [{ id: 'evil1', code: 'V', delta: -50, timestamp: new Date().toISOString() }] });
  assert.equal(s.state('C2').inventory[0].qty, 50, "the other shop's stock is untouched");
  assert.equal((s.state('C2').stockMovementLog || []).length, 0);
  assert.ok(s.state('C1').inventory.find((i) => i.code === 'V'), 'it landed in the shop the link names');
});

test('on a shop\'s own subdomain, ?c= naming another shop is ignored (read and write)', async () => {
  const s = await twoShops();
  await s.post('https://x.pages.dev/api/pos-sync?c=C2', { inventory: [inv('SECRET', 7)] });
  const read = await s.get('https://shop-c1.mydukapos.store/api/pos-sync?c=C2');
  assert.ok(!(read.inventory || []).some((i) => i.code === 'SECRET'), 'C1\'s link cannot read C2');
  await s.post('https://shop-c1.mydukapos.store/api/pos-sync?c=C2', { inventory: [inv('X', 1)] });
  assert.ok(!(s.state('C2').inventory || []).some((i) => i.code === 'X'), 'nor write to it');
});

test('a movement or a stock count naming another shop\'s item / Aqua record changes nothing anywhere else', async () => {
  const s = await twoShops();
  await s.post('https://x.pages.dev/api/pos-sync?c=C2', { inventory: [inv('V', 50)], tanks: [{ id: 't2', siteId: 's', currentVolumeLiters: 900, updatedAt: 1 }] });
  await s.post('https://x.pages.dev/api/pos-sync?c=C1', { stockMovementLog: [
    { id: 'e1', kind: 'count', code: 'V', counted: 0, before: 50, delta: -50, timestamp: new Date().toISOString() },
    { id: 'e2', cell: { c: 'tanks', k: 'id:t2', f: 'currentVolumeLiters' }, delta: -900, timestamp: new Date().toISOString() },
  ] });
  assert.equal(s.state('C2').inventory[0].qty, 50);
  assert.equal(s.state('C2').tanks[0].currentVolumeLiters, 900);
});

test('an unknown or inactive link is refused outright (403), for reads and writes', async () => {
  const s = await twoShops();
  const r1 = await s.get('https://x.pages.dev/api/pos-sync?c=NOPE');
  assert.match(String(r1.error || ''), /not active/);
  const r2 = await s.post('https://x.pages.dev/api/pos-sync?c=NOPE', { inventory: [inv('A', 1)] });
  assert.match(String(r2.error || ''), /not active/);
});

test('opt-in hardening: with ROUTER_SHARED_SECRET set, a forged X-Forwarded-Host without the router\'s secret is not believed', async () => {
  const { resolveClientId } = await load('functions/api/_license.js');
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const slug = JSON.parse(kv.data.get('license:C2').value).slug;
  kv.data.set(`slug:${slug.toLowerCase()}`, { value: 'C2' });                  // the subdomain is registered to C2
  const req = (headers) => new Request('https://mydukapos.pages.dev/api/pos-sync', { headers });
  const open = { mydukapos_kv: kv };
  const hardened = { mydukapos_kv: kv, ROUTER_SHARED_SECRET: 's3cret' };
  // (slugs are matched the same way as before: whatever resolves today keeps resolving)
  const today = await resolveClientId(req({ 'X-Forwarded-Host': `${slug}.mydukapos.store` }), open);
  const forged = await resolveClientId(req({ 'X-Forwarded-Host': `${slug}.mydukapos.store` }), hardened);
  const viaRouter = await resolveClientId(req({ 'X-Forwarded-Host': `${slug}.mydukapos.store`, 'X-Router-Secret': 's3cret' }), hardened);
  assert.equal(today, 'C2', 'without the setting: as before');
  assert.equal(viaRouter, 'C2', 'the real router (with the secret) still reaches the shop');
  assert.notEqual(forged, 'C2', 'a forged header alone no longer names the shop');
});
