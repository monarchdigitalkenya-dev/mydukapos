// Finds identifiers used in an app that are declared NOWHERE on the page (a ReferenceError waiting to happen: "inventory is not defined").
// Conservative on purpose: a name declared in ANY scope of ANY script on the page counts as declared, so it only reports names that truly do not exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');       // (not URL.pathname: on Windows that is "/C:/dev/..." and became "C:\\C:\\dev")
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'owner/index.html'];
const win = new JSDOM('<html></html>').window;
const BUILTIN = new Set([...Object.getOwnPropertyNames(win), ...Object.getOwnPropertyNames(globalThis),
  'undefined', 'NaN', 'Infinity', 'arguments', 'BarcodeDetector', 'webkitSpeechRecognition', 'SpeechRecognition', 'webkitAudioContext', 'ResizeObserver', 'IntersectionObserver',
  'Notification', 'BluetoothDevice', 'USBDevice', 'CompressionStream', 'DecompressionStream', 'ImageCapture', 'PaymentRequest', 'Capacitor', 'gtag', 'requestIdleCallback', 'cancelIdleCallback',
  'CSS', 'indexedDB', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'caches', 'XLSX', 'define', 'module', 'angular', 'showSaveFilePicker', 'showOpenFilePicker', 'BeforeInstallPromptEvent', 'OffscreenCanvas', 'createImageBitmap', 'structuredClone', 'crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', 'URLSearchParams', 'Intl', 'WebSocket']);

function scripts(html) {
  const out = []; const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;             // json / templates
    const line0 = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    out.push({ code: m[2], line0 });
  }
  return out;
}
function patNames(n, add) {
  if (!n) return;
  if (n.type === 'Identifier') add(n.name);
  else if (n.type === 'ObjectPattern') n.properties.forEach((p) => patNames(p.type === 'RestElement' ? p.argument : p.value, add));
  else if (n.type === 'ArrayPattern') n.elements.forEach((e) => patNames(e, add));
  else if (n.type === 'AssignmentPattern') patNames(n.left, add);
  else if (n.type === 'RestElement') patNames(n.argument, add);
}
// `ctx` = the chain of enclosing functions and try-blocks, so a name that is only used where it was checked with `typeof` (same function) or
// inside try { } catch { } can be told apart from an unguarded use.
function walk(node, parent, key, visit, ctx = []) {
  if (!node || typeof node.type !== 'string') return;
  const isFn = /Function/.test(node.type);
  const guardedTry = node.type === 'TryStatement' && node.handler && key !== 'handler';
  const next = isFn ? ctx.concat({ fn: node }) : ctx;
  visit(node, parent, key, ctx);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    const c2 = (guardedTry && k === 'block') ? next.concat({ tryBlock: node }) : next;
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, k, visit, c2));
    else if (v && typeof v.type === 'string') walk(v, node, k, visit, c2);
  }
}

export function lintApp(app) {
  const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
  const declared = new Set(), refs = [];
  for (const sc of scripts(html)) {
    let ast;
    try { ast = parse(sc.code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true }); }
    catch (e) { refs.push({ name: '(syntax error: ' + e.message + ')', line: sc.line0 + ((e.loc && e.loc.line) || 1) - 1 }); continue; }
    const typeofGuards = new Map();       // function node -> names it checks with typeof
    walk(ast, null, null, (n, p, k, ctx) => {
      if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) declared.add(n.id.name); }
      if (n.type === 'FunctionExpression' && n.id) declared.add(n.id.name);
      if (n.type === 'ClassExpression' && n.id) declared.add(n.id.name);
      if (n.type === 'VariableDeclarator') patNames(n.id, (x) => declared.add(x));
      if (/^(Function|ArrowFunction)/.test(n.type) || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression') (n.params || []).forEach((q) => patNames(q, (x) => declared.add(x)));
      if (n.type === 'CatchClause' && n.param) patNames(n.param, (x) => declared.add(x));
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type === 'Identifier' && n.left.object.name === 'window') declared.add(n.left.property.name);
      if (n.type === 'Identifier') {
        if (p && p.type === 'MemberExpression' && k === 'property' && !p.computed) return;
        if (p && (p.type === 'Property' || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') && k === 'key' && !p.computed && !(p.shorthand)) return;
        if (p && p.type === 'LabeledStatement' && k === 'label') return;
        if (p && (p.type === 'BreakStatement' || p.type === 'ContinueStatement')) return;
        if (p && p.type === 'UnaryExpression' && p.operator === 'typeof') { ctx.forEach((c) => { if (c.fn) { if (!typeofGuards.has(c.fn)) typeofGuards.set(c.fn, new Set()); typeofGuards.get(c.fn).add(n.name); } }); return; }
        refs.push({ name: n.name, line: sc.line0 + n.loc.start.line - 1, ctx, guards: typeofGuards });
      }
    });
  }
  const missing = new Map();
  for (const r of refs) {
    if (declared.has(r.name) || BUILTIN.has(r.name)) continue;
    if (r.ctx && r.ctx.some((c) => c.tryBlock)) continue;                                           // inside try { } catch { }
    if (r.ctx && r.guards && r.ctx.some((c) => c.fn && r.guards.get(c.fn) && r.guards.get(c.fn).has(r.name))) continue;   // checked with typeof in the same function
    if (!missing.has(r.name)) missing.set(r.name, []);
    missing.get(r.name).push(r.line);
  }
  return missing;
}

