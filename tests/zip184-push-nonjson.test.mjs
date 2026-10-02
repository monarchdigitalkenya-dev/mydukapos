import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
const ITEMS = [{ code: '00001', type: 'item', name: 'Widget', price: 100, qty: 50, unit: 'pcs', vatCategory: 'A' }];

test('zip 184: a 200 non-JSON push reply (captive portal) does not mark the sale as sent', async () => {
  const s = makeServer();
  let portal = false;
  const s2 = { ...s, fetch: async (u, o = {}) => {
    const isPost = String(o.method || 'GET').toUpperCase() === 'POST' && String(u).includes('pos-sync');
    if (portal && isPost) return new Response('<html>Please log in to Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return s.fetch(u, o);
  } };
  const a = await openDevice('index.html', s2, { pos_inventory: JSON.stringify(ITEMS) });
  await a.w.eval('pushNow()');
  a.w.eval('showToast = function () {}');
  await sleep(300);
  portal = true;
  a.w.eval("salesLog.push({id:'SALE-X1', timestamp:new Date().toISOString(), paid:true, paymentMethod:'cash', cashAmount:100, items:[{name:'Widget',price:100,qty:1,code:'00001'}]}); safeSetItem('pos_sales_log', JSON.stringify(salesLog)); queuePush()");
  await sleep(2500);
  assert.equal(a.w.eval("window.__pushAck && window.__pushAck.salesLog ? window.__pushAck.salesLog.has('i:SALE-X1') : false"), false, 'must not be acknowledged');
  assert.equal(a.w.eval('hasUnsyncedWork()'), true, 'still unsent work');
  portal = false;
  await a.w.eval('flushThenPull()');
  await sleep(1500);
  assert.ok((s.serverState().salesLog || []).some(x => x.id === 'SALE-X1'), 'uploaded after the portal is gone');
  a.close();
});
