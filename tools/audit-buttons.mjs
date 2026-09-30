// zip 161 - static audit of every button / control that runs an async handler.
//
//   node tools/audit-buttons.mjs            print the table, exit 1 when something is not accepted
//   node tools/audit-buttons.mjs --json     the same as JSON
//   node tools/audit-buttons.mjs --all      also list the handlers that are fine
//
// For every app it finds the inline onclick / onchange / onsubmit / oninput ... handlers (in the markup AND in the template strings the app
// draws its screens with), resolves the global functions they call, and reads each function's syntax tree:
//
//   no-guard        the app does not install the click guard (clickGuardInstall) at boot, so a slow async handler can be pressed twice
//   dup-hazard      the handler changes state (array.push / unshift / splice, a save to storage) BEFORE the first await that can fail (the network), with no
//                   single-flight flag / disabled button / duplicate check first: a second press while the first waits adds a second record
//                   (the "Generate Invite Link" bug: a second pending invite per press)
//   dup-covered     the same, but the handler is only reachable from onclick, so the click guard already ignores the second press (information)
//   no-try          an async handler awaits the network with no try/catch anywhere around it: a failure is an unhandled rejection (the click guard now
//                   turns that into a message, so this is information, not a failure)
//   guard-denied    an async handler is on the click guard's built-in never-list
//
// dup-hazard and no-guard fail the audit (exit 1) unless the exact finding is accepted, with a reason, in tools/audit-buttons.allow.json:
//   { "<app>::<function>::<rule>": "why this is fine" }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'owner/index.html'];
const ALLOW_FILE = path.join(ROOT, 'tools/audit-buttons.allow.json');
const NETWORK = /(?<![\w.$])(fetch|pushNow|pushNowOrWarn|flushThenPull|flushPendingPush|pullState|pullStateOnce|syncHaveCheck|probeServer|inviteRunPush|inviteMakeLive|trackPush)\s*\(/;
const GUARDED_BY_NAME = /busy|inflight|in_flight|running|submitting|pending|saving|working|lock|single|once|guard|processing|loading|sending|checkoutAttempt/i;
const KEYWORDS = /^(if|for|while|switch|return|function|catch|typeof|await|new|void|delete|event|this|do|else|try|throw|in|of|alert|confirm|prompt|parseInt|parseFloat|String|Number|Boolean|Math|JSON|Date|Array|Object|setTimeout|clearTimeout|showToast)$/;
const NEVER = ['showToast', 'closeReceipt', 'switchTab', 'guardedSwitchTab'];        // mirrors clickGuardInstall

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showAll = args.includes('--all');
const allow = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) : {};

function scripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;
    out.push({ code: m[2], line0: html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length });
  }
  return out;
}
function namesOf(code) {
  const out = [];
  const re = /(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) if (!KEYWORDS.test(m[2]) && !out.includes(m[2])) out.push(m[2]);
  return out;
}
function walk(node, fn, inFn = false) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, inFn);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    const nestedFn = /Function/.test(node.type) ? true : inFn;
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, fn, nestedFn));
    else if (v && typeof v.type === 'string') walk(v, fn, nestedFn);
  }
}
// The statements of a function body, in order, WITHOUT entering nested functions.
function bodyNodes(fnNode) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    out.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      const kids = Array.isArray(v) ? v : [v];
      kids.forEach((c) => { if (c && typeof c.type === 'string' && !/Function/.test(c.type)) visit(c); });
    }
  };
  visit(fnNode.body);
  return out;
}

