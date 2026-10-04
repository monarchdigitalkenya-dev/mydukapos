import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

// zip 204: the storefront reading a live catalogue — offers, systems, detail pages, filters, sorting, routing. Public site only.
const PS = path.join(ROOT, 'public-site');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const P = (id, name, cat, kind, o = {}) => ({ id, slug: id, name, sku: 'SKU-' + id, cat, kind, stock: 'in', blurb: name + ' blurb', description: name + ' long text', specs: [{ k: 'Warranty', v: '12 months' }], images: [], featured: false, related: [], createdAt: 1, pos: 0, price: 10000, eff: 10000, onOffer: false, offerEnd: 0, discount: 0, pct: 0, was: null, ...o });
const CATALOG = {
  ok: true, live: true, configured: true, now: Date.now(),
  categories: [{ id: 'c1', name: 'Printers', slug: 'printers', scope: 'product' }, { id: 'c2', name: 'Scanners', slug: 'scanners', scope: 'product' }, { id: 'c3', name: 'Retail systems', slug: 'retail', scope: 'system' }],
  products: [
    P('p1', 'Thermal Printer 80mm', 'c1', 'printer', { price: 18000, eff: 15000, was: 18000, onOffer: true, discount: 3000, pct: 17, featured: true, offerEnd: Date.now() + 864e5, related: ['p2'] }),
    P('p2', 'Barcode Scanner', 'c2', 'scanner', { price: 7000, eff: 7000, createdAt: 5 }),
    P('p3', 'Cash Drawer', 'c1', 'drawer', { price: null, eff: null, stock: 'out', createdAt: 3 }),
    P('p4', 'Label Printer', 'c1', 'label', { price: 30000, eff: 30000, createdAt: 9, featured: true }),
  ],
  systems: [{ id: 's1', slug: 'retail-pack', name: 'Retail Starter System', cat: 'c3', kind: 'bundle', stock: 'in', blurb: 'Everything for a shop', description: '', specs: [], images: [], featured: true, createdAt: 2, pos: 0, price: 22000, eff: 20000, was: 22000, onOffer: true, discount: 2000, pct: 9, offerEnd: Date.now() + 864e5, individualValue: 25000, saving: 5000,
    components: [{ id: 'p1', name: 'Thermal Printer 80mm', qty: 1, unit: 15000, kind: 'printer', image: '' }, { id: 'p2', name: 'Barcode Scanner', qty: 1, unit: 7000, kind: 'scanner', image: '' }, { id: 'p3', name: 'Cash Drawer', qty: 1, unit: 3000, kind: 'drawer', image: '' }] }],
};
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (u === '/api/catalog') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(CATALOG)); }
    const cand = u === '/' ? 'public-site/index.html' : u.startsWith('/icons/') ? u.slice(1) : u.startsWith('/shop/') ? 'public-site/shop.html' : fs.existsSync(path.join(PS, u)) && fs.statSync(path.join(PS, u)).isFile() ? 'public-site' + u : 'public-site' + u + '.html';
    const p = path.join(ROOT, cand);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function withSite(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
async function open(browser, base, url, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: o.w || 1366, height: o.h || 800 }, reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
  await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(String(e.message)));
  await p.goto(base + url); return { ctx, p, errors };
}
const names = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#grid .pc h3')).map((h) => h.textContent));

