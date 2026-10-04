import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, boot, until } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// zip 204: Owner Console 🛍️ Catalogue tab — adding a product with an offer through the real form, saved through the real API handler.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

test('Catalogue tab: create a product with an offer, see the discount preview, hide and delete it', async () => {
  const cat = await load('functions/api/catalog.js'), oa = await load('functions/api/_owner-auth.js');
  const env = { mydukapos_kv: makeKV() };
  await oa.createOwnerAccount(env, 'o@x.ke', 'owner-pass-1');
  const tok = await oa.createOwnerSession(env, await oa.getOwnerAccount(env));
  const api = async (b) => (await cat.onRequestPost({ request: new Request('https://mydukapos.store/api/catalog', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) }), env })).json();
  await api({ action: 'saveCategory', category: { name: 'Printers' } });
  const fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/catalog')) {
      const res = await (opts.method === 'POST' ? cat.onRequestPost : cat.onRequestGet)({ request: new Request('https://mydukapos.store/api/catalog', { method: opts.method || 'GET', headers: opts.headers, body: opts.body }), env });
      const j = await res.json(); return { ok: res.ok, status: res.status, json: async () => j };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900, storage: { pos_owner_session_token: tok } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const $ = (id) => d.getElementById(id);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const set = (id, v) => { const el = $(id); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  assert.ok($('owner-catalog-tab-btn'), 'tab button exists');
  await w.eval('loadOwnerCatalog()');
  await until(() => $('ct-body').textContent.includes('Printers') || $('ct-body').textContent.length > 20, 3000);
  click($('ct-new')); await until(() => $('ct-name'), 2000);
  set('ct-name', 'Thermal Printer 80mm'); set('ct-price', '18000');
  $('ct-cat').value = $('ct-cat').options[1].value;
  $('ct-on').checked = true; $('ct-on').dispatchEvent(new w.Event('change', { bubbles: true }));
  set('ct-op', '15000');
  await until(() => /17% OFF/.test($('ct-pv').textContent), 2000);
  assert.match($('ct-pv').textContent, /3,000/);
  click($('ct-save'));
  await until(async () => (await api({ action: 'list' })).products.length === 1, 4000);
  let L = await api({ action: 'list' }); const p = L.products[0];
  assert.equal(p.name, 'Thermal Printer 80mm'); assert.equal(p.price, 18000); assert.equal(p.offerPrice, 15000); assert.equal(p.published, true);
  const pub = await (await cat.onRequestGet({ request: new Request('https://mydukapos.store/api/catalog'), env })).json();
  assert.equal(pub.products[0].eff, 15000); assert.equal(pub.products[0].pct, 17);
  await until(() => d.querySelector('[data-ct="pub"]'), 3000);
  click(d.querySelector('[data-ct="pub"]'));
  await until(async () => (await api({ action: 'list' })).products[0].published === false, 3000);
  assert.equal((await (await cat.onRequestGet({ request: new Request('https://mydukapos.store/api/catalog'), env })).json()).products.length, 0, 'hidden items vanish from the public list');
  w.confirm = () => true;
  click(d.querySelector('[data-ct="del"]'));
  await until(async () => (await api({ action: 'list' })).products.length === 0, 3000);
  assert.deepEqual(errors, []); close();
});

test('Catalogue tab: double-tap Save makes one product, categories are added inline, unsaved work is protected, a stale window reloads instead of overwriting', async () => {
  const cat = await load('functions/api/catalog.js'), oa = await load('functions/api/_owner-auth.js');
  const env = { mydukapos_kv: makeKV() };
  await oa.createOwnerAccount(env, 'o@x.ke', 'owner-pass-1');
  const tok = await oa.createOwnerSession(env, await oa.getOwnerAccount(env));
  const raw = (b) => cat.onRequestPost({ request: new Request('https://mydukapos.store/api/catalog', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) }), env }).then((r) => r.json());
  const fetch = async (url, opts = {}) => {
    const res = await (opts.method === 'POST' ? cat.onRequestPost : cat.onRequestGet)({ request: new Request('https://mydukapos.store/api/catalog', { method: opts.method || 'GET', headers: opts.headers, body: opts.body }), env });
    const j = await res.json(); return { ok: res.ok, status: res.status, json: async () => j };
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch, wait: 900, storage: { pos_owner_session_token: tok } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const $ = (id) => d.getElementById(id);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const tab = (v) => click(d.querySelector('[data-ct-view="' + v + '"]'));
  await w.eval('loadOwnerCatalog()');
  // categories: inline form, no prompt()
  tab('categories'); await until(() => $('ct-cname-new'), 2000);
  $('ct-cname-new').value = 'Scanners'; click(d.querySelector('[data-ct="cadd"]'));
  await until(async () => (await raw({ action: 'list' })).categories.length === 1, 3000);
  $('ct-cname-new').value = ''; click(d.querySelector('[data-ct="cadd"]'));
  await until(() => /Type a category name/.test($('ct-msg').textContent), 2000);
  // double tap on Save
  tab('products'); await until(() => $('ct-new').textContent.includes('product'), 1000);
  click($('ct-new')); await until(() => $('ct-name'), 2000);
  $('ct-name').value = 'Once only'; $('ct-price').value = '500';
  click($('ct-save')); click($('ct-save'));
  await until(async () => (await raw({ action: 'list' })).products.length >= 1, 3000); await new Promise((r) => setTimeout(r, 400));
  assert.equal((await raw({ action: 'list' })).products.length, 1, 'two taps, one product');
  // unsaved work: Cancel asks first, "no" keeps the form
  await until(() => d.querySelector('[data-ct="edit"]'), 2000);
  click(d.querySelector('[data-ct="edit"]')); await until(() => $('ct-name'), 2000);
  $('ct-name').value = 'Changed name'; let asked = 0; w.confirm = () => { asked++; return false; };
  click($('ct-cancel')); await new Promise((r) => setTimeout(r, 200));
  assert.equal(asked, 1); assert.ok($('ct-name'), 'form is still open'); assert.equal($('ct-name').value, 'Changed name');
  w.confirm = () => true; click($('ct-cancel')); await until(() => !$('ct-name'), 2000);
  // another window changes the catalogue: this page's save is refused, the list reloads, nothing is overwritten
  await raw({ action: 'saveProduct', product: { name: 'Added elsewhere', price: 9 } });
  click($('ct-new')); await until(() => $('ct-name'), 2000);
  $('ct-name').value = 'Late save'; click($('ct-save'));
  await until(() => /changed in another window/.test($('ct-msg').textContent), 3000);
  assert.deepEqual((await raw({ action: 'list' })).products.map((p) => p.name).sort(), ['Added elsewhere', 'Once only']);
  assert.ok(d.getElementById('ct-body').textContent.includes('Added elsewhere'), 'the list reloaded with the other window\'s product');
  assert.deepEqual(errors, []); close();
});
