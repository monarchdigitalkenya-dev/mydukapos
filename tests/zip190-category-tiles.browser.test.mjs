import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 190: category image tiles on the Sales Counter (src/shared/blocks/category-tiles.html). Real Chromium on a phone-sized screen.
// Settings > Category images (switch + a picture per category, picked through the real file chooser), the tiles on the counter, tapping a tile
// (Hotel: sub-category tiles first), Back, search bypass, the cart keeping the opened category, switch OFF = today's counter, persistence, the
// settings sync (payload + not sent again on every sale), the 60-picture cap, the 240 px scaling, dark theme, no sideways scroll, no page errors.
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
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const RED_URL = 'data:image/png;base64,' + RED;
const it = (code, name, category, extra = {}) => ({ code, type: 'item', name, category, price: 50, qty: 10, unit: 'pcs', ...extra });
const SHOP = [
  it('A1', 'Soda', 'Drinks'), it('A2', 'Juice', 'Drinks'), it('A3', 'Water', 'Drinks'),
  it('B1', 'Bread', 'Bakery'), it('B2', 'Scone', 'Bakery'),
  it('S1', 'Pen', 'Stationery'),
];
const HOTEL = [
  it('M1', 'Choc shake', 'Milkshakes'), it('M2', 'Vanilla shake', 'Milkshakes'), it('M3', 'Mango shake', 'Milkshakes'),
  it('P1', 'Pizza', 'Mains'), it('P2', 'Burger', 'Mains'),
  it('D1', 'Cola', 'Drinks'),
];
const APPS = { shop: 'index.html', hotel: 'hotel/index.html', pharmacy: 'pharmacy/index.html', production: 'production/index.html', services: 'services/index.html', hospital: 'hospital/index.html', water: 'water/index.html' };

async function withApp(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
async function open(browser, base, app, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, inv, extra]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Shop');
    localStorage.setItem('pos_inventory', JSON.stringify(inv));
    Object.keys(extra || {}).forEach((k) => localStorage.setItem(k, extra[k]));
  }, [H, o.inv || SHOP, o.storage || {}]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/' + APPS[app]); await page.waitForTimeout(1300);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const tab = async (page, id) => { await page.evaluate((t) => { document.querySelector('.tab-link[data-tab="' + t + '"]').click(); }, id); await page.waitForTimeout(300); };
