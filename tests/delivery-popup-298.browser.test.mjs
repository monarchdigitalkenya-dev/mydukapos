import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 298: the Delivery popup must be CLICKABLE in a real browser. jsdom has no layout, so the zip 293 test passed while every tap on a field
// landed on the dark backdrop (the form sat inside the cart panel's stacking context, under the backdrop) and closed the popup.
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

for (const app of ['index.html', 'hospital/index.html']) {
  for (const [label, vp, mobile] of [['desktop', { width: 1366, height: 768 }, false], ['phone', { width: 390, height: 780 }, true]]) {
    test(`${app} (${label}): the Delivery form fields can be clicked and typed into, and Done keeps the delivery`, { skip }, async () => {
      const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
        await ctx.route('**/api/**', (r) => r.abort());
        await ctx.addInitScript(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_inventory', JSON.stringify([{ code: 'A1', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 60, qty: 50, unit: 'pcs', vatCategory: 'A', updatedAt: 1 }])); });
        const page = await ctx.newPage();
        await page.goto(base + '/' + app); await page.waitForTimeout(1500);
        await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; } const s = document.getElementById('boot-splash'); if (s) s.remove(); window.showToast = () => {}; });
        await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'sales-tab'));
        await page.evaluate(() => addToCart('A1')); await page.waitForTimeout(300);
        if (await page.locator('.ptl-bar.on').count()) { await page.locator('.ptl-bar.on').first().tap(); await page.waitForTimeout(300); }
        const btn = page.locator('#order-delivery-btn');
        if (mobile) await btn.tap(); else await btn.click();
        await page.waitForTimeout(400);
        // what is on top at the middle of the first field? It must be the field itself, never the backdrop.
        const top = await page.evaluate(() => { const i = document.getElementById('delivery-client-name-input'); const r = i.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t && t.id === 'dlv-back' ? 'backdrop' : 'form'; });   // (the desktop UI is zoomed 0.8, which skews elementFromPoint a little - so the check is "not the backdrop"; the clicks below are the real proof)
        assert.equal(top, 'form', 'the backdrop must not cover the form');
        await page.click('#delivery-client-name-input'); await page.keyboard.type('John');
        await page.click('#delivery-fee-input'); await page.keyboard.type('150');
        assert.equal(await page.evaluate(() => !document.getElementById('delivery-details-group').classList.contains('dlv-closed')), true, 'still open after typing');
        await page.click('.dlv-foot button:has-text("Done")'); await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => orderType), 'delivery');
        assert.match(await page.evaluate(() => document.getElementById('dlv-sum-text').textContent), /John.*150/);
        await ctx.close();
      } finally { await browser.close(); srv.close(); }
    });
  }
}
