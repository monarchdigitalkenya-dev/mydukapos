import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// zip 282: the MyDukaPOS favicon set - real files of the right kind and size, and every public page points at them.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const read = (p) => fs.readFileSync(path.join(ROOT, p));

test('favicon files are genuine and the right size', () => {
  for (const [f, w] of [['favicon-16x16.png', 16], ['favicon-32x32.png', 32], ['apple-touch-icon.png', 180], ['icons/icon-192.png', 192], ['icons/icon-512.png', 512]]) {
    const b = read(f);
    assert.ok(b.subarray(0, 8).equals(PNG), f + ' is a PNG');
    assert.deepEqual(pngSize(b), [w, w], f + ' is ' + w + 'x' + w);
  }
  const ico = read('favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1, 'ICO type');
  const n = ico.readUInt16LE(4); assert.ok(n >= 3, 'several sizes');
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16, w = ico[e] || 256, len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    sizes.push(w); assert.ok(ico.subarray(off, off + 8).equals(PNG), 'entry ' + w + ' holds a PNG image');
    assert.ok(off + len <= ico.length);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
  const svg = read('favicon.svg').toString('utf8');
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
  assert.ok(!/<text|<image|<script/i.test(svg), 'pure shapes: no text, raster or script');
  assert.ok(svg.includes('prefers-color-scheme:dark'), 'the cart stays visible on a dark tab');
});

test('every public page uses the same favicon set, theme colour and brand; no stale icon links', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public-site')).filter((f) => f.endsWith('.html')).map((f) => 'public-site/' + f).concat(['404.html', 'errors/403.html', 'errors/429.html', 'errors/500.html']);
  for (const p of pages) {
    const t = read(p).toString('utf8');
    const head = t.slice(0, t.indexOf('</head>'));
    // zip 283: the links carry a cache-busting ?v=<release>, and the SVG icon may be inline (data:image/svg+xml - it follows dark mode)
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const href of ['/favicon.ico', '/favicon.svg', '/favicon-32x32.png', '/favicon-16x16.png', '/apple-touch-icon.png']) {
      const h2 = head.replace(/<link rel="shortcut icon"[^>]*>/g, '');           // the legacy duplicate of the .ico for old browsers is fine
      let n = (h2.match(new RegExp('href="' + esc(href) + '(?:\\?v=\\d+)?"', 'g')) || []).length;
      if (href === '/favicon.svg') n += (h2.match(/rel="icon" href="data:image\/svg\+xml/g) || []).length;
      assert.equal(n, 1, p + ': exactly one ' + href);
    }
    assert.ok(!/rel="(?:icon|apple-touch-icon)" href="\/icons\//.test(head), p + ': old icon link removed');
    assert.equal((head.match(/<meta name="theme-color"/g) || []).length, 1, p + ': one theme-color');
    assert.ok(/<title>[^<]*MyDuka ?POS/.test(head) || p.endsWith('portfolio.html'), p + ': the brand in the title');   // the zip 307 home page writes it "MyDuka POS"
    assert.equal((head.match(/<title>/g) || []).length, 1, p + ': one title');
  }
  const idx = read('public-site/index.html').toString('utf8');
  assert.ok(idx.includes('"logo":"https://mydukapos.store/img/mydukapos-logo.png"'));
  assert.ok(read('public-site/img/mydukapos-logo.png').subarray(0, 8).equals(PNG));
});

test('the favicon files are static (no Function call) and cached', () => {
  const r = JSON.parse(read('_routes.json').toString('utf8'));
  for (const f of ['/favicon.ico', '/favicon.svg', '/favicon-16x16.png', '/favicon-32x32.png', '/apple-touch-icon.png']) assert.ok(r.exclude.includes(f), f + ' excluded');
  assert.ok(r.exclude.length <= 100, 'Cloudflare limit');
  const h = read('_headers').toString('utf8');
  assert.ok(h.includes('/favicon.svg\n  Cache-Control: public, max-age=86400'));
});
