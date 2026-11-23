import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, APPS } from './helpers.mjs';

// zip 203: the premium public website — the hardware shop page, the premium design layer and its motion. Public site only; the POS apps are untouched.
const PS = path.join(ROOT, 'public-site');
const read = (f) => fs.readFileSync(path.join(PS, f), 'utf8');
const site = await import(pathToFileURL(path.join(ROOT, 'functions/_site.js')).href);

test('/shop is a public apex page, its files are served, and it is in the sitemap', () => {
  assert.equal(site.APEX_PAGES['/shop'], 'shop');
  for (const f of ['/premium.css', '/motion.js', '/shop-art.js', '/shop-ui.js', '/shop-catalog.json', '/site.css']) assert.ok(site.APEX_FILES.test(f), f);
  assert.ok(!site.APEX_FILES.test('/package.json') && !site.APEX_FILES.test('/shop-catalog.json.bak'));
  assert.ok(site.sitemapEntries().some((e) => e.path === '/shop'));
  for (const f of ['shop.html', 'premium.css', 'motion.js', 'shop-art.js', 'shop-catalog.json']) assert.ok(fs.existsSync(path.join(PS, f)), f);
});

test('the catalogue is valid: unique ids, known categories and artwork, honest prices, a WhatsApp number', () => {
  const c = JSON.parse(read('shop-catalog.json'));
  const cats = new Set(c.categories.map((x) => x.key)); assert.ok(cats.size >= 6);
  const art = read('shop-art.js');
  const win = {}; new Function('window', 'document', art)(win, { querySelectorAll: () => [] }); const kinds = new Set(win.pmKinds);
  const ids = new Set();
  assert.ok(c.products.length >= 12);
  for (const p of c.products) {
    assert.ok(!ids.has(p.id), 'duplicate ' + p.id); ids.add(p.id);
    assert.ok(cats.has(p.cat), p.id + ' category'); assert.ok(kinds.has(p.kind), p.id + ' kind ' + p.kind);
    assert.ok(p.name && p.blurb && Array.isArray(p.points) && p.points.length >= 2, p.id + ' text');
    assert.ok(p.price === null || (typeof p.price === 'number' && p.price > 0), p.id + ' price is a real number or null (shown as "Get a quote")');
  }
  for (const k of cats) assert.ok(c.products.some((p) => p.cat === k), 'category ' + k + ' has a product');
  assert.match(String(c.whatsapp), /^254\d{9}$/);
});

test('homepage keeps every id the page script fills in, links to Hardware, and every public page has the Hardware link', () => {
  const h = read('index.html');
  for (const id of ['hero-headline', 'hero-subhead', 'price-amount-hero', 'apps', 'pricing', 'hardware', 'home-featured']) assert.ok(h.includes('id="' + id + '"'), id);      // zip 307: complete systems and offers live on /shop (linked from the hardware section)
  assert.ok(h.includes('href="/shop"') && h.includes('/premium.css') && h.includes('/motion.js'));
  for (const f of ['faq', 'contact', 'offers', 'terms', 'privacy', 'cookies', 'acceptable-use', 'shop']) assert.ok(read(f + '.html').includes('href="/shop"'), f);
});

test('motion is purposeful and respectful: reduced-motion switches it off, the entrance is under a second, no POS app loads it', () => {
  const css = read('premium.css'), js = read('motion.js');
  assert.match(css, /prefers-reduced-motion:\s*reduce/); assert.match(js, /prefers-reduced-motion/);
  const dur = [...css.matchAll(/animation:pmIn\s+([\d.]+)s/g)].map((m) => +m[1]); assert.ok(dur.length && dur.every((d) => d >= 0.3 && d <= 0.8), 'entrance 300–800ms: ' + dur);
  assert.ok(!/alert\(|document\.write/.test(js));
  for (const a of APPS.concat(['order/index.html', 'owner/index.html'])) { const t = fs.readFileSync(path.join(ROOT, a), 'utf8'); assert.ok(!/premium\.css|motion\.js|shop-art\.js/.test(t), a + ' must not load the website layer'); }
});

// ---------- real browser ----------
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/')('playwright').chromium; } catch (e2) { /* none */ }
}
const skip = !chromium && 'Playwright not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
function serve() {            // mimics the apex routing of functions/_middleware.js: "/" -> index, "/shop" -> shop.html, files from public-site, icons from the root
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const cand = u === '/' ? 'public-site/index.html' : u.startsWith('/icons/') ? u.slice(1) : fs.existsSync(path.join(PS, u)) && fs.statSync(path.join(PS, u)).isFile() ? 'public-site' + u : 'public-site' + u + '.html';
    const p = path.join(ROOT, cand);
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function withSite(fn) {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try { await fn(browser, base); } finally { await browser.close(); srv.close(); }
}
async function page(browser, base, url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w || 1366, height: opts.h || 800 }, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  await ctx.route(/fonts\.(googleapis|gstatic)|\/api\//, (r) => r.abort());
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(String(e.message)));
  await p.goto(base + url); return { ctx, p, errors };
}

