import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// zip 204: the product catalogue API — products, categories, offers, complete systems and pictures are owner-managed DATA.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const APEX = 'https://mydukapos.store';
const post = (body, tok) => new Request(APEX + '/api/catalog', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function tokenOf(env) { const oa = await load('functions/api/_owner-auth.js'); return oa.createOwnerSession(env, await oa.getOwnerAccount(env)); }
async function setup() {
  const cat = await load('functions/api/catalog.js'), oa = await load('functions/api/_owner-auth.js');
  const env = { mydukapos_kv: makeKV() };
  await oa.createOwnerAccount(env, 'o@x.ke', 'owner-pass-1');
  const tok = await oa.createOwnerSession(env, await oa.getOwnerAccount(env));
  const call = async (b, auth = true) => { const r = await cat.onRequestPost({ request: post(b, auth ? tok : null), env }); return { status: r.status, j: await r.json() }; };
  const pub = async () => (await cat.onRequestGet({ request: new Request(APEX + '/api/catalog'), env })).json();
  return { cat, env, call, pub };
}

test('nothing is configured at first: the public list is empty and says so; owner actions need the owner', async () => {
  const { call, pub } = await setup();
  const p = await pub(); assert.equal(p.configured, false); assert.deepEqual(p.products, []);
  assert.equal((await call({ action: 'list' }, false)).status, 401);
  assert.equal((await call({ action: 'saveProduct', product: { name: 'x' } }, false)).status, 401);
});

test('categories: unlimited, unique by name per kind, can be renamed and deleted (items fall back to "no category")', async () => {
  const { call } = await setup();
  let r = await call({ action: 'saveCategory', category: { name: 'Printers' } }); assert.equal(r.status, 200);
  assert.equal((await call({ action: 'saveCategory', category: { name: 'printers' } })).status, 400, 'same name twice refused');
  assert.equal((await call({ action: 'saveCategory', category: { name: 'Printers', scope: 'system' } })).status, 200, 'same name is fine for systems');
  assert.equal((await call({ action: 'saveCategory', category: { name: '' } })).status, 400);
  for (let i = 0; i < 30; i++) assert.equal((await call({ action: 'saveCategory', category: { name: 'Type ' + i } })).status, 200);
  r = await call({ action: 'list' }); assert.ok(r.j.categories.length >= 32);
  const cid = r.j.categories[0].id;
  const p = await call({ action: 'saveProduct', product: { name: 'P1', price: 1000, categoryId: cid } });
  assert.equal(p.j.products[0].categoryId, cid);
  const d = await call({ action: 'deleteCategory', id: cid }); assert.equal(d.j.products[0].categoryId, '');
});

test('products: price rules, previous price, offers calculate discount and percent, and the SERVER clock decides if an offer is live', async () => {
  const { call, pub } = await setup();
  const cat = (await call({ action: 'saveCategory', category: { name: 'Scanners' } })).j.categories[0].id;
  const save = async (x) => call({ action: 'saveProduct', product: { categoryId: cat, ...x } });
  assert.equal((await save({ name: '' })).status, 400);
  assert.equal((await save({ name: 'Bad offer', price: 1000, onOffer: true, offerPrice: 1200 })).status, 400, 'offer must be lower');
  assert.equal((await save({ name: 'No price offer', onOffer: true, offerPrice: 100 })).status, 400, 'offer needs a regular price');
  assert.equal((await save({ name: 'Bad prev', price: 1000, prevPrice: 900 })).status, 400, 'previous price must be higher');
  const now = Date.now();
  await save({ name: 'Live offer', price: 15000, onOffer: true, offerPrice: 12999 });
  await save({ name: 'Future offer', price: 5000, onOffer: true, offerPrice: 4000, offerStart: now + 3600e3, offerEnd: now + 7200e3 });
  await save({ name: 'Ended offer', price: 5000, onOffer: true, offerPrice: 4000, offerStart: now - 7200e3, offerEnd: now - 3600e3 });
  await save({ name: 'Reduced', price: 800, prevPrice: 1000 });
  await save({ name: 'Quote only' });
  await save({ name: 'Draft', price: 1, published: false });
  const p = await pub(); const by = (n) => p.products.find((x) => x.name === n);
  assert.equal(p.products.length, 5, 'drafts are not public');
  assert.deepEqual([by('Live offer').onOffer, by('Live offer').eff, by('Live offer').was, by('Live offer').discount, by('Live offer').pct], [true, 12999, 15000, 2001, 13]);
  assert.equal(by('Future offer').onOffer, false); assert.equal(by('Future offer').eff, 5000);
  assert.equal(by('Ended offer').onOffer, false); assert.equal(by('Ended offer').eff, 5000);
  assert.deepEqual([by('Reduced').eff, by('Reduced').was, by('Reduced').pct], [800, 1000, 20]);
  assert.equal(by('Quote only').eff, null, 'no price = get a quote');
  assert.ok(p.categories.some((k) => k.name === 'Scanners'));
});

test('featured / publish toggles, related products and deleting a product tidy up everything that pointed at it', async () => {
  const { call, pub } = await setup();
  const mk = async (name, extra = {}) => { const r = await call({ action: 'saveProduct', product: { name, price: 1000, ...extra } }); return r.j.products.find((p) => p.name === name).id; };
  const a = await mk('A'), b = await mk('B');
  await call({ action: 'saveProduct', product: { id: a, name: 'A', price: 1000, related: [b, 'nonexistent1'] } });
  assert.deepEqual((await pub()).products.find((p) => p.name === 'A').related, [b]);
  await call({ action: 'patchProduct', id: a, patch: { featured: true } });
  assert.equal((await pub()).products.find((p) => p.name === 'A').featured, true);
  await call({ action: 'patchProduct', id: b, patch: { published: false } });
  assert.deepEqual((await pub()).products.find((p) => p.name === 'A').related, [], 'an unpublished product is not suggested');
  const sys = await call({ action: 'saveSystem', system: { name: 'S', price: 1500, components: [{ productId: a, qty: 1 }, { productId: b, qty: 2 }] } });
  assert.equal(sys.j.systems[0].components.length, 2);
  const blocked = await call({ action: 'deleteProduct', id: b });
  assert.equal(blocked.status, 409, 'a product that is part of a system cannot be deleted from under it'); assert.match(blocked.j.error, /"S"/);
  await call({ action: 'saveSystem', system: { id: sys.j.systems[0].id, name: 'S', price: 1500, components: [{ productId: a, qty: 1 }] } });
  const del = await call({ action: 'deleteProduct', id: b });
  assert.equal(del.status, 200); assert.equal(del.j.systems[0].components.length, 1);
  assert.deepEqual(del.j.products[0].related, [], 'removed from related');
});

test('systems reference products: individual value, saving and an offer on the system are all calculated; a component without a price hides the saving', async () => {
  const { call, pub } = await setup();
  const mk = async (name, price, extra = {}) => (await call({ action: 'saveProduct', product: { name, price, ...extra } })).j.products.find((p) => p.name === name).id;
  const pc = await mk('POS Computer', 30000), mon = await mk('Monitor', 12000), scn = await mk('Scanner', 4500), prn = await mk('Printer', 15000, { onOffer: true, offerPrice: 12000 }), dr = await mk('Drawer', 6800);
  assert.equal((await call({ action: 'saveSystem', system: { name: 'Empty', components: [] } })).status, 400, 'a system needs components');
  assert.equal((await call({ action: 'saveSystem', system: { name: 'Ghost', price: 100, components: [{ productId: 'zzzzzzzzzz', qty: 1 }] } })).status, 400);
  const comps = [pc, mon, scn, prn, dr].map((id) => ({ productId: id, qty: 1 })).concat([]);
  let r = await call({ action: 'saveSystem', system: { name: 'Retail POS System', price: 62999, components: comps } });
  let s = (await pub()).systems[0];
  assert.equal(s.individualValue, 30000 + 12000 + 4500 + 12000 + 6800, 'value uses what each part costs today (the printer is on offer)');
  assert.equal(s.saving, 65300 - 62999 > 0 ? 65300 - 62999 : 0);
  assert.equal(s.eff, 62999);
  // quantity counts
  await call({ action: 'saveSystem', system: { id: r.j.systems[0].id, name: 'Retail POS System', price: 62999, components: comps.map((k) => k.productId === scn ? { ...k, qty: 2 } : k) } });
  s = (await pub()).systems[0]; assert.equal(s.individualValue, 69800); assert.equal(s.saving, 69800 - 62999);
  // the system itself on offer
  await call({ action: 'patchSystem', id: s.id, patch: { onOffer: true } }).then((x) => assert.equal(x.status, 400, 'needs an offer price first'));
  await call({ action: 'saveSystem', system: { id: s.id, name: 'Retail POS System', price: 62999, onOffer: true, offerPrice: 57999, components: comps } });
  s = (await pub()).systems[0];
  assert.deepEqual([s.onOffer, s.eff, s.was, s.discount], [true, 57999, 62999, 5000]);
  assert.equal(s.saving, 65300 - 57999, 'the saving is against the individual value');
  // a changed product price flows through
  await call({ action: 'saveProduct', product: { id: mon, name: 'Monitor', price: 20000 } });
  assert.equal((await pub()).systems[0].individualValue, 73300);
  // an unpriced component: no saving is claimed
  const free = await mk('Cables', null);
  await call({ action: 'saveSystem', system: { id: s.id, name: 'Retail POS System', price: 62999, components: [...comps, { productId: free, qty: 1 }] } });
  s = (await pub()).systems[0]; assert.equal(s.individualValue, null); assert.equal(s.saving, 0);
});

test('pictures: only real images, served publicly and cacheable, and a picture still in use cannot be deleted', async () => {
  const { cat: c2, env: e2, call: call2 } = await setup();
  assert.equal((await call2({ action: 'uploadImage', dataUrl: 'data:image/png;base64,AAAA' })).status, 400, 'not an image');
  assert.equal((await call2({ action: 'uploadImage', dataUrl: 'data:text/html;base64,PGI+' })).status, 400);
  const up = await call2({ action: 'uploadImage', dataUrl: PNG }); assert.equal(up.status, 200); const id = up.j.id;
  const get = await c2.onRequestGet({ request: new Request(APEX + '/api/catalog?img=' + id), env: e2 });
  assert.equal(get.status, 200); assert.equal(get.headers.get('Content-Type'), 'image/png'); assert.match(get.headers.get('Cache-Control'), /immutable/);
  assert.equal((await c2.onRequestGet({ request: new Request(APEX + '/api/catalog?img=nope'), env: e2 })).status, 404);
  const p = await call2({ action: 'saveProduct', product: { name: 'With pic', price: 100, images: [id, '../../etc'] } });
  assert.deepEqual(p.j.products[0].images, [id], 'bad ids dropped');
  assert.equal((await call2({ action: 'deleteImage', id })).status, 400, 'in use');
  await call2({ action: 'saveProduct', product: { id: p.j.products[0].id, name: 'With pic', price: 100, images: [] } });
  assert.equal((await c2.onRequestGet({ request: new Request(APEX + '/api/catalog?img=' + id), env: e2 })).status, 404, 'removing it from the item removes the file');
});

test('starter import adds categories and items once (no duplicates), reordering works, and the public list keeps the owner\'s order', async () => {
  const { call, pub } = await setup();
  const starter = { categories: [{ key: 'p', label: 'Printers' }], products: [{ name: 'Receipt Printer', cat: 'p', kind: 'printer', blurb: 'Fast', points: ['Cutter', 'USB'], price: null }, { name: 'Label Printer', cat: 'p', kind: 'label', blurb: 'Labels', points: [] }] };
  let r = await call({ action: 'import', ...starter }); assert.equal(r.j.added, 2);
  r = await call({ action: 'import', ...starter }); assert.equal(r.j.added, 0, 'a second import adds nothing');
  assert.equal(r.j.categories.length, 1);
  const [a, b] = r.j.products.map((p) => p.id);
  await call({ action: 'reorderProducts', ids: [b, a] });
  assert.deepEqual((await pub()).products.map((p) => p.name), ['Label Printer', 'Receipt Printer']);
});

test('safety: a failed read never wipes the catalogue, stale windows are refused, bad bodies get clean errors', async () => {
  const { call, env, cat } = await setup();
  const r1 = await call({ action: 'saveProduct', product: { name: 'Keep me', price: 5000 } }); assert.equal(r1.status, 200);
  const rev = r1.j.rev;
  // a second window that still thinks the catalogue is at an older revision is told so and nothing changes
  const stale = await call({ action: 'saveProduct', baseRev: rev - 1, product: { name: 'Late', price: 1 } });
  assert.equal(stale.status, 409); assert.equal(stale.j.stale, true); assert.equal(stale.j.products.length, 1);
  assert.equal((await call({ action: 'saveProduct', baseRev: rev, product: { name: 'On time', price: 1 } })).status, 200);
  // the store cannot be read: refuse (503) instead of starting from an empty catalogue
  const real = env.mydukapos_kv.get; env.mydukapos_kv.get = async (k, ...r) => { if (String(k) === 'catalog:v1') throw new Error('kv down'); return real.call(env.mydukapos_kv, k, ...r); };
  assert.equal((await call({ action: 'saveCategory', category: { name: 'Oops' } })).status, 503);
  env.mydukapos_kv.get = async (k, ...r) => (String(k) === 'catalog:v1' ? '{not json' : real.call(env.mydukapos_kv, k, ...r));
  assert.equal((await call({ action: 'saveCategory', category: { name: 'Oops' } })).status, 503);
  env.mydukapos_kv.get = real;
  assert.equal((await call({ action: 'list' })).j.products.length, 2, 'both products survived');
  // odd bodies: JSON null, a string patch, null items in an import
  for (const raw of ['null', '"x"', '[]']) assert.equal((await cat.onRequestPost({ request: new Request('https://mydukapos.store/api/catalog', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + (await tokenOf(env)) }, body: raw }), env })).status, 400);
  const id = r1.j.products[0].id;
  assert.equal((await call({ action: 'patchProduct', id, patch: 'published' })).status, 200);
  assert.equal((await call({ action: 'import', categories: [null, 5], products: [null, { name: 'Imported' }] })).status, 200);
});

