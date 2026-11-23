import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 332: People > Staff hub + tick-box bulk payroll on a phone, in every module that has payroll (server calls are stubbed).
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const serve = () => new Promise((r) => { const s = http.createServer((q, res) => { const p = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); }); s.listen(0, '127.0.0.1', () => r(s)); });

test('water: Raw Materials screen on a phone — add a variety, restock in bags, produce picking a variety', { skip, timeout: 90000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route('**/api/**', (r) => r.abort());
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
    await page.goto(base + '/water/index.html'); await page.waitForTimeout(1500);
    await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; });
    await page.evaluate(() => {
      activeSiteId = (sites.find((s) => s.type === 'production') || sites[0]).id;
      products.push({ code: 'P1', name: 'Water 500ml', siteId: activeSiteId, category: 'bottled', price: 30, qty: 0, vatCategory: 'A', productionRecipe: [] });
      document.querySelectorAll('.tab-content').forEach((x) => x.classList.remove('active')); document.getElementById('materials-tab').classList.add('active'); renderRawMaterialsTable();
    });
    assert.ok(await page.evaluate(() => !!document.getElementById('aqm-root') && document.getElementById('aqm-root').offsetParent !== null), 'materials list is visible');
    // add a bottle variety with opening stock
    await page.evaluate(() => AquaMat.openEdit());
    await page.fill('#aqe-name', 'Hex 500ml'); await page.selectOption('#aqe-cat', 'bottle'); await page.fill('#aqe-cost', '5'); await page.fill('#aqe-oq', '100');
    await page.click('#aqm-ov .aqm-go');
    assert.match(await page.textContent('#aqm-root'), /Hex 500ml/);
    // a second bottle variety, a cap, then the recipe
    await page.evaluate(() => { AquaMat.createMaterial({ name: 'Round 500ml', category: 'bottle', unitCost: 6, units: [{ name: 'bag', factor: 50 }], openingQty: 20 }); AquaMat.createMaterial({ name: 'Blue cap', category: 'cap', unitCost: 1, openingQty: 500 }); });
    const ids = await page.evaluate(() => rawMaterials.map((m) => [m.name, m.id]));
    const id = (n) => ids.find((x) => x[0] === n)[1];
    // restock 2 bags of Round
    await page.evaluate((i) => AquaMat.openRestock(i), id('Round 500ml'));
    await page.fill('#aqr-q', '2'); await page.selectOption('#aqr-u', 'bag'); await page.fill('#aqr-t', '600');
    assert.match(await page.textContent('#aqr-prev'), /2 bag = 100 pcs/);
    await page.click('#aqr-go');
    assert.equal(await page.evaluate((i) => rawMaterials.find((m) => m.id === i).stockQty, id('Round 500ml')), 120);
    // recipe: bottle (both varieties allowed), cap
    await page.evaluate(() => { const p = products.find((x) => x.code === 'P1'); AquaMat.associate(rawMaterials.find((m) => m.name === 'Hex 500ml').id, 'P1', true); AquaMat.associate(rawMaterials.find((m) => m.name === 'Round 500ml').id, 'P1', true); AquaMat.associate(rawMaterials.find((m) => m.name === 'Blue cap').id, 'P1', true); p.productionRecipe.forEach((r) => { r.qtyPerUnit = 1; }); });
    await page.evaluate(() => AquaMat.openProduce('P1', 10, ''));
    // two bottle varieties -> must choose; one cap -> automatic
    assert.equal(await page.isDisabled('#aqp-go'), true, 'cannot confirm until a bottle variety is chosen');
    assert.match(await page.textContent('#aqm-box'), /chosen automatically/);
    await page.selectOption('#aqm-box select', { label: (await page.$$eval('#aqm-box select option', (o) => o.map((x) => x.textContent).find((t) => /Round 500ml/.test(t)))) });
    assert.equal(await page.isDisabled('#aqp-go'), false);
    await page.click('#aqp-go');
    const r = await page.evaluate(() => ({ round: rawMaterials.find((m) => m.name === 'Round 500ml').stockQty, hex: rawMaterials.find((m) => m.name === 'Hex 500ml').stockQty, cap: rawMaterials.find((m) => m.name === 'Blue cap').stockQty, fg: products.find((p) => p.code === 'P1').qty }));
    assert.deepEqual(r, { round: 110, hex: 100, cap: 490, fg: 10 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
