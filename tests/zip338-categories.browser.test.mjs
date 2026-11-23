// zip 338: Settings -> Category Images & Order: add, rename (items follow) and delete (items become Uncategorised) a category.
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

async function open(browser, base, file, inv) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); localStorage.setItem('pos_inventory', invJson);
  }, [H, JSON.stringify(inv)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}

test('index.html: add, rename and delete a category in Settings', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const inv = [
      { code: 'A1', type: 'item', name: 'Cola', price: 50, qty: 5, unit: 'pcs', category: 'Drinks' },
      { code: 'A2', type: 'item', name: 'Juice', price: 60, qty: 5, unit: 'pcs', category: 'drinks' },
      { code: 'B1', type: 'item', name: 'Rice', price: 300, qty: 5, unit: 'pcs', category: 'Food' },
    ];
    const { ctx, page, errs } = await open(browser, base, 'index.html', inv);
    await page.evaluate(() => { window.confirm = () => true; document.getElementById('settings-tab-btn').click(); showSettingsSection('settings-section-catimages', document.querySelector('[data-section="settings-section-catimages"]')); __catTiles.renderPanel(); });
    const panel = '#ctl-panel';
    // add a category with no items
    await page.fill('#ctl-newcat', 'Snacks'); await page.click('[data-ctl-act="addcat"]');
    assert.match(await page.locator(panel).innerText(), /Snacks/);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pos_cat_extra'))), ['Snacks']);
    // a duplicate is refused
    await page.fill('#ctl-newcat', 'snacks'); await page.click('[data-ctl-act="addcat"]');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pos_cat_extra'))), ['Snacks']);
    // rename "Food" -> "Meals": the item follows
    await page.click(`[data-ctl-act="rncat"][data-k="${encodeURIComponent('Food')}"]`);
    await page.fill('#ctl-rn', 'Meals'); await page.click('[data-ctl-act="rnsave"]');
    assert.equal(await page.evaluate(() => inventory.find((p) => p.code === 'B1').category), 'Meals');
    // rename the empty "Snacks" -> "Treats"
    await page.click(`[data-ctl-act="rncat"][data-k="${encodeURIComponent('Snacks')}"]`);
    await page.fill('#ctl-rn', 'Treats'); await page.press('#ctl-rn', 'Enter');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pos_cat_extra'))), ['Treats']);
    // delete "Drinks" (Cola + Juice): items kept, now without a category
    await page.click(`[data-ctl-act="delcat"][data-k="${encodeURIComponent('Drinks')}"]`);
    const after = await page.evaluate(() => inventory.map((p) => [p.code, p.category || null, p.qty]));
    assert.deepEqual(after, [['A1', null, 5], ['A2', null, 5], ['B1', 'Meals', 5]]);
    // it syncs
    assert.deepEqual(await page.evaluate(() => __catTiles.collect().catExtra), ['Treats']);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('hotel/index.html: the same panel adds / renames / deletes through the hotel category records', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const inv = [{ code: 'D1', type: 'service', name: 'Tea', price: 50, qty: 0, unit: 'pcs', category: 'Hot drinks' }];
    const { ctx, page, errs } = await open(browser, base, 'hotel/index.html', inv);
    await page.evaluate(() => { window.confirm = () => true; document.getElementById('settings-tab-btn').click(); showSettingsSection('settings-section-catimages', document.querySelector('[data-section="settings-section-catimages"]')); __catTiles.renderPanel(); });
    await page.fill('#ctl-newcat', 'Desserts'); await page.click('[data-ctl-act="addcat"]');
    assert.match(await page.locator('#ctl-panel').innerText(), /Desserts/);
    const id = await page.evaluate(() => hospCategories.find((c) => c.name === 'Desserts').id);
    await page.click(`[data-ctl-act="rncat"][data-k="${encodeURIComponent(id)}"]`);
    await page.fill('#ctl-rn', 'Sweets'); await page.click('[data-ctl-act="rnsave"]');
    assert.equal(await page.evaluate((i) => hospCategories.find((c) => c.id === i).name, id), 'Sweets');
    await page.click(`[data-ctl-act="delcat"][data-k="${encodeURIComponent(id)}"]`);
    assert.equal(await page.evaluate((i) => !!hospCategories.find((c) => c.id === i && !c._deleted), id), false);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
