import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV } from './kv-fake.mjs';
import { SHARED_DEMOS, ensureSharedDemo, SEED_MARK } from '../functions/api/_shared-demos.js';
import { buildDemoSeed, SEED_BUILDERS } from '../functions/api/_demo-seeds.js';
import { DEMO_PASSWORD_HASH } from '../functions/api/_demo-const.js';
import { onRequestPost as syncPost, onRequestGet as syncGet } from '../functions/api/pos-sync.js';
import { onRequestGet as statusGet } from '../functions/api/license-status.js';
import { onRequestGet as listGet } from '../functions/api/shared-demos.js';
import { seedShop } from './kv-fake.mjs';

const env = () => { const kv = makeKV(); seedShop(kv, 'REAL1', { type: 'permanent', createdAt: Date.UTC(2026, 9, 20) }); return { mydukapos_kv: kv }; };
const req = (p, id, method = 'GET', body) => new Request('https://x.pages.dev' + p + (p.includes('?') ? '&' : '?') + 'c=' + id, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

test('every demo has a generator, fixed ids, and no embedded images', () => {
  for (const d of SHARED_DEMOS) {
    assert.ok(SEED_BUILDERS[d.key], d.key + ' has sample data');
    const s = buildDemoSeed(d.key, Date.UTC(2026, 9, 12));
    const text = JSON.stringify(s);
    assert.ok(!/data:image|base64,/.test(text), d.key + ': no base64 pictures in the stored data');
    assert.ok(text.length < 400 * 1024, d.key + ': stays small (' + Math.round(text.length / 1024) + ' KB)');
    assert.deepEqual(JSON.parse(JSON.stringify(buildDemoSeed(d.key, Date.UTC(2026, 9, 12)))), JSON.parse(text), d.key + ': the same shop every time');
  }
});

test('seeding is idempotent, versioned and only ever touches the demo shops', async () => {
  const e = env();
  const spec = SHARED_DEMOS.find((d) => d.key === 'retail');
  const a = await ensureSharedDemo(e, spec);
  assert.equal(a.seeded, true);
  const b = await ensureSharedDemo(e, spec);
  assert.equal(b.seeded, false, 'a second visit seeds nothing');
  const st = JSON.parse(e.mydukapos_kv.data.get('pos-data:state:demo_retail').value);
  assert.equal(st.pwHash, DEMO_PASSWORD_HASH);
  assert.ok(st.inventory.length > 20 && st.salesLog.length > 50);
  const rec = JSON.parse(e.mydukapos_kv.data.get('license:demo_retail').value);
  assert.equal(rec.sharedDemo, true); assert.equal(rec.expiresAt, null); assert.equal(rec.slug, 'demo-retail');
  const real = e.mydukapos_kv.data.get('pos-data:state:REAL1');
  assert.equal(real, undefined, 'no real shop was written');
  const f = await ensureSharedDemo(e, spec, { force: true });
  assert.equal(f.seeded, true, 'the owner can force a reset');
});

test('visitors cannot change the shared demo on the server, and another shop is unaffected', async () => {
  const e = env(); const spec = SHARED_DEMOS.find((d) => d.key === 'hardware');
  await ensureSharedDemo(e, spec);
  const before = e.mydukapos_kv.data.get('pos-data:state:demo_hardware').value;
  const r = await syncPost({ request: req('/api/pos-sync', 'demo_hardware', 'POST', { inventory: [], salesLog: [{ id: 'evil' }], updatedAt: Date.now() + 99999 }), env: e, waitUntil() {} });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.stored, false);
  assert.equal(e.mydukapos_kv.data.get('pos-data:state:demo_hardware').value, before, 'nothing stored for the demo');
  const g = await syncGet({ request: req('/api/pos-sync', 'demo_hardware'), env: e, waitUntil() {} });
  assert.equal(g.status, 200);
  const body = await g.json();
  assert.ok(Array.isArray(body.inventory) && body.inventory.length > 20, 'a visitor receives the loaded sample');
  const s = await (await statusGet({ request: req('/api/license-status', 'demo_hardware'), env: e })).json();
  assert.equal(s.sharedDemo, true);
});

test('a real shop may use 0000 as its password: it is stored like any other', async () => {
  const e = env();
  const r = await syncPost({ request: req('/api/pos-sync', 'REAL1', 'POST', { pwHash: DEMO_PASSWORD_HASH, adminPwHash: DEMO_PASSWORD_HASH, businessName: 'Mama Duka', updatedAt: Date.now() }), env: e, waitUntil() {} });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.passwordRefused, undefined);
  const g = await (await syncGet({ request: req('/api/pos-sync', 'REAL1'), env: e, waitUntil() {} })).json();
  assert.equal(g.businessName, 'Mama Duka'); assert.equal(g.pwHash, DEMO_PASSWORD_HASH); assert.equal(g.adminPwHash, DEMO_PASSWORD_HASH);
});

test('the gallery list is public, cacheable and carries login instructions', async () => {
  const e = env();
  const r = await listGet({ request: new Request('https://x.pages.dev/api/shared-demos'), env: e });
  const j = await r.json();
  assert.equal(j.demos.length, SHARED_DEMOS.length);
  assert.ok(j.demos.every((d) => d.password === '0000' && d.openUrl.startsWith('/api/shared-demos?open=') && d.features.length >= 4));
  assert.match(r.headers.get('cache-control'), /max-age=300/);
  assert.equal(e.mydukapos_kv.data.has('license:demo_retail'), false, 'listing creates nothing');
});
