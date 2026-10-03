import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/shared/functions.js', import.meta.url), 'utf8');
const grab = (n) => { const i = src.indexOf('//@fn ' + n + '\n'); assert.ok(i >= 0, n); const j = src.indexOf('\n//@fn ', i + 5); return src.slice(i, j < 0 ? undefined : j); };
function ctx(mode) {
  const store = mode ? { pos_daily_sales_sort: mode } : {};
  const sb = { document: { getElementById: () => null }, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } }, saleDeliveryFee: (s) => Number(s.fee) || 0 };
  vm.createContext(sb);
  vm.runInContext(grab('dailySalesSortMode') + grab('dailySalesComparator'), sb);
  return sb;
}
const sales = [
  { id: 'a', timestamp: '2026-10-02T08:00:00Z', items: [{ price: 100, qty: 2 }] },
  { id: 'b', timestamp: '2026-10-02T10:00:00Z', items: [{ price: 50, qty: 1 }] },
  { id: 'c', timestamp: '2026-10-02T09:00:00Z', items: [{ price: 10, qty: 1 }], fee: 300 },
  { id: 'd', timestamp: '2026-10-02T11:00:00Z', items: [] },
];
const order = (mode) => { const s = ctx(mode); return vm.runInContext('(rows) => rows.slice().sort(dailySalesComparator()).map((r) => r.id).join("")', s)(sales); };
test('default is newest first', () => assert.equal(order(null), 'dbca'));
test('oldest first', () => assert.equal(order('old'), 'acbd'));
test('highest amount first (delivery fee counts)', () => assert.equal(order('high'), 'cabd'));
test('lowest amount first', () => assert.equal(order('low'), 'dbac'));
test('unknown value falls back to newest first', () => assert.equal(order('zzz'), 'dbca'));
test('every app has the selector and uses the comparator', () => {
  for (const f of ['index.html', 'water', 'hotel', 'hospital', 'pharmacy', 'production', 'services']) {
    const h = fs.readFileSync(new URL('../' + (f === 'index.html' ? f : f + '/index.html'), import.meta.url), 'utf8');
    assert.ok(h.includes('id="daily-sales-sort"') && h.includes('dailySalesComparator('), f);
  }
});
