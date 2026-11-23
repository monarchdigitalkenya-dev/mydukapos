import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 327: pre-filled public demos - one new product per hourly session, original names locked, imports off. Normal shops untouched.
const SEED = {
  pos_inventory: JSON.stringify([
    { code: 'SUG', type: 'item', name: 'Sugar 1kg', category: 'Groceries', price: 160, wholesalePrice: 130, qty: 40, unit: 'pcs', vatCategory: 'A', openingStock: { qty: 40, costPrice: 100, date: '2026-01-01', setBy: 'x' } },
    { code: 'MLK', type: 'item', name: 'Milk 500ml', category: 'Dairy', price: 60, wholesalePrice: 45, qty: 25, unit: 'pcs', vatCategory: 'A', openingStock: { qty: 25, costPrice: 40, date: '2026-01-01', setBy: 'x' } }]),
  pos_last_synced_at: String(Date.now() - 1000),
};
const DEMO_URL = 'https://demo-retail.mydukapos.store/?c=demo_retail';
const net = (id, isDemo) => async (url) => {
  if (/\/api\/license-status/.test(String(url))) return new Response(JSON.stringify({ valid: true, clientId: id, type: 'permanent', sharedDemo: isDemo }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('offline');
};
const prod = (code, name) => `{ code: '${code}', type: 'item', name: '${name}', price: 10, qty: 5, unit: 'pcs', vatCategory: 'A' }`;
const names = (w) => JSON.parse(w.eval("JSON.stringify(JSON.parse(localStorage.getItem('pos_inventory')).map(p => p.code + ':' + p.name))"));
async function demo(t) {
  const dev = await boot('index.html', { url: DEMO_URL, storage: SEED, fetch: net('demo_retail', true), wait: 600 });
  t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  dev.w.eval("window.__toasts = []; showToast = function (m) { window.__toasts.push(String(m)); }; window.confirm = () => true; window.alert = () => {}; window.__demoResetNoReload = true;");
  assert.ok(await until(() => dev.w.eval("!!localStorage.getItem('sd_baseline') && !!localStorage.getItem('sd_orig')"), 12000), 'the sample and its original names are recorded');
  return dev;
}

test('demo: the first new product is kept, the second is taken out again (memory and storage)', async (t) => {
  const d = await demo(t);
  d.w.eval(`inventory.push(${prod('N1', 'My first')}); saveInventoryNow ? 0 : 0; safeSetItem('pos_inventory', JSON.stringify(inventory));`.replace('saveInventoryNow ? 0 : 0;', ''));
  assert.ok(names(d.w).includes('N1:My first'));
  d.w.eval(`inventory.push(${prod('N2', 'My second')}); safeSetItem('pos_inventory', JSON.stringify(inventory));`);
  assert.ok(!names(d.w).includes('N2:My second'), 'storage');
  assert.ok(!d.w.eval("inventory.some(p => p.code === 'N2')"), 'memory');
  assert.ok(d.w.eval('window.__toasts.some(m => /one new product/i.test(m))'));
  assert.equal(d.w.eval('DemoGuard.newCount()'), 1);
});

test('demo: an original product cannot be renamed; its other fields can still change', async (t) => {
  const d = await demo(t);
  d.w.eval("inventory[0].name = 'Hacked'; inventory[0].price = 175; safeSetItem('pos_inventory', JSON.stringify(inventory));");
  assert.ok(names(d.w).includes('SUG:Sugar 1kg'));
  assert.equal(d.w.eval("inventory[0].name"), 'Sugar 1kg');
  assert.equal(d.w.eval("JSON.parse(localStorage.getItem('pos_inventory'))[0].price"), 175);
});

test('demo: after the hourly restore one new product is allowed again and the original names are still locked', async (t) => {
  const d = await demo(t);
  d.w.eval(`inventory.push(${prod('N1', 'First')}); safeSetItem('pos_inventory', JSON.stringify(inventory));`);
  assert.equal(d.w.eval('DemoGuard.newCount()'), 1);
  d.w.eval('DemoReset.restoreNow()');
  assert.equal(d.w.eval("localStorage.getItem('sd_new_codes')"), null, 'the restore clears the allowance');
  assert.ok(d.w.eval("!!localStorage.getItem('sd_orig')"), 'the original names survive the restore');
  assert.ok(!names(d.w).some((n) => n.startsWith('N1:')), 'the visitor product is gone');
});

test('demo: imports are blocked (functions, buttons and file pickers)', async (t) => {
  const d = await demo(t);
  const before = d.w.eval('inventory.length');
  d.w.eval("importInventoryCsv({ name: 'x.csv', text: () => Promise.resolve('name,price\\nZed,5') });");
  assert.equal(d.w.eval('inventory.length'), before);
  assert.ok(d.w.eval('window.__toasts.some(m => /importing is turned off/i.test(m))'));
  const el = d.d.getElementById('inventory-import-file-input');
  if (el) { let prevented = false; el.addEventListener('click', (e) => { prevented = e.defaultPrevented; }); el.dispatchEvent(new d.w.MouseEvent('click', { bubbles: true, cancelable: true })); assert.ok(prevented || el.disabled, 'the picker does not open'); }
});

test('a normal shop is untouched: rename, many new products, imports available', async (t) => {
  const dev = await boot('index.html', { url: 'https://shop.mydukapos.store/?c=real1', storage: SEED, fetch: net('real1', false), wait: 600 });
  t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  dev.w.eval(`inventory[0].name = 'Renamed'; inventory.push(${prod('A1', 'a')}, ${prod('A2', 'b')}, ${prod('A3', 'c')}); safeSetItem('pos_inventory', JSON.stringify(inventory));`);
  assert.deepEqual(names(dev.w).sort(), ['A1:a', 'A2:b', 'A3:c', 'MLK:Milk 500ml', 'SUG:Renamed']);
  assert.equal(dev.w.eval("typeof window.DemoGuard"), 'undefined');
  assert.equal(dev.w.eval("localStorage.getItem('sd_orig')"), null);
});