test('rules: addresses stay stable on rename, categories keep their kind, a product only takes a product category, emptied catalogue stays empty, hidden parts are not leaked', async () => {
  const { call, pub } = await setup();
  const pc = (await call({ action: 'saveCategory', category: { name: 'Printers' } })).j.categories[0].id;
  const sc = (await call({ action: 'saveCategory', category: { name: 'Retail', scope: 'system' } })).j.categories[1].id;
  assert.equal((await call({ action: 'saveCategory', category: { id: 'nope', name: 'x' } })).status, 404);
  assert.equal((await call({ action: 'saveCategory', category: { id: pc, name: 'Printers 2', scope: 'system' } })).j.categories[0].scope, 'product');
  let r = await call({ action: 'saveProduct', product: { name: 'Thermal', price: 1000, categoryId: sc } });
  assert.equal(r.j.products[0].categoryId, '', 'a system type is not a product category');
  const id = r.j.products[0].id, slug = r.j.products[0].slug;
  r = await call({ action: 'saveProduct', product: { id, name: 'Thermal Printer Renamed', price: 1000, categoryId: pc } });
  assert.equal(r.j.products[0].slug, slug, 'the link people already have keeps working');
  const hid = (await call({ action: 'saveProduct', product: { name: 'Secret part', price: 777, published: false } })).j.products[1].id;
  await call({ action: 'saveSystem', system: { name: 'Pack', price: 1500, components: [{ productId: id, qty: 1 }, { productId: hid, qty: 1 }] } });
  const txt = JSON.stringify((await pub()).systems);
  assert.ok(!txt.includes('Secret part') && !txt.includes('777'), 'a hidden product never reaches the public list');
  assert.equal((await pub()).systems[0].saving, 0, 'no saving can be claimed on a part that is not shown');
  const all = await call({ action: 'list' });
  await call({ action: 'deleteSystem', id: all.j.systems[0].id });
  for (const p of all.j.products) await call({ action: 'deleteProduct', id: p.id });
  for (const k of all.j.categories) await call({ action: 'deleteCategory', id: k.id });
  const p = await pub(); assert.equal(p.configured, true, 'deleting everything on purpose leaves the shop empty, not back on the starter list'); assert.deepEqual(p.products, []);
});

