// ES2018 ceiling for the Services engine (SERVICES_ARCHITECTURE.md R5 / D2): every script in every src/shared/blocks/svc-*.html must parse as ES2018
// and avoid the newer runtime APIs (old Android WebViews). Owner: B1-S. The checker itself is self-tested below so an empty stub cannot hide a broken guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockNames, blockScripts, es2018Problems, SVC_ES2018_MODE } from './svc-helpers.mjs';

test('the ES2018 checker rejects what it must and accepts ES2018 (mode: ' + SVC_ES2018_MODE + ')', () => {
  const bad = ['var a = b?.c;', 'var a = b ?? 1;', 'try { x(); } catch { y(); }', 'var s = "a-b".replaceAll("-", "+");', 'var o = Object.fromEntries([]);', 'var f = [[1]].flat();',
    'var c = structuredClone({});', 'var f = [1].flatMap(function (x) { return x; });', 'var g = globalThis;', 'class A { x = 1; }'];
  bad.forEach((code) => assert.ok(es2018Problems(code).length > 0, 'must reject: ' + code));
  const good = ['var a = { ...b, c: 1 };', 'function f(a, b,) { return a ** b; }', 'async function f() { for await (var x of y) {} }', 'var s = "obj?.x ?? y"; // a?.b ?? c\n/* x.flat() */', 'try { x(); } catch (e) { y(); }',
    'var re = /(?<y>\\d{4})/; var p = Promise.resolve().finally(function () {});'];
  good.forEach((code) => assert.deepEqual(es2018Problems(code), [], 'must accept: ' + code));
});

test('there are 18 svc blocks and each one is ES2018-clean', () => {
  const names = blockNames();
  assert.equal(names.length, 18);
  names.forEach((n) => blockScripts(n).forEach((js, i) => assert.deepEqual(es2018Problems(js), [], `${n} script #${i}`)));
});
