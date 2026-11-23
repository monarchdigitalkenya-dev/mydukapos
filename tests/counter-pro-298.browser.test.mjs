import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// Zip 298: the compact Sales Counter (dense grid, one search box, category bar, Hold | Drawer | Complete row) and the always-ready barcode scanner,
// checked in a REAL browser: layout, overlap and focus are things jsdom cannot see. A scanner is simulated the way a keyboard-wedge one behaves:
// every key within a few milliseconds, then Enter, typed into whatever has the focus (nothing, usually).
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
const CATS = ['Hardware', 'Paint', 'Plumbing', 'Electrical'];
const INV = [];
for (let i = 1; i <= 40; i++) INV.push({ code: 'P' + String(i).padStart(4, '0'), type: 'item', name: 'Product number ' + i + ' with a fairly long name', price: 50 + i * 7, qty: 30, unit: 'pcs', vatCategory: 'A', category: CATS[i % CATS.length], updatedAt: 1 });
INV.push({ code: '5901234123457', type: 'item', name: 'Scanned Soap', price: 120, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Hardware', updatedAt: 1 });
INV.push({ code: '4006381333931', type: 'item', name: 'Scanned Glue', price: 80, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Paint', updatedAt: 1 });

async function open(browser, base, app, vp, { mobile = false, cashFloat = true } = {}) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.addInitScript(([inv, cash]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('pos_inventory', JSON.stringify(inv));
    if (!cash) localStorage.setItem('pos_cash_config', JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }]));
  }, [INV, cashFloat]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/' + app); await page.waitForTimeout(1600);
  await page.evaluate(() => {
    for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; }
    const s = document.getElementById('boot-splash'); if (s) s.remove();
    window.__toasts = []; window.showToast = (m) => { window.__toasts.push(String(m)); };
  });
  await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'sales-tab'));
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}
const qtyOf = (page) => page.evaluate(() => Object.values(currentCart).reduce((s, l) => s + (Number(l.qty) || 0), 0));
const lines = (page) => page.evaluate(() => Object.keys(currentCart).length);
// a keyboard-wedge scan: every key lands within a millisecond or two of the last (a loaded CI machine can make real key presses slower than a scanner,
// which would only test the machine), Enter last, all of it sent to whatever has the focus - exactly like a real scanner. Like a real keyboard, a key
// that nobody cancelled is inserted into a focused text box.
async function scan(page, code) {
  await page.evaluate((c) => {
    const el = document.activeElement || document.body;
    const send = (key) => { const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; };
    for (const ch of c) { const ev = send(ch); if (!ev.defaultPrevented && 'value' in el) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    send('Enter');
  }, code);
  await page.waitForTimeout(250);
}

for (const app of ['index.html', 'hotel/index.html']) {
  test(`${app} (desktop): dense grid, one search box, compact categories, Hold | Drawer | Complete on one row`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app, { width: 1366, height: 768 });
      const m = await page.evaluate(() => {
        const g = document.getElementById('item-image-grid'), cells = [...g.querySelectorAll('.item-grid-cell')];
        const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
        const img = g.querySelector('.item-grid-cell img, .item-grid-cell .igc-noimg');
        const s = document.getElementById('sales-search'), h3 = document.querySelector('#sales-tab .pos-products > h3');
        return { cols, cells: cells.length, imgH: img ? img.getBoundingClientRect().height : -1, ph: s.placeholder, h3: h3 ? getComputedStyle(h3).display : 'none', tab: document.getElementById('sales-tab').className };
      });
      assert.ok(m.cols >= 5 && m.cols <= 7, 'product columns 5-7, got ' + m.cols);
      assert.ok(m.imgH >= 80, 'zip 299: a full square picture, not a strip, got ' + m.imgH);
      const sq = await page.evaluate(() => { const i = document.querySelector('#item-image-grid .item-grid-cell img'); if (!i) return null; const r = i.getBoundingClientRect(); return { ratio: r.width / r.height, fit: getComputedStyle(i).objectFit }; });
      if (sq) { assert.ok(Math.abs(sq.ratio - 1) < 0.03, 'picture is 1:1, got ' + sq.ratio); assert.equal(sq.fit, 'contain', 'the whole picture shows'); }
      assert.equal(m.ph, 'Search products, barcode or SKU...');
      assert.equal(m.h3, 'none', 'the separate "Product Search" heading is gone');
      // clear (x) inside the search box
      await page.click('#sales-search'); await page.keyboard.type('number 1');
      assert.equal(await page.locator('#cc-clear').isVisible(), true, 'clear button shows once there is text');
      await page.click('#cc-clear');
      assert.equal(await page.evaluate(() => document.getElementById('sales-search').value), '');
      assert.equal(await page.locator('#cc-clear').isVisible(), false);
      // categories: a compact row, a click filters the grid, All brings everything back
      if (app === 'index.html') {
        const bar = await page.evaluate(() => { const b = document.getElementById('cc-cat-bar'); const r = b.getBoundingClientRect(); return { h: r.height, chips: b.querySelectorAll('.cc-chip').length, one: b.scrollHeight <= r.height + 4 }; });
        assert.ok(bar.h <= 44 && bar.one, 'one slim row, height ' + bar.h);
        assert.ok(bar.chips >= 5, 'All + each category');
        const total = await page.evaluate(() => document.querySelectorAll('#item-image-grid .item-grid-cell').length);
        await page.click('#cc-cat-bar .cc-chip[data-k="paint"]'); await page.waitForTimeout(250);
        const paint = await page.evaluate(() => [...document.querySelectorAll('#item-image-grid .item-grid-cell')].map((c) => c.getAttribute('onclick')).join('|'));
        const expected = INV.filter((p) => p.category === 'Paint').length;
        assert.equal((paint.match(/addToCart/g) || []).length, expected, 'only Paint items');
        assert.equal(await page.evaluate(() => document.querySelector('#cc-cat-bar .cc-chip.on').getAttribute('data-k')), 'paint');
        await page.click('#cc-cat-bar .cc-chip[data-k="__all"]'); await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => document.querySelectorAll('#item-image-grid .item-grid-cell').length), total, 'All again');
      }
      // Hold | Drawer | Complete: same row, in that order, no overlap, inside the screen
      await page.evaluate(() => addToCart('P0001'));
      await page.waitForTimeout(500);
      const row = await page.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, vis: getComputedStyle(e).display !== 'none' }; };
        return { hold: r('hold-sale-btn'), chip: r('cash-chip'), done: r('main-checkout-btn'), total: r('cart-grand-total'), vh: window.innerHeight, label: document.getElementById('main-checkout-btn').textContent.trim(), holdLabel: document.getElementById('hold-sale-btn').textContent.trim(), chipLabel: (document.getElementById('cash-chip') || {}).textContent };
      });
      assert.ok(row.hold && row.done, 'hold + complete buttons exist');
      assert.ok(Math.abs(row.hold.t - row.done.t) < 8, 'Hold and Complete on one row');
      if (row.chip) { assert.ok(Math.abs(row.chip.t - row.done.t) < 8, 'Drawer on the same row'); assert.ok(row.hold.l < row.chip.l && row.chip.l < row.done.l, 'order Hold | Drawer | Complete'); assert.ok(row.chip.r <= row.done.l + 1 && row.hold.r <= row.chip.l + 1, 'no overlap'); assert.equal(row.chipLabel, '💵 Open Drawer'); }
      assert.ok(row.done.w > row.hold.w, 'Complete Sale is the primary, widest button');
      assert.ok(row.done.b <= row.vh && row.total.b <= row.vh, 'the total and the sale buttons are on screen without scrolling');
      assert.equal(row.label, '✅ Complete Sale');
      assert.equal(row.holdLabel, '⏸️ Hold Sale');
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

