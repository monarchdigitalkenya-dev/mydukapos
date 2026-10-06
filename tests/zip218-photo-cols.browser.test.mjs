import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 218: "Photos per row" on the phone (2 or 3) for the item photo grid AND the category / sub-category picture tiles; saved for every device (it travels with the shop settings).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) { try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ } }
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() { const srv = http.createServer((req, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv))); }
const H = crypto.createHash('sha256').update('pw').digest('hex');
const RED_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const it = (code, name, category, extra = {}) => ({ code, type: 'item', name, category, price: 50, qty: 10, unit: 'pcs', ...extra });
const INV = [it('A1', 'Soda', 'Drinks'), it('A2', 'Juice', 'Drinks'), it('A3', 'Water', 'Drinks'), it('B1', 'Bread', 'Bakery'), it('B2', 'Scone', 'Bakery'), it('S1', 'Pen', 'Stationery')];
const cols = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).gridTemplateColumns.split(' ').length : 0; }, sel);

async function open(browser, base, file, storage) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, inv, extra]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'Test Shop'); localStorage.setItem('pos_inventory', JSON.stringify(inv));
    for (const k of ['pos_notif_prompt_last', 'pos_cd_detect_last']) localStorage.setItem(k, String(Date.now()));
    Object.keys(extra || {}).forEach((k) => localStorage.setItem(k, extra[k]));
  }, [H, INV, storage || {}]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1300);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
  await page.waitForFunction(() => window.__phoneTill && !!document.getElementById('ptl-bar'), null, { timeout: 8000 });
  await page.waitForTimeout(500); return { ctx, page, errors };
}
const tab = async (page, id) => { await page.evaluate((t) => { document.querySelector('.tab-link[data-tab="' + t + '"]').click(); }, id); await page.waitForTimeout(400); };
async function pick(page, val) {
  await tab(page, 'settings-tab');
  await page.evaluate(() => { const b = document.querySelector('[data-section="settings-section-view"]'); if (b) b.click(); });
  await page.waitForSelector('input[name="ptl-cols"]', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('input[name="ptl-cols"]').closest('label').scrollIntoView({ block: 'center' }));
  await page.click('label:has(input[name="ptl-cols"][value="' + val + '"])'); await page.waitForTimeout(300);
}

for (const file of ['index.html', 'hotel/index.html']) {
  test(`${file}: Photos per row 2 -> 3 on the phone: item photos and category tiles, syncs to other devices, survives a reload`, { skip, timeout: 120000 }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    try {
      const { ctx, page, errors } = await open(browser, base, file, { pos_category_images: JSON.stringify({ Drinks: RED_URL }), pos_cat_tiles: 'true', pos_cat_plain: 'false' });
      await tab(page, 'sales-tab');
      assert.equal(await cols(page, '#ctl-host .ctl-grid'), 2, 'starts at 2 per row');
      await pick(page, '3'); await tab(page, 'sales-tab');
      assert.equal(await cols(page, '#ctl-host .ctl-grid'), 3, 'category picture tiles: 3 per row');
      await page.evaluate(() => { window.__catTiles.setEnabled(false); }); await page.waitForTimeout(300);
      assert.equal(await cols(page, '#item-image-grid'), 3, 'item photos: 3 per row');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
      const out = await page.evaluate(() => (window.extraSettingsCollect() || {}).phoneTill);
      assert.equal(out.cols, 3, 'travels with the shop settings');
      assert.equal(await page.evaluate(() => localStorage.getItem('pos_ptl_cols')), '3');
      // another device receives it
      const b = await open(browser, base, file, {}); await tab(b.page, 'sales-tab');
      assert.equal(await cols(b.page, '#item-image-grid'), 2);
      await b.page.evaluate((o) => { window.extraSettingsApply({ phoneTill: { cols: o } }); }, 3); await b.page.waitForTimeout(500);
      assert.equal(await cols(b.page, '#item-image-grid'), 3, 'the other device switched too');
      await b.page.evaluate(() => window.extraSettingsApply({ phoneTill: { cols: 2 } })); await b.page.waitForTimeout(400);
      assert.equal(await cols(b.page, '#item-image-grid'), 2, 'and back');
      // back to 2 on the first
      await pick(page, '2'); await tab(page, 'sales-tab'); assert.equal(await cols(page, '#item-image-grid'), 2);
      assert.deepEqual(errors, []); assert.deepEqual(b.errors, []); await ctx.close(); await b.ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}
