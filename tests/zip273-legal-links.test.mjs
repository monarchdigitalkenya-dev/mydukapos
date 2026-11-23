// zip 273: Terms and Privacy always resolve to the ONE canonical copy on the main domain, from every app and every host; the public pages carry
// absolute canonical / og URLs in the HTML itself; legal pages on a client's own subdomain redirect to the apex; private pages are noindex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';
import * as mw from '../functions/_middleware.js';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html', 'owner/index.html'];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('no app links Terms or Privacy with a relative path; every legal link is absolute and marked data-legal', () => {
  for (const f of APPS) {
    const h = read(f);
    assert.ok(!/href="\/(terms|privacy|cookies|acceptable-use)"/.test(h), f + ': a relative legal link is left');
    assert.ok(h.includes('@shared-block:legal-links:begin'), f + ': the legal-links block is present');
  }
  for (const f of APPS.filter((x) => x !== 'owner/index.html')) assert.match(read(f), /<a href="https:\/\/mydukapos\.store\/terms" data-legal="\/terms"/, f + ': sign-up consent link');
});

test('lock screen, sign-in and owner sign-in show Terms and Privacy; on a shop subdomain they point at the apex, on a preview at that origin', async () => {
  for (const [url, expected] of [['https://shop1.mydukapos.store/', 'https://mydukapos.store'], ['https://preview.mydukapos.pages.dev/', 'https://preview.mydukapos.pages.dev'], ['https://mydukapos.store/', 'https://mydukapos.store']]) {
    for (const app of ['index.html', 'hotel/index.html', 'owner/index.html']) {
      const b = await boot(app, { url, wait: 200 });
      try {
        const d = b.d;
        const screens = app === 'owner/index.html' ? ['#license-lock-screen', '#owner-auth-screen', '#login-screen'] : ['#license-lock-screen', '#login-screen'];
        for (const sel of screens) {
          const a = d.querySelector(sel + ' .legal-foot a[data-legal="/terms"]'), p = d.querySelector(sel + ' .legal-foot a[data-legal="/privacy"]');
          assert.ok(a && p, `${app} ${sel} has the links`);
          assert.equal(a.href, expected + '/terms', `${app} ${sel} on ${url}`); assert.equal(p.href, expected + '/privacy');
        }
        const consent = d.querySelector('#signup-terms-row a[data-legal="/terms"]');
        if (consent) assert.equal(consent.href, expected + '/terms');
      } finally { b.close(); }
    }
  }
});

const ASSETS = { fetch: async (req) => { const p = new URL(req.url).pathname; return new Response(p === '/public-site/app.html' ? read('public-site/app.html') : 'PAGE ' + p, { status: 200, headers: { 'Content-Type': 'text/html' } }); } };
const run = (url, extra = {}) => mw.onRequest({ request: new Request(url), env: { ROOT_DOMAIN: 'mydukapos.store', ASSETS, ...extra }, next: async () => new Response('APP', { status: 200, headers: { 'Content-Type': 'text/html' } }) });

test('legal pages: the apex serves them, a client subdomain redirects (301) to the apex, a preview and localhost still serve', async () => {
  for (const p of ['/terms', '/privacy', '/cookies', '/acceptable-use']) {
    const apex = await run('https://mydukapos.store' + p); assert.equal(apex.status, 200);
    const www = await run('https://www.mydukapos.store' + p); assert.equal(www.status, 200);
    const shop = await run('https://georgehardware.mydukapos.store' + p);
    assert.equal(shop.status, 301); assert.equal(shop.headers.get('Location'), 'https://mydukapos.store' + p);
    assert.equal((await run('https://preview-1.mydukapos.pages.dev' + p)).status, 200);
    assert.equal((await run('http://localhost:8788' + p)).status, 200);
  }
  const custom = await run('https://shop.example.co.ke/terms', { ROOT_DOMAIN: 'example.co.ke' });
  assert.equal(custom.headers.get('Location'), 'https://example.co.ke/terms', 'the canonical origin follows ROOT_DOMAIN');
});

test('public pages: canonical, og:url and og:image are absolute in the HTML; no script is needed to fix them; product pages have one description', async () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public-site')).filter((x) => /^(index|faq|contact|offers|terms|privacy|cookies|acceptable-use|shop)\.html$/.test(x))) {
    const h = read('public-site/' + f);
    assert.match(h, /<link rel="canonical" href="https:\/\/mydukapos\.store\/[^"]*">/, f + ' canonical');
    assert.match(h, /og:image" content="https:\/\/mydukapos\.store\/img\/og-default\.png"/, f + ' og:image');
    assert.ok(!/data-canonical|data-abs/.test(h), f + ': no script rewriting of canonical / og');
  }
  const res = await run('https://www.mydukapos.store/products/hotel', { ROOT_DOMAIN: 'mydukapos.store' });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal((html.match(/<meta name="description"/g) || []).length, 1, 'one description');
  assert.match(html, /<link rel="canonical" href="https:\/\/mydukapos\.store\/products\/hotel">/, 'canonical is the production apex even when served from www');
  assert.match(html, /twitter:title/); assert.match(html, /og:image" content="https:\/\/mydukapos\.store\/img\/og-default\.png"/);
});

test('private pages are noindex (meta or header): pesapal-done, dashboard, pay pages', () => {
  assert.match(read('pesapal-done.html'), /name="robots" content="noindex/);
  const headers = read('_headers');
  for (const p of ['/dashboard.html', '/pesapal-done.html', '/pay/*']) assert.ok(new RegExp('^' + p.replace(/[*.]/g, '\\$&') + '\\n  X-Robots-Tag: noindex', 'm').test(headers), p);
});
