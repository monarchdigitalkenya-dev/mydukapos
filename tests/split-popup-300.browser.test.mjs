import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 300: Split payment opens as a popup. Before, Cash / M-Pesa / Card / Cash-tendered / M-Pesa phone boxes were squeezed into the cart card and sat on top of
// each other (and left the cart one and a half rows high). Checked in a REAL browser, because overlap is layout and jsdom has none.
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
const INV = [];
for (let i = 1; i <= 6; i++) INV.push({ code: 'P' + i, type: 'item', name: 'Product ' + i, price: 100 + i * 40, qty: 30, unit: 'pcs', vatCategory: 'A', category: 'Hardware', updatedAt: 1 });

async function open(browser, base, app, vp) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript((inv) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_inventory', JSON.stringify(inv)); }, INV);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/' + app); await page.waitForTimeout(1600);
  await page.evaluate(() => {
    for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; }
    const s = document.getElementById('boot-splash'); if (s) s.remove();
    window.showToast = () => {};
  });
  await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'sales-tab'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => { addToCart('P1'); addToCart('P2'); addToCart('P2'); });   // 140 + 2 x 180 = 500
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const box = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 0 && r.height > 0 }; }, id);
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2;

for (const [app, vp] of [['index.html', { width: 1920, height: 1080 }], ['index.html', { width: 1366, height: 768 }], ['hotel/index.html', { width: 1366, height: 768 }], ['pharmacy/index.html', { width: 1920, height: 1080 }]]) {
  test(`${app} @${vp.width}: Split opens as a popup, no boxes on top of each other, Done leaves a summary in the cart`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app, vp);
      await page.click('#pay-split-btn'); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), true, 'the popup opens when Split is chosen');
      const ids = ['split-cash-input', 'split-mpesa-input', 'split-cash-tendered-input', 'mpesa-phone-input', 'mpesa-send-btn', 'mpesa-payer-name-input', 'mpesa-code-input'];
      const bx = {}; for (const id of ids) { bx[id] = await box(page, id); assert.ok(bx[id] && bx[id].vis, id + ' is visible in the popup'); }
      const card = await box(page, 'split-card-input'); if (card && card.vis) bx['split-card-input'] = card;
      const keys = Object.keys(bx);
      for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) assert.ok(!overlap(bx[keys[i]], bx[keys[j]]), keys[i] + ' overlaps ' + keys[j]);
      const fit = await page.evaluate(() => { const c = document.querySelector('#sp-modal .sp-card').getBoundingClientRect(); return { t: c.top, b: c.bottom, vh: innerHeight, done: document.querySelector('#sp-modal .sp-done').getBoundingClientRect().bottom }; });
      assert.ok(fit.t >= 0 && fit.b <= fit.vh + 1 && fit.done <= fit.vh + 1, 'the popup fits the screen: ' + JSON.stringify(fit));
      // the real split maths still runs through the popup: typing cash rebalances M-Pesa, the balance line says so
      await page.fill('#split-cash-input', '200'); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.getElementById('split-mpesa-input').value), '300.00');
      assert.match(await page.evaluate(() => document.getElementById('split-balance-line').textContent), /matches total/);
      // Done closes it, Split stays chosen, the cart shows a one-line summary with Edit, and the cart no longer has the loose boxes
      await page.click('#sp-modal .sp-done'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), false);
      assert.equal(await page.evaluate(() => currentPaymentMethod), 'split');
      const s = await page.evaluate(() => { const e = document.getElementById('sp-summary'); const r = e.getBoundingClientRect(); return { hidden: e.hidden, w: r.width, h: r.height, t: e.textContent }; });
      assert.ok(!s.hidden && s.w > 100 && s.h > 20 && /Cash KES 200\.00/.test(s.t) && /M-Pesa KES 300\.00/.test(s.t) && /matches total/.test(s.t), 'summary: ' + JSON.stringify(s));
      assert.equal((await box(page, 'split-cash-input')).vis, false, 'the loose boxes are no longer in the cart');
      // the cart has room again
      const cartH = await page.evaluate(() => document.querySelector('#sales-tab .pos-cart-scroll').getBoundingClientRect().height);
      assert.ok(cartH >= 110, 'the cart keeps its room, got ' + cartH);
      // Edit re-opens it with the same numbers
      await page.click('#sp-summary'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), true);
      assert.equal(await page.evaluate(() => document.getElementById('split-cash-input').value), '200');
      // Esc closes
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), false);
      // switching to M-Pesa puts the M-Pesa details back in the cart and removes the summary; switching back to Split re-opens the popup
      await page.click('#pay-mpesa-btn'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.getElementById('sp-summary').hidden), true);
      assert.equal(await page.evaluate(() => !!document.getElementById('mpesa-prompt-panel').closest('#sp-modal')), false, 'M-Pesa details are back in the cart');
      assert.equal((await box(page, 'mpesa-phone-input')).vis, true);
      await page.click('#pay-split-btn'); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), true);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('index.html (phone): the phone sheet keeps its own payment steps - Split stays inline, no popup', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html', { width: 390, height: 844 });
    await page.evaluate(() => setPaymentMethod('split')); await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ open: document.getElementById('sp-modal').classList.contains('open'), inModal: !!document.getElementById('split-payment-panel').closest('#sp-modal'), sumHidden: document.getElementById('sp-summary').hidden }));
    assert.deepEqual(m, { open: false, inModal: false, sumHidden: true });
    // resizing a tablet window down to phone width hands the panels back to the cart, and back up re-opens the popup
    await page.setViewportSize({ width: 1100, height: 800 }); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('sp-modal').classList.contains('open')), true, 'wide again: popup');
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => ({ open: document.getElementById('sp-modal').classList.contains('open'), inModal: !!document.getElementById('split-payment-panel').closest('#sp-modal'), mpInModal: !!document.getElementById('mpesa-prompt-panel').closest('#sp-modal') })), { open: false, inModal: false, mpInModal: false });
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
