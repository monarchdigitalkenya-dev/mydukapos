import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// zip 307: the public site says only what the product really does. These tests pin the trust fixes so they cannot quietly come back.
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PUBLIC = ['index.html', 'app.html', 'faq.html', 'offers.html', 'shop.html', 'websites.html', 'portfolio.html', 'contact.html', 'terms.html'].map((f) => 'public-site/' + f);
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, (m) => (/PRODUCTS = \{/.test(m) ? m : '')).replace(/<style[\s\S]*?<\/style>/g, '');

test('no unsupported claims anywhere on the public site (KRA compliance, real-time eTIMS, "M-Pesa built in", unlimited, forever, no lock-out)', () => {
  const banned = [/KRA[- ]compliant/i, /eTIMS[- ]compliant/i, /submit to (KRA|eTIMS) in real time/i, /signature (shown|right there) on the receipt/i, /M-Pesa built in/i, /STK push built in/i,
    /Never loses a sale/i, /Unlimited (receipts|branches|staff)/i, /[∞]/, /Keep it forever/i, /YOURS FOR GOOD/i, /no (surprise )?lock-?out/i, /No monthly fee, no renewal/i, /Payment\. Ever\./i, /set up and tested (with MyDukaPOS )?before/i];
  for (const f of PUBLIC) {
    const t = visible(r(f));
    for (const b of banned) assert.doesNotMatch(t, b, f + ' still says ' + b);
  }
  assert.doesNotMatch(r('functions/_site.js'), /KRA eTIMS, working offline/);
});

test('the home page states the verified status of eTIMS, M-Pesa STK Push and offline, beside the features', () => {
  const h = r('public-site/index.html');
  for (const x of ['organises your sales and tax records for review and manual reporting', 'not official KRA returns or eTIMS invoices', 'needs your business\'s own KRA approval and setup',
    'Automatic M-Pesa prompts (STK Push) work once your own M-Pesa or payment-gateway account is set up', 'a sale is marked paid only when the provider confirms', 'Provider setup needed for STK Push',
    'Works without internet', 'Needs internet', 'When you are back online', 'Do not clear the browser\'s data', 'id="offline"']) assert.ok(h.includes(x), x);
  const app = r('public-site/app.html');
  assert.ok(app.includes("['M-Pesa at checkout'") && app.includes('Tax records for review') && app.includes('Once your M-Pesa till is connected'));
  const faq = r('public-site/faq.html');
  for (const x of ['Does MyDuka submit sales to KRA eTIMS?', 'Can customers pay by M-Pesa?', 'What does the price include?']) assert.ok(faq.includes(x), x);
});

