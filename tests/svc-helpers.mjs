// tests/svc-helpers.mjs — helpers for the Services engine tests (SERVICES_ARCHITECTURE.md 2.1 "Node loading of pure blocks", Appendix B).
//
//   loadSvc(blocks, globals)   run the <script> text of src/shared/blocks/<name>.html in ONE vm context and return that context.
//                              The functions the blocks declare (plain global functions) are plain properties of the returned object:
//                                  const svc = loadSvc(['svc-core', 'svc-templates']);  svc.svcNormPhone('0712 345 678')
//                              `let` / `const` top-level names are NOT properties of a vm global: use svc.__eval('svcSomeLet') for those.
//   NOTE (cross-realm): arrays / objects built inside the context have the CONTEXT'S Array.prototype, so assert.deepStrictEqual on them fails
//                              ("same structure but not reference-equal" / prototype mismatch). Use toPlain(value) (a JSON round trip) or
//                              assert.deepEqual (loose) when comparing.
//   blockNames()               the 18 svc-* block names in page order (from tools/lib.mjs SHARED_BLOCKS).
//   blockScripts(name)         the script texts inside a block file (HTML comments are skipped, so a header comment may mention anything).
//   topLevelNames(code)        names declared at the top level of a script (function / var / let / const / class).
//   es2018Problems(code)       [] when the script is ES2018-clean. ES2018 is the ceiling for the engine (old Android WebViews, SERVICES_ARCHITECTURE.md R5):
//                              with acorn in node_modules (it is a devDependency and tools/ already needs it) the script must PARSE as ecmaVersion 2018
//                              (so `?.`, `??`, optional catch binding, BigInt, class fields ... fail), and the AST is walked for the runtime APIs that
//                              syntax alone cannot catch (replaceAll, Object.fromEntries, .flat/.flatMap, structuredClone, matchAll, allSettled, trimStart/
//                              trimEnd, globalThis). If acorn cannot be imported the same rules run as a conservative REGEX check on the code with
//                              comments and string literals blanked out (may over-report; never under-reports the listed constructs).
//   SVC_ES2018_MODE            'acorn' | 'regex' (which checker is active).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { ROOT } from './helpers.mjs';

export const BLOCK_DIR = path.join(ROOT, 'src/shared/blocks');

let acorn = null;
try { acorn = await import('acorn'); } catch (e) { acorn = null; }
export const SVC_ES2018_MODE = acorn ? 'acorn' : 'regex';

