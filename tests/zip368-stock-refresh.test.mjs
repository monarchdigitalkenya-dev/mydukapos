import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 368: a phone that is stuck with unsent work must still SEE the server's stock figures (quantities only).
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha Soap', price: 150, wholesalePrice: 50, qty: 40, unit: 'pcs', vatCategory: 'A' }];
const QUIET = "showToast = function () {}; window.confirm = () => true; window.print = () => {};";
const open = (s) => openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, 1500, { indexedDB: new IDBFactory() });
// another till sold 15 pieces: the server now says 25
const serverSays = (s, qty) => {
  const k = 'pos-data:state:C1', cur = s.kv.data.get(k), st = JSON.parse(cur.value);
  st.inventory.find((r) => r.code === 'A').qty = qty; st.inventory.find((r) => r.code === 'A')._sq = qty; st.updatedAt = Date.now() + 5000;
  s.kv.data.set(k, { ...cur, value: JSON.stringify(st) });
};

test('a stuck phone takes the server stock figure when "Refresh stock" runs, and keeps everything else it holds', async () => {
  const s = makeServer({ d1: true });
  const d = await open(s);
  try {
    const w = d.w; w.eval(QUIET);
    assert.equal(w.eval('inventory.find(p => p.code === "A").qty'), 40);
    w.eval("inventory.find(p => p.code === 'A').name = 'Alpha Soap (my edit)'");   // an unsent local edit must survive
    serverSays(s, 25);
    w.eval('window.__pushFailed = true');                                          // stuck: a push was refused
    assert.equal(w.eval('hasUnsyncedWork()'), true);
    const n = await w.eval('PSR.refresh("test", { force: true })');
    assert.ok(n >= 1, 'at least one figure changed, got ' + n);
    assert.equal(w.eval('inventory.find(p => p.code === "A").qty'), 25, 'stock now matches the server');
    assert.equal(w.eval('inventory.find(p => p.code === "A").name'), 'Alpha Soap (my edit)', 'the unsent edit was not wiped');
    assert.equal(w.document.getElementById('psr-bar'), null, 'zip 379: no stock bar on screen');
  } finally { d.close(); }
});

test('zip 379: no bar or button - the silent refresh takes the new figure, and answers -1 when the server cannot be reached', async () => {
  const s = makeServer({ d1: true });
  const d = await open(s);
  try {
    const w = d.w; w.eval(QUIET);
    serverSays(s, 31);
    assert.equal(w.document.getElementById('psr-btn'), null, 'no button on screen');
    w.eval('PSR.refresh("test", { force: true })');
    assert.ok(await until(() => w.eval('inventory.find(p => p.code === "A").qty') === 31, 10000), 'the refresh pulled the new figure');
    s.state.down = true; await sleep(50);
    const n = await w.eval('PSR.refresh("test", { force: true })');
    assert.equal(n, -1, 'cannot reach the server');
    assert.equal(w.document.getElementById('psr-bar'), null, 'and still nothing on screen');
  } finally { s.state.down = false; d.close(); }
});
