import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 133: pictures for every module in Cloudflare R2 (KV fallback), product photos moved out of the synced item list,
// "not collected" reason optional, 🔔 approvals badge.
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const JPEG = (n = 2000) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]).toString('base64');
function makeR2() {
  const m = new Map();
  return {
    m,
    async put(k, v, o) { m.set(k, { bytes: new Uint8Array(v), httpMetadata: (o && o.httpMetadata) || {}, customMetadata: (o && o.customMetadata) || {} }); },
    async get(k) { const x = m.get(k); return x ? { ...x, arrayBuffer: async () => x.bytes.buffer.slice(x.bytes.byteOffset, x.bytes.byteOffset + x.bytes.byteLength) } : null; },
    async head(k) { return m.has(k) ? {} : null; },
    async delete(k) { m.delete(k); },
  };
}
const post = (m, env, c, body) => m.onRequestPost({ request: new Request(`https://x.pages.dev/api/media?c=${c}`, { method: 'POST', body: JSON.stringify(body) }), env });
const get = (m, env, c, q) => m.onRequestGet({ request: new Request(`https://x.pages.dev/api/media?c=${c}&${q}`), env });

test('media: stored in R2 under the shop, read back as the image itself (cacheable), idempotent, other shops cannot read it', async () => {
  const kv = makeKV(); seedShop(kv, 'C1'); seedShop(kv, 'C2');
  const r2 = makeR2(); const env = { mydukapos_kv: kv, MEDIA: r2 };
  const m = await load('media.js');
  const img = JPEG();
  let r = await post(m, env, 'C1', { k: 'p', id: 'p-abcdef', dataUrl: img });
  const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.backend, 'r2'); assert.equal(d.url, '/api/media?k=p&id=p-abcdef');
  assert.ok(r2.m.has('shop/C1/p/p-abcdef'), 'kept in R2 under the shop');
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith('media:')).length, 0, 'nothing in KV');
  r = await post(m, env, 'C1', { k: 'p', id: 'p-abcdef', dataUrl: img });
  assert.equal((await r.json()).existed, true, 'a retry stores nothing twice');
  r = await get(m, env, 'C1', 'k=p&id=p-abcdef');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('base64'), img.split(',')[1]);
  assert.equal((await get(m, env, 'C2', 'k=p&id=p-abcdef')).status, 404, 'shop C2 cannot read C1\'s photo');
  // private kinds never say "cache me publicly"
  await post(m, env, 'C1', { k: 'r', id: 'r-abcdef', dataUrl: img });
  assert.match((await get(m, env, 'C1', 'k=r&id=r-abcdef')).headers.get('cache-control'), /no-store/);
  await post(m, env, 'C1', { action: 'delete', k: 'p', id: 'p-abcdef' });
  assert.equal((await get(m, env, 'C1', 'k=p&id=p-abcdef')).status, 404);
});

