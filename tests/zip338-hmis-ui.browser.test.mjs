// zip 338: HMIS redesign - cashier payment summary, sectioned reception form, no horizontal overflow at 1366/1440/tablet/mobile.
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

async function open(browser, base, file, inv, vp = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport: vp });
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


const INV = [
  { code: 'PARA', type: 'item', name: 'Paracetamol', price: 100, qty: 50, unit: 'pcs', category: 'Meds' },
  { code: 'AMOX', type: 'item', name: 'Amoxicillin', price: 250, qty: 20, unit: 'pcs', category: 'Meds' },
];
const goto = (page, t) => page.evaluate((t) => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, t), t);

test('hospital cashier: live Total due / Paid / Balance / Change and the checkout button stays in view', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errs } = await open(browser, base, 'hospital/index.html', INV);
    await goto(page, 'sales-tab'); await page.waitForTimeout(800);
    const cell = (k) => page.locator(`#hmu-pay [data-k="${k}"]`).innerText();
    assert.match(await cell('due'), /0\.00/);
    await page.evaluate(() => { addToCart('PARA'); addToCart('PARA'); addToCart('AMOX'); });
    await page.waitForTimeout(900);
    assert.match(await cell('due'), /450\.00/);              // 2 x 100 + 250
    await page.click('#pay-cash-btn'); await page.waitForTimeout(300);
    await page.fill('#cash-tendered-input', '400');
    assert.match(await cell('paid'), /400\.00/); assert.match(await cell('bal'), /50\.00/); assert.match(await cell('chg'), /0\.00/);
    await page.fill('#cash-tendered-input', '500');
    assert.match(await cell('bal'), /0\.00/); assert.match(await cell('chg'), /50\.00/);
    // the checkout button is on screen without scrolling at 1366x768, and the page does not scroll sideways
    const box = await page.locator('#main-checkout-btn').boundingBox();
    assert.ok(box && box.y + box.height <= 768 && box.height >= 34, 'checkout visible and big: ' + JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    // split: paid is the sum of the two parts (the two fields balance each other against the total)
    await page.evaluate(() => setPaymentMethod('split')); await page.fill('#split-cash-input', '200'); await page.waitForTimeout(700);
    const sum = await page.evaluate(() => (parseFloat(document.getElementById('split-cash-input').value) || 0) + (parseFloat(document.getElementById('split-mpesa-input').value) || 0));
    assert.match(await cell('paid'), new RegExp(sum.toFixed(2).replace('.', '\\.')));
    // the sale is unchanged by the design layer: still the same handler, nothing sold by merely looking
    assert.equal(await page.evaluate(() => (JSON.parse(localStorage.getItem('pos_sales') || '[]')).length), 0);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('hospital reception: labelled sections, two columns on desktop, one on a phone, ids intact', { skip, timeout: 120000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const [w, h, cols] of [[1366, 768, 2], [1440, 900, 2], [390, 844, 1]]) {
      const { ctx, page, errs } = await open(browser, base, 'hospital/index.html', INV, { width: w, height: h });
      await goto(page, 'reception-tab'); await page.waitForTimeout(900);
      const heads = await page.locator('#reception-registration-panel .hmu-sec').allInnerTexts();
      assert.deepEqual(heads.map((t) => t.trim().toLowerCase()), ['patient identity', 'contact', 'next of kin', 'medical']);
      for (const id of ['patient-name-input', 'patient-dob-input', 'patient-sex-input', 'patient-phone-input', 'patient-nok-name-input', 'patient-save-btn']) assert.equal(await page.locator('#' + id).count(), 1, id);
      const n = await page.evaluate(() => getComputedStyle(document.getElementById('reception-registration-panel')).gridTemplateColumns.split(' ').length);
      assert.equal(n, cols, w + 'px columns');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scroll at ' + w);
      const hh = await page.evaluate(() => document.getElementById('patient-name-input').getBoundingClientRect().height);
      assert.ok(hh >= 39, 'input height ' + hh);
      assert.deepEqual(errs, []);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});

test('hospital: key screens never scroll sideways at 1366, 1440, tablet and phone', { skip, timeout: 180000 }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const [w, h] of [[1366, 768], [1440, 900], [820, 1180], [390, 844]]) {
      const { ctx, page, errs } = await open(browser, base, 'hospital/index.html', INV, { width: w, height: h });
      for (const t of ['dashboard-tab', 'sales-tab', 'reception-tab', 'inventory-list-tab', 'bills-tab', 'pharmacy-tab']) {
        await goto(page, t); await page.waitForTimeout(500);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${t} overflows at ${w}`);
      }
      assert.deepEqual(errs, []);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});
