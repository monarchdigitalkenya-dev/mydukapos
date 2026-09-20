import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Aqua POS: Shop staff request an item from Production; Production's bell shows who asked; dismissing clears it.
test('a Shop request shows in the bell with who asked, and clears when dismissed', async () => {
  const { w, d, errors, close } = await boot('water/index.html', { wait: 300 });
  w.eval('showToast = function () {}');
  w.eval("products = [{ code: 'P1', name: 'Bale 500ml', qty: 0, stock: {}, siteId: 'site-shop-1' }]");
  w.eval("currentServer = { id: 'u1', name: 'Ann' }; isAdminServing = function () { return true; }");
  w.eval("requestStockFromProduction('P1')");
  assert.equal(w.eval("stockRequests.filter(r => r.status === 'pending').length"), 1);
  w.eval('renderLowStockDispatchBanner()');
  assert.equal(d.getElementById('notif-badge').style.display, 'flex');
  assert.match(d.getElementById('notif-list').textContent, /Bale 500ml/);
  assert.match(d.getElementById('notif-list').textContent, /requested by Ann/);
  const id = w.eval('stockRequests[0].id');
  w.eval(`dismissStockRequest('${id}')`);
  assert.doesNotMatch(d.getElementById('notif-list').textContent, /requested by Ann/, 'the request is gone from the bell');
  assert.deepEqual(errors, []);
  close();
});

test('requests merge per record on the server: two tills\' requests both survive, and a dismissed one is not resurrected by a stale device', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const post = (b) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', ...b }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const pull = async () => (await m.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1'), env })).json();
  const t = Date.now();
  await post({ updatedAt: t, stockRequests: [{ id: 'r1', code: 'P1', status: 'pending', updatedAt: t - 100 }] });
  await post({ updatedAt: t + 5, stockRequests: [{ id: 'r2', code: 'P2', status: 'pending', updatedAt: t + 1 }] });          // another till
  assert.deepEqual((await pull()).stockRequests.map((r) => r.id).sort(), ['r1', 'r2'], 'not replaced wholesale');
  await post({ updatedAt: t + 10, stockRequests: [{ id: 'r1', code: 'P1', status: 'fulfilled', updatedAt: t + 8 }] });         // Production dismisses r1
  await post({ updatedAt: t + 12, stockRequests: [{ id: 'r1', code: 'P1', status: 'pending', updatedAt: t - 100 }] });         // stale till still shows it pending
  assert.equal((await pull()).stockRequests.find((r) => r.id === 'r1').status, 'fulfilled');
});
