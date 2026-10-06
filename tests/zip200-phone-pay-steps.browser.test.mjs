import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// (helpers copied from zip190) the PHONE TILL block (src/shared/blocks/phone-till.html) in a real phone-sized Chromium (390 x 844, touch), in every app that has a Sales Counter:
//   1. every cart line is fully on screen (name, qty, unit price, total, remove) and the page never scrolls sideways;
//   2. the round cart button / the bottom bar open the cart as a full-screen sheet; Confirm is reachable; a cash sale records exactly one sale and closes the sheet;
//   3. the hide options (customer phone box, Walk-In / Delivery choice, tabs on this phone) and the search style work, and are still there after a reload;
//   4. on a 1280 px screen nothing changed.
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const H = crypto.createHash('sha256').update('pw').digest('hex');

// ---- seeds: a small shop for every app ----
const INV = [
  { code: 'A1', type: 'item', name: 'Soda 500ml', category: 'Drinks', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs' },
  { code: 'A2', type: 'item', name: 'Mineral Water 1L', category: 'Drinks', price: 60, wholesalePrice: 30, qty: 40, unit: 'pcs' },
  { code: 'A3', type: 'item', name: 'Crisps Large Bag With A Really Long Name To Wrap Onto Two Lines', category: 'Snacks', price: 150, wholesalePrice: 90, qty: 30, unit: 'pcs' },
  { code: 'A4', type: 'item', name: 'Chocolate Bar', category: 'Snacks', price: 120, wholesalePrice: 70, qty: 3, unit: 'pcs' },
];
const SHOP = 'site-shop-1';
const WATER_PRODUCTS = [
  { code: 'B1', category: 'bottled', name: '500ml Sealed Bottle', sizeML: 500, price: 20, wholesalePrice: 10, qty: 40, stock: { [SHOP]: 40 }, vatCategory: 'A' },
  { code: 'A1', category: 'accessory', name: 'Dispenser With A Rather Long Name Indeed', price: 100, wholesalePrice: 60, qty: 2, stock: { [SHOP]: 20 }, vatCategory: 'A' },
];
const APPS = [
  { key: 'shop', file: 'index.html', search: true, phone: 'sms-checkout-phone-input' },
  { key: 'hotel', file: 'hotel/index.html', search: true, phone: 'sms-checkout-phone-input', tabs: true },
  { key: 'pharmacy', file: 'pharmacy/index.html', search: true, phone: 'sms-checkout-phone-input' },
  { key: 'production', file: 'production/index.html', search: true, phone: 'sms-checkout-phone-input' },
  { key: 'water', file: 'water/index.html', water: true, phone: 'sale-customer-phone-input' },
  { key: 'hospital', file: 'hospital/index.html', search: true, phone: 'sms-checkout-phone-input' },
  { key: 'services', file: 'services/index.html', search: true, phone: 'sms-checkout-phone-input' },
];

async function open(browser, base, app, { width = 390, height = 844, reuse = null } = {}) {
  const phone = width < 700;
  const ctx = reuse ? reuse.ctx : await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  if (!reuse) {
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(([h, inv, water, shop]) => { localStorage.setItem('pos_cash_reg_on', '0');
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      const pre = water ? 'aqua_' : 'pos_';
      localStorage.setItem(pre + 'pw_hash', h); localStorage.setItem(pre + 'biz_name', 'Test Shop');
      for (const k of ['pos_notif_prompt_last', 'pos_cd_detect_last', 'aqua_notif_prompt_last']) localStorage.setItem(k, String(Date.now()));   // no "turn on notifications" banner over the bottom bar
      if (water) {
        localStorage.setItem('aqua_active_site_id', shop); localStorage.setItem('aqua_products', JSON.stringify(inv));
        localStorage.setItem('aqua_refill_sizes', JSON.stringify([{ id: 'size-1', sizeML: 1000, label: '1L', price: 10, siteId: shop, vatCategory: 'A' }]));
      } else localStorage.setItem('pos_inventory', JSON.stringify(inv));
    }, [H, app.water ? WATER_PRODUCTS : INV, !!app.water, SHOP]);
  }
  await page.goto(base + '/' + app.file); await page.waitForTimeout(1300);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.waitForFunction(() => window.__phoneTill && !!document.getElementById('ptl-bar'), null, { timeout: 8000 });
  if (app.water) await page.evaluate(() => renderAllItemsGrid());
  await page.waitForTimeout(700);
  await clearBanners(page);
  return { ctx, page, errors };
}
const clearBanners = (page) => page.evaluate(() => { for (const id of ['notif-prompt-banner']) { const b = document.getElementById(id); if (b) b.remove(); } });
async function addTwo(page, app) {
  if (app.water) await page.evaluate(() => { Array.from(document.querySelectorAll('#all-items-grid > .size-card')).slice(0, 2).forEach((c) => c.click()); });
  else await page.evaluate(() => { addToCart('A1'); addToCart('A3'); });
  await page.waitForTimeout(500);
}
async function withApps(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
const salesCount = (page) => page.evaluate(() => (typeof salesLog !== 'undefined' && Array.isArray(salesLog)) ? salesLog.length : -1);
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; }, sel);
async function openSettingsCard(page) {
  await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="settings-tab"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const b = document.querySelector('[data-section="settings-section-paymethods"]'); if (b) b.click(); });
  await page.waitForFunction(() => !!document.getElementById('pos-phonetill-panel') && !!document.querySelector('#pos-phonetill-panel .ptl-sw'), null, { timeout: 8000 });
}
const flip = (page, id) => page.evaluate((i) => { const l = document.getElementById(i).closest('label'); l.scrollIntoView({ block: 'center' }); }, id).then(() => page.click('label.ptl-sw:has(#' + id + ')'));
const toSales = async (page) => { await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="sales-tab"]'); if (b) b.click(); }); await page.waitForTimeout(400); await clearBanners(page); };
// opens the cart sheet with two items in it (a hidden box is only meaningful to check where it would be drawn)
const sheetUp = async (page, app) => { await toSales(page); if (!(await page.evaluate(() => Object.keys(currentCart).length))) await addTwo(page, app); await page.click('#mobile-cart-fab'); await page.waitForTimeout(350); };
const sheetDown = async (page) => { await page.click('.ptl-back'); await page.waitForTimeout(250); };