test('storefront: offers and systems sections, offer maths on cards, filters, sort and routing', { skip, timeout: 120000 }, async () => {
  await withSite(async (browser, base) => {
    const { ctx, p, errors } = await open(browser, base, '/shop');
    await p.waitForSelector('#grid .pc'); await p.waitForTimeout(600);
    assert.equal(await p.evaluate(() => document.querySelectorAll('#offer-grid .oc').length), 2, 'both live offers are big cards');
    assert.equal(await p.evaluate(() => document.querySelectorAll('#sys-grid .pc.sys').length), 1);
    const offerTxt = await p.evaluate(() => document.getElementById('offer-grid').textContent);
    assert.match(offerTxt, /17%/); assert.match(offerTxt, /KES 15,000/); assert.match(offerTxt, /KES 18,000/); assert.match(offerTxt, /5,000/, 'system saving shown');
    assert.ok((await names(p)).length === 5, 'products and systems in the catalogue grid');
    await p.waitForTimeout(1300);
    assert.equal(await p.evaluate(() => document.querySelector('.stats b').textContent), '4', 'count-up lands on the real number');
    // category
    await p.click('.chip[data-chip="c:c2"]'); await p.waitForTimeout(500);
    assert.deepEqual(await names(p), ['Barcode Scanner']);
    assert.match(await p.evaluate(() => location.search), /cat=scanners/);
    // offers view, systems view
    await p.click('.chip[data-chip="offers"]'); await p.waitForTimeout(500); assert.equal((await names(p)).length, 2);
    await p.click('.chip[data-chip="systems"]'); await p.waitForTimeout(500); assert.deepEqual(await names(p), ['Retail Starter System']);
    await p.click('.chip[data-chip="all"]'); await p.waitForTimeout(500);
    // sort: price low to high puts unpriced last
    await p.selectOption('#sort', 'low'); await p.waitForTimeout(500);
    const low = await names(p); assert.equal(low[0], 'Barcode Scanner'); assert.equal(low.at(-1), 'Cash Drawer');
    await p.selectOption('#sort', 'newest'); await p.waitForTimeout(500); assert.equal((await names(p))[0], 'Label Printer');
    // price range + availability
    await p.selectOption('#sort', 'featured'); await p.fill('#min', '10000'); await p.fill('#max', '20000'); await p.waitForTimeout(700);
    assert.deepEqual((await names(p)).sort(), ['Retail Starter System', 'Thermal Printer 80mm']);
    await p.fill('#min', ''); await p.fill('#max', ''); await p.check('#avail'); await p.waitForTimeout(700);
    assert.ok(!(await names(p)).includes('Cash Drawer'), 'out of stock hidden when only available is asked for');
    await p.uncheck('#avail');
    // deep link
    await p.goto(base + '/shop?view=systems'); await p.waitForSelector('#grid .pc'); await p.waitForTimeout(400);
    assert.deepEqual(await names(p), ['Retail Starter System']);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

test('storefront: product page (gallery area, price emphasis, related, JSON-LD) and system page (value vs price, YOU SAVE, parts link to products)', { skip, timeout: 90000 }, async () => {
  await withSite(async (browser, base) => {
    const { ctx, p, errors } = await open(browser, base, '/shop/p/p1');
    await p.waitForSelector('.info h1'); await p.waitForTimeout(400);
    assert.equal(await p.title(), 'Thermal Printer 80mm — mydukapos');
    const t = await p.evaluate(() => document.querySelector('.info').textContent);
    assert.match(t, /KES 15,000/); assert.match(t, /KES 18,000/); assert.match(t, /Warranty/); assert.match(t, /SKU SKU-p1/);
    assert.equal(await p.evaluate(() => !!document.querySelector('.stage .ob')), true, 'offer badge');
    assert.match(await p.evaluate(() => document.querySelector('.more h2').textContent), /may also need/);
    assert.ok((await p.evaluate(() => document.querySelectorAll('.more .pc').length)) >= 1);
    const ld = JSON.parse(await p.evaluate(() => document.getElementById('ld').textContent)); assert.equal(ld['@type'], 'Product'); assert.equal(ld.offers.price, 15000);
    assert.match(await p.evaluate(() => document.querySelector('.cta .primary').href), /wa\.me\/254791598506\?text=.*Thermal/);
    await p.click('.more .pc'); await p.waitForTimeout(500); assert.match(await p.evaluate(() => location.pathname), /^\/shop\/p\//);
    await p.goto(base + '/shop/s/retail-pack'); await p.waitForSelector('.parts'); await p.waitForTimeout(300);
    const v = await p.evaluate(() => document.querySelector('.vs').textContent);
    assert.match(v, /25,000/); assert.match(v, /20,000/); assert.match(v, /5,000/); assert.match(v.toLowerCase(), /you save/);
    assert.equal(await p.evaluate(() => document.querySelectorAll('.parts a.part').length), 3);
    await p.click('.parts a.part'); await p.waitForTimeout(500); assert.equal(await p.evaluate(() => location.pathname), '/shop/p/p1');
    await p.goto(base + '/shop/p/nope'); await p.waitForTimeout(500);
    assert.match(await p.evaluate(() => document.getElementById('view').textContent), /could not find/);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

test('home page shows featured products, systems and offers from the catalogue; nav gets the Products dropdown', { skip, timeout: 90000 }, async () => {
  await withSite(async (browser, base) => {
    const { ctx, p, errors } = await open(browser, base, '/');
    await p.waitForSelector('#home-featured .pc'); await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => !document.getElementById('home-offers-sec').hidden && document.querySelectorAll('#home-offers .oc').length), 2);
    assert.equal(await p.evaluate(() => document.querySelectorAll('#home-systems .pc.sys').length), 1);
    await p.hover('.nav-dd-btn'); await p.waitForTimeout(400);
    const menu = await p.evaluate(() => document.querySelector('.nav-dd-menu').textContent);
    assert.match(menu, /Printers/); assert.match(menu, /Complete systems/); assert.match(menu, /Special offers/);
    assert.deepEqual(errors, []); await ctx.close();
    const m = await open(browser, base, '/', { w: 390, h: 844 }); await m.p.waitForSelector('#home-featured .pc'); await m.p.waitForTimeout(800);
    assert.equal(await m.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scroll on a phone');
    assert.deepEqual(m.errors, []); await m.ctx.close();
    const r = await open(browser, base, '/shop', { reduced: true }); await r.p.waitForSelector('#grid .pc'); await r.p.waitForTimeout(400);
    assert.equal(await r.p.evaluate(() => document.querySelector('.stats b').textContent), '4', 'reduced motion: counts are set at once');
    await r.ctx.close();
  });
});

test('phone: no sideways scroll on any storefront page, the menu drawer and filter panel work by touch, Escape/outside tap close the drawer, tap targets are comfortable', { skip, timeout: 120000 }, async () => {
  await withSite(async (browser, base) => {
    for (const w of [360, 390, 768]) {
      for (const u of ['/', '/shop', '/shop/p/p1', '/shop/s/retail-pack', '/faq', '/offers']) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, hasTouch: true, isMobile: w < 700 });
        await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
        const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
        await p.goto(base + u); await p.waitForTimeout(900);
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, w + ' ' + u + ' sideways scroll');
        const tiny = await p.evaluate(() => Array.from(document.querySelectorAll('button,select,input:not([type=hidden]):not([type=checkbox])')).filter((e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && r.height < 36; }).map((e) => e.id || e.className));
        assert.deepEqual(tiny, [], w + ' ' + u + ' controls under 36px tall');
        assert.deepEqual(errs, [], w + ' ' + u);
        await ctx.close();
      }
    }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
    const p = await ctx.newPage(); await p.goto(base + '/shop'); await p.waitForSelector('#grid .pc'); await p.waitForTimeout(500);
    const nav = () => p.evaluate(() => document.body.classList.contains('nav-open'));
    await p.tap('.nav-burger'); await p.waitForTimeout(400); assert.equal(await nav(), true);
    await p.tap('.nav-dd-btn'); await p.waitForTimeout(300);
    assert.ok((await p.evaluate(() => Array.from(document.querySelectorAll('.nav-dd-menu a')).filter((a) => a.getBoundingClientRect().height > 0).length)) >= 3, 'Products list opens inside the drawer');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300); assert.equal(await nav(), false, 'Escape closes the drawer');
    await p.tap('.nav-burger'); await p.waitForTimeout(300); await p.tap('.nav-dd-btn'); await p.waitForTimeout(200);
    await p.tap('.nav-dd-menu a[href*="view=offers"]'); await p.waitForTimeout(700);
    assert.equal(await nav(), false, 'choosing a link closes the drawer'); assert.match(await p.evaluate(() => location.search), /view=offers/);
    assert.equal((await names(p)).length, 2, 'the offers view opened in the page, no reload');
    await p.evaluate(() => document.getElementById('catalogue').scrollIntoView()); await p.waitForTimeout(300);
    await p.tap('#fbtn'); await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => document.getElementById('fbtn').getAttribute('aria-expanded')), 'true');
    assert.equal(await p.evaluate(() => { const r = document.getElementById('sort').getBoundingClientRect(); return r.height > 0 && r.bottom < innerHeight; }), true, 'the sort control is visible when the panel is open');
    await p.selectOption('#sort', 'low'); await p.waitForTimeout(500);
    await ctx.close();
  });
});
