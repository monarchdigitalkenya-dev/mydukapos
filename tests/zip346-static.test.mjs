// zip 346: the pieces added in this zip are present in every app that should have them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const rd = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('pack import + stock take by level blocks are in every app that has Package sizes', () => {
  for (const a of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html']) {
    const h = rd(a); assert.ok(h.includes('id="pki-js"') && h.includes('id="tkl-js"'), 'missing in ' + a);
  }
});
test('the importer reads the supplier-style text columns', async () => {
  const vm = await import('node:vm');
  const html = rd('src/shared/blocks/pack-import.html');
  const js = /<script id="pki-js">([\s\S]*?)<\/script>/.exec(html)[1];
  const win = { document: { readyState: 'complete', getElementById: () => null, addEventListener() {} }, setTimeout() {} }; win.window = win;
  vm.createContext(win); vm.runInContext(js, win);
  const P = win.__pki;
  const a = P.parseLegacy('1 box of 12 pkts', '12 packets of 100 sweets', '1 sweet');
  assert.equal(a.unit, 'sweet'); assert.equal(a.pPer, 100); assert.equal(a.bPer, 12); assert.equal(a.issues.length, 0);
  const b = P.parseLegacy('1 case=6 bottles', 'NA', '1 bottle');
  assert.equal(b.bPer, 6); assert.equal(b.bPerOf, 'pieces'); assert.equal(b.pPer, null);
  const c = P.parseLegacy('1 box', 'OUT= 6 pcs', '1 pc');
  assert.equal(c.pPer, 6); assert.equal(c.bPer, null); assert.ok(c.issues.length === 1, 'box size missing is reported, not guessed');
  assert.equal(P.parseLegacy('1 bale', '1 Dozen', '1 pc').pPer, 12);
});
test('stock take by level adds the levels up', async () => {
  const vm = await import('node:vm');
  const js = /<script id="tkl-js">([\s\S]*?)<\/script>/.exec(rd('src/shared/blocks/take-levels.html'))[1];
  const SE = { levels: (p) => p.packs, split: (p, q) => { const out = []; for (const l of p.packs) { const n = Math.floor(q / l.per); if (n) { out.push({ id: l.id, n }); q -= n * l.per; } } out.push({ id: 'base', n: q }); return out; } };
  const win = { SE, document: { readyState: 'complete', getElementById: () => null, addEventListener() {} } }; win.window = win;
  vm.createContext(win); vm.runInContext(js, win);
  const p = { unit: 'sweet', packs: [{ id: 'b', name: 'Box', per: 1200 }, { id: 'k', name: 'Packet', per: 100 }] };
  assert.equal(win.__tkl.total(p, { b: '2', k: '3', base: '5' }).total, 2705);
  assert.equal(JSON.stringify(win.__tkl.fromBase(p, 2707)), JSON.stringify({ b: '2', k: '3', base: '7' }));
  assert.equal(win.__tkl.total(p, { b: 'x' }).bad, true);
});