const step = (page) => page.evaluate(() => ['pps-s1', 'pps-s2', 'pps-s3'].filter((c) => document.documentElement.classList.contains(c)).join(''));
const shown = (page, sel) => vis(page, sel);

for (const app of APPS) {
  test(`${app.key}: Collect -> only the shop's payment methods -> that method's boxes -> Confirm, no scrolling, one sale`, { skip, timeout: 120000 }, async () => {
    await withApps(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app);
      await addTwo(page, app);
      await page.click('#mobile-cart-fab'); await page.waitForTimeout(400);
      // step 1: the cart, payment boxes out of the way, the pinned button says Collect
      assert.equal(await step(page), 'pps-s1');
      assert.equal(await shown(page, '#payment-toggle'), false, 'payment buttons wait for Collect');
      assert.equal(await shown(page, '#cash-payment-panel'), false);
      const label = await page.evaluate(() => getComputedStyle(document.getElementById('main-checkout-btn'), '::before').content);
      assert.match(label, /Collect/);
      const before = await salesCount(page);
      await page.tap('#main-checkout-btn'); await page.waitForTimeout(300);
      assert.equal(await salesCount(page), before, 'Collect does not sell');
      // step 2: only the methods the shop shows, big, all inside the screen without scrolling
      assert.equal(await step(page), 'pps-s2');
      const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#payment-toggle button')).filter((b) => getComputedStyle(b).display !== 'none').map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, h: r.height, t: r.top, b: r.bottom, vh: innerHeight }; }));
      assert.ok(tiles.length >= 2, 'the shop has several methods on: ' + JSON.stringify(tiles.map((t) => t.id)));
      for (const t of tiles) { assert.ok(t.h >= 56, t.id + ' is big: ' + t.h); assert.ok(t.t >= 0 && t.b <= t.vh, t.id + ' is on screen without scrolling'); }
      assert.equal(await shown(page, '#cart-table'), false, 'the cart is not shown while choosing');
      assert.match(await page.evaluate(() => document.getElementById('pps-head').textContent), /Amount to collect/);
      assert.match(await page.evaluate(() => document.getElementById('pps-head').textContent), /KES/);
      // choose Cash -> step 3: only the cash box is open, Confirm pinned
      await page.tap('#pay-cash-btn'); await page.waitForTimeout(300);
      assert.equal(await step(page), 'pps-s3');
      assert.equal(await shown(page, '#cash-payment-panel'), true, 'cash box shown');
      assert.equal(await shown(page, '#mpesa-prompt-panel'), false);
      assert.equal(await shown(page, '#payment-toggle'), false);
      const dock = await page.evaluate(() => { const b = document.getElementById('main-checkout-btn').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight, w: b.width }; });
      assert.ok(dock.top >= 0 && dock.bottom <= dock.vh + 0.5 && dock.w > 80, 'Confirm is pinned on screen: ' + JSON.stringify(dock));
      const inp = await page.evaluate(() => { const i = document.getElementById('cash-tendered-input'); const r = i.getBoundingClientRect(); return { t: r.top, b: r.bottom, vh: innerHeight }; });
      assert.ok(inp.t >= 0 && inp.b <= inp.vh, 'the amount box is on screen without scrolling: ' + JSON.stringify(inp));
      // Back returns to the methods, then to the cart
      await page.tap('#pps-head .pps-back'); await page.waitForTimeout(250);
      assert.equal(await step(page), 'pps-s2');
      await page.tap('#pps-head .pps-edit').catch(() => {}); await page.waitForTimeout(150);
      await page.tap('#main-checkout-btn'); await page.waitForTimeout(250);
      await page.tap('#pay-cash-btn'); await page.waitForTimeout(250);
      await page.evaluate(() => { const t = document.getElementById('cash-tendered-input'); t.value = '1000'; t.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.tap('#main-checkout-btn');
      await page.waitForFunction((b) => (typeof salesLog !== 'undefined' ? salesLog.length : -1) > b, before, { timeout: 15000 });
      await page.waitForTimeout(700);
      assert.equal(await salesCount(page), before + 1, 'exactly one sale');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open')), false, 'sheet closed');
      assert.equal(await step(page), '', 'steps reset after the sale');
      // next sale starts at step 1 again
      await addTwo(page, app); await page.click('#mobile-cart-fab'); await page.waitForTimeout(350);
      assert.equal(await step(page), 'pps-s1');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}

test('a method the shop switched off is not offered; one method skips the choice; split shows its own boxes', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[0];
    const { ctx, page, errors } = await open(browser, base, app);
    await addTwo(page, app);
    await page.evaluate(() => { for (const id of ['pay-card-btn', 'pay-bill-btn', 'pay-mpesa-btn']) { const b = document.getElementById(id); if (b) b.style.display = 'none'; } });
    await page.click('#mobile-cart-fab'); await page.waitForTimeout(350);
    await page.tap('#main-checkout-btn'); await page.waitForTimeout(250);
    const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#payment-toggle button')).filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.id));
    assert.deepEqual(ids, ['pay-cash-btn', 'pay-split-btn']);
    await page.tap('#pay-split-btn'); await page.waitForTimeout(250);
    assert.equal(await step(page), 'pps-s3');
    assert.equal(await shown(page, '#split-payment-panel'), true, 'split boxes');
    assert.equal(await shown(page, '#cash-payment-panel'), false);
    assert.ok(await page.evaluate(() => { const i = document.getElementById('split-cash-input').getBoundingClientRect(); return i.top >= 0 && i.bottom <= innerHeight; }), 'split boxes on screen');
    // only one method on: Collect goes straight to its boxes
    await page.tap('#pps-head .pps-edit'); await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('pay-split-btn').style.display = 'none'; });
    await page.tap('#main-checkout-btn'); await page.waitForTimeout(300);
    assert.equal(await step(page), 'pps-s3', 'a single method skips the choice');
    assert.equal(await shown(page, '#cash-payment-panel'), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('on a computer nothing changes: the payment buttons and Confirm stay where they were, no steps', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, APPS[0], { width: 1280, height: 900 });
    await page.evaluate(() => addToCart('A1')); await page.waitForTimeout(400);
    assert.equal(await step(page), '');
    assert.equal(await shown(page, '#payment-toggle'), true);
    assert.equal(await shown(page, '#main-checkout-btn'), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
