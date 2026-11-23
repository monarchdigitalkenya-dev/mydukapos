// zip 340: Inventory: match extra "Item (Size)" items to the real size - same variant, no new code.
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

async function open(browser, base, file, seed, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([h, invJson]) => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
    localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }])); localStorage.setItem('pos_round_up', '0');
    localStorage.setItem('pos_pw_hash', h); localStorage.setItem('pos_biz_name', 'T'); const s = JSON.parse(invJson); for (const k of Object.keys(s)) localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k]));
  }, [H, JSON.stringify(seed)]);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto(base + '/' + file); await page.waitForTimeout(1500);
  await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } const a = document.getElementById('app-container'); if (a) a.style.display = ''; window.showToast = () => {}; });
  return { ctx, page, errs };
}


const SEED = { pos_inventory: [
  { code: 'BEIGENORMALSHIRT', type: 'item', name: 'Beige Normal shirt', price: 300, qty: 0, unit: 'pcs', hasVariants: true, variants: [
    { id: 'v-xl', name: 'XL', code: 'BEIGENORMALSHIRT-XL', price: 400, qty: 0 }, { id: 'v-l', name: 'L', code: 'BEIGENORMALSHIRT-L', price: 350, qty: 2 } ] },
  { code: 'BEIGENORMALSHIRT::1792225035349-2zmp0mu5ui', type: 'item', name: 'Beige Normal shirt (XL)', price: 400, qty: 7, unit: 'pcs' },
  { code: 'ZZ-OTHER-9', type: 'item', name: 'Beige Normal shirt (L)', price: 350, qty: 3, unit: 'pcs' },
  { code: 'UNRELATED', type: 'item', name: 'Soap', price: 50, qty: 4, unit: 'pcs' },
] };

test('extra "Item (Size)" items are matched into the real size, stock added once, no new item', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errs } = await open(browser, base, 'index.html', SEED);
    const found = await page.evaluate(() => window.SE.strayVariants(inventory).map(x => x.stray.name + '>' + x.variant.name).sort());
    assert.deepEqual(found, ['Beige Normal shirt (L)>L', 'Beige Normal shirt (XL)>XL']);
    await page.evaluate(() => { window.confirm = () => true; window.showToast = () => {}; });
    await page.evaluate(() => { guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'inventory-list-tab'); });
    await page.waitForTimeout(1500);
    assert.ok(await page.$('#spx-inv-bar [data-x="strays"]'), 'the Match button is visible in Inventory');
    await page.click('#spx-inv-bar [data-x="strays"]'); await page.waitForTimeout(200);
    await page.click('[data-spx="strayall"]'); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const p = inventory.find(x => x.code === 'BEIGENORMALSHIRT'); return { xl: p.variants.find(v => v.id === 'v-xl').qty, l: p.variants.find(v => v.id === 'v-l').qty, total: p.qty, n: inventory.length, active: inventory.filter(x => !x.archived).length, left: window.SE.strayVariants(inventory.filter(x => !x.archived)).length }; });
    assert.equal(r.xl, 7); assert.equal(r.l, 5); assert.equal(r.total, 12); assert.equal(r.n, 4, 'no new item was created'); assert.equal(r.active, 2); assert.equal(r.left, 0);
    assert.deepEqual(errs.filter(e => !/WebSocket|Failed to load/.test(e)), []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
