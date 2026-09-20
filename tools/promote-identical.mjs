// Moves functions that are IDENTICAL (apart from comments/whitespace) in every app that has them into src/shared/.
//
//   node tools/promote-identical.mjs --dry   list what would move
//   node tools/promote-identical.mjs         do it (then it runs the equivalent of `npm run sync`)
//
// Only touches a function when it is safe by construction:
//   * it is declared exactly once per app, at the top level, in the SAME <script> block as that app's @shared region
//     (function declarations are only hoisted within one script element);
//   * every app that has it has the same normalised source;
//   * no app already lists it as shared.
// The canonical copy is the variant with the most comments. Local copies are cut out of each app by exact source
// position, the name is added to each app's @shared:begin list, and the library gets the function.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MODULES, FN_FILE, read, write, scriptBlocks, topLevelFunctions, REGION_RE } from './lib.mjs';

const dry = process.argv.includes('--dry');
// Stricter than the drift report's normaliser: only whole-line comments, block comments and trailing comments that contain no
// quote characters are ignored, so a "//" inside a string (a URL) can never hide a real difference.
const norm = (t) => t.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^'"`\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
const hash = (t) => crypto.createHash('md5').update(norm(t)).digest('hex');

const info = {};
for (const m of MODULES) {
  const html = read(m);
  const blocks = scriptBlocks(html);
  const region = html.match(REGION_RE);
  const regionAt = region ? region.index : -1;
  const regionBlock = blocks.findIndex((b) => b.start <= regionAt && regionAt < b.start + b.js.length);
  info[m] = { html, blocks, decls: topLevelFunctions(html).decls, shared: new Set(region ? region[1].split(',') : []), regionBlock };
}

const names = new Set();
MODULES.forEach((m) => Object.keys(info[m].decls).forEach((n) => names.add(n)));

const plan = [];
for (const n of [...names].sort()) {
  const have = MODULES.filter((m) => info[m].decls[n]);
  if (have.length < 2) continue;
  if (have.some((m) => info[m].shared.has(n))) continue;
  if (have.some((m) => info[m].decls[n].length !== 1)) continue;
  if (have.some((m) => info[m].decls[n][0].block !== info[m].regionBlock)) continue;
  if (new Set(have.map((m) => hash(info[m].decls[n][0].src))).size !== 1) continue;
  const best = have.map((m) => info[m].decls[n][0].src).sort((a, b) => b.length - a.length)[0];
  plan.push({ n, have, src: best });
}

console.log(`${plan.length} function(s) can be promoted:`);
plan.forEach((p) => console.log(`  ${p.n}  (${p.have.length} apps, ${p.src.length} chars)`));
if (dry || plan.length === 0) process.exit(0);

// 1. the library
let lib = fs.readFileSync(FN_FILE, 'utf8').replace(/\n+$/, '\n');
for (const p of plan) lib += `\n//@fn ${p.n}\n${p.src}\n`;
fs.writeFileSync(FN_FILE, lib);

// 2. every app: cut the local copies (last first, so offsets stay valid) and list the names
for (const m of MODULES) {
  const mine = plan.filter((p) => p.have.includes(m));
  if (!mine.length) continue;
  let html = info[m].html;
  const cuts = mine.map((p) => {
    const d = info[m].decls[p.n][0];
    const b = info[m].blocks[d.block];
    let s = b.start + d.node.start, e = b.start + d.node.end;
    while (s > 0 && /[ \t]/.test(html[s - 1])) s--;           // take the indentation with it
    if (html[e] === '\n') e++;
    return [s, e];
  }).sort((a, b) => b[0] - a[0]);
  for (const [s, e] of cuts) html = html.slice(0, s) + html.slice(e);
  html = html.replace(REGION_RE, (whole, list) => whole.replace(`names=${list} `, `names=${list},${mine.map((p) => p.n).join(',')} `));
  write(m, html);
}
console.log('Done. Now run: npm run sync && npm run check && npm test');
