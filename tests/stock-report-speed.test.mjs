import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 122: the Stock Report totals every item in one pass (it used to re-scan the whole history per item: ~50 s on a phone with
// 3,000 items), and shows 200 rows at a time. Same figures as the old per-item scans.
const OLD = `({
  mvAfter: (code, d) => stockMovementLog.filter(m => m.code === code && dateKey(new Date(m.timestamp)) > d).reduce((s, m) => s + stockMoveDelta(m), 0),
  mvIn: (code, f, t, add) => stockMovementLog.filter(m => m.code === code && dateKey(new Date(m.timestamp)) >= f && dateKey(new Date(m.timestamp)) <= t && (add ? stockMoveDelta(m) > 0 : stockMoveDelta(m) < 0)).reduce((s, m) => s + Math.abs(stockMoveDelta(m)), 0),
  soldAfter: (code, d) => { let s = 0; salesLog.forEach(x => { if (x.voided) return; if (dateKey(new Date(x.timestamp)) <= d) return; (x.items || []).forEach(it => { if (it.code === code) s += it.qty; }); }); return s; },
  soldIn: (code, f, t) => { let s = 0; salesLog.forEach(x => { if (x.voided) return; const k = dateKey(new Date(x.timestamp)); if (k < f || k > t) return; (x.items || []).forEach(it => { if (it.code === code) s += it.qty; }); }); return s; },
})`;

for (const app of ['index.html', 'water/index.html', 'hotel/index.html']) {
  test(`${app}: stock report figures are exactly the old per-item figures`, async () => {
    const { w, close } = await boot(app, { wait: 700 });
    const r = w.eval(`(() => {
      const old = ${OLD};
      let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const codes = ['A', 'B', '1', 1, 'Z'], day = 86400000, now = Date.now();
      salesLog.length = 0; stockMovementLog.length = 0;
      for (let i = 0; i < 300; i++) salesLog.push({ id: 's' + i, voided: rnd() < 0.1, timestamp: new Date(now - rnd() * 40 * day).toISOString(), items: [{ code: codes[(rnd() * 5) | 0], qty: 1 + ((rnd() * 5) | 0) }] });
      for (let i = 0; i < 300; i++) stockMovementLog.push({ id: 'm' + i, code: codes[(rnd() * 5) | 0], delta: Math.round((rnd() - 0.5) * 20), timestamp: new Date(now - rnd() * 40 * day).toISOString(), ...(rnd() < 0.2 ? { _srv: { applied: rnd() < 0.5, before: 5, after: 3 } } : {}) });
      const dates = [dateKey(new Date(now - 30 * day)), dateKey(new Date(now - 7 * day)), dateKey(new Date(now))];
      const bad = [];
      for (const c of codes) for (const f of dates) for (const t of dates) {
        if (old.mvAfter(c, t) !== stockMovementDeltaAfter(c, t)) bad.push('mvAfter ' + c);
        if (old.mvIn(c, f, t, true) !== stockMovementDeltaWithinRange(c, f, t, true)) bad.push('added ' + c);
        if (old.mvIn(c, f, t, false) !== stockMovementDeltaWithinRange(c, f, t, false)) bad.push('removed ' + c);
        if (old.soldAfter(c, t) !== soldQtyAfter(c, t)) bad.push('soldAfter ' + c);
        if (old.soldIn(c, f, t) !== soldQtyWithinRange(c, f, t)) bad.push('soldIn ' + c);
      }
      return bad;
    })()`);
    assert.equal(r.length, 0, r.join(', '));
    close();
  });
}

test('a sale recorded right after the report was built is counted (no stale totals)', async () => {
  const { w, close } = await boot('index.html', { wait: 700 });
  const r = w.eval(`(() => {
    salesLog.length = 0; const t = dateKey(new Date(Date.now() - 86400000 * 3)), today = dateKey(new Date());
    const before = soldQtyWithinRange('A', t, today);
    salesLog.push({ id: 'x', timestamp: new Date().toISOString(), items: [{ code: 'A', qty: 4 }] });
    return [before, soldQtyWithinRange('A', t, today)];
  })()`);
  assert.deepEqual([...r], [0, 4]);
  close();
});

test('3,000 items x 5,000 sales: the report builds fast and shows 200 rows with "Show more" / "Show all"', async () => {
  const { w, d, close } = await boot('index.html', { wait: 700 });
  const ms = w.eval(`(() => {
    inventory.length = 0; salesLog.length = 0;
    for (let i = 0; i < 3000; i++) inventory.push({ code: 'C' + i, type: 'item', name: 'Item ' + i, price: 10, wholesalePrice: 6, qty: 50, unit: 'pcs' });
    for (let i = 0; i < 5000; i++) salesLog.push({ id: 's' + i, timestamp: new Date(Date.now() - i * 900000).toISOString(), items: [{ code: 'C' + (i % 3000), qty: 1 }] });
    const t = performance.now(); renderStockReport(); return performance.now() - t;
  })()`);
  assert.ok(ms < 3000, 'built in ' + Math.round(ms) + ' ms (was minutes in this test setup)');
  const rows = () => d.querySelectorAll('#stock-report-table tbody tr:not(.report-more-row)').length;
  assert.equal(rows(), 200);
  assert.match(d.querySelector('.report-more-row').textContent, /Showing 200 of 3000/);
  w.eval("reportShowMore('stock-report', false, 'renderStockReport')");
  assert.equal(rows(), 400);
  w.eval("reportShowMore('stock-report', true, 'renderStockReport')");
  assert.equal(rows(), 3000);
  assert.equal(d.querySelector('.report-more-row'), null);
  close();
});
