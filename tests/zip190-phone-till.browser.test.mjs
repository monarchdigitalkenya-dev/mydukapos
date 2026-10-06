import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 190: the PHONE TILL block (src/shared/blocks/phone-till.html) in a real phone-sized Chromium (390 x 844, touch), in every app that has a Sales Counter:
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
    await ctx.addInitScript(([h, inv, water, shop]) => {
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
  await page.evaluate(() => { const b = document.querySelector('[data-section="settings-section-view"]'); if (b) b.click(); });
  await page.waitForFunction(() => !!document.getElementById('pos-phonetill-panel') && !!document.querySelector('#pos-phonetill-panel .ptl-sw'), null, { timeout: 8000 });
}
const flip = (page, id) => page.evaluate((i) => { const l = document.getElementById(i).closest('label'); l.scrollIntoView({ block: 'center' }); }, id).then(() => page.click('label.ptl-sw:has(#' + id + ')'));
const toSales = async (page) => { await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="sales-tab"]'); if (b) b.click(); }); await page.waitForTimeout(400); await clearBanners(page); };
// opens the cart sheet with two items in it (a hidden box is only meaningful to check where it would be drawn)
const sheetUp = async (page, app) => { await toSales(page); if (!(await page.evaluate(() => Object.keys(currentCart).length))) await addTwo(page, app); await page.click('#mobile-cart-fab'); await page.waitForTimeout(350); };
// zip 200: the pay boxes (customer phone, cash tendered) are on the payment screen: tap Collect, pick cash
const toPay = async (page) => { await page.tap('#main-checkout-btn'); await page.waitForTimeout(250); if (await page.evaluate(() => document.documentElement.classList.contains('pps-s2'))) { await page.tap('#pay-cash-btn'); await page.waitForTimeout(250); } };
const sheetDown = async (page) => { if (await page.evaluate(() => /pps-s[23]/.test(document.documentElement.className))) { await page.click('#pps-head .pps-edit'); await page.waitForTimeout(200); } await page.click('.ptl-back'); await page.waitForTimeout(250); };

for (const app of APPS) {
  test(`${app.key}: phone cart lines fit, the cart opens as a sheet, a cash sale completes once and closes it`, { skip, timeout: 120000 }, async () => {
    await withApps(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app);
      // before anything is added: no bar, the cart card is not on the page, the document does not scroll sideways
      assert.equal(await vis(page, '#ptl-bar'), false, 'no bar while the cart is empty');
      assert.equal(await vis(page, '#cart-table'), false, 'the cart card is only reachable through the sheet on a phone');
      await addTwo(page, app);
      assert.equal(await vis(page, '#ptl-bar'), true, 'the summary bar shows once the cart has items');
      const bar = await page.evaluate(() => document.getElementById('ptl-bar').textContent.replace(/\s+/g, ' ').trim());
      assert.match(bar, /2 items/); assert.match(bar, /KES [\d,.]+/); assert.match(bar, /View cart/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on the product page');
      // the round cart button opens the sheet (a real tap)
      await page.click('#mobile-cart-fab');
      await page.waitForTimeout(400);
      const sheet = await page.evaluate(() => { const p = document.querySelector('.ptl-open'); const cs = getComputedStyle(p), r = p.getBoundingClientRect(); return { pos: cs.position, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, open: document.documentElement.classList.contains('ptl-sheet-open'), sw: p.scrollWidth, cw: p.clientWidth }; });
      assert.equal(sheet.pos, 'fixed'); assert.ok(sheet.open);
      assert.ok(Math.abs(sheet.x) < 1 && Math.abs(sheet.y) < 1 && Math.abs(sheet.w - sheet.vw) < 1 && Math.abs(sheet.h - sheet.vh) < 1, 'covers the whole viewport: ' + JSON.stringify(sheet));
      assert.ok(sheet.sw <= sheet.cw + 1, 'the sheet itself does not scroll sideways');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll with the sheet open');
      assert.equal(await vis(page, '.ptl-back'), true, 'a Back button is in the sheet header');
      // every cart line is fully inside the screen: name, qty box, unit price, total, remove
      const rows = await page.evaluate(() => {
        const out = [], W = innerWidth;
        document.querySelectorAll('#cart-table tbody tr').forEach((tr) => {
          if (tr.querySelector('td[colspan]')) return;
          const tds = tr.querySelectorAll(':scope > td'); const parts = { name: tds[0], qty: tds[1].querySelector('input'), price: tds[2], total: tds[3], remove: tds[4].querySelector('button') };
          const o = {};
          for (const k in parts) { const r = parts[k] ? parts[k].getBoundingClientRect() : null; o[k] = r ? { l: r.left, r: r.right, w: r.width, h: r.height } : null; }
          o.W = W; out.push(o);
        });
        return out;
      });
      assert.equal(rows.length, 2);
      for (const r of rows) {
        for (const k of ['name', 'qty', 'price', 'total', 'remove']) { assert.ok(r[k], k + ' exists'); assert.ok(r[k].w > 0 && r[k].l >= -0.5 && r[k].r <= r.W + 0.5, `${k} inside the screen: ${JSON.stringify(r[k])}`); }
        assert.ok(r.qty.h >= 40, 'qty box keeps a big tap height: ' + r.qty.h);
        assert.ok(r.remove.w >= 36 && r.remove.h >= 40, 'remove button keeps a real tap size');
      }
      // Confirm is on screen without scrolling, and the total is shown beside it
      const dock = await page.evaluate(() => { const b = document.getElementById('main-checkout-btn').getBoundingClientRect(), t = document.getElementById('cart-grand-total').getBoundingClientRect(); return { bt: b.top, bb: b.bottom, bl: b.left, br: b.right, tt: t.top, tb: t.bottom, vh: innerHeight, vw: innerWidth }; });
      assert.ok(dock.bt >= 0 && dock.bb <= dock.vh + 0.5 && dock.bl >= 0 && dock.br <= dock.vw + 0.5, 'Confirm is on screen: ' + JSON.stringify(dock));
      assert.ok(dock.tb <= dock.vh + 0.5 && dock.tt >= 0, 'the total is pinned on screen too');
      // Back closes it; the bar is back; open again
      await page.click('.ptl-back'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open')), false);
      assert.equal(await vis(page, '#cart-table'), false);
      assert.equal(await vis(page, '#ptl-bar'), true);
      await page.click('#ptl-bar'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open')), true, 'the bar opens the sheet too');
      // Escape closes it
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open')), false, 'Escape closes the sheet');
      await page.click('#ptl-bar'); await page.waitForTimeout(250);
      // complete a cash sale from the sheet: exactly one sale, the sheet closes by itself, the cart is empty
      const before = await salesCount(page);
      // zip 200: the pinned button is "Collect"; the shop's payment methods come next, then the method's boxes, then Confirm
      await page.tap('#main-checkout-btn'); await page.waitForTimeout(250);
      if (await page.evaluate(() => document.documentElement.classList.contains('pps-s2'))) { await page.tap('#pay-cash-btn'); await page.waitForTimeout(250); }
      await page.evaluate(() => { const t = document.getElementById('cash-tendered-input'); if (t) { t.value = '1000'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
      await page.tap('#main-checkout-btn');
      await page.waitForFunction((b) => (typeof salesLog !== 'undefined' ? salesLog.length : -1) > b, before, { timeout: 15000 });
      await page.waitForTimeout(700);
      assert.equal(await salesCount(page), before + 1, 'exactly one sale was recorded');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open')), false, 'the sheet closed by itself');
      assert.equal(await vis(page, '#ptl-bar'), false, 'the bar is gone with the empty cart');
      assert.equal(await page.evaluate(() => Object.keys(currentCart).length), 0);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}

test('a cart line stays whole at 320 px wide too (long name, big amounts)', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[1];
    const c2 = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    await c2.route('**/api/**', (r) => r.abort());
    await c2.addInitScript(([h, inv]) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_notif_prompt_last', String(Date.now())); localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', JSON.stringify(inv)); }, [H, INV.map((p) => ({ ...p, price: p.price * 1234.5 }))]);
    const page = await c2.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(base + '/' + app.file); await page.waitForTimeout(1300);
    await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
    await page.waitForFunction(() => !!document.getElementById('ptl-bar'));
    await page.waitForTimeout(600); await clearBanners(page);
    await page.evaluate(() => { addToCart('A1'); addToCart('A3'); setCartQty && setCartQty('A1', 12.5); });
    await page.waitForTimeout(400);
    await page.click('#mobile-cart-fab'); await page.waitForTimeout(400);
    const bad = await page.evaluate(() => {
      const W = innerWidth, out = [];
      document.querySelectorAll('#cart-table tbody tr td, #cart-table tbody tr button, #cart-table tbody tr input').forEach((e) => { const r = e.getBoundingClientRect(); if (r.width && (r.left < -0.5 || r.right > W + 0.5)) out.push(e.tagName + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); });
      return out;
    });
    assert.deepEqual(bad, [], 'nothing leaves the 320 px screen');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const dock = await page.evaluate(() => { const b = document.getElementById('main-checkout-btn').getBoundingClientRect(); return b.bottom <= innerHeight + 0.5 && b.top >= 0 && b.right <= innerWidth + 0.5; });
    assert.ok(dock, 'Confirm is still on screen at 320 x 640');
    assert.deepEqual(errors, []);
    await c2.close();
  });
});

for (const app of APPS) {
  test(`${app.key}: delivery switch forces walk-in; the phone box can be hidden and a sale still completes; settings persist after a reload`, { skip, timeout: 150000 }, async () => {
    await withApps(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app);
      // the card is in Settings, next to the payment methods
      await openSettingsCard(page);
      assert.equal(await page.evaluate(() => document.getElementById('pos-phonetill-panel').parentNode.id), 'settings-section-view');
      // (a) delivery: pick Delivery first, then switch the choice off -> walk-in, toggle and form hidden
      await page.evaluate(() => { setOrderType('delivery'); });
      assert.equal(await page.evaluate(() => orderType), 'delivery');
      await flip(page, 'ptl-sw-delivery'); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => orderType), 'walkin', 'forced back to walk-in');
      assert.equal(await page.evaluate(() => document.getElementById('order-walkin-btn').classList.contains('active')), true);
      await sheetUp(page, app);
      assert.equal(await vis(page, '#order-type-toggle'), false, 'the whole Walk-In / Delivery toggle is hidden');
      assert.equal(await vis(page, '#delivery-details-group'), false);
      await sheetDown(page);
      await page.evaluate(() => { setOrderType('delivery'); });
      assert.equal(await page.evaluate(() => orderType), 'walkin', 'it can never end up on delivery while the choice is hidden');
      // (b) customer phone: type one, hide the box -> hidden, emptied
      await sheetUp(page, app); await toPay(page);
      assert.equal(await vis(page, '#' + app.phone), true, 'the phone box shows while the switch is on');
      await page.evaluate((id) => { document.getElementById(id).value = '0712345678'; }, app.phone);
      await sheetDown(page);
      await openSettingsCard(page);
      await flip(page, 'ptl-sw-phone'); await page.waitForTimeout(300);
      await sheetUp(page, app); await toPay(page);
      assert.equal(await vis(page, '#' + app.phone), false, 'the phone box is hidden');
      assert.equal(await page.evaluate((id) => document.getElementById(id).value, app.phone), '', 'a number typed earlier is dropped');
      // the settings are shop settings: they are in the sync payload (the same hook the payment methods use)
      assert.deepEqual(await page.evaluate(() => extraSettingsCollect().phoneTill), { phone: false, delivery: false, tables: true });
      // a sale still completes with the box hidden and empty
      const before = await salesCount(page);
      assert.equal(await vis(page, '#' + app.phone), false, 'still hidden inside the sheet');
      await page.evaluate(() => { const t = document.getElementById('cash-tendered-input'); if (t) { t.value = '1000'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
      await page.tap('#main-checkout-btn');
      await page.waitForFunction((b) => salesLog.length > b, before, { timeout: 15000 });
      await page.waitForTimeout(500);
      assert.equal(await salesCount(page), before + 1);
      const last = await page.evaluate(() => { const s = salesLog[salesLog.length - 1]; return { phone: s.customerPhone == null ? null : s.customerPhone, type: s.orderType }; });
      assert.equal(last.phone, null); assert.equal(last.type, 'walkin');
      // persists after a reload
      await page.close();
      const again = await open(browser, base, app, { reuse: { ctx } });
      await sheetUp(again.page, app);
      assert.equal(await vis(again.page, '#order-type-toggle'), false, 'delivery choice still hidden after a reload');
      assert.equal(await vis(again.page, '#' + app.phone), false, 'phone box still hidden after a reload');
      await sheetDown(again.page);
      assert.equal(await again.page.evaluate(() => document.documentElement.classList.contains('ptl-no-delivery') && document.documentElement.classList.contains('ptl-no-phone')), true);
      // ... and the switches show it
      await openSettingsCard(again.page);
      assert.equal(await again.page.evaluate(() => [document.getElementById('ptl-sw-delivery').checked, document.getElementById('ptl-sw-phone').checked]).then((a) => a.join()), 'false,false');
      // switching back on shows everything again
      await flip(again.page, 'ptl-sw-delivery'); await flip(again.page, 'ptl-sw-phone'); await again.page.waitForTimeout(300);
      await sheetUp(again.page, app);
      assert.equal(await vis(again.page, '#order-type-toggle'), true, 'the Walk-In / Delivery choice is back');
      await toPay(again.page);
      assert.equal(await vis(again.page, '#' + app.phone), true, 'the phone box is back');
      assert.deepEqual(errors, []); assert.deepEqual(again.errors, []);
      await ctx.close();
    });
  });
}

for (const app of APPS.filter((a) => a.search)) {
  test(`${app.key}: search icon mode expands and collapses and live search still returns results`, { skip, timeout: 120000 }, async () => {
    await withApps(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app);
      // bar mode (default): the box is the header, the placeholder carries the label, no "Product Search" title on screen
      assert.equal(await vis(page, '#sales-search'), true);
      assert.equal(await vis(page, '#ptl-search-btn'), false);
      assert.match(await page.evaluate(() => document.getElementById('sales-search').getAttribute('placeholder')), /Search/);
      const h3 = await page.evaluate(() => { const h = document.querySelector('.ptl-prod > h3'); const r = h.getBoundingClientRect(); const s = document.getElementById('sales-search').getBoundingClientRect(); return { fs: getComputedStyle(h).fontSize, h: r.height, searchTop: s.top, h3Top: r.top }; });
      assert.equal(h3.fs, '0px', 'the "Product Search" heading takes no room');
      assert.ok(Math.abs(h3.searchTop - h3.h3Top) < 40, 'the header buttons share the search box row');
      // live search works in bar mode
      await page.fill('#sales-search', 'soda'); await page.waitForTimeout(300);
      assert.equal(await vis(page, '#search-results'), true);
      assert.ok(await page.evaluate(() => document.querySelectorAll('#search-results .search-item').length) >= 1);
      await page.fill('#sales-search', ''); await page.waitForTimeout(200);
      // icon mode
      await openSettingsCard(page);
      await page.evaluate(() => document.querySelector('input[name="ptl-search"][value="icon"]').closest('label').scrollIntoView({ block: 'center' }));
      await page.click('label:has(input[name="ptl-search"][value="icon"])'); await page.waitForTimeout(300);
      await toSales(page);
      assert.equal(await vis(page, '#sales-search'), false, 'the box is collapsed');
      assert.equal(await vis(page, '#ptl-search-btn'), true, 'the magnifier shows');
      const small = await page.evaluate(() => { const r = document.getElementById('ptl-search-btn').getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(small.h >= 44 && small.w >= 44, 'a real tap size');
      await page.tap('#ptl-search-btn'); await page.waitForTimeout(400);
      assert.equal(await vis(page, '#sales-search'), true, 'the box expands');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'sales-search', 'and has the keyboard');
      await page.fill('#sales-search', 'soda'); await page.waitForTimeout(300);
      assert.equal(await vis(page, '#search-results'), true);
      const box = await page.evaluate(() => { const r = document.getElementById('search-results').getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth, n: document.querySelectorAll('#search-results .search-item').length }; });
      assert.ok(box.n >= 1 && box.l >= 0 && box.r <= box.vw + 0.5, 'results drop down inside the screen: ' + JSON.stringify(box));
      // tap a result: it lands in the cart
      await page.evaluate(() => { document.querySelector('#search-results .search-item').click(); }); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => Object.keys(currentCart).length), 1);
      assert.equal(await vis(page, '#sales-search'), false, 'picking a result puts the box away again');
      // closing collapses it and clears the text and the results
      await page.tap('#ptl-search-btn'); await page.waitForTimeout(300);
      await page.fill('#sales-search', 'soda'); await page.waitForTimeout(200);
      await page.tap('.ptl-search-x'); await page.waitForTimeout(300);
      assert.equal(await vis(page, '#sales-search'), false, 'closing collapses the box');
      assert.equal(await page.evaluate(() => document.getElementById('sales-search').value), '');
      assert.equal(await vis(page, '#search-results'), false);
      // it is a per-device setting that survives a reload
      await page.close();
      const again = await open(browser, base, app, { reuse: { ctx } });
      assert.equal(await vis(again.page, '#ptl-search-btn'), true);
      assert.equal(await vis(again.page, '#sales-search'), false);
      assert.ok(await again.page.evaluate(() => localStorage.getItem('pos_ptl_search') === 'icon'));
      // zip 217: the search style is a shop setting now - it travels to every device
      assert.equal(await again.page.evaluate(() => (extraSettingsCollect().phoneTill || {}).search), 'icon');
      assert.deepEqual(errors, []); assert.deepEqual(again.errors, []);
      await ctx.close();
    });
  });
}