const toSales = (page) => tab(page, 'sales-tab');
async function toPanel(page) { await tab(page, 'settings-tab'); await page.evaluate(() => document.querySelector('.settings-subtab-btn[data-section="settings-section-catimages"]').click()); await page.waitForTimeout(200); }
const tiles = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#ctl-host .ctl-tile')).map((t) => ({ kind: t.dataset.ctl, name: t.querySelector('.ctl-name').textContent, n: Number(t.querySelector('.ctl-badge').textContent), img: !!t.querySelector('img'), ph: (t.querySelector('.ctl-ph') || {}).textContent || '', tag: t.tagName })));
const cells = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#item-image-grid .item-grid-cell')).map((c) => (c.querySelector('.igc-name') || {}).textContent));
const gridShown = (page) => page.evaluate(() => getComputedStyle(document.getElementById('item-image-grid')).display !== 'none');
const hostShown = (page) => page.evaluate(() => { const h = document.getElementById('ctl-host'); return !!h && getComputedStyle(h).display !== 'none' && h.innerHTML.trim() !== ''; });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
const tap = async (page, name) => { await page.locator('#ctl-host .ctl-tile', { hasText: name }).first().click(); await page.waitForTimeout(250); };
const sorted = (a) => a.slice().sort();
async function bigPng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#e67e22'); g.addColorStop(1, '#2980b9'); x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    for (let i = 0; i < 400; i++) { x.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,50%)'; x.beginPath(); x.arc((i * 97) % 1600, (i * 61) % 1200, 20 + (i % 40), 0, 7); x.fill(); }
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}
async function pickImage(page, key, buffer) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#ctl-panel [data-ctl-act="pick"][data-k="' + encodeURIComponent(key) + '"]').click()]);
  await fc.setFiles({ name: 'cat.png', mimeType: 'image/png', buffer });
  await page.waitForFunction((k) => !!window.__catTiles.images()[k] || /no room|up to|could not/i.test((document.getElementById('ctl-msg') || {}).textContent || ''), key, { timeout: 8000 });
  await page.waitForTimeout(150);
}
const setSwitch = async (page, on) => { await page.locator('#ctl-switch').setChecked(on); await page.waitForTimeout(250); };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// every app with the plain category field: Shop, Pharmacy, Production, Services, Hospital behave the same
for (const app of ['shop', 'pharmacy', 'production', 'services', 'hospital']) {
  test(`${app}: tiles, image + letter tile, open a category, back, search bypass, cart keeps the category, switch off = today`, { skip, timeout: 180000 }, async () => {
    await withApp(async (browser, base) => {
      // the counter as it is today (switch never turned on)
      const b0 = await open(browser, base, app);
      await toSales(b0.page);
      const baseline = await b0.page.evaluate(() => document.getElementById('item-image-grid').innerHTML);
      const baseCells = await cells(b0.page);
      assert.equal(baseCells.length, 6);
      assert.equal(await hostShown(b0.page), false, 'no tiles while the switch is off');
      assert.equal(await b0.page.evaluate(() => document.body.classList.contains('ctl-on')), false);
      assert.deepEqual(b0.errors, []); await b0.ctx.close();

      const { ctx, page, errors } = await open(browser, base, app);
      await toSales(page);
      // Settings: the panel exists, lists every category, the switch is OFF by default
      await toPanel(page);
      assert.equal(await page.evaluate(() => document.getElementById('ctl-switch').checked), false, 'default OFF');
      assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#ctl-panel .ctl-rname b')).map((b) => b.textContent)), ['Bakery', 'Drinks', 'Stationery']);
      assert.ok(await page.evaluate(() => document.getElementById('ctl-file').accept === 'image/*'), 'camera / gallery allowed');
      // a BIG picture through the real file chooser: scaled to <= 240 px, JPEG, about 20 KB
      await pickImage(page, 'Drinks', await bigPng(page));
      const dm = await page.evaluate(() => new Promise((res) => { const u = window.__catTiles.images().Drinks; const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight, len: u.length, jpeg: u.startsWith('data:image/jpeg') }); i.src = u; }));
      assert.ok(dm.w <= 240 && dm.h <= 240 && dm.w >= 200, 'scaled to 240 px: ' + JSON.stringify(dm));
      assert.ok(Math.abs(dm.w / dm.h - 4 / 3) < 0.03, 'keeps the proportions');
      assert.ok(dm.jpeg && dm.len <= 28000, 'a small JPEG: ' + dm.len);
      await pickImage(page, 'Bakery', Buffer.from(RED, 'base64'));
      assert.deepEqual(Object.keys(await page.evaluate(() => window.__catTiles.images())).sort(), ['Bakery', 'Drinks']);
      assert.ok(await noSideScroll(page), 'settings panel fits a phone');
      await setSwitch(page, true);
      assert.equal(await page.evaluate(() => localStorage.getItem('pos_cat_tiles')), 'true');

      // the counter: tiles instead of the grid
      await toSales(page);
      assert.equal(await hostShown(page), true);
      assert.equal(await gridShown(page), false, 'the product grid waits behind the tiles');
      const t = await tiles(page);
      assert.deepEqual(t.map((x) => x.name), ['Bakery', 'Drinks', 'Stationery', 'All items']);
      assert.deepEqual(t.map((x) => x.n), [2, 3, 1, 6]);
      assert.ok(t[1].img && t[0].img, 'the two categories with a picture show it');
      assert.ok(!t[2].img && t[2].ph === 'ST', 'a category without a picture gets a letter tile: ' + t[2].ph);
      assert.ok(t.every((x) => x.tag === 'BUTTON'), 'tiles are buttons (keyboard)');
      assert.ok(await page.evaluate(() => { const g = getComputedStyle(document.querySelector('.ctl-grid')).gridTemplateColumns.split(' ').length; return g === 2; }), 'two columns on a phone');
      assert.ok(await page.evaluate(() => Array.from(document.querySelectorAll('#ctl-host img')).every((i) => i.getAttribute('loading') === 'lazy')), 'lazy images');
      assert.ok(await noSideScroll(page), 'tiles fit a phone');
      // keyboard: Enter on a focused tile opens it
      await page.locator('#ctl-host .ctl-tile', { hasText: 'Stationery' }).focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
      assert.deepEqual(await cells(page), ['Pen']); await page.locator('.ctl-back').click(); await page.waitForTimeout(250);
      assert.equal((await tiles(page)).length, 4);

      // open Drinks: only Drinks
      await tap(page, 'Drinks');
      assert.deepEqual(sorted(await cells(page)), ['Juice', 'Soda', 'Water']);
      assert.equal(await gridShown(page), true);
      assert.match(await page.evaluate(() => document.querySelector('.ctl-head').textContent), /All categories.*Drinks/);
      assert.equal((await tiles(page)).length, 0, 'tiles give way to the products');
      assert.ok(await noSideScroll(page));
      // adding an item must not bounce back to the root
      await page.locator('#item-image-grid .item-grid-cell', { hasText: 'Soda' }).click(); await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => Object.keys(currentCart).length >= 1), 'the item is in the cart');
      assert.deepEqual(sorted(await cells(page)), ['Juice', 'Soda', 'Water'], 'still inside Drinks after the cart changed');
      assert.equal((await page.evaluate(() => window.__catTiles.state())).cat, 'Drinks');
      // search bypasses the tiles (from inside a category too), clearing returns where he was
      await page.fill('#sales-search', 'bread'); await page.waitForTimeout(500);
      assert.equal(await hostShown(page), false); assert.deepEqual(await cells(page), ['Bread']);
      await page.fill('#sales-search', ''); await page.waitForTimeout(400);
      assert.deepEqual(sorted(await cells(page)), ['Juice', 'Soda', 'Water']); assert.match(await page.evaluate(() => document.querySelector('.ctl-head').textContent), /Drinks/);
      // Back -> the root; search from the root
      await page.locator('.ctl-back').click(); await page.waitForTimeout(300);
      assert.equal((await tiles(page)).length, 4); assert.equal(await gridShown(page), false);
      await page.fill('#sales-search', 'pen'); await page.waitForTimeout(500);
      assert.equal(await hostShown(page), false); assert.deepEqual(await cells(page), ['Pen']); assert.equal(await gridShown(page), true);
      await page.fill('#sales-search', ''); await page.waitForTimeout(400);
      assert.equal(await hostShown(page), true); assert.equal(await gridShown(page), false);
      // "All items" is the way to every item
      await tap(page, 'All items'); assert.equal((await cells(page)).length, 6);
      await page.locator('.ctl-back').click(); await page.waitForTimeout(250);
      // dark theme: the tiles follow the page colours
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.waitForTimeout(600);
      assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.ctl-tile')).backgroundColor !== 'rgb(255, 255, 255)'), 'dark tile');
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
      assert.deepEqual(errors, []);

      // it persists: a reload still opens on the tiles, with the pictures
      await page.reload(); await page.waitForTimeout(1300);
      await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; }); await page.waitForTimeout(500);
      assert.equal(await hostShown(page), true); assert.equal((await tiles(page)).filter((x) => x.img).length, 2);
      // ...and switching OFF gives back exactly today's counter
      await toPanel(page); await setSwitch(page, false); await toSales(page);
      assert.equal(await hostShown(page), false); assert.equal(await gridShown(page), true);
      assert.equal(await page.evaluate(() => document.body.classList.contains('ctl-on') || document.body.classList.contains('ctl-hide')), false);
      assert.equal(await page.evaluate(() => document.getElementById('item-image-grid').innerHTML), baseline, 'the grid is exactly what it was before');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
}

