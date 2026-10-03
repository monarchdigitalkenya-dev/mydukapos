import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 10, wholesalePrice: 5, qty: 30, unit: 'pcs', vatCategory: 'A' },
];
const qty = (w, c = 'A') => w.eval(`inventory.find(p => p.code === '${c}').qty`);
const quiet = (w) => w.eval('showToast = function () {}; window.confirm = () => true; window.print = () => {}');
const srv = (s, c = 'A') => s.serverState().inventory.find((p) => p.code === c).qty;
const refresh = async (dev, s, wait = 900) => { const st = deviceStorage(dev.w); dev.close(); const n = await openDevice('index.html', s, st, wait); quiet(n.w); return n; };
async function shop() {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) });
  quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  return { s, a };
}
const restock = (w, code, n) => {
  w.eval(`restockDraft = [{ rowId: 1, code: '${code}', name: '', unit: 'pcs', qty: '${n}', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()`);
};

// zip 186 (item 5): a restock saved qty but not its stock movement; a refresh inside the push window (reply lost) made the reloaded page log a
// second "Stock correction" of the same size -> 200 instead of 150. markLocalDirty now saves the movement log with the quantities.
for (const [mode, wait] of [['down', 0], ['down', 400], ['up', 0], ['up', 50], ['up', 400]]) test(`restock then refresh after ${wait}ms, server ${mode}: 150, never 200`, async () => {
  const { s, a: a0 } = await shop();
  let a = a0;
  if (mode === 'down') s.state.down = true;
  restock(a.w, 'A', 50);
  assert.equal(qty(a.w), 150);
  await sleep(wait);
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 150, 'after refresh (1)');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 150, 'after sync');
  assert.equal(srv(s), 150, 'server');
  const moves = (s.serverState().stockMovementLog || []).filter((m) => m.code === 'A' || m.itemCode === 'A');
  assert.equal(moves.length, 1, 'one movement on the server (no "Stock correction" twin)');
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 150, 'after refresh (2)');
  a.close();
});

for (const mode of ['down', 'up']) test(`stock take then an immediate refresh, server ${mode}: the count survives`, async () => {
  const { s, a: a0 } = await shop();
  let a = a0;
  if (mode === 'down') s.state.down = true;
  a.w.eval("stockTakeSet('A','qty','120'); stockTakeApplyOne('A')");
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 120, 'after refresh');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 120); assert.equal(srv(s), 120);
  a.close();
});
