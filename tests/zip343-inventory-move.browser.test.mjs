// zip 340: Inventory: match extra "Item (Size)" items to the real size - same variant, no new code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });
const H = crypto.createHash('sha256').update('pw').digest('hex');

async function open(browser, base, file, seed, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => { const u = r.request().url(); if (/\/api\/store/.test(u) && globalThis.__storeMock) return globalThis.__storeMock(r); return r.abort(); });
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); const s = JSON.parse(invJson); for (const k of Object.keys(s)) localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k]));
  }, [H, JSON.stringify(seed)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}



const SEED = { pos_inventory: [
  { code: 'SHIRT', type: 'item', name: 'Beige Normal shirt', price: 300, qty: 2, unit: 'pcs', hasVariants: true, variants: [
    { id: 'v-xl', name: 'XL', code: 'SHIRT-XL', price: 400, qty: 0 }, { id: 'v-l', name: 'L', code: 'SHIRT-L', price: 350, qty: 2 } ] },
  { code: 'BOLT', type: 'item', name: 'Bolt', price: 5, qty: 10, unit: 'pcs' } ] };

test('Inventory: every row has a Move button; Store -> this size adds to the existing size, once', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const b = await chromium.launch();
  let calls = 0;
  globalThis.__storeMock = (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action === 'removeFromStore') { calls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ moved: true, items: [], withdrawn: [{ movementId: 'mv-' + body.idemKey, storeItemId: 's1', code: 'SHIRT::v-xl', name: 'Beige Normal shirt (XL)', unit: 'pcs', qty: body.items[0].qty }] }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 's1', name: 'Beige Normal shirt (XL)', code: 'SHIRT::v-xl', qty: 7, unit: 'pcs' }] }) });
  };
  try {
    const { page, errs } = await open(b, base, 'index.html', SEED);
    await page.evaluate(() => { storeItemsCache = [{ id: 's1', name: 'Beige Normal shirt (XL)', code: 'SHIRT::v-xl', qty: 7, unit: 'pcs' }]; guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'inventory-list-tab'); renderInventoryTable(); });
    await page.waitForTimeout(2800);
    const n = await page.evaluate(() => document.querySelectorAll('#inventory-list-tab .inv-move-btn, #inventory-list-tab [data-spxmv]').length);
    assert.ok(n >= 2, 'Move buttons on rows: ' + n);
    await page.evaluate(() => openMoveStock('SHIRT', 'v-xl')); await page.waitForTimeout(400);
    const radios = await page.evaluate(() => [...document.querySelectorAll('[name="spx-mv-to"]')].map(r => r.value));
    assert.ok(radios.includes('store') && radios.includes('fromstore'));
    await page.check('[name="spx-mv-to"][value="fromstore"]'); await page.waitForTimeout(300);
    await page.fill('#spx-mv-qty', '3');
    await page.evaluate(() => { storeItemsCache = [{ id: 's1', name: 'Beige Normal shirt (XL)', code: 'SHIRT::v-xl', qty: 7, unit: 'pcs' }]; const s = document.getElementById('spx-mv-from'); if (!s.value) s.innerHTML = '<option value="s1">x</option>'; });
    await page.click('#spx-mv-go'); await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({ n: inventory.length, xl: inventory[0].variants.find(v => v.id === 'v-xl').qty, parent: inventory[0].qty }));
    assert.equal(r.n, 2, 'no new item created'); assert.equal(r.xl, 3); assert.equal(r.parent, 5); assert.equal(calls, 1);
    assert.deepEqual(errs.filter((e) => !/ERR_FAILED|sync-ws|favicon/.test(e)), []);
  } finally { globalThis.__storeMock = null; await b.close(); srv.close(); }
});

test('Store Move: a line made by "Import from Inventory" (PARENT::id, "Name (Size)") finds the existing size in Inventory', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const b = await chromium.launch();
  const STORE = [{ id: 's1', name: 'Beige Normal shirt (XL)', code: 'SHIRT::v-xl', qty: 0, unit: 'pcs' }, { id: 's2', name: 'Beige Normal shirt (L)', code: 'SHIRT::zzz-unknown', qty: 0, unit: 'pcs' }, { id: 's3', name: 'Bolt', code: 'BOLT', qty: 1, unit: 'pcs' }];
  globalThis.__storeMock = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: STORE }) });
  try {
    const { page } = await open(b, base, 'index.html', SEED);
    await page.evaluate(() => {
      storeItemsCache = [{ id: 's1', name: 'Beige Normal shirt (XL)', code: 'SHIRT::v-xl', qty: 0, unit: 'pcs' }, { id: 's2', name: 'Beige Normal shirt (L)', code: 'SHIRT::zzz-unknown', qty: 0, unit: 'pcs' }, { id: 's3', name: 'Bolt', code: 'BOLT', qty: 1, unit: 'pcs' }];
      guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'store-tab'); renderStoreTab();
      return null; });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const out = [];
      for (const id of ['s1', 's2', 's3']) {
        const btn = document.querySelector('[data-move="' + id + '"]'); if (!btn) { out.push('nobtn'); continue; }
        btn.click(); document.querySelector('[name="sp2-mv-dir"][value="frominv"]').click();
        out.push([...document.querySelectorAll('#sp2-mv-inv option')].map(o => o.textContent).join('|'));
        document.getElementById('sp2-mv-x').click();
      }
      return out;
    });
    assert.match(r[0], /Beige Normal shirt \(XL\)/, 'by PARENT::variantId: ' + r[0]);
    assert.match(r[1], /Beige Normal shirt \(L\)/, 'by the "Name (Size)" label when the id is unknown: ' + r[1]);
    assert.match(r[2], /Bolt/, r[2]);
  } finally { globalThis.__storeMock = null; await b.close(); srv.close(); }
});