test('hotel: the Table / Room picker can be hidden even with Tab payments on; the Tabs button stays and a Tab order still goes to a guest', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[1];
    const { ctx, page, errors } = await open(browser, base, app);
    await openSettingsCard(page);
    await flip(page, 'ptl-sw-tables'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('ptl-sw-tables').checked), false);
    assert.match(await page.evaluate(() => document.querySelector('#pos-phonetill-panel .ptl-sw:has(#ptl-sw-tables) small').textContent), /Tabs button stays/);
    await toSales(page);
    await page.evaluate(() => { addToCart('A1'); }); await page.waitForTimeout(300);
    await page.click('#mobile-cart-fab'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-no-loc')), true);
    assert.equal(await vis(page, '#sales-location-select'), false, 'the Table / Room picker is hidden although Tab payments are accepted');
    assert.equal(await page.evaluate(() => { const b = [...document.querySelectorAll('.ptl-loc-group button')].find((x) => /Tabs/.test(x.textContent)); return !!b && b.offsetParent !== null; }), true, 'the Tabs button stays');
    await page.tap('#main-checkout-btn'); await page.waitForTimeout(250);   // zip 200: Collect shows the payment methods
    assert.equal(await vis(page, '#pay-tab-btn'), true, 'Tab payment is still offered');
    // a Tab order with no table picked goes to an auto-numbered guest tab
    await page.evaluate(() => { setPaymentMethod('tab'); });
    const before = await page.evaluate(() => tabs.filter((t) => t.status === 'OPEN').length);
    await page.evaluate(() => { submitTabOrder(); }); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => tabs.filter((t) => t.status === 'OPEN' && /^Guest: Guest \d+$/.test(t.label)).length), before + 1);
    // switch it back on -> the picker returns
    await openSettingsCard(page);
    await flip(page, 'ptl-sw-tables'); await page.waitForTimeout(300);
    await toSales(page);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ptl-no-loc')), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('hotel: tabs hidden on this phone are gone; only Settings cannot be hidden; roles still win', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[1];
    const { ctx, page, errors } = await open(browser, base, app);
    await page.evaluate(() => window.sidebarNav && window.sidebarNav.off());   // zip 202: this per-phone preference belongs to the fallback bar
    await openSettingsCard(page);
    // zip 215: the Sales Counter can be hidden too; only Settings is never in the list
    const listed = await page.evaluate(() => Array.from(document.querySelectorAll('.ptl-tab-cb')).map((c) => c.value));
    assert.ok(listed.length > 5);
    assert.equal(listed.includes('sales-tab'), true); assert.equal(listed.includes('settings-tab'), false);
    // hide Kitchen and the Dashboard (when present) on this phone
    const hide = ['kitchen-tab', 'dashboard-tab'].filter((t) => listed.includes(t));
    assert.ok(hide.length >= 1);
    // a tab the roles hide (inline display:none, like applyServerVisibility does) must stay hidden whatever we do
    await page.evaluate(() => { const b = document.querySelector('.tab-link[data-tab="staff-tab"]'); if (b) b.style.display = 'none'; });
    for (const t of hide) { await page.evaluate((id) => document.querySelector('.ptl-tab-cb[value="' + id + '"]').closest('label').scrollIntoView({ block: 'center' }), t); await page.click('label:has(.ptl-tab-cb[value="' + t + '"])'); }
    await page.waitForTimeout(400);
    // zip 215: a hidden tab is GONE (bar, More and side menu), not parked under More
    for (const t of hide) {
      const st = await page.evaluate((id) => Array.from(document.querySelectorAll('.tab-link[data-tab="' + id + '"]')).map((b) => ({ off: b.classList.contains('ptl-tab-off'), shown: getComputedStyle(b).display !== 'none' })), t);
      assert.ok(st.length >= 1 && st.every((x) => x.off && !x.shown), t + ' is hidden everywhere');
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tab-link[data-tab="staff-tab"]')).display), 'none', 'a role-hidden tab stays hidden');
    // ticking it again brings it back
    await page.evaluate((id) => document.querySelector('.ptl-tab-cb[value="' + id + '"]').closest('label').scrollIntoView({ block: 'center' }), hide[0]); await page.click('label:has(.ptl-tab-cb[value="' + hide[0] + '"])'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate((t) => Array.from(document.querySelectorAll('.tab-link[data-tab="' + t + '"]')).some((b) => !b.classList.contains('ptl-tab-off')), hide[0]), true, 'it is back');
    await page.evaluate((id) => document.querySelector('.ptl-tab-cb[value="' + id + '"]').closest('label').scrollIntoView({ block: 'center' }), hide[0]); await page.click('label:has(.ptl-tab-cb[value="' + hide[0] + '"])'); await page.waitForTimeout(300);
    // zip 217: the hidden tabs are shop settings now - in the synced payload (every device); survives a reload
    assert.equal(await page.evaluate(() => JSON.stringify((extraSettingsCollect().phoneTill || {}).tabsOff || []).includes('kitchen-tab')), true);
    assert.equal(await page.evaluate(() => (JSON.parse(localStorage.getItem('pos_ptl_tabs_off')) || []).length >= 1), true);
    await page.close();
    const again = await open(browser, base, app, { reuse: { ctx } });
    await again.page.evaluate(() => window.sidebarNav && window.sidebarNav.off());
    await again.page.waitForTimeout(800);
    assert.equal(await again.page.evaluate((t) => { const b = document.querySelector('.tab-link[data-tab="' + t + '"]'); return b.classList.contains('ptl-tab-off'); }, hide[0]), true);
    assert.deepEqual(errors, []); assert.deepEqual(again.errors, []);
    await ctx.close();
  });
});