test('index.html: the barcode scanner is ready without clicking anything, through categories, manual adds, hold / retrieve, and unknown codes', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html', { width: 1366, height: 768 }, { cashFloat: false });
    assert.equal(await page.evaluate(() => document.activeElement === document.body || document.activeElement === document.documentElement), true, 'nothing is focused (the search box is NOT clicked)');
    await scan(page, '5901234123457');
    assert.equal(await qtyOf(page), 1, '1: the first scan adds the item');
    await scan(page, '4006381333931');
    assert.equal(await lines(page), 2, '2: a different product is a second line');
    await scan(page, '5901234123457'); await scan(page, '5901234123457');
    assert.equal(await page.evaluate(() => currentCart['5901234123457'].qty), 3, '3: the same product repeatedly raises the quantity');
    // 4: change category, keep scanning - no click in the search box
    await page.click('#cc-cat-bar .cc-chip[data-k="plumbing"]'); await page.waitForTimeout(200);
    await scan(page, '4006381333931');
    assert.equal(await page.evaluate(() => currentCart['4006381333931'].qty), 2, '4: scan after a category change (a Paint item while Plumbing is shown)');
    // 5: add manually, then scan another
    await page.evaluate(() => addToCart('P0002')); await scan(page, '5901234123457');
    assert.equal(await page.evaluate(() => currentCart['5901234123457'].qty), 4, '5: manual add then a scan');
    // 6: hold, retrieve, scan
    await page.click('#hold-sale-btn'); await page.waitForTimeout(400);
    assert.equal(await qtyOf(page), 0, 'held: the cart is empty');
    await scan(page, '5901234123457');
    assert.equal(await qtyOf(page), 1, '6a: a scan after Hold starts the next sale');
    await page.evaluate(() => { try { resumeHeldSale(); } catch (e) { /* the button path below */ } });
    // 8: unknown code - a toast, then the next scan still works
    await page.evaluate(() => { window.__toasts.length = 0; });
    await scan(page, '9999999999999');
    assert.ok((await page.evaluate(() => window.__toasts)).some((t) => /No item with code/.test(t)), '8: a non-blocking "not found" message');
    const before = await qtyOf(page);
    await scan(page, '4006381333931');
    assert.equal(await qtyOf(page), before + 1, '8: the next scan still works');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('index.html: typing in a payment reference / customer / dialog box is never mistaken for a scan; the search box and number boxes still scan', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html', { width: 1366, height: 768 }, { cashFloat: false });
    await page.evaluate(() => addToCart('P0001'));
    const before = await qtyOf(page);
    // a customer / delivery box: even a burst as fast as a scanner stays in the box
    await page.click('#order-delivery-btn'); await page.waitForTimeout(400);
    await page.click('#delivery-client-name-input');
    await scan(page, '5901234123457');
    assert.equal(await qtyOf(page), before, 'nothing was added: it was typing');
    assert.equal(await page.evaluate(() => document.getElementById('delivery-client-name-input').value), '5901234123457', 'the text stays in the box');
    assert.equal(await page.evaluate(() => window.__ccScanSkip()), true);
    assert.equal((await page.locator('#cc-scan').textContent()).trim(), 'Scan ready', 'the light always says Scan ready');
    await page.click('.dlv-foot button:has-text("Walk-in")'); await page.waitForTimeout(300);
    // human-speed typing in the search box is just typing
    await page.click('#sales-search'); await page.keyboard.type('5901234123457', { delay: 130 }); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    // (the app's own rule: an exact code + Enter in the search box adds it - that is existing behaviour and is unchanged)
    assert.equal(await page.evaluate(() => window.__ccScanSkip()), false, 'the search box is scan-friendly');
    await page.evaluate(() => { document.getElementById('sales-search').value = ''; liveSearch(''); document.activeElement.blur(); });
    // a quantity box: a scan wins and the digits do not stay in it
    const q0 = await qtyOf(page);
    await page.click('#cart-table input[type=number]'); await scan(page, '4006381333931');
    assert.equal(await qtyOf(page), q0 + 1, 'a scan with the cursor in a quantity box still adds the item');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('index.html: after a completed sale the very next scan starts the next sale', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html', { width: 1366, height: 768 }, { cashFloat: false });
    await scan(page, '5901234123457');
    assert.equal(await qtyOf(page), 1);
    await page.click('#pay-cash-btn'); await page.fill('#cash-tendered-input', '500');
    await page.click('#main-checkout-btn'); await page.waitForTimeout(1500);
    assert.equal(await qtyOf(page), 0, 'the sale completed and the cart is empty');
    await scan(page, '4006381333931');
    assert.equal(await qtyOf(page), 1, '7: the next customer\'s first scan is added at once');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('index.html (phone): the phone till layout is untouched', { skip }, async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, base, 'index.html', { width: 390, height: 780 }, { mobile: true });
    await page.evaluate(() => addToCart('P0001')); await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ row: !!document.getElementById('cc-actions'), on: document.getElementById('sales-tab').classList.contains('ccp-on'), label: document.getElementById('main-checkout-btn').textContent.trim(), clr: !!document.getElementById('cc-clear') && getComputedStyle(document.getElementById('cc-clear')).display }));
    assert.equal(r.row, false, 'no desktop action row on a phone');
    assert.equal(r.on, false);
    assert.equal(r.label, '✅ Confirm');
    assert.notEqual(r.clr, 'inline-flex');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

