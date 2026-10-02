import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/shared/functions.js', import.meta.url), 'utf8');
const grab = (n) => { const i = src.indexOf('//@fn ' + n + '\n'); assert.ok(i >= 0, n); const j = src.indexOf('\n//@fn ', i + 5); return src.slice(i, j < 0 ? undefined : j); };
function ctx(cols) {
  const store = cols ? { pos_device_cols: String(cols) } : {};
  const sb = { window: {}, localStorage: { getItem: (k) => (k in store ? store[k] : null) }, receiptPrintableMm: () => 72, receiptFontPtNow: () => 7, receiptPaperMm: () => 80, Math };
  vm.createContext(sb);
  vm.runInContext(grab('deviceColsCap') + '\n' + grab('getPaperCols'), sb);
  return sb;
}
test('80 mm default stays 48 characters', () => assert.equal(vm.runInContext('getPaperCols()', ctx()), 48));
test('a 42-character head caps the line at 42', () => assert.equal(vm.runInContext('getPaperCols()', ctx(42)), 42));
test('nonsense cap is ignored', () => assert.equal(vm.runInContext('getPaperCols()', ctx(5)), 48));