function auditApp(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const app = rel === 'index.html' ? 'index' : rel.split('/')[0];
  const fns = new Map();                 // name -> { node, src, line }
  const parsed = [];
  for (const sc of scripts(html)) {
    let ast;
    try { ast = parse(sc.code, { ecmaVersion: 'latest' }); } catch (e) { continue; }
    parsed.push({ sc, ast });
    for (const n of ast.body) if (n.type === 'FunctionDeclaration' && n.id) fns.set(n.id.name, { node: n, code: sc.code, line: sc.line0 + sc.code.slice(0, n.start).split('\n').length - 1 });
  }
  const hasGuard = /clickGuardInstall\s*\(\s*\)/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')) && /function clickGuardInstall\b/.test(html);
  // handlers: on<event>="..." (markup and template strings)
  const handlers = new Map();            // fn -> { events:Set, count, sample }
  const re = /\bon(click|change|submit|input|keydown|keyup|blur|focus)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    for (const nm of namesOf(m[2].replace(/&#39;|&quot;|&amp;/g, ' '))) {
      if (!fns.has(nm)) continue;
      const h = handlers.get(nm) || { events: new Set(), count: 0, sample: m[2].slice(0, 70) };
      h.events.add(m[1]); h.count++;
      handlers.set(nm, h);
    }
  }
  // which functions touch the network (directly or through another function of the app)
  const direct = new Map();
  for (const [nm, f] of fns) direct.set(nm, NETWORK.test(f.code.slice(f.node.start, f.node.end)));
  const calls = new Map();
  for (const [nm, f] of fns) {
    const set = new Set();
    walk(f.node, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && fns.has(n.callee.name)) set.add(n.callee.name); });
    calls.set(nm, set);
  }
  const netMemo = new Map();
  const isNet = (nm, seen = new Set()) => {
    if (netMemo.has(nm)) return netMemo.get(nm);
    if (seen.has(nm)) return false;
    seen.add(nm);
    let r = !!direct.get(nm);
    if (!r) for (const c of calls.get(nm) || []) if (isNet(c, seen)) { r = true; break; }
    netMemo.set(nm, r);
    return r;
  };
  const findings = [];
  const rows = [];
  for (const [nm, h] of handlers) {
    const f = fns.get(nm);
    const node = f.node;
    const src = f.code.slice(node.start, node.end);
    const nodes = bodyNodes(node);
    const isAsync = !!node.async;
    const awaits = nodes.filter((n) => n.type === 'AwaitExpression');
    const netAwaits = awaits.filter((a) => {
      const t = f.code.slice(a.start, a.end);
      if (NETWORK.test(t)) return true;
      // await someAppFunction(...) that reaches the network
      return a.argument && a.argument.type === 'CallExpression' && a.argument.callee.type === 'Identifier' && isNet(a.argument.callee.name);
    });
    const firstNet = netAwaits.length ? Math.min(...netAwaits.map((a) => a.start)) : Infinity;
    // try / catch around the network awaits
    const tries = nodes.filter((n) => n.type === 'TryStatement' && n.handler);
    const covered = (a) => tries.some((t) => a.start >= t.block.start && a.end <= t.block.end);
    const unprotected = netAwaits.filter((a) => !covered(a));
    // state changed before the first network await
    const before = nodes.filter((n) => n.start < firstNet);
    // Only an APPEND to state that outlives the call is a duplicate hazard (array.push / unshift on something that is not declared inside the function).
    // Writing a setting or a hash is idempotent: a second press writes the same thing.
    const locals = new Set();
    node.params.forEach((pp) => { if (pp.type === 'Identifier') locals.add(pp.name); });
    nodes.forEach((n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') locals.add(n.id.name); });
    const rootOf = (e) => { while (e && e.type === 'MemberExpression') e = e.object; return e && e.type === 'Identifier' ? e.name : ''; };
    const mutations = [];
    before.forEach((n) => {
      if (n.type !== 'CallExpression') return;
      const t = f.code.slice(n.start, n.end);
      if (n.callee.type === 'MemberExpression' && n.callee.property && ['push', 'unshift'].includes(n.callee.property.name) && !locals.has(rootOf(n.callee.object))) mutations.push(t.replace(/\s+/g, ' ').slice(0, 50));
    });
    // one level down: an app function called before the first network await that itself appends to state (saveX() -> list.push)
    const appends = (fname) => {
      const g = fns.get(fname);
      if (!g || fname === nm) return '';
      const loc = new Set();
      g.node.params.forEach((pp) => { if (pp.type === 'Identifier') loc.add(pp.name); });
      let hit = '';
      bodyNodes(g.node).forEach((n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') loc.add(n.id.name);
      });
      bodyNodes(g.node).forEach((n) => {
        if (!hit && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property && ['push', 'unshift'].includes(n.callee.property.name) && !loc.has(rootOf(n.callee.object))) hit = fname + ' -> ' + g.code.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 40);
      });
      return hit;
    };
    before.forEach((n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && fns.has(n.callee.name)) { const h2 = appends(n.callee.name); if (h2) mutations.push(h2); }
    });
    // single flight: an early exit on a busy-ish flag, the button disabled, a *SingleFlight wrapper, or a duplicate check before the change
    const head = f.code.slice(node.body.start, mutations.length ? Math.min(firstNet, node.body.end) : node.body.end);
    const guards = [];
    nodes.forEach((n) => {
      if (n.type === 'IfStatement' && n.start < firstNet) {
        const test = f.code.slice(n.test.start, n.test.end);
        const cons = f.code.slice(n.consequent.start, n.consequent.end);
        if (/return\b/.test(cons) && GUARDED_BY_NAME.test(test)) guards.push('flag: ' + test.slice(0, 40));
      }
    });
    if (/\.disabled\s*=\s*true|aria-busy/.test(head)) guards.push('disables the button');
    if (/SingleFlight|singleFlight|hwSingleFlight/.test(src)) guards.push('single-flight wrapper');
    if (/\.(find|some|includes|findIndex)\s*\(/.test(head) && mutations.length) guards.push('duplicate check');
    if (/^\s*async function \w+\([^)]*\)\s*\{\s*return\s+(inviteGenerate|inviteSubmitRun)\(/.test(src)) guards.push('shared single-flight (inviteGenerate / inviteSubmitRun)');
    const row = { app, fn: nm, line: f.line, events: [...h.events].join(','), uses: h.count, async: isAsync, network: isNet(nm), guardedByClickGuard: hasGuard && isAsync && !NEVER.includes(nm), mutatesBeforeAwait: mutations.length, singleFlight: guards.join('; ') };
    rows.push(row);
    const add = (rule, detail) => {
      const key = `${app}::${nm}::${rule}`;
      findings.push({ key, app, fn: nm, line: f.line, rule, detail, accepted: allow[key] || null, fails: (rule === 'dup-hazard' || rule === 'no-guard') && !allow[key] });
    };
    if (isAsync && !hasGuard) add('no-guard', 'the app does not install clickGuardInstall()');
    if (isAsync && NEVER.includes(nm)) add('guard-denied', 'on the click guard never-list');
    if (isAsync && netAwaits.length && mutations.length && !guards.length) {
      // a button whose only trigger is onclick is covered at run time by the click guard (a second press while the first is pending does nothing);
      // anything reachable from onchange / onsubmit / onkeydown / oninput is not, and neither is an app without the guard
      const clickOnly = [...h.events].every((e) => e === 'click');
      const detail = `${mutations[0]} ... runs before the first network await, no single-flight or duplicate check`;
      if (clickOnly && hasGuard) add('dup-covered', detail + ' (covered at run time by the click guard: a second press is ignored)');
      else add('dup-hazard', detail);
    }
    if (isAsync && unprotected.length) add('no-try', `${unprotected.length} network await(s) without try/catch`);
  }
  return { app, rows, findings, hasGuard };
}

const results = APPS.filter((a) => fs.existsSync(path.join(ROOT, a))).map(auditApp);
const findings = results.flatMap((r) => r.findings);
const failing = findings.filter((f) => f.fails);
if (asJson) {
  console.log(JSON.stringify({ apps: results.map((r) => ({ app: r.app, hasGuard: r.hasGuard, handlers: r.rows.length, async: r.rows.filter((x) => x.async).length })), findings }, null, 2));
} else {
  console.log('app'.padEnd(11) + 'handlers  async  network  guard  findings');
  results.forEach((r) => console.log(r.app.padEnd(11) + String(r.rows.length).padEnd(10) + String(r.rows.filter((x) => x.async).length).padEnd(7) + String(r.rows.filter((x) => x.async && x.network).length).padEnd(9) + (r.hasGuard ? 'yes' : 'NO').padEnd(7) + r.findings.length));
  console.log('');
  for (const f of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.app.localeCompare(b.app))) {
    console.log(`${f.fails ? 'FAIL' : f.accepted ? 'ok  ' : 'info'} ${f.rule.padEnd(12)} ${f.app}::${f.fn} (line ${f.line})  ${f.detail}${f.accepted ? '  [accepted: ' + f.accepted + ']' : ''}`);
  }
  if (showAll) results.forEach((r) => r.rows.filter((x) => x.async).forEach((x) => console.log(`row ${x.app}::${x.fn} events=${x.events} net=${x.network} guards=[${x.singleFlight}]`)));
  console.log(`\n${failing.length ? failing.length + ' unaccepted finding(s) - fix them or accept them with a reason in tools/audit-buttons.allow.json' : 'Audit passed (no unaccepted findings).'}`);
}
process.exit(failing.length ? 1 : 0);
