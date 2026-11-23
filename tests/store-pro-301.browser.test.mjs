import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 301: the Store tab in a real browser, against an in-memory fake of /api/store (same actions as the server).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
// a tiny stand-in for functions/api/store.js (KV behaviour)
function fakeStore() {
  let items = [], n = 0;
  const ok = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const EX = ['category', 'supplier', 'notes', 'variantName', 'parentId', 'reorderLevel', 'minimumPrice'];
  const ext = (it, f) => { for (const k of EX) if (f[k] !== undefined) { if (f[k] === '' || f[k] === null) delete it[k]; else it[k] = ['reorderLevel', 'minimumPrice'].includes(k) ? parseFloat(f[k]) : String(f[k]); } if (f.isGroup !== undefined) { if (f.isGroup) it.isGroup = true; else delete it.isGroup; } };
  return async (route) => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'get') return ok(route, { items });
    if (b.action === 'getLog') return ok(route, { log: [] });
    if (b.action === 'pendingTransfers') return ok(route, { transfers: [] });
    if (b.action === 'addManual') { const x = b.item; const old = x.code ? items.find((i) => i.code && i.code.toLowerCase() === x.code.toLowerCase()) : items.find((i) => !i.code && i.name.toLowerCase() === x.name.toLowerCase()); if (old) old.qty += x.qty || 0; else items.push({ id: 'i' + (++n), code: x.code || null, name: x.name, unit: x.unit || 'pcs', price: x.price || 0, wholesaleSellingPrice: x.wholesaleSellingPrice || 0, wholesalePrice: x.wholesalePrice || 0, qty: x.qty || 0 }); return ok(route, { items }); }
    if (b.action === 'updateFields') { const it = items.find((i) => i.id === b.storeItemId); const f = b.fields; if (f.name !== undefined) it.name = f.name; if (f.code !== undefined) it.code = f.code || null; for (const k of ['price', 'wholesalePrice', 'wholesaleSellingPrice']) if (f[k] !== undefined) it[k] = parseFloat(f[k]); if (f.unit) it.unit = f.unit; ext(it, f); return ok(route, { items }); }
    if (b.action === 'setExtras') { for (const e of b.entries) { const it = e.storeItemId ? items.find((i) => i.id === e.storeItemId) : items.find((i) => i.code && i.code.toLowerCase() === String(e.code).toLowerCase()); if (it) ext(it, e.extras); } return ok(route, { items }); }
    if (b.action === 'setQty') { items.find((i) => i.id === b.storeItemId).qty = b.qty; return ok(route, { items }); }
    if (b.action === 'deleteItem') { items = items.filter((i) => i.id !== b.storeItemId); return ok(route, { items }); }
    if (b.action === 'removeFromStore') { const w = []; for (const r of b.items) { const it = items.find((i) => i.id === r.storeItemId); it.qty -= r.qty; w.push({ code: it.code, name: it.name, unit: it.unit, price: it.price, wholesaleSellingPrice: it.wholesaleSellingPrice, wholesalePrice: it.wholesalePrice, qty: r.qty, storeItemId: it.id }); } return ok(route, { items, withdrawn: w }); }
    return ok(route, { error: 'Unknown action.' });
  };
}
async function open(browser, base, app) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route('**/api/store', fakeStore());
  await ctx.route('**/api/**', (r) => (r.request().url().endsWith('/api/store') ? r.fallback() : r.abort()));
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/' + app); await page.waitForTimeout(1600);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; } const s = document.getElementById('boot-splash'); if (s) s.remove(); window.showToast = () => {}; window.confirm = () => true; });
  await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'store-tab'));
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}
const st = (page) => page.evaluate(() => JSON.parse(JSON.stringify(storeItemsCache)));

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: Store - add with every detail, edit in the row, variants, valuation`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app);
      assert.ok(await page.locator('#sp2-root').isVisible(), 'the new Store view shows');
      // add a plain item with everything
      await page.evaluate(() => toggleStoreManualForm()); await page.waitForTimeout(200);
      await page.fill('#sp2-m-name', 'Cement 50kg'); await page.fill('#sp2-m-code', 'CEM1'); await page.fill('#sp2-m-category', 'Hardware');
      await page.fill('#sp2-m-qty', '20'); await page.fill('#sp2-m-wholesalePrice', '600'); await page.fill('#sp2-m-price', '800'); await page.fill('#sp2-m-wholesaleSellingPrice', '700');
      await page.fill('#sp2-m-reorderLevel', '25'); await page.fill('#sp2-m-supplier', 'Bamburi'); await page.fill('#sp2-m-notes', 'Back store');
      await page.click('#sp2-modal [data-m="create"]'); await page.waitForTimeout(700);
      let items = await st(page); const c = items.find((i) => i.code === 'CEM1');
      assert.deepEqual([c.name, c.category, c.qty, c.wholesalePrice, c.price, c.wholesaleSellingPrice, c.reorderLevel, c.supplier, c.notes], ['Cement 50kg', 'Hardware', 20, 600, 800, 700, 25, 'Bamburi', 'Back store']);
      assert.ok(await page.locator('#sp2-modal.open').count(), 'the popup stays open in edit mode');
      // edit in the popup: price, then convert to variants in the same popup
      await page.fill('#sp2-m-price', '850'); await page.locator('#sp2-m-price').dispatchEvent('change'); await page.waitForTimeout(400);
      assert.equal((await st(page)).find((i) => i.code === 'CEM1').price, 850);
      await page.fill('#sp2-m-vnames', 'Grey, White'); await page.fill('#sp2-m-first', 'Standard'); await page.click('#sp2-modal [data-m="makegroup"]'); await page.waitForTimeout(1500);
      items = await st(page);
      const g = items.find((i) => i.isGroup); assert.equal(g.name, 'Cement 50kg');
      const kids = items.filter((i) => i.parentId === g.id); assert.deepEqual(kids.map((k) => k.variantName).sort(), ['Grey', 'Standard', 'White']);
      assert.equal(kids.find((k) => k.variantName === 'Standard').qty, 20, 'the existing stock became the first variant');
      assert.equal(kids.find((k) => k.variantName === 'Grey').qty, 0);
      assert.equal(new Set(kids.map((k) => k.code)).size, 3);
      // stock for a new variant, typed in the popup
      const grey = kids.find((k) => k.variantName === 'Grey');
      await page.fill(`#sp2-modal [data-vid="${grey.id}"][data-vf="qty"]`, '12'); await page.locator(`#sp2-modal [data-vid="${grey.id}"][data-vf="qty"]`).dispatchEvent('change'); await page.waitForTimeout(400);
      assert.equal((await st(page)).find((i) => i.id === grey.id).qty, 12);
      // rename the item: the variants follow
      await page.fill('#sp2-m-name', 'Cement'); await page.locator('#sp2-m-name').dispatchEvent('change'); await page.waitForTimeout(1200);
      items = await st(page); assert.ok(items.filter((i) => i.parentId === g.id).every((k) => /^Cement \(/.test(k.name)), 'variant names follow the item name');
      await page.click('#sp2-modal [data-m="done"]'); await page.waitForTimeout(300);
      // cost of a variant is set in the popup (the table mirrors Inventory: Price and Qty are inline, the rest is in Edit)
      const grey2 = (await st(page)).find((i) => i.id === grey.id);
      await page.evaluate((id) => { document.querySelector('[data-edit="' + id + '"]').click(); }, grey.id); await page.waitForTimeout(300);
      const cost = page.locator('#sp2-m-wholesalePrice');
      await cost.fill('650'); await cost.dispatchEvent('change'); await page.waitForTimeout(400);
      assert.equal((await st(page)).find((i) => i.id === grey.id).wholesalePrice, 650);
      await page.click('#sp2-modal [data-m="done"]'); await page.waitForTimeout(300);
      // inline edit of the variant row's Price (same table as Inventory); put it back afterwards
      const prow = page.locator(`#store-inv-table input[data-id="${grey.id}"][data-f="price"]`);
      await prow.fill('900'); await prow.dispatchEvent('change'); await page.waitForTimeout(400);
      assert.equal((await st(page)).find((i) => i.id === grey.id).price, 900);
      await prow.fill('850'); await prow.dispatchEvent('change'); await page.waitForTimeout(400);
      // search finds a variant by its name, and a category filter works
      await page.fill('#store-search-input', 'grey'); await page.locator('#store-search-input').dispatchEvent('input'); await page.waitForTimeout(500);
      assert.ok((await page.locator('#store-inv-table tbody tr').count()) >= 1, 'the matching variant row');
      await page.fill('#store-search-input', ''); await page.locator('#store-search-input').dispatchEvent('input'); await page.waitForTimeout(300);
      // valuation
      await page.click('#sp2-root [data-view="value"]'); await page.waitForTimeout(300);
      const txt = await page.locator('#sp2-root').innerText();
      // 20 x 600 + 12 x 650 = 19,800 cost ; retail 20 x 850 + 12 x 850 = 27,200
      assert.match(txt, /19,800\.00/); assert.match(txt, /27,200\.00/); assert.match(txt, /Hardware/);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}