test('pricing: one section, figures from /api/billing-terms, conditions beside the price, no invented promises', () => {
  const h = r('public-site/index.html');
  assert.equal((h.match(/id="pricing"/g) || []).length, 1, 'one pricing section');
  for (const x of ["fetch('/api/billing-terms')", 'What you get', 'Ongoing costs and limits', 'Not included', 'How you get it', 'Hardware (printers, scanners, terminals) is sold separately', 'KRA eTIMS approval', 'Get my own link',
    'paused until the renewal is paid', 'Each extra branch is its own link, at the same one-time price']) assert.ok(h.includes(x), x);
  assert.doesNotMatch(h, /id="testi-grid"[^>]*>\s*<div class="testi-card/, 'no testimonial is in the page itself');
  assert.match(r('public-site/app.html'), /fetch\('\/api\/billing-terms'\)/);
});

test('testimonials: none built in; only ones the owner marks genuine are kept as such, and only those are shown (no stars)', async () => {
  const wc = r('functions/api/website-content.js');
  assert.match(wc, /testimonials: \[\],/);
  assert.doesNotMatch(wc, /Grace Wambui|Peter Otieno|Dorcas Achieng/);
  assert.match(wc, /verified: t\.verified === true/);
  const h = r('public-site/index.html');
  assert.match(h, /t\.verified === true/); assert.doesNotMatch(h, /★★★★★/);
  assert.match(r('owner/index.html'), /A real customer said this and agreed to it being published/);
});

test('offer countdown: only for a real end date, with the date and Nairobi time zone, gone when it ends', () => {
  const h = r('public-site/index.html');
  assert.match(h, /if\(end&&end<=Date\.now\(\)\+skew\)return/);
  assert.match(h, /timeZone:'Africa\/Nairobi'/); assert.match(h, /\(Nairobi time\)/);
});

test('demo cards: sample data said plainly, the password each demo really uses, a working copy button, honest notes', () => {
  const h = r('public-site/index.html');
  for (const x of ['Sample data only.', 'Your changes stay on your device.', 'No money moves.', "x.password||'0000'", 'Copy password', 'data-ev="demo_open"', "fetch('/api/shared-demos')"]) assert.ok(h.includes(x), x);
  const sd = r('functions/api/_shared-demos.js');
  assert.match(sd, /password: '0000'/, 'the shared demos do use 0000');
});

test('journey counts: only named events, a number per day, nothing about the visitor; purchases counted by the server when they happen', async () => {
  const hit = await import(pathToFileURL(path.join(ROOT, 'functions/api/hit.js')).href);
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const post = (b) => hit.onRequestPost({ request: new Request('https://x/api/hit', { method: 'POST', body: JSON.stringify(b) }), env });
  await post({ event: 'demo_open' }); await post({ event: 'demo_open' }); await post({ event: 'pw_copy' }); await post({ event: 'purchase_done' }); await post({ event: '<x>' });
  const keys = [...kv.data.keys()];
  assert.equal(keys.filter((k) => k.endsWith(':#demo_open')).length, 1);
  assert.equal(kv.data.get(keys.find((k) => k.endsWith(':#demo_open'))).value, '2');
  assert.ok(keys.some((k) => k.endsWith(':#pw_copy')));
  assert.ok(!keys.some((k) => /purchase_done|<x>/.test(k)), 'a browser cannot invent events, and never a purchase');
  const gml = r('functions/api/get-my-link.js');
  assert.match(gml, /countEvent\(env, 'link_created'\)/); assert.match(gml, /countEvent\(env, 'link_start'\)/);
});

test('licence certificate: reassuring and true, not alarming', () => {
  const pdf = r('functions/api/_licence-pdf.js');
  assert.doesNotMatch(pdf, /text\([^\n]*Anyone with the link can open the shop/, 'the warning is no longer printed');
  assert.match(pdf, /Your data is safe: it travels over a secure connection, is stored encrypted and is backed up regularly\./);
});

test('every internal link on the home page goes somewhere that exists', () => {
  const h = r('public-site/index.html');
  const ids = new Set([...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const routes = new Set(['/', '/shop', '/offers', '/faq', '/contact', '/websites', '/portfolio', '/terms', '/privacy', '/cookies', '/acceptable-use', '/dashboard.html']);
  for (const [, href] of h.matchAll(/href="([^"]+)"/g)) {
    if (/^(https?:|data:|\/\/)/.test(href) || href.includes("'")) continue;
    if (href.startsWith('#')) { assert.ok(ids.has(href.slice(1)), 'anchor ' + href); continue; }
    const p = href.split('?')[0].split('#')[0];
    if (/^\/products\/(shop|hotel|hospital|production|pharmacy|services|water|carwash)$/.test(p) || routes.has(p)) continue;
    assert.ok(fs.existsSync(path.join(ROOT, 'public-site', p)) || fs.existsSync(path.join(ROOT, p)), 'file ' + href);
  }
});

// ---- in a real browser: the page with the server's answers (mocked), on a phone and a desktop ----
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire('/opt/npm-tools/node_modules/')('playwright').chromium; } catch (e2) { chromium = null; }
}
function site(terms, content) {
  const root = path.join(ROOT, 'public-site');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const demos = ['retail', 'pharmacy'].map((k) => ({ key: k, title: k + ' demo', tag: 'Retail', blurb: 'Sample.', image: '/img/card-shop-640.webp', openUrl: 'https://demo-' + k + '.mydukapos.store/', password: '0000' }));
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/api/shared-demos') return j({ demos });
    if (u.pathname === '/api/billing-terms') return j({ terms });
    if (u.pathname === '/api/website-content') return j({ content });
    if (u.pathname.startsWith('/api/')) { res.writeHead(204); return res.end(); }
    let p = u.pathname === '/' ? '/index.html' : u.pathname; const f = path.join(root, p);
    if (!fs.existsSync(f) || !f.startsWith(root)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ base: 'http://127.0.0.1:' + srv.address().port, close: () => { try { srv.closeAllConnections(); } catch (e) { /* older Node */ } srv.close(); } })));
}
const LIVE_TERMS = { currency: 'KES', link: 3000, linkPrices: { hospital: 5000 }, launched: true, launchAt: 1, subscription: { amount: 400, periodDays: 31, graceDays: 3, includedBranches: 3, includedStaffPerBranch: 5, firstPeriodIncluded: true }, addons: { extraBranch: { amount: 1000, qty: 1 }, branchBundle: { amount: 3000, qty: 3 }, staffBlock: { amount: 500, qty: 5 } } };
const CONTENT = { price: 3000, visibleProducts: ['shop', 'hotel', 'hospital', 'production', 'pharmacy', 'services', 'water'], testimonials: [{ quote: 'Made up', name: 'Nobody', role: 'x' }, { quote: 'Real words', name: 'Real Owner', role: 'Shop, Nakuru', verified: true }] };

