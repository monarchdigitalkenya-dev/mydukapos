import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 122: every button works on the FIRST tap, in a real (headless Chromium) phone browser. Skipped where Playwright is not
// installed (it is not a dependency of the app).
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
const H = crypto.createHash('sha256').update('pw').digest('hex');
async function open(browser, base, width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/api/**', (r) => r.abort());                                  // offline
  await ctx.addInitScript(([h]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T');
    localStorage.setItem('pos_inventory', JSON.stringify([{ code: 'A1', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs', vatCategory: 'A', updatedAt: 1 }]));
  }, [H]);
  const page = await ctx.newPage();
  await page.goto(base + '/index.html'); await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('login-screen').style.display = 'none'; });
  return { ctx, page };
}
const tapBox = async (page, loc) => { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); };

test('first tap counts even when the screen redraws under the finger — and never counts twice', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const redraw of ['none', 'pointerdown', 'mousedown', 'price-box']) {
      const { ctx, page } = await open(browser, base);
      await page.evaluate(() => addToCart('A1')); await page.waitForTimeout(200);
      if (redraw === 'price-box') {                                                   // typing a price, then tapping + (the box's blur redraws the cart)
        await page.evaluate(() => { window.selectCartPriceOption(Object.keys(currentCart)[0], 'custom'); });   // zip 180: the price menu's Custom entry opens the box
        await page.locator('input[id^="cart-custom-price-input-"]').first().tap(); await page.waitForTimeout(150);
      } else if (redraw !== 'none') {
        await page.evaluate((ev) => document.addEventListener(ev, () => renderCart(), true), redraw);   // what a sync arriving mid-tap does
      }
      const plus = page.locator('button').filter({ hasText: /^\+$/ }).filter({ visible: true }).first();
      await tapBox(page, plus);
      assert.equal(await page.evaluate(() => Object.values(currentCart)[0].qty), 2, `one tap = +1 (redraw: ${redraw})`);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});

test('small phone: "More" stays on screen after opening a long-named tab, and a height-only resize does not close it', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, base, 360);
    const more = page.locator('#tabs-more-btn');
    await tapBox(page, more);
    const t = page.locator('#tabs-more-menu .tab-link[data-tab="returns-tab"]'); await t.scrollIntoViewIfNeeded(); await tapBox(page, t);
    assert.ok(await page.evaluate(() => document.getElementById('returns-tab').classList.contains('active')));
    const onScreen = await page.evaluate(() => { const r = document.getElementById('tabs-more-btn').getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.right <= innerWidth && !!hit && !!hit.closest('#tabs-more-btn'); });
    assert.ok(onScreen, 'More is fully on screen and tappable');
    await tapBox(page, more);
    await page.setViewportSize({ width: 360, height: 700 });                        // the keyboard / address bar changing the height
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.getElementById('tabs-more-menu').classList.contains('show')), 'menu still open');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