test('shop: settings sync - the payload carries the pictures and the switch, a fresh phone sends none, pictures are not resent on every sale, a pull applies them', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const fresh = await open(browser, base, 'shop');
    const f = await fresh.page.evaluate(() => { const p = collectSyncPayload(); return { has: 'categoryImages' in p || 'catTilesOn' in p }; });
    assert.equal(f.has, false, 'a device with no copy of its own sends nothing (it must never blank the shop\'s pictures)');
    await fresh.ctx.close();

    const { ctx, page, errors } = await open(browser, base, 'shop', { storage: { pos_category_images: JSON.stringify({ Drinks: RED_URL }), pos_cat_tiles: 'true' } });
    const r = await page.evaluate(() => {
      const p = collectSyncPayload(), e = extraSettingsCollect();
      const s1 = slimPayloadForPush(collectSyncPayload()); const first = JSON.stringify(s1.body.categoryImages || null);
      s1.commit();
      const s2 = slimPayloadForPush(collectSyncPayload());
      const after = { has: 'categoryImages' in s2.body, switchStill: s2.body.catTilesOn };
      window.__catTiles.setImage('Bakery', 'data:image/png;base64,' + '#'.repeat(0) + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      const s3 = slimPayloadForPush(collectSyncPayload());
      const failedFirst = (() => { const s = slimPayloadForPush(collectSyncPayload()); return 'categoryImages' in s.body; })();      // not committed: still sent
      return { keys: Object.keys(p.categoryImages), on: p.catTilesOn, notInReceiptSnapshot: !('categoryImages' in e) && !('catTilesOn' in e), first, after, changed: Object.keys(s3.body.categoryImages || {}), failedFirst };
    });
    assert.deepEqual(r.keys, ['Drinks']); assert.equal(r.on, true); assert.ok(r.notInReceiptSnapshot, 'the receipt-settings snapshot stays small');
    assert.ok(r.first.includes('Drinks')); assert.equal(r.after.has, false, 'the same set is not sent again on the next sale'); assert.equal(r.after.switchStill, true);
    assert.deepEqual(r.changed.sort(), ['Bakery', 'Drinks'], 'a change is sent again'); assert.equal(r.failedFirst, true, 'a push the server never confirmed is sent again');
    // a pull applies the pictures and the switch, through the app's own applyRemotePayload
    const a = await page.evaluate(() => {
      applyRemotePayload({ categoryImages: { Stationery: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', Evil: 'javascript:alert(1)' }, catTilesOn: false, updatedAt: 1 });
      return { keys: Object.keys(window.__catTiles.images()), on: window.__catTiles.enabled(), stored: localStorage.getItem('pos_cat_tiles') };
    });
    assert.deepEqual(a.keys, ['Stationery'], 'applied; anything that is not a picture is dropped'); assert.equal(a.on, false); assert.equal(a.stored, 'false');
    const again = await page.evaluate(() => 'categoryImages' in slimPayloadForPush(collectSyncPayload()).body);
    assert.equal(again, false, 'what the server just sent is not sent back');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('shop: at most 60 pictures; a replacement still works at the cap; a phone at 320 px does not scroll sideways', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const seeded = {}; for (let i = 0; i < 58; i++) seeded['Old category ' + i] = RED_URL;
    const { ctx, page, errors } = await open(browser, base, 'shop', { width: 320, storage: { pos_category_images: JSON.stringify(seeded), pos_cat_tiles: 'true' } });
    await toPanel(page);
    assert.match(await page.locator('#ctl-panel').innerText(), /58 of 60 pictures used/);
    assert.ok(await noSideScroll(page), 'the panel with many rows fits 320 px');
    await pickImage(page, 'Drinks', Buffer.from(RED, 'base64'));       // 59
    await pickImage(page, 'Bakery', Buffer.from(RED, 'base64'));       // 60
    assert.equal(Object.keys(await page.evaluate(() => window.__catTiles.images())).length, 60);
    await pickImage(page, 'Stationery', Buffer.from(RED, 'base64'));   // refused
    assert.equal(Object.keys(await page.evaluate(() => window.__catTiles.images())).length, 60);
    assert.equal(await page.evaluate(() => !!window.__catTiles.images().Stationery), false);
    assert.match(await page.locator('#ctl-msg').innerText(), /up to 60/);
    assert.ok(await page.evaluate(() => document.getElementById('ctl-msg').classList.contains('bad')));
    await page.evaluate(() => document.querySelector('#ctl-panel [data-ctl-act="rm"][data-k="Old%20category%200"]').click());
    assert.equal(Object.keys(await page.evaluate(() => window.__catTiles.images())).length, 59, 'Remove frees a slot');
    await pickImage(page, 'Stationery', Buffer.from(RED, 'base64'));   // 60 again
    assert.equal(await page.evaluate(() => !!window.__catTiles.images().Stationery), true);
    // the 320 px counter: tiles, then a category
    await toSales(page);
    assert.equal(await hostShown(page), true); assert.ok(await noSideScroll(page), 'tiles fit 320 px');
    await tap(page, 'Drinks'); assert.ok(await noSideScroll(page), 'a category fits 320 px');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('shop: a wide screen (sidebar beside it) shows 4+ columns', { skip, timeout: 60000 }, async () => {
  await withApp(async (browser, base) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 800 } });
    await ctx.route('**/api/**', (r) => r.abort());
    await ctx.addInitScript(([h, inv]) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_inventory', JSON.stringify(inv)); localStorage.setItem('pos_cat_tiles', 'true'); }, [H, SHOP]);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(base + '/index.html'); await page.waitForTimeout(1300);
    await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; }); await page.waitForTimeout(400);
    assert.equal(await hostShown(page), true);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.ctl-grid')).gridTemplateColumns.split(' ').length);
    assert.ok(cols >= 4 && cols <= 6, 'columns on a desktop: ' + cols);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
test('hotel: tiles, sub-category tiles first, chips hidden then restored, search bypass, cart keeps the category', { skip, timeout: 180000 }, async () => {
  await withApp(async (browser, base) => {
    const seedSubs = async (page) => page.evaluate(() => {
      const id = hospScreenChips('sales').find((c) => /Milkshakes/.test(c.label)).id;
      hospConfig.subcats = { [id]: [{ id: 's200', name: '200' }, { id: 's100', name: '100' }] };
      const sub = (c, s) => { inventory.find((p) => p.code === c).subCat = s; };
      sub('M1', 's200'); sub('M3', 's200'); sub('M2', 's100');
      saveHospConfig(); hospCatTouch(); renderItemImageGrid('');
    });
    // today's counter (chips + grid) for comparison
    const b0 = await open(browser, base, 'hotel', { inv: HOTEL }); await seedSubs(b0.page); await toSales(b0.page);
    const baseline = await b0.page.evaluate(() => ({ grid: document.getElementById('item-image-grid').innerHTML, chips: getComputedStyle(document.getElementById('sc-cat-bar')).display, sel: localStorage.getItem('pos_hosp_catsel_sales') }));
    assert.notEqual(baseline.chips, 'none', 'chips visible today'); assert.equal((await cells(b0.page)).length, 6);
    await b0.ctx.close();

    const { ctx, page, errors } = await open(browser, base, 'hotel', { inv: HOTEL, storage: { pos_cat_plain: 'false' } });
    await seedSubs(page); await toSales(page);
    await toPanel(page);
    // the panel lists the category AND its sub-categories
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#ctl-panel .ctl-row .ctl-rname b')).map((b) => b.textContent)), ['Drinks', 'Mains', 'Milkshakes', '200', '100']);
    await pickImage(page, 'Milkshakes', await bigPng(page));
    await pickImage(page, 'Milkshakes › 100', Buffer.from(RED, 'base64'));
    assert.deepEqual(Object.keys(await page.evaluate(() => window.__catTiles.images())).sort(), ['Milkshakes', 'Milkshakes › 100']);
    await setSwitch(page, true);
    await toSales(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sc-cat-bar')).display), 'none', 'the old chip row is hidden while tiles are on');
    assert.ok(await page.evaluate(() => !!document.getElementById('sc-cat-bar')), 'but it stays in the page');
    let t = await tiles(page);
    assert.deepEqual(t.map((x) => x.name), ['Drinks', 'Mains', 'Milkshakes', 'All items']); assert.deepEqual(t.map((x) => x.n), [1, 2, 3, 6]);
    assert.ok(t[2].img, 'a picture on Milkshakes'); assert.ok(!t[1].img && t[1].ph === 'MA', 'a letter tile on Mains: ' + t[1].ph);
    assert.equal(await gridShown(page), false); assert.ok(await noSideScroll(page));
    // a category with sub-categories shows them first
    await tap(page, 'Milkshakes');
    t = await tiles(page);
    assert.deepEqual(t.map((x) => [x.kind, x.name, x.n]), [['sub', 'All Milkshakes', 3], ['sub', '200', 2], ['sub', '100', 1]]);
    assert.ok(t[0].img && t[2].img && !t[1].img, 'the parent picture on "All", the sub picture on 100, a letter tile on 200');
    assert.equal(await gridShown(page), false);
    assert.match(await page.evaluate(() => document.querySelector('.ctl-head').textContent), /All categories.*Milkshakes/);
    // a sub-category -> only its items; the app's own chip state is the one that filtered
    await tap(page, '100');
    assert.deepEqual(await cells(page), ['Vanilla shake']); assert.equal(await gridShown(page), true);
    assert.equal(await page.evaluate(() => hospCatSelGet('sales') === hospScreenChips('sales').find((c) => /Milkshakes/.test(c.label)).id), true, 'same state the chips set');
    await page.locator('#item-image-grid .item-grid-cell', { hasText: 'Vanilla' }).click(); await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => Object.keys(currentCart).length >= 1)); assert.deepEqual(await cells(page), ['Vanilla shake'], 'the cart change keeps him inside the sub-category');
    // search finds items everywhere, clearing returns
    await page.fill('#sales-search', 'burger'); await page.waitForTimeout(500);
    assert.equal(await hostShown(page), false); assert.deepEqual(await cells(page), ['Burger']);
    await page.fill('#sales-search', ''); await page.waitForTimeout(400);
    assert.deepEqual(await cells(page), ['Vanilla shake']);
    // up one level (the category's sub-category tiles), then "All Milkshakes", then the root
    await page.locator('.ctl-crumb-btn').click(); await page.waitForTimeout(300);
    assert.equal((await tiles(page)).length, 3);
    await tap(page, 'All Milkshakes'); assert.deepEqual(sorted(await cells(page)), ['Choc shake', 'Mango shake', 'Vanilla shake']);
    await page.locator('.ctl-back').click(); await page.waitForTimeout(300);
    assert.equal((await tiles(page)).length, 4);
    // a category without sub-categories goes straight to the products
    await tap(page, 'Mains'); assert.deepEqual(sorted(await cells(page)), ['Burger', 'Pizza']);
    await page.locator('.ctl-back').click(); await page.waitForTimeout(300);
    // persists, and OFF restores today's chips + grid + the chip selection
    await page.reload(); await page.waitForTimeout(1300);
    await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; }); await page.waitForTimeout(500);
    assert.equal(await hostShown(page), true); assert.equal((await tiles(page)).filter((x) => x.img).length, 1);
    await toPanel(page); await setSwitch(page, false); await toSales(page);
    assert.equal(await hostShown(page), false);
    const after = await page.evaluate(() => ({ grid: document.getElementById('item-image-grid').innerHTML, chips: getComputedStyle(document.getElementById('sc-cat-bar')).display, sel: localStorage.getItem('pos_hosp_catsel_sales') }));
    assert.equal(after.chips, baseline.chips, 'chips are back'); assert.equal(after.sel, baseline.sel, 'the chip selection is what it was'); assert.equal(after.grid, baseline.grid, 'the grid is exactly what it was');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

test('hotel: the settings payload carries the pictures; sub-category pictures are keyed "Category > Sub"', { skip, timeout: 90000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, 'hotel', { inv: HOTEL, storage: { pos_category_images: JSON.stringify({ Mains: RED_URL, 'Milkshakes › 100': RED_URL }), pos_cat_tiles: 'true', pos_cat_plain: 'false' } });
    const r = await page.evaluate(() => { const p = collectSyncPayload(); return { keys: Object.keys(p.categoryImages).sort(), on: p.catTilesOn, wrapped: !!window.slimPayloadForPush.__ctl && !!window.applyRemotePayload.__ctl && !!window.collectSyncPayload.__ctl }; });
    assert.deepEqual(r.keys, ['Mains', 'Milkshakes › 100']); assert.equal(r.on, true); assert.equal(r.wrapped, true);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

test('water: no product grid, so the block does nothing and nothing breaks', { skip, timeout: 60000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, 'water', { storage: { pos_cat_tiles: 'true' } });
    const r = await page.evaluate(() => ({ host: !!document.getElementById('ctl-host'), panel: !!document.getElementById('ctl-panel'), on: document.body.classList.contains('ctl-on') }));
    assert.deepEqual(r, { host: false, panel: false, on: false });
    assert.deepEqual(errors, []); await ctx.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------------
// zip 209: Hotel - a category WITHOUT a picture is a plain button, with a picture it is a picture tile; sub-categories are plain buttons;
// Category > Sub-category > Items (with their own pictures) > cart; the switch gives the letter tiles back; the other apps are unchanged.
test('hotel: plain buttons for categories / sub-categories without a picture, picture tiles only where a picture was added', { skip, timeout: 180000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, 'hotel', { inv: HOTEL, storage: { pos_category_images: JSON.stringify({ Milkshakes: RED_URL }), pos_cat_tiles: 'true' } });
    await page.evaluate(() => {
      const id = hospScreenChips('sales').find((c) => /Milkshakes/.test(c.label)).id;
      hospConfig.subcats = { [id]: [{ id: 's200', name: '200' }, { id: 's100', name: '100' }] };
      const sub = (c, s) => { inventory.find((p) => p.code === c).subCat = s; };
      sub('M1', 's200'); sub('M3', 's200'); sub('M2', 's100');
      saveHospConfig(); hospCatTouch(); renderItemImageGrid('');
    });
    await toSales(page);
    const snap = () => page.evaluate(() => ({
      pics: Array.from(document.querySelectorAll('#ctl-host .ctl-tile .ctl-name')).map((e) => e.textContent),
      plain: Array.from(document.querySelectorAll('#ctl-host .ctl-plain .ctl-pname')).map((e) => e.textContent),
      letters: document.querySelectorAll('#ctl-host .ctl-ph').length,
    }));
    let r = await snap();
    assert.deepEqual(r.pics, ['Milkshakes'], 'only the category with a picture is a picture tile');
    assert.deepEqual(r.plain.sort(), ['All items', 'Drinks', 'Mains'], 'the rest are plain buttons, as the chips were');
    assert.equal(r.letters, 0, 'no coloured letter tiles');
    // category -> its sub-categories (no pictures): plain buttons; the parent picture sits on "All Milkshakes"
    await page.locator('.ctl-tile', { hasText: 'Milkshakes' }).click(); await page.waitForTimeout(350);
    r = await snap();
    assert.deepEqual(r.pics, ['All Milkshakes']); assert.deepEqual(r.plain.sort(), ['100', '200']);
    // sub-category -> its items, each with the item's own picture cell
    await page.locator('.ctl-plain', { hasText: '200' }).click(); await page.waitForTimeout(350);
    assert.deepEqual(sorted(await cells(page)), ['Choc shake', 'Mango shake']); assert.equal(await gridShown(page), true);
    // item -> cart (the sale), still inside the same sub-category
    await page.locator('#item-image-grid .item-grid-cell', { hasText: 'Choc' }).click(); await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => Object.keys(currentCart).length >= 1));
    assert.deepEqual(sorted(await cells(page)), ['Choc shake', 'Mango shake']);
    // back to the root, a category with no sub-categories goes straight to its items
    await page.locator('.ctl-back').click(); await page.waitForTimeout(300);
    await page.locator('.ctl-plain', { hasText: 'Mains' }).click(); await page.waitForTimeout(350);
    assert.deepEqual(sorted(await cells(page)), ['Burger', 'Pizza']);
    // the switch gives the letter tiles back
    await page.evaluate(() => window.__catTiles.setPlain(false)); await page.locator('.ctl-back').click(); await page.waitForTimeout(300);
    r = await snap();
    assert.equal(r.plain.length, 0); assert.ok(r.letters >= 3, 'letter tiles are back: ' + r.letters);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

test('shop: nothing changes by itself - the letter tiles stay until the owner ticks the option', { skip, timeout: 120000 }, async () => {
  await withApp(async (browser, base) => {
    const { ctx, page, errors } = await open(browser, base, 'shop', { storage: { pos_category_images: JSON.stringify({ Drinks: RED_URL }), pos_cat_tiles: 'true' } });
    await toSales(page);
    assert.equal(await page.evaluate(() => window.__catTiles.plainOn()), false);
    assert.ok(await page.evaluate(() => document.querySelectorAll('#ctl-host .ctl-ph').length) >= 2, 'letter tiles as before');
    await page.evaluate(() => window.__catTiles.setPlain(true)); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#ctl-host .ctl-ph').length), 0);
    assert.ok(await page.evaluate(() => document.querySelectorAll('#ctl-host .ctl-plain').length) >= 2);
    assert.deepEqual(errors, []); await ctx.close();
  });
});