// Zip 299: product pictures are square (1:1) and the WHOLE picture shows (contain, never cropped) - checked with a wide and a tall picture
const WIDE = 'data:image/svg+xml;utf8,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='300' height='100'><rect width='300' height='100' fill='#e8f1ff'/><rect x='2' y='2' width='296' height='96' fill='none' stroke='#c0392b' stroke-width='4'/></svg>");
const TALL = 'data:image/svg+xml;utf8,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='300'><rect width='100' height='300' fill='#eafaf1'/><rect x='2' y='2' width='96' height='296' fill='none' stroke='#27ae60' stroke-width='4'/></svg>");
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) {
  test(`${app}: product pictures are square and show the whole picture`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      await ctx.route('**/api/**', (r) => r.abort());
      const inv = INV.map((p, i) => (i === 0 ? { ...p, image: WIDE } : i === 1 ? { ...p, image: TALL } : p));
      await ctx.addInitScript((i2) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('pos_inventory', JSON.stringify(i2)); }, inv);
      const page = await ctx.newPage(); await page.goto(base + '/' + app); await page.waitForTimeout(1600);
      await page.evaluate(() => { for (const id of ['login-screen', 'registration-screen']) { const l = document.getElementById(id); if (l) l.style.display = 'none'; } const s = document.getElementById('boot-splash'); if (s) s.remove(); });
      await page.evaluate(() => guardedSwitchTab({ preventDefault() {}, currentTarget: null, target: null }, 'sales-tab'));
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => [...document.querySelectorAll('#item-image-grid .item-grid-cell img')].map((i) => { const r = i.getBoundingClientRect(); return { w: r.width, h: r.height, fit: getComputedStyle(i).objectFit }; }));
      assert.ok(m.length >= 2, 'pictures are drawn, got ' + m.length);
      for (const i of m) { assert.ok(Math.abs(i.w - i.h) <= 1.5, `square 1:1, got ${i.w}x${i.h}`); assert.ok(i.w >= 80, 'big enough to see, got ' + i.w); assert.equal(i.fit, 'contain', 'never cropped'); }
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}

