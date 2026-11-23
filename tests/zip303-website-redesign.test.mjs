import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
test('home: required copy, CTAs, nav item, demo labelled, hero ids kept', () => {
  const h = r('public-site/index.html');
  for (const x of ['A POS built for the way', 'Kenyan businesses work.', 'Manage sales, stock, receipts and business records in one place.', 'Try a Live Demo', 'Explore Business Solutions', 'Your Business Deserves a ', 'Website This Good.', 'Get a Website for My Business', 'View Our Website Portfolio', 'href="/websites"', 'Interactive demonstration', 'id="hero-headline"', 'id="hero-subhead"', 'rel="canonical"', '/home-pro.js']) assert.ok(h.includes(x), x);
});
test('websites page: form fields, honeypot, time guard, canonical, no invented contact data', () => {
  const w = r('public-site/websites.html');
  for (const x of ['id="wd-name"', 'id="wd-biz"', 'name="method"', 'id="wd-type"', 'id="wd-msg"', 'name="website"', 'T0=Date.now()', 't:T0', "'/api/contact'", 'https://mydukapos.store/websites', 'aria-invalid', 'role="status"']) assert.ok(w.includes(x), x);
  assert.match(w, /<title>[^<]*MyDukaPOS/); assert.doesNotMatch(w, /testimonial/i);
  assert.ok((w.match(/wa\.me\/(\d+)/g) || []).every((m) => m.endsWith('254791598506')));
});
test('contact form sends its page-open time (not submit time)', () => { const c = r('public-site/contact.html'); assert.ok(c.includes('t:T0') && !c.includes('t:Date.now()')); });
test('routing and sitemap know /websites; motion respects reduced motion', () => {
  const s = r('functions/_site.js'); assert.ok(s.includes("'/websites'") && /home-pro/.test(s));
  assert.match(r('public-site/home-pro.css'), /prefers-reduced-motion/); assert.match(r('public-site/home-pro.js'), /prefers-reduced-motion/);
});
