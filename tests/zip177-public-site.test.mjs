import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, APPS } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const R = (url, o = {}) => new Request(url, o);
const post = (url, body, headers = {}) => R(url, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers }, body: JSON.stringify(body) });
const APEX = 'https://mydukapos.store';

// ---------- password hashing ----------
test('passwords: PBKDF2 hash verifies, an old one-round SHA-256 record verifies and is upgraded on login, weak ones are refused', async () => {
  const pw = await load('functions/api/_password.js');
  const h = await pw.hashPassword('correct horse 9');
  assert.match(h.passwordHash, /^p2\$100000\$/);
  assert.ok(await pw.checkPassword(h, 'correct horse 9'));
  assert.ok(!(await pw.checkPassword(h, 'correct horse 8')));
  const salt = 'abc', legacy = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + 'oldpass99'))).toString('hex');
  const rec = { salt, passwordHash: legacy };
  assert.ok(await pw.checkPassword(rec, 'oldpass99'), 'legacy still signs in');
  const up = await pw.upgradeOnLogin(rec, 'oldpass99');
  assert.match(up.passwordHash, /^p2\$/, 'upgraded');
  assert.ok(pw.passwordProblem('short1'));
  assert.ok(pw.passwordProblem('password'));
  assert.ok(pw.passwordProblem('aaaaaaaaaa'));
  assert.equal(pw.passwordProblem('Tr1cky-pass'), '');
});

// ---------- website sign-up: terms + strong password ----------
test('website sign-up needs the Terms ticked and an 8+ character password; the consent is recorded; login works', async () => {
  const da = await load('functions/api/demo-account.js');
  const env = { mydukapos_kv: makeKV() };
  const reg = (o) => da.onRequestPost({ request: post(APEX + '/api/demo-account', { action: 'register', channel: 'website', fullName: 'A B', phone: '0712345678', email: 'ab@example.com', password: 'Tr1cky-pass', confirmPassword: 'Tr1cky-pass', ...o }), env });
  let r = await reg({}); assert.equal(r.status, 400); assert.equal((await r.json()).code, 'terms_required');
  r = await reg({ acceptTerms: true, password: 'abc12', confirmPassword: 'abc12' }); assert.equal(r.status, 400, 'too short for the website');
  r = await reg({ acceptTerms: true }); assert.equal(r.status, 200, await r.clone().text());
  const acct = JSON.parse(env.mydukapos_kv.data.get('demo-account:ab@example.com').value);
  assert.ok(acct.terms && acct.terms.termsVersion && acct.terms.acceptedAt, 'consent recorded'); assert.match(acct.passwordHash, /^p2\$/);
  assert.ok(!JSON.stringify(acct.terms).includes('1.1.1.1'), 'raw IP is not stored');
  const l = await da.onRequestPost({ request: post(APEX + '/api/demo-account', { action: 'login', email: 'ab@example.com', password: 'Tr1cky-pass' }), env });
  assert.equal(l.status, 200);
});

// ---------- offers ----------
test('offers: only published offers inside their window are public, judged by the server clock; owner actions need the owner', async () => {
  const of = await load('functions/api/offers.js'), oa = await load('functions/api/_owner-auth.js');
  const env = { mydukapos_kv: makeKV() };
  await oa.createOwnerAccount(env, 'o@x.ke', 'owner-pass-1');
  const tok = await oa.createOwnerSession(env, await oa.getOwnerAccount(env));
  const call = (b, auth = true) => of.onRequestPost({ request: post(APEX + '/api/offers', b, auth ? { Authorization: 'Bearer ' + tok } : {}), env, ...{} });
  assert.equal((await call({ action: 'list' }, false)).status, 401);
  const now = Date.now();
  const save = async (o) => (await (await call({ action: 'save', offer: o })).json()).offers.slice(-1)[0];
  const a = await save({ title: 'Active', startsAt: now - 1000, endsAt: now + 3600e3 });
  const f = await save({ title: 'Future', startsAt: now + 3600e3, endsAt: now + 7200e3 });
  const e = await save({ title: 'Ended', startsAt: now - 7200e3, endsAt: now - 3600e3 });
  const n = await save({ title: 'NoEnd' });
  assert.equal((await (await call({ action: 'state', id: n.id, state: 'published' })).json()).error.length > 0, true, 'cannot publish without an end');
  for (const o of [a, f, e]) assert.equal((await call({ action: 'state', id: o.id, state: 'published' })).status, 200);
  const pub = await (await of.onRequestGet({ env })).json();
  assert.deepEqual(pub.offers.map((o) => o.title), ['Active']);
  assert.ok(Math.abs(pub.now - Date.now()) < 5000, 'server time is returned');
  const all = await (await call({ action: 'list' })).json();
  assert.deepEqual(Object.fromEntries(all.offers.map((o) => [o.title, o.status])), { Active: 'active', Future: 'scheduled', Ended: 'expired', NoEnd: 'draft' });
  await call({ action: 'state', id: a.id, state: 'paused' });
  assert.equal((await (await of.onRequestGet({ env })).json()).offers.length, 0, 'paused is hidden');
  assert.ok(all.audit.length >= 4 || (await (await call({ action: 'list' })).json()).audit.length >= 4, 'changes are logged');
  const bad = await save({ title: 'Evil', ctaUrl: 'javascript:alert(1)', endsAt: now + 1000 });
  assert.equal(bad.ctaUrl, '/', 'unsafe links are dropped');
});