test('homepage: hero text enters in order and finishes visible within a second; reduced motion shows it at once; no sideways scroll on a phone', { skip, timeout: 90000 }, async () => {
  await withSite(async (browser, base) => {
    const a = await page(browser, base, '/');
    await a.p.waitForTimeout(150);
    const early = await a.p.evaluate(() => Array.from(document.querySelectorAll('.hero .pm-in')).map((e) => +getComputedStyle(e).opacity));
    assert.ok(early.length >= 6);
    await a.p.waitForTimeout(1500);
    const late = await a.p.evaluate(() => Array.from(document.querySelectorAll('.hero .pm-in')).map((e) => +getComputedStyle(e).opacity));
    assert.ok(late.every((o) => o > 0.99), 'every hero piece ends fully visible: ' + late);
    assert.equal(await a.p.evaluate(() => { const b = document.getElementById('hp-film-play'); const r = b && b.getBoundingClientRect(); return !!r && r.width > 200 && r.height > 100; }), true, 'zip 307: the hero shows the real app (the film poster), not a drawn scene');
    assert.ok(await a.p.evaluate(() => document.querySelectorAll('#home-featured .pc').length) >= 1 && await a.p.evaluate(() => !document.getElementById('hardware').hidden), 'featured hardware drawn from the catalogue');
    await a.p.evaluate(() => window.scrollTo(0, 400)); await a.p.waitForTimeout(250);
    assert.equal(await a.p.evaluate(() => document.querySelector('header.site-nav').classList.contains('pm-scrolled')), true, 'nav tightens on scroll');
    assert.deepEqual(a.errors, []); await a.ctx.close();
    const r = await page(browser, base, '/', { reduced: true });
    await r.p.waitForTimeout(100);
    assert.ok(await r.p.evaluate(() => Array.from(document.querySelectorAll('.hero .pm-in')).every((e) => +getComputedStyle(e).opacity === 1)), 'reduced motion: visible immediately');
    assert.equal(await r.p.evaluate(() => getComputedStyle(document.querySelector('.hero .pm-aurora')).animationName), 'none');
    await r.ctx.close();
    const m = await page(browser, base, '/', { w: 390, h: 844 }); await m.p.waitForTimeout(1200);
    assert.equal(await m.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scroll on a phone');
    assert.deepEqual(m.errors, []); await m.ctx.close();
  });
});

test('shop page (starter catalogue, API unreachable): every item drawn, chips and search filter, detail page opens, quote bar builds a WhatsApp message', { skip, timeout: 90000 }, async () => {
  await withSite(async (browser, base) => {
    const { ctx, p, errors } = await page(browser, base, '/shop');
    const total = JSON.parse(read('shop-catalog.json')).products.length;
    await p.waitForSelector('#grid .pc'); await p.waitForTimeout(500);
    const count = () => p.evaluate(() => document.querySelectorAll('#grid .pc').length);
    assert.ok(await count() >= total, 'every starter item is drawn');
    assert.equal(await p.evaluate(() => document.querySelectorAll('#grid .pc .pc-img svg').length), await count(), 'each has its illustration');
    const first = await count();
    await p.click('.chip[data-chip^="c:"]'); await p.waitForTimeout(500);
    const n = await count(); assert.ok(n >= 1 && n < first, 'a category narrows the grid');
    await p.click('.chip[data-chip="all"]'); await p.fill('#q', 'cash drawer'); await p.waitForTimeout(600);
    const hits = await p.evaluate(() => Array.from(document.querySelectorAll('#grid .pc h3')).map((h) => h.textContent));
    assert.ok(hits.length >= 1 && hits.length < first && hits.includes('Cash Drawer'), 'search narrows the list: ' + hits);
    await p.fill('#q', 'zzzzqqq'); await p.waitForTimeout(600);
    assert.equal(await p.evaluate(() => document.getElementById('empty').hidden), false, 'no match says so');
    await p.fill('#q', ''); await p.waitForTimeout(600);
    assert.equal(await p.evaluate(() => document.getElementById('qbar').classList.contains('on')), false);
    // open two items, add each to the quote
    const hrefs = await p.evaluate(() => Array.from(document.querySelectorAll('#grid .pc')).slice(0, 3).map((a) => a.getAttribute('href')));
    for (const h of [hrefs[0], hrefs[2]]) {
      await p.evaluate((u) => document.querySelector('#grid .pc[href="' + u + '"], .grid .pc[href="' + u + '"]') ? document.querySelector('.pc[href="' + u + '"]').click() : 0, h);
      await p.waitForSelector('#addq'); await p.click('#addq'); await p.waitForTimeout(150);
      await p.goBack(); await p.waitForSelector('#grid .pc'); await p.waitForTimeout(500);
    }
    await p.waitForTimeout(700);
    assert.equal(await p.evaluate(() => document.getElementById('qbar').classList.contains('on')), true);
    assert.equal(await p.evaluate(() => document.getElementById('qn').textContent), '2');
    const href = await p.evaluate(() => document.getElementById('qgo').href);
    assert.match(href, /^https:\/\/wa\.me\/254791598506\?text=/);
    const msg = decodeURIComponent(href.split('text=')[1]); assert.ok(msg.includes('/shop/'), 'links back to each item');
    await p.click('#qclr'); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => document.getElementById('qbar').classList.contains('on')), false);
    assert.deepEqual(errors, []); await ctx.close();
    const m = await page(browser, base, '/shop', { w: 390, h: 844 }); await m.p.waitForSelector('#grid .pc'); await m.p.waitForTimeout(500);
    assert.equal(await m.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'shop: no sideways scroll on a phone');
    assert.deepEqual(m.errors, []); await m.ctx.close();
  });
});