test('browser: pricing shows the subscription, limits and add-ons the checkout really uses; only the genuine testimonial appears; phone and desktop fit', { skip: !chromium, timeout: 120000 }, async () => {
  const s = await site(LIVE_TERMS, CONTENT);
  const b = await chromium.launch();
  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1366, height: 860 }]) {
      const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(s.base + '/', { waitUntil: 'load' }); await p.waitForTimeout(900);
      const t = await p.evaluate(() => ({ sub: document.getElementById('price-subscription').textContent, lim: document.getElementById('price-limits').textContent, ongoing: document.getElementById('price-ongoing').textContent, per: document.getElementById('price-per-product').textContent, badge: document.getElementById('price-badge').textContent, amt: document.getElementById('price-amount').textContent,
        testi: document.getElementById('testimonials').hidden, quotes: [...document.querySelectorAll('#testi-grid .testi-quote')].map((x) => x.textContent), overflow: document.documentElement.scrollWidth > innerWidth, demos: document.querySelectorAll('#demo-gallery .dg-card').length }));
      assert.match(t.sub, /KES 400 every 31 days/); assert.match(t.sub, /3 more days/); assert.match(t.sub, /paused until the renewal is paid/);
      assert.match(t.lim, /3 branches/); assert.match(t.lim, /5 staff logins per branch/);
      assert.match(t.ongoing, /extra branch KES 1,000/);
      assert.match(t.per, /Hospital KES 5,000/); assert.match(t.badge, /from/); assert.equal(t.amt, '3,000');
      assert.equal(t.testi, false); assert.deepEqual(t.quotes, ['Real words'], 'the unticked testimonial is not shown');
      assert.equal(t.overflow, false, 'no sideways scroll at ' + vp.width); assert.equal(t.demos, 2);
      assert.deepEqual(errs, []);
      await ctx.close();
    }
    // billing not live: no subscription is claimed, and nothing says "never"
    s.close();
    const s2 = await site({ currency: 'KES', link: 3000, linkPrices: {}, launched: false, launchAt: 0, subscription: null, addons: {} }, { ...CONTENT, testimonials: [] });
    const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] }); const p = await ctx.newPage();
    await p.goto(s2.base + '/', { waitUntil: 'load' }); await p.waitForTimeout(900);
    assert.equal(await p.textContent('#price-subscription'), 'No subscription is charged at the moment.');
    assert.equal(await p.evaluate(() => document.getElementById('testimonials').hidden), true, 'no genuine testimonial -> no testimonial section');
    // the copy button copies the demo password, and the skip link reaches the content
    await p.click('#demo-gallery .dg-login button');
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), '0000');
    await p.goto(s2.base + '/', { waitUntil: 'load' });
    await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => document.activeElement.className), 'h7-skip', 'the first Tab reaches "Skip to content"');
    await ctx.close(); s2.close();
  } finally { await b.close(); }
});