// ---------- contact form ----------
test('contact form: valid message is stored, honeypot and too-fast posts store nothing, per-IP limit applies', async () => {
  const c = await load('functions/api/contact.js');
  const env = { mydukapos_kv: makeKV(), CONTACT_HOURLY_LIMIT: '3' };
  const send = (b, ip = '5.5.5.5') => c.onRequestPost({ request: post(APEX + '/api/contact', b, { 'CF-Connecting-IP': ip }), env });
  const good = { name: 'Ann', contact: 'ann@x.ke', message: 'Hello there', website: '', t: Date.now() - 10000 };
  assert.equal((await send(good)).status, 200);
  const stored = () => [...env.mydukapos_kv.data.keys()].filter((k) => k.startsWith('contact-msg:')).length;
  assert.equal(stored(), 1);
  await send({ ...good, website: 'http://spam' }); assert.equal(stored(), 1, 'honeypot');
  await send({ ...good, t: Date.now() }); assert.equal(stored(), 1, 'too fast');
  assert.equal((await send({ ...good, message: 'x' })).status, 400);
  await send(good); await send(good);
  assert.equal((await send(good)).status, 429, 'limit reached');
  assert.equal((await send(good, '6.6.6.6')).status, 200, 'another IP is fine');
});

// ---------- OTP verification ----------
test('verification: email code works once, wrong codes are counted and locked, resend cooldown, unavailable channel is honest', async () => {
  const v = await load('functions/api/verify.js'), da = await load('functions/api/demo-account.js');
  const env = { mydukapos_kv: makeKV() };
  const reg = await da.onRequestPost({ request: post(APEX + '/api/demo-account', { action: 'register', channel: 'website', acceptTerms: true, fullName: 'V W', phone: '+254712345678', email: 'vw@example.com', password: 'Tr1cky-pass', confirmPassword: 'Tr1cky-pass' }), env });
  const token = (await reg.json()).token; assert.ok(token);
  const call = (b) => v.onRequestPost({ request: post(APEX + '/api/verify', { token, ...b }), env });
  let r = await call({ action: 'send', channel: 'email' });
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'channel_unavailable', 'no e-mail provider configured -> honest 503');
  r = await call({ action: 'send', channel: 'whatsapp' }); assert.equal(r.status, 503);
  // configure providers and mock their HTTP
  env.mydukapos_kv.data.set('email-config:v1', { value: JSON.stringify({ resendApiKey: 're_x' }) });
  const ec = await import(pathToFileURL(path.join(ROOT, 'functions/api/email-config.js')).href);
  let sentCode = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); sentCode = (b.html || '').match(/>(\d{6})</)?.[1] || null; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const cfg = await ec.getEmailConfig(env);
    assert.ok(cfg.resendApiKey, 'e-mail provider configured for the rest of this test');
    r = await call({ action: 'send', channel: 'email' }); assert.equal(r.status, 200); assert.ok(sentCode, 'code sent');
    assert.equal((await call({ action: 'send', channel: 'email' })).status, 429, 'cooldown');
    for (let i = 0; i < 5; i++) assert.equal((await call({ action: 'check', channel: 'email', code: '000000' })).status, 400);
    assert.equal((await call({ action: 'check', channel: 'email', code: sentCode })).status, 429, 'locked after 5 wrong tries');
  } finally { globalThis.fetch = realFetch; }
});

test('verification: phone numbers are normalised for WhatsApp, and VERIFICATION_REQUIRED is off by default', async () => {
  const v = await load('functions/api/verify.js');
  assert.equal(v.toIntlPhone('0712 345 678'), '254712345678');
  assert.equal(v.toIntlPhone('+254112345678'), '254112345678');
  assert.equal(v.toIntlPhone('12345'), '');
  assert.equal(v.verificationRequired({}), false);
  assert.equal(v.verificationRequired({ VERIFICATION_REQUIRED: '1' }), true);
});

