// ONE-TIME MIGRATION (already run — kept so the process is repeatable/auditable).
//
// Moves every function that is BYTE-IDENTICAL in all the apps that define it
// (and defined in 3+ apps, declared exactly once per app, in the app's main
// script) out of the individual index.html files and into src/shared/functions.js,
// leaving a generated "shared region" at the top of each app's main script.
//
// Behaviour-preserving by construction: only top-level function DECLARATIONS
// move, and those are hoisted, so where they sit in the script doesn't matter.
// Functions that differ between apps are NOT touched — see `npm run drift`.
import fs from 'node:fs';
import { MODULES, ROOT, FN_FILE, BLOCK_DIR, read, write, topLevelFunctions, REGION_RE, regionText, SHARED_BLOCKS, blockText } from './lib.mjs';

const per = {};
for (const m of MODULES) {
  const html = read(m);
  if (REGION_RE.test(html)) { console.error(`${m} already has a shared region — nothing to extract (use "npm run sync").`); process.exit(1); }
  per[m] = { html, ...topLevelFunctions(html) };
  const sizes = per[m].blocks.map((b) => b.js.length);
  per[m].main = sizes.indexOf(Math.max(...sizes));
}

const names = new Set();
MODULES.forEach((m) => Object.keys(per[m].decls).forEach((n) => names.add(n)));

const canonical = new Map();
for (const n of [...names].sort()) {
  const have = MODULES.filter((m) => per[m].decls[n]);
  if (have.length < 3) continue;
  if (have.some((m) => per[m].decls[n].length !== 1)) continue;                 // declared twice somewhere
  if (have.some((m) => per[m].decls[n][0].block !== per[m].main)) continue;     // not in the main script
  const srcs = new Set(have.map((m) => per[m].decls[n][0].src));
  if (srcs.size !== 1) continue;                                                // differs between apps
  canonical.set(n, [...srcs][0]);
}

// --- canonical library -------------------------------------------------
let lib = '// CANONICAL SHARED FUNCTIONS — edit here, then run `npm run sync` to write them into every app.\n' +
  '// Only functions that were byte-identical in every app that has them live here. Each app\n' +
  '// lists which of these it uses in the header of its "@shared" region.\n\n';
for (const [n, src] of canonical) lib += `//@fn ${n}\n${src}\n\n`;
fs.mkdirSync(BLOCK_DIR, { recursive: true });
fs.writeFileSync(FN_FILE, lib);

// --- rewrite each app --------------------------------------------------
let moved = 0;
for (const m of MODULES) {
  const { html, blocks, decls, main } = per[m];
  const mine = [...canonical.keys()].filter((n) => decls[n]);
  const b = blocks[main];
  let js = b.js;
  // replace back-to-front so earlier offsets stay valid
  const edits = mine.map((n) => decls[n][0].node).sort((x, y) => y.start - x.start);
  for (const node of edits) js = js.slice(0, node.start) + `/* -> shared: ${node.id.name} */` + js.slice(node.end);
  // insert the region after any leading "use strict" directive / whitespace
  const lead = js.match(/^\s*/)[0].length;
  const region = regionText(mine, canonical);
  js = js.slice(0, lead) + region + '\n\n        ' + js.slice(lead);
  write(m, html.slice(0, b.start) + js + html.slice(b.start + b.js.length));
  moved += mine.length;
  console.log(`${m}: ${mine.length} functions moved into the shared region`);
}
console.log(`\n${canonical.size} distinct shared functions (${moved} copies removed across ${MODULES.length} apps).`);

// --- whole shared HTML/script blocks ----------------------------------
for (const [name, def] of Object.entries(SHARED_BLOCKS)) {
  if (def.only) continue;      // `only` blocks (the svc-* Services engine) are authored in src/shared/blocks/, never extracted from an app
  let canonical = null;
  for (const m of MODULES) {
    const html = read(m);
    const start = html.indexOf(def.startMarker);
    if (start === -1) throw new Error(`${m}: block "${name}" not found`);
    const endTag = html.indexOf('</script>', start) + '</script>'.length;
    const text = html.slice(start, endTag);
    if (canonical === null) canonical = text;
    else if (canonical !== text) throw new Error(`${m}: block "${name}" differs from the others — resolve before extracting`);
    write(m, html.slice(0, start) + blockText(name, text) + html.slice(endTag));
  }
  fs.writeFileSync(`${BLOCK_DIR}/${name}.html`, canonical + '\n');
  console.log(`block ${name}: single-sourced in src/shared/blocks/${name}.html`);
}