// The 18 blocks in page order: parsed from tools/lib.mjs so this file never drifts from SHARED_BLOCKS.
export function blockNames() {
  const lib = fs.readFileSync(path.join(ROOT, 'tools/lib.mjs'), 'utf8');
  const out = []; const re = /^\s*'(svc-[a-z-]+)':\s*\{/gm; let m;
  while ((m = re.exec(lib))) out.push(m[1]);
  return out;
}
export function readBlock(name) { return fs.readFileSync(path.join(BLOCK_DIR, (name.startsWith('svc-') ? name : 'svc-' + name) + '.html'), 'utf8'); }

// Script element bodies of a block file. An HTML comment is skipped as a whole, so text like "a script element" (or even a literal tag) inside
// a header comment never starts a script.
export function scriptsOfHtml(html) {
  const out = []; let i = 0;
  while (i < html.length) {
    const c = html.indexOf('<!--', i), s = html.slice(i).search(/<script\b/i);
    const sAbs = s === -1 ? -1 : i + s;
    if (sAbs === -1) break;
    if (c !== -1 && c < sAbs) { const e = html.indexOf('-->', c + 4); i = e === -1 ? html.length : e + 3; continue; }
    const open = html.indexOf('>', sAbs);
    const tag = html.slice(sAbs, open + 1);
    const close = html.indexOf('</script>', open);
    if (close === -1) break;
    if (!/\bsrc\s*=/i.test(tag) && !/type\s*=\s*["'](?!text\/javascript|module)/i.test(tag)) out.push(html.slice(open + 1, close));
    i = close + 9;
  }
  return out;
}
export function blockScripts(name) { return scriptsOfHtml(readBlock(name)); }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// vm loader
// ---------------------------------------------------------------------------------------------------------------------------------------------
function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); }, removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } };
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function loadSvc(blocks = ['svc-core', 'svc-templates'], globals = {}) {
  let seq = 0;
  const base = {
    console, Date, Math, JSON, Number, String, Array, Object, Boolean, RegExp, Error, Map, Set, WeakMap, Promise, parseFloat, parseInt, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    crypto: webcrypto,
    localStorage: makeStorage(),
    // the few app globals pure code may call (functions from src/shared/functions.js / services/index.html, reduced to what a test needs)
    genSaleId: () => Date.now() + '-' + (++seq).toString(36).padStart(4, '0') + Math.random().toString(36).slice(2, 8),
    bizDayKey: (ms) => new Date((ms == null ? Date.now() : ms) + 3 * 3600000).toISOString().slice(0, 10),      // Kenya business day (UTC+3)
    tillNumber: () => 1,
    getOrCreateDeviceId: () => 'dev-test',
    round2,
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    normalizeKenyanPhone: (p) => String(p || '').replace(/[\s\-().]/g, ''),
    safeSetItem: (k, v) => { try { ctx.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    customers: [], serviceJobs: [], bookings: [], inventory: [], staff: [], salesLog: [], bills: [], stockMovementLog: [],
    ...globals,
  };
  const ctx = vm.createContext(base);
  Object.defineProperty(ctx, '__eval', { value: (code) => vm.runInContext(String(code), ctx), enumerable: false });
  for (const name of blocks) {
    const n = name.startsWith('svc-') ? name : 'svc-' + name;
    blockScripts(n).forEach((js, i) => vm.runInContext(js, ctx, { filename: `${n}.html#script${i}` }));
  }
  return ctx;
}
export function toPlain(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// top-level names + ES2018 guard
// ---------------------------------------------------------------------------------------------------------------------------------------------
function patNames(n, add) {
  if (!n) return;
  if (n.type === 'Identifier') add(n.name);
  else if (n.type === 'ObjectPattern') n.properties.forEach((p) => patNames(p.type === 'RestElement' ? p.argument : p.value, add));
  else if (n.type === 'ArrayPattern') n.elements.forEach((e) => patNames(e, add));
  else if (n.type === 'AssignmentPattern') patNames(n.left, add);
  else if (n.type === 'RestElement') patNames(n.argument, add);
}
export function topLevelNames(code) {
  const names = [];
  const add = (x) => names.push(x);
  if (acorn) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    for (const n of ast.body) {
      if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) add(n.id.name);
      else if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => patNames(d.id, add));
    }
  } else {
    const re = /^(?:async\s+)?(?:function\*?|class|var|let|const)\s+([A-Za-z_$][\w$]*)/gm; let m;
    while ((m = re.exec(code))) add(m[1]);
  }
  return names;
}

const BANNED_MEMBERS = new Set(['replaceAll', 'fromEntries', 'flat', 'flatMap', 'matchAll', 'allSettled', 'trimStart', 'trimEnd']);
const BANNED_IDENTS = new Set(['structuredClone', 'globalThis', 'BigInt']);
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit));
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}
// comments and string / template literal contents blanked (same length), for the regex fallback
function blank(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);
}
export const stripCommentsAndStrings = blank;
export function es2018Problems(code) {
  const problems = [];
  if (acorn) {
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 2018, sourceType: 'script' }); }
    catch (e) { return ['does not parse as ES2018: ' + e.message]; }
    walk(ast, (n) => {
      if (n.type === 'MemberExpression' && !n.computed && n.property && BANNED_MEMBERS.has(n.property.name)) problems.push('.' + n.property.name + ' (newer than ES2018) at ' + n.start);
      if (n.type === 'Identifier' && BANNED_IDENTS.has(n.name)) problems.push(n.name + ' (newer than ES2018) at ' + n.start);
    });
    return problems;
  }
  const c = blank(code);
  const rules = [[/\?\./, '?. (optional chaining)'], [/\?\?/, '?? (nullish coalescing)'], [/catch\s*\{/, 'optional catch binding'], [/\b(?:replaceAll|fromEntries|matchAll|allSettled|trimStart|trimEnd|flatMap)\b/, 'runtime API newer than ES2018'],
    [/\.flat\s*\(/, '.flat()'], [/\bstructuredClone\b|\bglobalThis\b|\bBigInt\b/, 'structuredClone / globalThis / BigInt'], [/\b\d[\d_]*n\b/, 'BigInt literal'], [/\b\d+_\d+/, 'numeric separator']];
  rules.forEach(([re, what]) => { const m = re.exec(c); if (m) problems.push(what + ' near "' + c.slice(Math.max(0, m.index - 20), m.index + 25).replace(/\s+/g, ' ') + '"'); });
  return problems;
}
export function assertEs2018(code, label) {
  const p = es2018Problems(code);
  if (p.length) throw new Error(`${label || 'script'} is not ES2018-clean (${SVC_ES2018_MODE}): ${p.join('; ')}`);
}
