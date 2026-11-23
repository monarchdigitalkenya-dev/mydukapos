import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

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
// a purchase order for n of code A, then "Arrived" with everything ticked
const receive = (w, n, id = 'po-t1') => w.eval(`purchaseOrders.push({ id: '${id}', orderNo: 'PO-${id}', createdAt: new Date().toISOString(), supplierName: 'S', items: [{ id: 'pl-${id}', code: 'A', name: 'Alpha', unit: 'pcs', qty: ${n}, cost: 40, receivedQty: 0 }], status: 'pending', statusHistory: [] }); poOpenArriveModal('${id}'); poConfirmArrival()`);

for (const [mode, wait] of [['down', 0], ['down', 400], ['up', 0], ['up', 50], ['up', 400]]) test(`purchase order arrival then refresh after ${wait}ms, server ${mode}: 150, never 100 or 200`, async () => {
  const { s, a: a0 } = await shop();
  let a = a0;
  if (mode === 'down') s.state.down = true;
  receive(a.w, 50);
  assert.equal(qty(a.w), 150);
  await sleep(wait);
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 150, 'after refresh (1)');
  s.state.down = false;
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 150, 'after sync');
  assert.equal(srv(s), 150, 'server');
  const moves = (s.serverState().stockMovementLog || []).filter((m) => m.code === 'A');
  assert.equal(moves.length, 1, 'one movement on the server (no "Stock correction" twin)');
  a = await refresh(a, s, 1200);
  assert.equal(qty(a.w), 150, 'after refresh (2)');
  a.close();
});

test('a purchase received on one till reaches the other till and survives its sales', async () => {
  const { s, a } = await shop();
  const b = await openDevice('index.html', s, deviceStorage(a.w), 900); quiet(b.w);
  receive(a.w, 40);
  await a.w.eval('flushThenPull()'); await sleep(300);
  await b.w.eval('pullState()'); await sleep(300);
  assert.equal(qty(b.w), 140, 'till B sees the purchase');
  assert.equal(srv(s), 140);
  a.close(); b.close();
});

test('restock, purchase and stock take in a row: the count wins, later purchases add on top', async () => {
  const { s, a } = await shop();
  a.w.eval("restockDraft = [{ rowId: 1, code: 'A', name: '', unit: 'pcs', qty: '10', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()");
  assert.equal(qty(a.w), 110);
  a.w.eval("stockTakeSet('A','qty','90'); stockTakeApplyOne('A')");
  assert.equal(qty(a.w), 90);
  await sleep(1100);
  receive(a.w, 25);
  assert.equal(qty(a.w), 115);
  await a.w.eval('flushThenPull()'); await sleep(300);
  assert.equal(qty(a.w), 115, 'device after sync');
  assert.equal(srv(s), 115, 'server');
  a.close();
});

test('Stock Report: a sale is counted once (Sold), not again as a removal; purchases, restocks and counts land in Added / Removed', async () => {
  const { a } = await shop();
  // 100 on the shelf. Sell 2, restock 5, purchase-order 3, stock-take down by 1 (104 -> counted 103... see below)
  await a.w.eval("deductStockForSaleUnit(inventory.find(p => p.code === 'A'), 2, 'unit'); salesLog.push({ id: 's1', timestamp: new Date().toISOString(), items: [{ code: 'A', name: 'Alpha', qty: 2, price: 100 }], total: 200 })");
  await a.w.eval("restockDraft = [{ rowId: 1, code: 'A', name: '', unit: 'pcs', qty: '5', cost: '40', sellPrice: '', wholesaleSell: '' }]; window.__lastRestockAt = 0; completeRestock()");
  receive(a.w, 3);
  await a.w.eval("stockTakeSet('A','qty','105'); stockTakeApplyOne('A')");   // 106 on the shelf, counted 105
  assert.equal(await qty(a.w), 105);
  const row = JSON.parse(await a.w.eval("JSON.stringify(buildStockReportRows(stockReportPeriodRange()).find(r => r.code === 'A'))"));
  assert.equal(row.opening, 100, 'opening is what was there before today');
  assert.equal(row.added, 8, 'restock 5 + purchase order 3');
  assert.equal(row.removed, 1, 'the stock-take shortage only (the sale is under Sold)');
  assert.equal(row.sold, 2);
  assert.equal(row.closing, 105);
  a.close();
});
