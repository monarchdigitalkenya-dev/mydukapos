// Name hygiene of the Services engine blocks (SERVICES_ARCHITECTURE.md 2.1 rule 4, 8.3 "Dependency direction", Appendix B). Owner: B1-S.
//  1. every top-level name a block declares starts with svc / Svc / SVC_
//  2. no name is declared twice across the 18 blocks
//  3. no name collides with a shared function (src/shared/functions.js //@fn) or with any other top-level name of services/index.html
//  4. services/index.html declares no svc* name outside the svc marker pairs
//  5. dependency direction: B1 blocks never reference B2/B3 names, and B2 / B3 blocks never reference each other, except guarded by `typeof name`
//     (B2/B3 -> B1 and everything -> the same block is free). The checker is self-tested on synthetic input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { blockNames, blockScripts, scriptsOfHtml, topLevelNames, stripCommentsAndStrings } from './svc-helpers.mjs';

const PHASE = { 'svc-core': 1, 'svc-templates': 1, 'svc-form': 1, 'svc-store': 1, 'svc-ui-home': 1, 'svc-config-ui': 1,
  'svc-metrics': 2, 'svc-ui-board': 2, 'svc-appts': 2, 'svc-reports': 2,
  'svc-catalog': 3, 'svc-inventory': 3, 'svc-quote': 3, 'svc-pay': 3, 'svc-notify': 3, 'svc-perms': 3, 'svc-photos': 3, 'svc-custom': 3 };
const okName = (n) => /^(svc|Svc|SVC_)/.test(n);

// blocks: { name: { names:[...], code } } -> list of violations of rule 5
export function dependencyViolations(blocks) {
  const owner = new Map();
  Object.entries(blocks).forEach(([b, v]) => v.names.forEach((n) => owner.set(n, b)));
  const bad = [];
  Object.entries(blocks).forEach(([b, v]) => {
    const code = stripCommentsAndStrings(v.code);
    owner.forEach((ob, name) => {
      if (ob === b) return;
      const pb = PHASE[b] || 1, po = PHASE[ob] || 1;
      const allowed = po === pb || po === 1;                    // same phase is free; B1 is free for everybody; B2 <-> B3 and B1 -> B2/B3 are not
      if (allowed) return;
      const re = new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g'); let m;
      let guarded = false;                                      // guarded = a `typeof name` check appears before the use (same block)
      while ((m = re.exec(code))) {
        if (/typeof\s+$/.test(code.slice(Math.max(0, m.index - 8), m.index))) { guarded = true; continue; }
        if (!guarded) { bad.push(`${b} uses ${name} (declared in ${ob}) without a typeof guard`); break; }
      }
    });
  });
  return bad;
}

const blocks = {};
blockNames().forEach((n) => { const code = blockScripts(n).join('\n'); blocks[n] = { code, names: code.trim() ? topLevelNames(code) : [] }; });

test('the dependency checker flags unguarded upward/sideways references and allows guarded ones', () => {
  const syn = {
    'svc-core': { code: 'function svcA() { return svcLater(); }', names: ['svcA'] },
    'svc-store': { code: 'function svcB() { if (typeof svcLater === "function") svcLater(); return svcA(); }', names: ['svcB'] },
    'svc-metrics': { code: 'function svcLater() { return svcA() + svcPayThing(); }', names: ['svcLater'] },
    'svc-pay': { code: 'function svcPayThing() {}', names: ['svcPayThing'] },
  };
  const v = dependencyViolations(syn);
  assert.deepEqual(v.sort(), ['svc-core uses svcLater (declared in svc-metrics) without a typeof guard', 'svc-metrics uses svcPayThing (declared in svc-pay) without a typeof guard'].sort());
});

test('every top-level name in an svc block starts with svc / Svc / SVC_ and is declared once', () => {
  const seen = new Map();
  Object.entries(blocks).forEach(([b, v]) => v.names.forEach((n) => {
    assert.ok(okName(n), `${b} declares "${n}"`);
    assert.ok(!seen.has(n), `"${n}" is declared in both ${seen.get(n)} and ${b}`);
    seen.set(n, b);
  }));
});

test('no svc name collides with a shared function or with the page itself; the page declares no svc* name outside the marker pairs', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'src/shared/functions.js'), 'utf8');
  const shared = new Set([...lib.matchAll(/^\/\/@fn (\S+)$/gm)].map((m) => m[1]));
  let page = fs.readFileSync(path.join(ROOT, 'services/index.html'), 'utf8');
  page = page.replace(/<!-- @shared-block:svc-[a-z-]+:begin -->[\s\S]*?<!-- @shared-block:svc-[a-z-]+:end -->/g, '');
  const pageNames = new Set();
  scriptsOfHtml(page).forEach((js) => { try { topLevelNames(js).forEach((n) => pageNames.add(n)); } catch (e) { /* a non-script snippet */ } });
  [...pageNames].forEach((n) => assert.ok(!okName(n) || !/^svc/i.test(n), `services/index.html declares "${n}" outside the svc blocks`));
  Object.entries(blocks).forEach(([b, v]) => v.names.forEach((n) => {
    assert.ok(!shared.has(n), `${b}: "${n}" collides with a shared function`);
    assert.ok(!pageNames.has(n), `${b}: "${n}" collides with a top-level name of services/index.html`);
  }));
});

test('dependency direction: B1 never calls B2/B3, B2 and B3 never call each other, unless guarded with typeof', () => {
  assert.deepEqual(dependencyViolations(blocks), []);
});