// ---------- crawl / SEO ----------
test('robots.txt, sitemap.xml and llms.txt: apex is open, a client host is closed', async () => {
  const rb = await load('functions/robots.txt.js'), sm = await load('functions/sitemap.xml.js'), ll = await load('functions/llms.txt.js');
  const env = { ROOT_DOMAIN: 'mydukapos.store' };
  const apex = await (await rb.onRequestGet({ request: R(APEX + '/robots.txt'), env })).text();
  assert.match(apex, /Allow: \//); assert.match(apex, /Disallow: \/api\//); assert.match(apex, /Sitemap: https:\/\/mydukapos\.store\/sitemap\.xml/);
  const shop = await (await rb.onRequestGet({ request: R('https://george.mydukapos.store/robots.txt'), env })).text();
  assert.match(shop, /Disallow: \/\n/); assert.doesNotMatch(shop, /Allow/);
  const xml = await (await sm.onRequestGet({ request: R(APEX + '/sitemap.xml'), env })).text();
  for (const p of ['/', '/offers', '/faq', '/contact', '/terms', '/privacy', '/products/shop']) assert.ok(xml.includes(`<loc>${APEX}${p}</loc>`), p);
  assert.ok(!xml.includes('/owner') && !xml.includes('/dashboard'), 'private pages are not listed');
  assert.equal((await ll.onRequestGet({ request: R('https://george.mydukapos.store/llms.txt'), env })).status, 404);
  assert.match(await (await ll.onRequestGet({ request: R(APEX + '/llms.txt'), env })).text(), /Pharmacy POS/);
});

test('every private app page carries a noindex meta tag and the security headers file covers them', () => {
  for (const f of [...APPS, 'crm/index.html', 'order/index.html']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8').slice(0, 3000), /<meta name="robots" content="noindex, nofollow">/, f);
  const h = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  for (const x of ['X-Content-Type-Options: nosniff', 'Referrer-Policy', 'X-Robots-Tag: noindex', '/owner/*', '/crm/*']) assert.ok(h.includes(x), x);
});

test('generated public pages match the generator (run `npm run build:public` if this fails)', async () => {
  const { buildAll } = await load('tools/build-public-pages.mjs');
  for (const [f, html] of Object.entries(buildAll())) assert.equal(fs.readFileSync(path.join(ROOT, f), 'utf8'), html, f + ' is out of date');
});

test('public pages: one h1, a title, a description, canonical, skip link, labelled form fields, no placeholder text', () => {
  for (const p of ['terms', 'privacy', 'cookies', 'acceptable-use', 'faq', 'contact', 'offers']) {
    const h = fs.readFileSync(path.join(ROOT, `public-site/${p}.html`), 'utf8');
    assert.equal((h.match(/<h1[ >]/g) || []).length, 1, p + ' h1');
    for (const re of [/<title>[^<]{5,}<\/title>/, /<meta name="description" content="[^"]{10,}"/, /rel="canonical"/, /class="skip"/, /lang="en"/]) assert.match(h, re, p);
    assert.doesNotMatch(h, /lorem ipsum|TODO|\[company|\[address/i, p);
  }
  const c = fs.readFileSync(path.join(ROOT, 'public-site/contact.html'), 'utf8');
  for (const id of ['cf-name', 'cf-contact', 'cf-msg']) assert.match(c, new RegExp(`<label for="${id}"`));
});

test('the sign-up form on the public site asks for Terms consent and a strong password; the dashboard keeps the sign-in when offline', () => {
  const a = fs.readFileSync(path.join(ROOT, 'public-site/app.html'), 'utf8'), d = fs.readFileSync(path.join(ROOT, 'public-site/dashboard.html'), 'utf8');
  assert.match(a, /id="demo-accept-terms"/); assert.match(a, /acceptTerms: true/); assert.match(a, /channel: 'website'/); assert.match(a, /<!--@seo-->/);
  assert.doesNotMatch(a, /href="dashboard\.html"|href="app\.html/, 'links are absolute so /products/<key> works');
  assert.match(d, /e instanceof TypeError/); assert.match(d, /Your sign-in is kept/);
  const i = fs.readFileSync(path.join(ROOT, 'public-site/index.html'), 'utf8');
  for (const x of ['href="/terms"', 'href="/privacy"', 'rel="canonical"', 'application/ld+json', 'id="proof-fees"']) assert.ok(i.includes(x), x);
});

test('analytics: only known public paths are counted per day, nothing personal is stored, and the report is owner-only', async () => {
  const hit = await load('functions/api/hit.js'), oa = await load('functions/api/_owner-auth.js');
  const env = { mydukapos_kv: makeKV() };
  for (const p of ['/', '/', '/faq', '/evil/../x', '/products/shop']) await hit.onRequestPost({ request: post(APEX + '/api/hit', { path: p }), env });
  await oa.createOwnerAccount(env, 'o@x.ke', 'owner-pass-1');
  const tok = await oa.createOwnerSession(env, await oa.getOwnerAccount(env));
  const rep = await (await hit.onRequestPost({ request: post(APEX + '/api/hit', { action: 'report' }, { Authorization: 'Bearer ' + tok }), env })).json();
  assert.deepEqual(Object.values(rep.days)[0], { '/': 2, '/faq': 1, '/products/shop': 1 });
  assert.ok(![...env.mydukapos_kv.data.values()].some((v) => String(v.value).includes('1.1.1.1')), 'no IP stored');
  assert.equal((await hit.onRequestPost({ request: post(APEX + '/api/hit', { action: 'report' }), env })).status, 401);
});
