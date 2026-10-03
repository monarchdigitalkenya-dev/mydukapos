import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';

// Zip 185 — public website: image addresses from the editable content cannot break out of an attribute, the page counter cannot be used to create
// unlimited keys, the contact form keeps line breaks out of the e-mail subject.
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('app.html safeImgSrc: real images pass, attribute break-outs and script addresses are dropped', () => {
  const src = read('public-site/app.html');
  const m = src.match(/function safeImgSrc\(u\) \{[\s\S]*?\n    \}/);
  assert.ok(m, 'helper present');
  const safe = vm.runInNewContext('(' + m[0].replace(/^function safeImgSrc/, 'function') + ')');
  assert.equal(safe('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.equal(safe('img/shot-aquapos-sales-counter.jpg'), 'img/shot-aquapos-sales-counter.jpg');
  assert.equal(safe('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(safe('data:image/png" onerror="alert(1)'), '');
  assert.equal(safe('data:image/svg+xml;base64,AAAA" onload="x'), '');
  assert.equal(safe('javascript:alert(1)'), '');
  assert.equal(safe('https://x.com/a" onerror="alert(1)'), '');
  assert.equal(safe(null), '');
  assert.ok(!/src="\$\{(s\.dataUrl|screenshots\[0\]\.dataUrl|m\.photoDataUrl)\}"/.test(src), 'no raw dataUrl left inside a src attribute');
});

test('dashboard.html: server text put into innerHTML is escaped; a non-JSON error page no longer logs the person out', () => {
  const src = read('public-site/dashboard.html');
  assert.match(src, /escHtml\(r\.sentTo\)/);
  assert.match(src, /escHtml\(e\.message\)/);
  assert.ok(!/'<p class="demo-error">' \+ e\.message/.test(src));
  assert.ok((src.match(/res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/g) || []).length >= 3, 'api(), login and reset parse defensively');
});

test('hit.js counts only real pages: /products/<anything> no longer creates a KV key per text', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const hit = await load('functions/api/hit.js');
  const send = (p) => hit.onRequestPost({ request: new Request('https://x/api/hit', { method: 'POST', body: JSON.stringify({ path: p }) }), env });
  await send('/products/shop'); await send('/products/shop/'); await send('/products/zzz-random-1'); await send('/products/' + 'a'.repeat(30)); await send('/faq');
  const keys = (await kv.list({ prefix: 'an:' })).keys.map((k) => k.name);
  assert.equal(keys.length, 2, keys.join(','));
  assert.ok(keys.some((k) => k.endsWith(':/products/shop')) && keys.some((k) => k.endsWith(':/faq')));
  assert.equal(Number(await kv.get(keys.find((k) => k.endsWith(':/products/shop')))), 2, 'trailing slash counted with the page');
});

test('contact.js: line breaks in name / contact are flattened (they go into an e-mail subject)', async () => {
  const kv = makeKV(); const env = { mydukapos_kv: kv };
  const c = await load('functions/api/contact.js');
  const r = await c.onRequestPost({ request: new Request('https://x/api/contact', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ name: 'Eve\r\nBcc: x@evil.test', contact: '0712\n345678', message: 'Hello there, call me please', t: Date.now() - 60000 }) }), env });
  assert.equal(r.status, 200);
  const l = await kv.list({ prefix: 'contact-msg:' });
  const rec = JSON.parse(await kv.get(l.keys[0].name));
  assert.ok(!/[\r\n]/.test(rec.name) && !/[\r\n]/.test(rec.contact), JSON.stringify(rec));
});

