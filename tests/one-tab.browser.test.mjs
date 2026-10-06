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

// Zip 125: "some of today's sales are missing" on ONE device — the app open in two tabs. Each tab saved its whole (older) sales list
// over the other's; an unsent sale was lost. Now only one tab works at a time.
test('two tabs on one device: the older tab cannot save over a sale; "Use it here" switches; every sale is kept', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/api/**', (r) => r.abort());                                 // offline: nothing reaches the server to rescue it
    await ctx.addInitScript(([h]) => { localStorage.setItem('pos_cash_reg_on', '0'); if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1'); localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T');
      localStorage.setItem('pos_inventory', JSON.stringify([{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }])); }, [H]);
    const open = async (p) => { p = p || await ctx.newPage(); await p.goto(base + '/index.html'); await p.waitForTimeout(1200); await p.evaluate(() => { const l = document.getElementById('login-screen'); if (l) l.style.display = 'none'; window.showToast = () => {}; window.print = () => {}; }); return p; };
    const sell = (p) => p.evaluate(async () => { if (window.__tabInactive) return 'blocked'; addToCart('A'); currentPaymentMethod = 'cash'; document.getElementById('cash-tendered-input').value = '1000'; await checkoutCart(); return 'sold'; });
    const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('pos_sales_log') || '[]').length);
    const tabB = await open();
    const tabA = await open();
    assert.ok(await tabB.locator('#one-tab-screen').isVisible(), 'the older tab shows "open in another tab"');
    assert.equal(await sell(tabA), 'sold');
    assert.equal(await sell(tabB), 'blocked');
    await tabB.evaluate(() => { localStorage.setItem('pos_sales_log', '[]'); });        // anything it still tries to save is refused
    assert.equal(await saved(tabA), 1);
    await tabB.locator('#one-tab-use-here').click(); await tabB.waitForLoadState('load'); await open(tabB);
    assert.ok(await tabA.locator('#one-tab-screen').isVisible(), 'now the other one stops');
    assert.equal(await tabB.evaluate(() => salesLog.length), 1, 'it has the sale made in the other tab');
    assert.equal(await sell(tabB), 'sold');
    const again = await open(await ctx.newPage());
    assert.equal(await again.evaluate(() => salesLog.length), 2, 'both sales kept');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('the customer display is not a second till: it is never stopped and never stops the till', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.route('**/api/**', (r) => r.abort());
    const till = await ctx.newPage(); await till.goto(base + '/index.html'); await till.waitForTimeout(800);
    const disp = await ctx.newPage(); await disp.goto(base + '/index.html?display=customer'); await disp.waitForTimeout(800);
    assert.equal(await till.evaluate(() => !!window.__tabInactive), false);
    assert.equal(await disp.evaluate(() => !!window.__tabInactive), false);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