test('shop page cards still show with reduced motion', { skip, timeout: 60000 }, async () => {
  await withSite(async (browser, base) => {
    const { ctx, p } = await page(browser, base, '/shop', { reduced: true }); await p.waitForSelector('#grid .pc'); await p.waitForTimeout(300);
    assert.ok(await p.evaluate(() => Array.from(document.querySelectorAll('#grid .pc')).slice(0, 3).every((e) => +getComputedStyle(e).opacity === 1)));
    await ctx.close();
  });
});

test('routing: the apex serves /shop and its files from public-site; a client subdomain does not get the marketing page', async () => {
  const mw = await import(pathToFileURL(path.join(ROOT, 'functions/_middleware.js')).href);
  const seen = [];
  const env = { ROOT_DOMAIN: 'mydukapos.store', ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('x', { status: 200, headers: { 'Content-Type': 'text/html' } }); } } };
  const go = (u) => mw.onRequest({ request: new Request(u), env, next: async () => new Response('NEXT', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  await go('https://mydukapos.store/shop'); assert.equal(seen.pop(), '/public-site/shop.html');
  await go('https://mydukapos.store/shop-catalog.json'); assert.equal(seen.pop(), '/public-site/shop-catalog.json');
  await go('https://mydukapos.store/shop/p/some-item'); assert.equal(seen.pop(), '/public-site/shop.html');
  await go('https://mydukapos.store/premium.css'); assert.equal(seen.pop(), '/public-site/premium.css');
  await go('https://mydukapos.store/motion.js'); assert.equal(seen.pop(), '/public-site/motion.js');
  const r = await go('https://george.mydukapos.store/shop'); assert.equal(await r.text(), 'NEXT'); assert.equal(seen.length, 0, 'a client subdomain falls through untouched');
});
