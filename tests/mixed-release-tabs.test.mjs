import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 121: a tab still running an older release on the same device writes stock movements without the `lg` mark. Once the ledger
// is on, those are pending like this build's own (the server applies them once all the same), so the till never shows stock that
// ignores a sale it has not sent yet.
test('movements from an older tab after the ledger started count as pending; older history and processed ones do not', async () => {
  const since = Date.now() - 60000;
  const { w, close } = await boot('index.html', { storage: { pos_stock_ledger_v1: '1', pos_stock_ledger_since: String(since) }, wait: 700 });
  const iso = (t) => new Date(t).toISOString();
  w.eval(`stockMovementLog.push(
    { id: 'old-tab', code: 'A', delta: -1, timestamp: '${iso(Date.now() - 1000)}' },
    { id: 'history', code: 'A', delta: -1, timestamp: '${iso(since - 86400000)}' },
    { id: 'done', code: 'A', delta: -1, timestamp: '${iso(Date.now() - 500)}', _srv: { applied: true } },
    { id: 'mine', lg: 1, code: 'A', delta: -2, timestamp: '${iso(Date.now())}' })`);
  const ids = w.eval('stockPendingMoves().map((m) => m.id).join(",")');
  assert.equal(ids, 'old-tab,mine');
  close();
});

test('a shop whose ledger was switched on by an earlier release starts the clock now (nothing old becomes pending)', async () => {
  const { w, close } = await boot('index.html', { storage: { pos_stock_ledger_v1: '1' }, wait: 700 });
  w.eval(`stockMovementLog.push({ id: 'old', code: 'A', delta: -1, timestamp: '${new Date(Date.now() - 5000).toISOString()}' })`);
  assert.equal(w.eval('stockPendingMoves().length'), 0);
  assert.ok(Number(w.localStorage.getItem('pos_stock_ledger_since')) > Date.now() - 60000);
  close();
});
