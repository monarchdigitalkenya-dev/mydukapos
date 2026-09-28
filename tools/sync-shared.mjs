// Writes the canonical shared code (src/shared/) into every app's index.html.
//
//   node tools/sync-shared.mjs          rewrite the apps
//   node tools/sync-shared.mjs --check  change nothing; exit 1 if any app is out of sync
//                                       (use this before every deploy)
//
// Two kinds of shared code:
//   1. Functions  — src/shared/functions.js. Each app's script starts with
//      /* @shared:begin names=a,b,c */ ... /* @shared:end */ ; the names list
//      is which shared functions THAT app uses. To give an app another shared
//      function, add its name to that list. To change a function for every
//      app, edit it in functions.js. Never edit inside a region by hand.
//   2. Blocks     — src/shared/blocks/NAME.html, between
//      <!-- @shared-block:NAME:begin --> / <!-- @shared-block:NAME:end -->.
import fs from 'node:fs';
import { MODULES, BLOCK_TARGETS, BLOCK_DIR, read, write, loadFunctionLibrary, regionText, REGION_RE, SHARED_BLOCKS, blockRegex, blockText } from './lib.mjs';

const check = process.argv.includes('--check');
const lib = loadFunctionLibrary();
let stale = 0;

for (const m of BLOCK_TARGETS) {
  let html = read(m);
  const before = html;

  const mm = MODULES.includes(m) ? html.match(REGION_RE) : true;
  if (!mm) { console.error(`${m}: no @shared region found`); process.exit(2); }
  if (MODULES.includes(m)) {
    const names = mm[1].split(',').filter(Boolean);
    const missing = names.filter((n) => !lib.has(n));
    if (missing.length) { console.error(`${m}: shared functions not in the library: ${missing.join(', ')}`); process.exit(2); }
    html = html.replace(REGION_RE, () => regionText(names, lib));
    // zip 146: a shared function that calls ANOTHER shared function this app does not include (and does not define itself) is a
    // ReferenceError waiting to happen — one inside a try { } is invisible to the lint, and silently broke every push once.
    const have = new Set(names);
    const unmet = [];
    for (const n of names) {
      const src = String(lib.get(n)).replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');           // not in comments
      for (const other of lib.keys()) {
        if (have.has(other) || !new RegExp('(?<![\\w.$])' + other + '\\s*\\(').test(src)) continue;
        if (new RegExp('typeof\\s+' + other + '\\b').test(src)) continue;                      // guarded: optional on purpose
        if (new RegExp('function\\s+' + other + '\\b|\\b(const|let|var)\\s+' + other + '\\b|window\\.' + other + '\\s*=').test(html)) continue;
        unmet.push(`${n} -> ${other}`);
      }
    }
    if (unmet.length) { console.error(`${m}: shared functions call shared functions this app does not include (add them to its names list):\n  ${unmet.join('\n  ')}`); process.exit(2); }
  }

  for (const name of Object.keys(SHARED_BLOCKS)) {
    if (!(SHARED_BLOCKS[name].owner || MODULES.includes(m))) continue;   // e.g. the Hardware popup is not for the owner console
    if ((SHARED_BLOCKS[name].skip || []).includes(m)) continue;         // e.g. the Orders tab is not for Aqua POS (water)
    // a block can carry different content per module (the user guides): src/shared/blocks/<name>/<module>.html, module = shop | hotel | hospital | ...
    const moduleKey = m === 'index.html' ? 'shop' : m.split('/')[0];
    const canon = fs.readFileSync(SHARED_BLOCKS[name].perModule ? `${BLOCK_DIR}/${name}/${moduleKey}.html` : `${BLOCK_DIR}/${name}.html`, 'utf8');
    if (!blockRegex(name).test(html)) { console.error(`${m}: block "${name}" markers not found`); process.exit(2); }
    html = html.replace(blockRegex(name), () => blockText(name, canon));
  }

  if (html !== before) {
    stale++;
    console.log(`${check ? 'OUT OF SYNC' : 'updated'}: ${m}`);
    if (!check) write(m, html);
  }
}

if (check) {
  if (stale) { console.error(`\n${stale} app(s) out of sync — run "npm run sync".`); process.exit(1); }
  console.log('All apps match src/shared/.');
} else if (!stale) {
  console.log('Everything already in sync.');
}