if (process.argv[1] && process.argv[1].endsWith('lint-globals.mjs')) {
  let bad = 0;
  for (const app of APPS) {
    const missing = lintApp(app);
    if (missing.size) { bad += missing.size; console.log(`\n${app}: ${missing.size} name(s) used but never declared`); for (const [n, lines] of missing) console.log(`   ${n}  (line ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ', …' : ''})`); }
  }
  console.log(bad ? `\n${bad} undeclared name(s) in total` : 'No undeclared names found.');
  process.exitCode = bad ? 1 : 0;
}

// ---- inline handlers (onclick="save()") that call a function which does not exist ----
const KEYWORDS = new Set(['if', 'for', 'while', 'return', 'function', 'typeof', 'new', 'switch', 'catch', 'void', 'delete', 'await', 'async', 'else', 'do', 'in', 'of', 'this', 'event']);
export function lintHandlers(app) {
  const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
  const declared = new Set();
  for (const sc of scripts(html)) {
    try {
      const ast = parse(sc.code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
      walk(ast, null, null, (n) => {
        if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) declared.add(n.id.name);
        if (n.type === 'VariableDeclarator') patNames(n.id, (x) => declared.add(x));
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type === 'Identifier' && n.left.object.name === 'window') declared.add(n.left.property.name);
      });
    } catch (e) { /* reported by lintApp */ }
  }
  const missing = new Map();
  const re = /\bon(?:click|change|input|submit|keydown|keyup|keypress|blur|focus|mousedown|mouseup|touchstart|dblclick|oninput|load|error)\s*=\s*\\?(["'])([\s\S]*?)\\?\1/gi;
  let m;
  while ((m = re.exec(html))) {
    let code = m[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\$\{[^}]*\}/g, '0').replace(/\\(['"])/g, '$1');
    const line = html.slice(0, m.index).split('\n').length;
    const lineText = html.split('\n')[line - 1] || '';
    if (/^\s*(\/\/|\*|<!--)/.test(lineText)) continue;                       // documentation, not a handler
    const calls = code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g);
    for (const c of calls) {
      const name = c[1];
      if (KEYWORDS.has(name) || declared.has(name) || BUILTIN.has(name)) continue;
      if (!missing.has(name)) missing.set(name, []);
      missing.get(name).push(line);
    }
  }
  return missing;
}
if (process.argv[1] && process.argv[1].endsWith('lint-globals.mjs')) {
  let bad = 0;
  for (const app of APPS) {
    const missing = lintHandlers(app);
    if (missing.size) { bad += missing.size; console.log(`\n${app}: ${missing.size} inline handler(s) call a function that does not exist`); for (const [n, lines] of missing) console.log(`   ${n}()  (line ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ', …' : ''})`); }
  }
  console.log(bad ? `\n${bad} missing handler function(s) in total` : 'Every inline handler calls a function that exists.');
  if (bad) process.exitCode = 1;
}