test('media: refuses what is not really an image, oversize files, bad ids; works on KV until the R2 bucket exists', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const m = await load('media.js');
  const env = { mydukapos_kv: kv };                                        // no R2 binding yet
  assert.equal((await post(m, env, 'C1', { k: 'p', id: 'p-111111', dataUrl: 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400, 'says JPEG, is not');
  assert.equal((await post(m, env, 'C1', { k: 'p', id: 'p-111111', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400, 'no SVG');
  assert.equal((await post(m, env, 'C1', { k: 'p', id: '../../x', dataUrl: JPEG() })).status, 400);
  assert.equal((await post(m, env, 'C1', { k: 'zz', id: 'p-111111', dataUrl: JPEG() })).status, 400);
  assert.equal((await post(m, env, 'C1', { k: 'p', id: 'p-222222', dataUrl: JPEG(700 * 1024) })).status, 413);
  const r = await post(m, env, 'C1', { k: 'p', id: 'p-333333', dataUrl: JPEG() });
  assert.equal((await r.json()).backend, 'kv');
  assert.equal((await get(m, env, 'C1', 'k=p&id=p-333333')).status, 200);
  // later the bucket is switched on: what was stored in KV is still read
  const env2 = { mydukapos_kv: kv, MEDIA: makeR2() };
  assert.equal((await get(m, env2, 'C1', 'k=p&id=p-333333')).status, 200);
});

test('radiology images now go to R2 too, and images uploaded by zip 132 (old KV records) are still shown', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const r2 = makeR2(); const env = { mydukapos_kv: kv, MEDIA: r2 };
  const m = await load('radiology-image.js');
  const img = JPEG();
  await m.onRequestPost({ request: new Request('https://x.pages.dev/api/radiology-image?c=C1', { method: 'POST', body: JSON.stringify({ id: 'ri-new001', orderId: 'o1', dataUrl: img }) }), env });
  assert.ok(r2.m.has('shop/C1/r/ri-new001'));
  kv.data.set('pos-radimg:C1:ri-old001', { value: JSON.stringify({ orderId: 'o0', dataUrl: img, at: 1 }) });
  for (const id of ['ri-new001', 'ri-old001']) {
    const r = await m.onRequestGet({ request: new Request(`https://x.pages.dev/api/radiology-image?c=C1&id=${id}`), env });
    assert.equal(r.status, 200, id); assert.equal((await r.json()).dataUrl, img);
  }
});

for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
  test(`${app}: product photos move out of the synced item list to R2 (once, only if unchanged) and the list gets small`, async () => {
    const posted = [];
    const fetch = async (url, opts = {}) => {
      if (/\/api\/media/.test(String(url)) && opts.method === 'POST') { const b = JSON.parse(opts.body); posted.push(b); return new Response(JSON.stringify({ ok: true, url: `/api/media?k=p&id=${b.id}` }), { status: 200 }); }
      return new Response('{}', { status: 404 });
    };
    const b = await boot(app, { fetch, wait: 900 });
    const w = b.w;
    const list = app === 'water/index.html' ? 'products' : 'inventory';
    const key = app === 'water/index.html' ? 'aqua_products' : 'pos_inventory';
    const big = JPEG(40000);
    w.eval(`${list}.push({ code: 'X1', id: 'X1', name: 'Burger', price: 500, qty: 5, image: ${JSON.stringify(big)} }, { code: 'X2', id: 'X2', name: 'Soda', price: 100, qty: 5, image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }); safeSetItem('${key}', JSON.stringify(${list}))`);
    const before = w.localStorage.getItem(key).length;
    assert.equal(await w.eval('storageOffloadPhotos()'), 1);
    const it = JSON.parse(w.eval(`JSON.stringify(${list}.find(x => x.code === 'X1'))`));
    assert.match(it.image, /^\/api\/media\?k=p&id=/, 'the item keeps only the address');
    assert.equal(posted.filter((p) => p.dataUrl === big).length, 1);
    assert.ok(w.localStorage.getItem(key).length < before - 40000, 'the saved list shrank');
    assert.equal(await w.eval('storageOffloadPhotos()'), 0, 'nothing sent twice');
    b.close();
  });
}

test('an edit made while the photo was uploading wins (the old photo address is not written over it)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = async (url, opts = {}) => {
    if (/\/api\/media/.test(String(url)) && opts.method === 'POST') { await gate; const b = JSON.parse(opts.body); return new Response(JSON.stringify({ ok: true, url: `/api/media?k=p&id=${b.id}` }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  const b = await boot('index.html', { fetch, wait: 900 });
  const w = b.w;
  w.eval(`inventory.push({ code: 'X1', name: 'Burger', price: 500, qty: 5, image: ${JSON.stringify(JPEG(3000))} })`);
  const p = w.eval('storageOffloadPhotos()');
  w.eval(`inventory.find(x => x.code === 'X1').image = ${JSON.stringify(JPEG(4000))}`);    // the owner changed the photo meanwhile
  release();
  assert.equal(await p, 0);
  assert.match(w.eval("inventory.find(x => x.code === 'X1').image"), /^data:image\/jpeg/);
  b.close();
});

test('an older server without the media store: photos stay as they are, nothing breaks', async () => {
  const fetch = async () => new Response('Not found', { status: 404 });
  const b = await boot('index.html', { fetch, wait: 900 });
  b.w.eval(`inventory.push({ code: 'X1', name: 'Burger', price: 500, qty: 5, image: ${JSON.stringify(JPEG(3000))} })`);
  assert.equal(await b.w.eval('storageOffloadPhotos()'), 0);
  assert.match(b.w.eval("inventory.find(x => x.code === 'X1').image"), /^data:image/);
  b.close();
});

test('every app\'s service worker keeps product photos (k=p) on the device, never clinical images', async () => {
  const fs = await import('node:fs');
  for (const f of ['sw.js', 'hotel/sw.js', 'hospital/sw.js', 'pharmacy/sw.js', 'production/sw.js', 'services/sw.js', 'water/sw.js', 'owner/sw.js']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(s, /url\.pathname\.endsWith\('\/api\/media'\) && url\.searchParams\.get\('k'\) === 'p'/, f);
    assert.ok(s.indexOf("endsWith('/api/media')") < s.indexOf("if (url.pathname.includes('/api/')) return;"), f + ': before the "never cache /api/" rule');
  }
});

test('Hospital: "not collected" needs no reason; 🔔 badge counts requests waiting for a manager', async () => {
  const b = await boot('hospital/index.html', { storage: { pos_staff: JSON.stringify([{ id: 'st1', name: 'Cate', roles: ['cash-shift-tab'] }, { id: 'st2', name: 'Mo', isManager: true, roles: ['cash-shift-tab'] }]) }, wait: 1500 });
  const w = b.w;
  w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); }; window.prompt = () => ''");
  w.eval("patientCharges.push({ id: 'ch1', ref: 'V1', patientId: 'PT-1', kind: 'medication', name: 'Amoxicillin', qty: 2, price: 30, status: 'paid', dispenseState: 'awaiting', paidAt: Date.now() })");
  w.eval("pharmacyNotCollected('ch1')");
  assert.equal(w.eval("patientCharges.find(c => c.id === 'ch1').dispenseState"), 'not_collected', 'saved with no reason');
  w.eval("currentServer = staff.find(s => s.id === 'st2'); updateApprovalsBadge()");
  const badge = () => b.d.getElementById('approvals-badge');
  assert.equal(badge().style.display, 'none');
  w.eval("approvalRequests.push({ id: 'a1', type: 'void', status: 'pending', requestedBy: 'Cate', requestedAt: Date.now(), refNumber: 'R1', amount: 10, reason: 'x' }); updateApprovalsBadge()");
  assert.equal(badge().textContent, '1'); assert.notEqual(badge().style.display, 'none');
  assert.ok((w.eval('window.__toasts') || []).some((t) => /new request to approve/.test(t)), 'the manager is told once');
  w.eval("approvalRequests[0].status = 'approved'; updateApprovalsBadge()");
  assert.equal(badge().style.display, 'none');
  b.close();
});
