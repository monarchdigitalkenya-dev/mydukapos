import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const SALE = { id: 'S1', timestamp: Date.now() - 1000, items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }], total: 100, paid: false, paymentMethod: 'Cash', paidStatusChanges: [{ at: 1, by: 'x', from: 'paid', to: 'unpaid' }] };
const LEGACY = { id: 'S2', timestamp: Date.now() - 2000, items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }], total: 100, paid: false, paymentMethod: 'Credit' };

for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html']) test(`${app}: a sale marked unpaid in Daily Sales is still a sale after a reload; an old-style unpaid sale still goes to Bills`, async () => {
  const t = await boot(app, { storage: { pos_sales_log: JSON.stringify([SALE, LEGACY]) }, wait: 800 });
  const ids = t.w.eval('salesLog.map(s => s.id)');
  assert.deepEqual([...ids], ['S1'], 'the toggled sale stays in salesLog');
  assert.deepEqual([...t.w.eval('bills.map(b => b.id)')], ['S2'], 'the legacy one moved to Bills');
  t.close();
});

test('PosNet: any 2xx API answer flips offline to online by itself (seen); a refusal never does', async () => {
  const t = await boot('index.html', { fetch: () => Promise.reject(new Error('offline')), wait: 600 });
  t.w.__posNetInternetProbe = () => Promise.resolve(false); t.w.__posNetOwnProbe = () => Promise.resolve(false);
  t.w.__posNetSyncProbe = () => Promise.resolve({ kind: 'none' });
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('PosNet.state'), 'offline');
  t.w.eval("PosNet.seen(403, 'application/json')");
  assert.equal(t.w.eval('PosNet.state'), 'backend_unavailable', 'a refusal proves the server is there, not that it works');
  t.w.eval("PosNet.seen(200, 'text/html')");
  assert.equal(t.w.eval('PosNet.state'), 'backend_unavailable', 'an HTML page is not the API');
  t.w.eval("PosNet.seen(200, 'application/json')");
  assert.equal(t.w.eval('PosNet.state'), 'online');
  t.close();
});

test('PosNet: health blocked but the sync endpoint answers -> online', async () => {
  const t = await boot('index.html', { fetch: (u) => /health/.test(String(u)) ? Promise.resolve(json({}, 404)) : Promise.reject(new Error('x')), wait: 600 });
  t.w.__posNetInternetProbe = () => Promise.resolve(false); t.w.__posNetOwnProbe = () => Promise.resolve(false);
  t.w.__posNetSyncProbe = () => Promise.resolve({ kind: 'ok', status: 200 });
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('PosNet.state'), 'online');
  t.close();
});

test('PosNet (zip 194): offline shows only a small calm pill - no Retry bar, no button; PosNet.retryNow() still re-checks and the pill goes away', async () => {
  let up = false;
  const t = await boot('index.html', {
    fetch: (u) => up ? Promise.resolve(json({ ok: true })) : Promise.reject(new Error('offline')), wait: 600,
    beforeParse: (w) => { w.__posNetRetryBarMs = 0; },
  });
  t.w.__posNetInternetProbe = () => Promise.resolve(false); t.w.__posNetOwnProbe = () => Promise.resolve(false);
  t.w.__posNetSyncProbe = () => Promise.resolve({ kind: 'none' });
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('PosNet.state'), 'offline');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(t.d.getElementById('posnet-offline-pill'), null, 'zip 379: no pill on screen at all');
  assert.equal(t.d.getElementById('posnet-retry-bar'), null, 'no Retry bar');
  assert.equal(t.d.getElementById('posnet-retry-btn'), null, 'no Retry button');
  up = true;
  await t.w.eval('PosNet.retryNow()');
  assert.ok(await until(() => t.w.eval('PosNet.state') === 'online', 8000), 'online after retryNow');
  assert.ok(await until(() => !t.d.getElementById('posnet-offline-pill'), 3000), 'the pill goes away');
  t.close();
});
