import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// zip 305: the home-page demo film costs nothing until it is tapped, plays muted inline, pauses itself, and is light enough for phones.
test('home: the demo film section is there, tap-to-play, and never downloads the video up front', () => {
  const h = r('public-site/index.html');
  for (const x of ['id="watch"', 'id="hp-film-play"', '/img/demo-film-poster.jpg', '/img/demo-film-poster-640.webp', 'fetchpriority="high"', 'width="1280" height="720"', 'Try a Live Demo', '"@type":"VideoObject"']) assert.ok(h.includes(x), x);      // zip 307: the poster IS the hero image now, so it loads first (never lazy)
  assert.doesNotMatch(h, /<video\b/, 'no <video> in the page itself: it is created only after the tap');
  assert.doesNotMatch(h, /autoplay/i, 'nothing plays by itself');
  const js = r('public-site/home-pro.js');
  for (const x of ["v.muted = true", "playsinline", "IntersectionObserver", "visibilitychange", "demo-film-720.webm", "demo-film-720.mp4"]) assert.ok(js.includes(x), x);
});
test('the film files are small enough for a phone and served from the cached /img/demo-* path', () => {
  for (const f of ['demo-film-720.mp4', 'demo-film-720.webm']) { const s = fs.statSync(path.join(ROOT, 'public-site/img', f)).size; assert.ok(s > 500000 && s < 5 * 1024 * 1024, f + ' ' + s); }
  assert.ok(fs.statSync(path.join(ROOT, 'public-site/img/demo-film-poster.jpg')).size < 200 * 1024);
  assert.match(r('_headers'), /\/img\/demo-\*\n\s+Cache-Control: public, max-age=604800/);
  assert.match(r('functions/_site.js'), /img\\\/\[A-Za-z0-9_.-\]\+/);
});