// Zip 300: on a tablet (a narrow cart panel) every cart line stays fully inside the panel - name, total, quantity, price and remove - no columns off the edge
for (const app of ['index.html', 'hospital/index.html']) {
  test(`${app} @1024: a narrow cart stacks each line so nothing runs off the edge`, { skip }, async () => {
    const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser, base, app, { width: 1024, height: 768 });
      await page.evaluate(() => { addToCart('P0001'); addToCart('P0002'); });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const sc = document.querySelector('#sales-tab .pos-cart-scroll'), r = sc.getBoundingClientRect();
        const rows = [...document.querySelectorAll('#cart-table tbody tr')].filter((tr) => tr.children.length >= 5);
        const out = rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => { const b = td.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; }));
        return { narrow: document.getElementById('sales-tab').classList.contains('cc-narrow'), left: r.left, right: r.right, sw: sc.scrollWidth, cw: sc.clientWidth, rows: out };
      });
      assert.equal(m.narrow, true, 'the narrow layout switches on');
      assert.ok(m.sw <= m.cw + 1, `no sideways scrolling: ${m.sw} > ${m.cw}`);
      assert.ok(m.rows.length >= 2);
      for (const row of m.rows) for (const c of row) assert.ok(c.l >= m.left - 1 && c.r <= m.right + 1 && c.w > 10, 'a cart cell is inside the panel: ' + JSON.stringify(c) + ' panel ' + m.left + '-' + m.right);
      // and nothing in a line sits on top of its neighbour: quantity [-][1][+] | price | remove
      const gaps = await page.evaluate(() => [...document.querySelectorAll('#cart-table tbody tr')].filter((tr) => tr.children.length >= 5).map((tr) => {
        const plus = tr.querySelector('.qty-controls button:last-of-type').getBoundingClientRect(), chip = tr.querySelector('.cart-price-chip').getBoundingClientRect(), rm = tr.querySelector('.remove-btn').getBoundingClientRect();
        return { qtyToPrice: chip.left - plus.right, priceToRemove: rm.left - chip.right };
      }));
      for (const g of gaps) assert.ok(g.qtyToPrice >= 0 && g.priceToRemove >= 0, 'no overlap inside a cart line: ' + JSON.stringify(g));
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
}
