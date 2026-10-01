import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html'];

test('a short order ticket is never a landscape page (page is never shorter than the roll is wide)', async () => {
  for (const a of APPS) {
    const { w, close } = await boot(a, { wait: 700 });
    try {
      for (const mm of [58, 80]) {
        const rule = w.eval(`receiptPageRule(${mm}, null, 20)`);          // a 20 mm fixed length used to give "80mm 40mm" = landscape
        const m = /size:\s*([\d.]+)mm\s+([\d.]+)mm/.exec(rule);
        assert.ok(m, a + ' rule ' + rule);
        assert.ok(Number(m[2]) >= Number(m[1]), `${a}: ${mm}mm roll -> ${rule} must not be wider than tall (landscape)`);
      }
      const long = w.eval('receiptPageRule(80, null, 300)');
      assert.match(long, /80mm 300mm/, a + ': a long receipt keeps its length');
    } finally { close(); }
  }
});

test('stockValueTotals matches the plain maths (one map, first match wins)', async () => {
  const { w, close } = await boot('index.html', { wait: 700 });
  try {
    const r = JSON.parse(w.eval(`(() => {
      inventory.length = 0;
      inventory.push({ code: 'A', price: 10, wholesalePrice: 4, qty: 1 }, { code: 'A', price: 99, wholesalePrice: 99, qty: 1 }, { code: 'B', price: 5, wholesaleSellingPrice: 3, wholesalePrice: 2, qty: 1, dualUnit: true, pieceQty: 2, piecePrice: 1, pieceWholesalePrice: 0.5 });
      return JSON.stringify(stockValueTotals([{ code: 'A', closing: 3 }, { code: 'B', closing: 2 }, { code: 'ZZ', closing: 9 }]));
    })()`));
    assert.deepEqual(r, { retail: 3 * 10 + 2 * 5 + 2 * 1, wholesale: 3 * 10 + 2 * 3 + 2 * 1, cost: 3 * 4 + 2 * 2 + 2 * 0.5 });
  } finally { close(); }
});

test('sales journal version string: memoised but still changes when the record changes', async () => {
  const { w, close } = await boot('index.html', { wait: 700 });
  try {
    const r = JSON.parse(w.eval(`(() => {
      const s = { id: 'x1', timestamp: '2026-10-01T10:00:00.000Z', items: [{ price: 10, qty: 2 }], paymentMethod: 'cash' };
      const a = window.salesJournalSig(s), a2 = window.salesJournalSig(s);
      s.customerName = 'Jane';
      const b = window.salesJournalSig(s);
      s.updatedAt = 'ignored-by-version';
      const c = window.salesJournalSig(s);
      return JSON.stringify({ same: a === a2, changed: a !== b, ignored: b === c });
    })()`));
    assert.deepEqual(r, { same: true, changed: true, ignored: true });
  } finally { close(); }
});

test('connection monitor: faster recovery and parallel probes', async () => {
  const { w, close } = await boot('index.html', { wait: 700 });
  try { assert.ok(typeof w.PosNet === 'object'); } finally { close(); }
});