for (const app of APPS) {
  test(`${app.key}: at 1280 px nothing changed (cart card in the page, delivery choice visible, no bar, old search box)`, { skip, timeout: 120000 }, async () => {
    await withApps(async (browser, base) => {
      const { ctx, page, errors } = await open(browser, base, app, { width: 1280, height: 800 });
      await addTwo(page, app);
      const d = await page.evaluate((hasSearch) => {
        const p = document.querySelector('#cart-sticky-bar').closest('.panel'), cs = getComputedStyle(p);
        const tb = document.getElementById('cart-table'), th = tb.querySelector('thead');
        const h = document.querySelector('#sales-tab .pos-grid > .panel > h3');
        const rowd = tb.querySelector('tbody tr') && getComputedStyle(tb.querySelector('tbody tr')).display;
        return {
          pos: cs.position, disp: cs.display, tableDisp: getComputedStyle(tb).display, theadDisp: getComputedStyle(th).display, rowDisp: rowd,
          toggle: getComputedStyle(document.getElementById('order-type-toggle')).display,
          bar: getComputedStyle(document.getElementById('ptl-bar')).display,
          back: getComputedStyle(document.querySelector('.ptl-back')).display,
          sheet: document.documentElement.classList.contains('ptl-sheet-open'),
          htmlOverflow: getComputedStyle(document.documentElement).overflow,
          heading: h ? getComputedStyle(h).fontSize : null,
          ph: hasSearch ? document.getElementById('sales-search').getAttribute('placeholder') : null,
          searchBtn: document.querySelector('.ptl-search-btn') ? getComputedStyle(document.querySelector('.ptl-search-btn')).display : 'none',
          cols: getComputedStyle(document.getElementById(hasSearch ? 'item-image-grid' : 'all-items-grid')).gridTemplateColumns.split(' ').length,
          fabs: [document.getElementById('floating-kb-toggle'), document.getElementById('scroll-to-top-btn')].filter(Boolean).map((e) => getComputedStyle(e).width),
        };
      }, !!app.search);
      assert.notEqual(d.pos, 'fixed', 'the cart card is not a sheet on a big screen: ' + d.pos);
      assert.notEqual(d.disp, 'none');
      assert.equal(d.tableDisp, 'table'); assert.equal(d.theadDisp, 'table-header-group'); assert.equal(d.rowDisp, 'table-row');
      assert.notEqual(d.toggle, 'none', 'the Walk-In / Delivery choice is visible');
      assert.equal(d.bar, 'none'); assert.equal(d.back, 'none'); assert.equal(d.sheet, false); assert.equal(d.searchBtn, 'none');
      assert.notEqual(d.htmlOverflow, 'hidden');
      if (app.search) {
        assert.match(d.ph, /Search by Code|Search/); assert.doesNotMatch(d.ph, /Search products…/);
        assert.notEqual(d.heading, '0px', 'the Product Search heading is still there');
      }
      assert.ok(d.cols >= 3 || !app.search, 'the tile grid keeps its own column count on a computer: ' + d.cols);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      for (const w of d.fabs) assert.ok(parseFloat(w) >= 44, 'floating buttons keep their size on a computer: ' + w);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}

test('the pay-later bill still gets its phone number while the phone box is switched off', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[0];
    const { ctx, page, errors } = await open(browser, base, app);
    await page.evaluate(() => { const s = window.__phoneTillApi.shop(); localStorage.setItem('pos_ptl_shop', JSON.stringify({ phone: 0, delivery: 1, tables: 1 })); window.__phoneTillApi.apply(); });
    await addTwo(page, app);
    await page.click('#mobile-cart-fab'); await page.waitForTimeout(300);
    await toPay(page);                                                       // zip 200: the phone box lives on the payment screen
    assert.equal(await vis(page, '#sms-checkout-phone-input'), false);
    await page.evaluate(() => setPaymentMethod('bill')); await page.waitForTimeout(200);
    assert.equal(await vis(page, '#sms-checkout-phone-input'), true, 'Bill keeps the box: the bill is saved against that number');
    await page.evaluate(() => setPaymentMethod('cash')); await page.waitForTimeout(200);
    assert.equal(await vis(page, '#sms-checkout-phone-input'), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('the sheet closes by itself when the cart is emptied or another tab opens; a held sale is reachable from the bar', { skip, timeout: 120000 }, async () => {
  await withApps(async (browser, base) => {
    const app = APPS[0];
    const { ctx, page, errors } = await open(browser, base, app);
    const sheetOpen = () => page.evaluate(() => document.documentElement.classList.contains('ptl-sheet-open'));
    // removing the last line from inside the sheet closes it
    await addTwo(page, app);
    await page.click('#mobile-cart-fab'); await page.waitForTimeout(300);
    assert.equal(await sheetOpen(), true);
    await page.tap('#cart-table tbody tr:nth-child(1) .remove-btn'); await page.waitForTimeout(250);
    assert.equal(await sheetOpen(), true, 'one line left: still open');
    await page.tap('#cart-table tbody tr:nth-child(1) .remove-btn'); await page.waitForTimeout(400);
    assert.equal(await sheetOpen(), false, 'an empty cart closes the sheet');
    assert.equal(await vis(page, '#ptl-bar'), false);
    // another tab opening closes it (and the cart is still there when you come back)
    await addTwo(page, app);
    await page.click('#ptl-bar'); await page.waitForTimeout(300);
    assert.equal(await sheetOpen(), true);
    await page.evaluate(() => { document.querySelector('.tab-link[data-tab="dashboard-tab"]').click(); }); await page.waitForTimeout(400);
    assert.equal(await sheetOpen(), false, 'switching tab closes the sheet');
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow !== 'hidden' && getComputedStyle(document.body).overflow !== 'hidden'), true, 'the page scrolls again');
    assert.equal(await vis(page, '#ptl-bar'), false, 'no bar on another tab');
    await toSales(page);
    assert.equal(await vis(page, '#ptl-bar'), true, 'the bar is back on the Sales Counter with the cart intact');
    // hold the sale from inside the sheet: the sheet closes, the bar offers to resume it
    await page.click('#ptl-bar'); await page.waitForTimeout(300);
    await page.tap('#hold-sale-btn'); await page.waitForTimeout(500);
    assert.equal(await sheetOpen(), false, 'putting the sale on hold closes the sheet');
    assert.equal(await vis(page, '#ptl-bar'), true, 'the bar stays, to bring the held sale back');
    assert.match(await page.evaluate(() => document.getElementById('ptl-bar').textContent), /on hold/);
    await page.click('#ptl-bar'); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => Object.keys(currentCart).length), 2, 'the held sale is back in the cart');
    assert.match(await page.evaluate(() => document.getElementById('ptl-bar').textContent), /2 items/);
    // growing past phone width while the sheet is open lets go of the page
    await page.click('#ptl-bar'); await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1100, height: 800 }); await page.waitForTimeout(500);
    assert.equal(await sheetOpen(), false);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#cart-sticky-bar').closest('.panel')).position), 'fixed');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
