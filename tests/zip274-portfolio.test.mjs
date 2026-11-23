// zip 274: the portfolio page (/portfolio). Served on the apex only, valid metadata and structured data, every link / anchor / image resolves,
// no invented claims, the inquiry form validates accessibly and posts to the site's existing /api/contact, the project filter works.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';
import * as mw from '../functions/_middleware.js';
import { sitemapEntries, APEX_PAGES } from '../functions/_site.js';

const html = fs.readFileSync(path.join(ROOT, 'public-site/portfolio.html'), 'utf8');
const dom = new JSDOM(html);
const d = dom.window.document;

test('routing: /portfolio is an apex page (served on mydukapos.store and www, never on a client subdomain), listed in the sitemap, counted by the page-hit list', async () => {
  assert.equal(APEX_PAGES['/portfolio'], 'portfolio');
  assert.ok(sitemapEntries().some((e) => e.path === '/portfolio'));
  const ASSETS = { fetch: async (req) => new Response('SERVED ' + new URL(req.url).pathname, { status: 200, headers: { 'Content-Type': 'text/html' } }) };
  const run = (url) => mw.onRequest({ request: new Request(url), env: { ROOT_DOMAIN: 'mydukapos.store', ASSETS }, next: async () => new Response('APP', { headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(await (await run('https://mydukapos.store/portfolio')).text(), 'SERVED /public-site/portfolio.html');
  assert.equal(await (await run('https://www.mydukapos.store/portfolio/')).text(), 'SERVED /public-site/portfolio.html');
  assert.equal(await (await run('https://george.mydukapos.store/portfolio')).text(), 'APP', 'a shop address gets its own app, not the portfolio');
  assert.match(fs.readFileSync(path.join(ROOT, 'functions/api/hit.js'), 'utf8'), /'\/portfolio'/);
});

test('metadata: one h1, unique title and description, absolute canonical / og / twitter, valid structured data that says only what is true', () => {
  assert.equal(d.querySelectorAll('h1').length, 1);
  const title = d.querySelector('title').textContent; assert.ok(title.length >= 30 && title.length <= 70, title);
  const desc = d.querySelector('meta[name=description]').content; assert.ok(desc.length >= 80 && desc.length <= 175, desc.length + ': ' + desc);
  assert.equal(d.querySelector('link[rel=canonical]').href, 'https://mydukapos.store/portfolio');
  assert.equal(d.querySelector('meta[property="og:url"]').content, 'https://mydukapos.store/portfolio');
  const og = d.querySelector('meta[property="og:image"]').content; assert.match(og, /^https:\/\/mydukapos\.store\/img\//);
  assert.ok(fs.existsSync(path.join(ROOT, 'public-site', og.replace('https://mydukapos.store/', ''))), 'the social image exists');
  assert.ok(d.querySelector('meta[name="twitter:title"]') && d.querySelector('meta[name="twitter:description"]'));
  const ld = JSON.parse(d.querySelector('script[type="application/ld+json"]').textContent);
  const types = ld['@graph'].map((x) => x['@type']);
  assert.deepEqual(types, ['Person', 'ProfessionalService', 'WebPage']);
  const person = ld['@graph'][0]; assert.equal(person.name, 'Samuel Mugwe Kamotho'); assert.equal(person.telephone, '+254113607529'); assert.equal(person.email, 'monarchdigitalkenya@gmail.com'); assert.equal(person.worksFor['@id'], ld['@graph'][1]['@id']);
  for (const k of ['aggregateRating', 'review', 'award', 'alumniOf', 'sameAs', 'image']) assert.ok(!JSON.stringify(ld).includes('"' + k + '"'), 'nothing invented: ' + k);
  assert.ok(d.documentElement.lang === 'en' && d.querySelector('a.skip[href="#main"]') && d.querySelector('main#main'));
  assert.ok(d.querySelector('nav a[href="/portfolio"][aria-current=page]'));
});

test('every internal link, anchor and image resolves; the portrait falls back gracefully when the photo is not there yet', () => {
  const known = new Set(['/', '/terms', '/privacy', '/contact', '/faq', ...Object.keys(APEX_PAGES)]);
  for (const a of d.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    if (/^(tel:\+254113607529|mailto:monarchdigitalkenya@gmail\.com)$/.test(h)) continue;
    if (/^https?:|^mailto:|^tel:/.test(h)) { assert.match(h, /^https:\/\/(wa\.me\/254791598506|richma-supplier\.pages\.dev\/$)/, 'only the existing WhatsApp number and the Richma Supplier site are linked externally: ' + h); if (!/wa\.me/.test(h)) assert.match(a.getAttribute('rel') || '', /noopener/); continue; }
    if (h.startsWith('#')) { assert.ok(d.getElementById(h.slice(1)), 'anchor target ' + h); continue; }
    const p = h.split('#')[0];
    assert.ok(known.has(p) || /^\/products\/(shop|hotel|hospital|production|pharmacy|services|water)$/.test(p), 'link ' + h);
  }
  for (const img of d.querySelectorAll('img')) {
    const src = img.getAttribute('src'), file = path.join(ROOT, 'public-site', src);
    assert.ok(img.getAttribute('alt') && img.getAttribute('width') && img.getAttribute('height'), 'alt + size: ' + src);
    if (src !== '/api/site-photo') { assert.ok(fs.existsSync(file), 'image exists: ' + src); assert.equal(img.getAttribute('loading'), 'lazy'); }
  }
  const portrait = d.getElementById('portrait-img');
  assert.match(portrait.getAttribute('onerror'), /hidden/); assert.ok(d.getElementById('portrait-mono'), 'a monogram shows until the photo exists');
  assert.equal(portrait.getAttribute('fetchpriority'), 'high');
});

test('honesty: no testimonials, ratings, awards, degrees, counters or unverifiable numbers', () => {
  const text = d.body.textContent.toLowerCase();
  for (const bad of ['testimonial', 'award', 'certified', 'degree', 'university', 'years of experience', '100%', 'clients served', 'guarantee', '5-star', 'five-star']) assert.ok(!text.includes(bad), 'must not claim: ' + bad);
  assert.match(text, /richma supplier/); assert.ok(d.querySelector('a[href="https://richma-supplier.pages.dev/"]'), 'the Richma card links to the live site'); assert.ok(!/0710915391|richardmaweu/i.test(html), "a client's own contact details are not copied onto this page");
});

async function page(fetchImpl) {
  const w = new JSDOM(html, { runScripts: 'dangerously', url: 'https://mydukapos.store/portfolio', beforeParse(win) { win.fetch = fetchImpl; win.navigator.sendBeacon = () => true; } }).window;
  return w;
}
const submit = (w) => w.document.getElementById('pf').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
const tick = (n = 5) => new Promise((r) => setTimeout(r, n));

test('form: empty / bad input shows accessible errors (aria-invalid, text, focus), sends nothing; a good one posts to /api/contact and confirms', async () => {
  const calls = [];
  const w = await page(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); });
  const doc = w.document;
  submit(w); await tick();
  assert.equal(calls.length, 0);
  assert.equal(doc.getElementById('pf-name').getAttribute('aria-invalid'), 'true'); assert.match(doc.getElementById('pf-name-e').textContent, /name/i);
  assert.match(doc.getElementById('pf-contact-e').textContent, /email or phone/i); assert.match(doc.getElementById('pf-msg-e').textContent, /tell me/i);
  assert.equal(doc.activeElement && doc.activeElement.id, 'pf-name', 'focus moves to the first problem');
  doc.getElementById('pf-name').value = 'Jane Wanjiru'; doc.getElementById('pf-contact').value = 'not-a-contact'; doc.getElementById('pf-msg').value = 'I need a website for my salon.';
  submit(w); await tick();
  assert.match(doc.getElementById('pf-contact-e').textContent, /does not look like/i); assert.equal(calls.length, 0);
  doc.getElementById('pf-contact').value = '0712 345 678'; doc.getElementById('pf-biz').value = 'Jane Salon'; doc.getElementById('pf-need').value = 'A website';
  doc.querySelector('input[name=via][value=Email]').checked = true;
  submit(w); await tick(20);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/contact');
  const b = calls[0].body;
  assert.equal(b.name, 'Jane Wanjiru'); assert.equal(b.contact, '0712 345 678'); assert.equal(b.website, ''); assert.ok(b.t > 0, 'the honeypot field and the page-open time travel with it');
  assert.match(b.message, /Portfolio enquiry\nBusiness: Jane Salon\nNeeds: A website\nPrefers: Email\n\nI need a website for my salon\./);
  assert.match(doc.getElementById('pf-out').textContent, /Thank you/); assert.ok(doc.getElementById('pf-out').classList.contains('ok'));
  assert.equal(doc.getElementById('pf-btn').disabled, false);
});

test('form: a server refusal (rate limit, bot check) is shown to the visitor, with the WhatsApp alternative, and the form keeps their text', async () => {
  const w = await page(async () => new Response('{"error":"Too many messages from your network. Please try again later or WhatsApp us."}', { status: 429 }));
  const doc = w.document;
  doc.getElementById('pf-name').value = 'A'; doc.getElementById('pf-contact').value = 'a@b.co'; doc.getElementById('pf-msg').value = 'Please call me about a shop system.';
  submit(w); await tick(20);
  const out = doc.getElementById('pf-out'); assert.ok(out.classList.contains('bad')); assert.match(out.textContent, /Too many messages/); assert.match(out.textContent, /WhatsApp/);
  assert.equal(doc.getElementById('pf-msg').value, 'Please call me about a shop system.');
});

test('filters: each category shows only its projects, All restores them, aria-pressed follows', async () => {
  const w = await page(async () => new Response('{}'));
  const doc = w.document, btn = (f) => doc.querySelector(`.filters button[data-f="${f}"]`), visible = () => [...doc.querySelectorAll('#projects .proj')].filter((c) => !c.hidden).map((c) => c.querySelector('h3').textContent);
  assert.equal(visible().length, 5);
  btn('ecommerce').click(); assert.deepEqual(visible(), ['Richma Supplier']); assert.equal(btn('ecommerce').getAttribute('aria-pressed'), 'true'); assert.equal(btn('all').getAttribute('aria-pressed'), 'false');
  btn('integrations').click(); assert.deepEqual(visible(), ['M-PESA, payments and eTIMS in MyDukaPOS']);
  btn('software').click(); assert.deepEqual(visible(), ['MyDukaPOS', 'M-PESA, payments and eTIMS in MyDukaPOS', 'Custom business systems']);
  btn('all').click(); assert.equal(visible().length, 5);
});

test('the rest of the public site links to it', () => {
  for (const f of ['index', 'shop', 'faq', 'contact', 'offers', 'terms', 'privacy']) assert.match(fs.readFileSync(path.join(ROOT, 'public-site', f + '.html'), 'utf8'), /href="\/portfolio"/, f);
});