test('pictures are removed only after the catalogue is saved, and never while another item still uses them', async () => {
  const { call, env, cat } = await setup();
  const up = async () => (await call({ action: 'uploadImage', dataUrl: PNG })).j.id;
  const im = await up();
  const a = (await call({ action: 'saveProduct', product: { name: 'A', price: 1, images: [im] } })).j.products[0].id;
  const b = (await call({ action: 'saveProduct', product: { name: 'B', price: 1, images: [im] } })).j.products[1].id;
  await call({ action: 'saveProduct', product: { id: a, name: 'A', price: 1, images: [] } });
  const get = async () => (await cat.onRequestGet({ request: new Request(APEX + '/api/catalog?img=' + im), env })).status;
  assert.equal(await get(), 200, 'B still uses it');
  await call({ action: 'deleteProduct', id: b });
  assert.equal(await get(), 404, 'nobody uses it any more');
  const im2 = await up();
  const c = (await call({ action: 'saveProduct', product: { name: 'C', price: 1, images: [im2] } })).j.products[0].id;
  const put = env.mydukapos_kv.put; env.mydukapos_kv.put = async () => { throw new Error('write failed'); };
  assert.equal((await call({ action: 'deleteProduct', id: c })).status, 500);
  env.mydukapos_kv.put = put;
  assert.equal((await cat.onRequestGet({ request: new Request(APEX + '/api/catalog?img=' + im2), env })).status, 200, 'a failed save leaves the picture in place');
});
