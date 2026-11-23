// tools/build-home-cards.mjs — generates the home page's product cards from public-site/product-cards.json (zip 288).
//   node tools/build-home-cards.mjs           rewrite public-site/index.html
//   node tools/build-home-cards.mjs --check   change nothing; exit 1 if index.html is out of date
// Why generated: the cards used to be drawn by script only, so a crawler's first response had an EMPTY grid and no link to any product page.
// The same markup is now in the served HTML (crawlable links) AND is what the page script draws when the owner hides a product or edits a tagline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'public-site/index.html');
const DATA = path.join(ROOT, 'public-site/product-cards.json');

// The browser-side renderer: ONE source, used twice — written into index.html's script (for cards redrawn after the owner hides a product or
// edits a tagline) AND evaluated here to print the static markup. So the served HTML and the redrawn cards can never differ.
// Icons: simple 24px line icons (stroke = currentColor), one consistent set.
export const BROWSER_SRC = `const CARD_ICONS = {
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  stethoscope: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
  factory: '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/>',
  pill: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5v5Z"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M5 12h14"/><path d="M9 3c0 1 .8 1.5.8 2.5M12 2.5c0 1 .8 1.5.8 2.5M15 3c0 1 .8 1.5.8 2.5"/>'
};
function cardEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function cardHtml(p, desc) {
  var d = desc || p.desc;
  return '<a href="/products/' + p.key + '" class="app-card" style="--accent:' + p.accent + ';--tint:' + p.tint + ';--pos:' + (p.pos || 'right center') + '">' +
    '<picture class="card-photo"><source type="image/webp" srcset="/img/card-' + p.key + '-640.webp 640w, /img/card-' + p.key + '-1200.webp 1200w" sizes="(min-width:1100px) 33vw, (min-width:640px) 50vw, 100vw">' +
    '<img src="/img/card-' + p.key + '-640.webp" alt="' + cardEsc(p.alt) + '" width="1200" height="800" loading="lazy" decoding="async" onerror="this.parentNode.classList.add(&#39;no-photo&#39;);this.remove()"></picture>' +
    '<span class="card-shade" aria-hidden="true"></span>' +
    '<span class="card-body"><span class="icon" style="background:' + p.accent + '"><svg class="ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (CARD_ICONS[p.icon] || '') + '</svg></span>' +
    '<h3 class="name">' + cardEsc(p.name) + '</h3><p class="desc">' + cardEsc(d) + '</p>' +
    '<span class="go">Explore this solution <svg class="arr" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span></span></a>';
}`;
export const cardHtml = new Function(BROWSER_SRC + '\nreturn cardHtml;')();

export function build() {
  const cards = JSON.parse(fs.readFileSync(DATA, 'utf8')).cards;
  let html = fs.readFileSync(INDEX, 'utf8');
  const grid = cards.map((c) => '            ' + cardHtml(c)).join('\n');
  const data = BROWSER_SRC + '\nconst ALL_PRODUCTS = ' + JSON.stringify(cards.map(({ key, name, icon, accent, tint, desc, alt, pos }) => ({ key, name, icon, accent, tint, desc, alt, pos }))) + ';';
  const g1 = /<!--@cards:begin-->[\s\S]*?<!--@cards:end-->/, d1 = /\/\*@cards-data:begin\*\/[\s\S]*?\/\*@cards-data:end\*\//;
  if (!g1.test(html) || !d1.test(html)) throw new Error('index.html is missing the @cards markers');
  html = html.replace(g1, () => `<!--@cards:begin-->\n${grid}\n            <!--@cards:end-->`).replace(d1, () => `/*@cards-data:begin*/\n${data}\n    /*@cards-data:end*/`);
  return html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build();
  if (process.argv.includes('--check')) { if (fs.readFileSync(INDEX, 'utf8') !== out) { console.error('public-site/index.html cards are out of date: run `npm run build:cards`'); process.exit(1); } console.log('cards in sync'); }
  else { fs.writeFileSync(INDEX, out); console.log('wrote public-site/index.html'); }
}
