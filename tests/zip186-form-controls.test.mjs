import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// Zip 186: every text box / select / textarea in every app is bigger and looks modern, and the text typed in it is ONE STEP bigger
// (16px on a computer, 17px on a phone). The look lives in ONE shared block (src/shared/blocks/form-controls.html) that `npm run sync`
// writes into every app; the public pages carry their own copy of the same design.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'owner/index.html'];
const BLOCK = read('src/shared/blocks/form-controls.html');
const cssOf = (html) => (html.match(/<style id="zip186-form-controls">([\s\S]*?)<\/style>/) || [])[1] || '';
const px = (css, re) => { const m = css.match(re); return m ? parseFloat(m[1]) : NaN; };

test('the shared block exists, is registered for every app, and says what it does', () => {
  assert.match(BLOCK, /\/\* zip186 form controls \*\//);
  assert.match(read('tools/lib.mjs'), /'form-controls':\s*\{[^}]*owner:\s*true/);
});

for (const app of APPS) {
  test(`${app}: carries the zip186 form-controls block, last in the page`, () => {
    const html = read(app);
    assert.ok(html.includes('<!-- @shared-block:form-controls:begin -->') && html.includes('<!-- @shared-block:form-controls:end -->'), 'block markers present');
    const css = cssOf(html);
    assert.match(css, /\/\* zip186 form controls \*\//);
    assert.equal(css, cssOf(BLOCK), 'identical to the shared source (run npm run sync)');
    // it must come after every other <style> so it wins the cascade
    const at = html.indexOf('<style id="zip186-form-controls">');
    assert.equal(html.indexOf('<style', at + 10), -1, 'no <style> after the form-controls block');
    assert.ok(at > html.lastIndexOf('</style>', at - 1) - 1);
  });
}

test('font sizes: 16px on a computer, 17px on a phone, compact 15px / 17px, never below 16px on a phone', () => {
  const css = cssOf(BLOCK);
  const base = css.slice(css.indexOf('/* 1. every text-like box */'), css.indexOf('/* 2. textarea */'));
  assert.ok(px(base, /font-size:\s*([\d.]+)px\s*!important/) >= 16, 'desktop base >= 16px');
  const phone = css.slice(css.indexOf('/* 8. phones'));
  assert.ok(px(phone, /font-size:\s*([\d.]+)px\s*!important/) >= 17, 'phone >= 17px (was 16px)');
  assert.match(phone, /@media \(max-width: 768px\)/);
  const compact = css.slice(css.indexOf('/* 7. compact variant'), css.indexOf('/* 8. phones'));
  assert.ok(px(compact, /font-size:\s*([\d.]+)px\s*!important/) >= 15, 'compact desktop >= 15px');
  // the compact desktop size is inside a min-width query, so a phone never gets the 15px
  assert.match(compact, /@media \(min-width: 769px\)[\s\S]*font-size: 15px/);
});

test('sizes: tall boxes, soft border, radius, focus ring, textarea, select chevron, touch height', () => {
  const css = cssOf(BLOCK);
  assert.ok(px(css, /min-height:\s*(\d+)px !important;\s*padding-top:\s*12px/) >= 46, 'min-height 46px');
  assert.match(css, /padding-top: 12px !important;[\s\S]*padding-left: 14px !important/);
  assert.match(css, /border: 1\.5px solid var\(--z186-bd\)/);
  assert.ok(px(css, /border-radius:\s*(\d+)px;\s*box-shadow: var\(--z186-shadow\)/) >= 10);
  assert.match(css, /:focus \{[^}]*box-shadow: 0 0 0 3px/);
  assert.match(css, /textarea[^{]*\{\s*min-height: 96px !important;\s*resize: vertical/);
  assert.match(css, /select[^{]*:not\(\[multiple\][^{]*\{[^}]*appearance|appearance: none/);
  assert.match(css, /background-image: var\(--z186-chev\)/);
  assert.match(css, /--z186-chev: url\("data:image\/svg\+xml/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 48px !important/);
  assert.match(css, /:disabled \{/); assert.match(css, /:read-only/); assert.match(css, /aria-invalid/);
  assert.match(css, /::placeholder/);
  assert.match(css, /html\[data-theme="dark"\] \{[\s\S]*--z186-bg:/, 'dark-mode tokens');
});

test('it leaves checkbox, radio, range, colour, file and hidden alone, and the deliberately big boxes', () => {
  const css = cssOf(BLOCK);
  // selector list names text-like types only
  assert.match(css, /input:is\(\[type=text\],\[type=number\],\[type=tel\],\[type=email\],\[type=password\],\[type=search\],\[type=url\],\[type=date\],\[type=time\],\[type=datetime-local\]/);
  for (const t of ['checkbox', 'radio', 'range', 'color', 'file', 'hidden']) assert.ok(!new RegExp(`\\[type=${t}\\]`).test(css.replace(/[^\n]*\/\*[^\n]*\*\//g, '')), `${t} is not styled`);
  assert.match(css, /\.z186-skip/); assert.match(css, /\[id\^="rsz-"\]/); assert.match(css, /\[id\^="pos-rk-"\]/);
});

test('boxes with an icon inside, narrow table boxes and grids are protected', () => {
  const css = cssOf(BLOCK);
  assert.match(css, /\.pw-toggle-wrap, \.phone-picker-wrap\) input:not\([^{]*\{ padding-right: 46px !important/);
  assert.match(css, /td, th, \.qty-controls/); assert.match(css, /min-height: 40px !important/);
  assert.match(css, /:where\(input[^\n]*\) \{ min-width: 0; \}/, 'boxes can shrink inside grid / flex rows');
  assert.match(css, /:where\(label\.label \+ :is\(/, 'a box after label.label fills the row');
});

test('public pages, order page and launcher: bigger boxes, 16px+ text, 17px on a phone', () => {
  const pages = { 'public-site/site.css': /zip186 form controls/, 'public-site/dashboard.html': /zip186 form controls/, 'public-site/app.html': /zip186 form controls/, 'order/index.html': /zip186 form controls/, 'native/launcher/launcher.html': /zip186 form controls/ };
  for (const [p, re] of Object.entries(pages)) {
    const t = read(p); assert.match(t, re, p);
    const tail = p.startsWith('native/') ? t : t.slice(t.indexOf('zip186 form controls'));
    const sizes = [...tail.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)].map((m) => parseFloat(m[1]) * (m[2] === 'rem' ? 16 : 1));
    assert.ok(sizes.length && Math.max(...sizes) >= 17 && sizes.some((s) => s >= 16), `${p}: sizes ${sizes}`);
    assert.ok(/min-height:\s*(4[6-9]|5\d)px/.test(tail), `${p}: tall boxes`);
  }
});
