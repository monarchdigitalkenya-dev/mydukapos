import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

// Pushes send only NEW or CHANGED log records (the server merges by id), so a shop with a long history
// doesn't upload the whole history on every sale.
const mkSales = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, timestamp: new Date(1789890000000 + (from + i) * 1000).toISOString(), items: [{ code: '1', qty: 1, price: 10 }], paymentMethod: 'cash', cashAmount: 10 }));

for (const app of ['index.html', 'hotel/index.html', 'water/index.html']) {
  // zip 129: the first push no longer uploads the whole history at once (on a slow line it timed out, was retried in full, and never
  // finished): it goes in batches of 150 sales, the next straight after the last is accepted, until everything is there.
  test(`${app}: the first push goes in batches until everything is sent, then only new/changed records; a failed push resends`, async () => {
    const bodies = [];
    let fail = false;
    const fetch = (u, o) => {
      if (o && o.method === 'POST' && String(u).includes('/api/pos-sync')) {
        bodies.push(JSON.parse(o.body));
        return Promise.resolve(fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) });
      }
      return Promise.reject(new Error('offline'));
    };
    const { w, errors, close } = await boot(app, { fetch, wait: 300 });
    w.eval('showToast = function () {}');
    const push = () => w.eval(app.startsWith('water') ? "pushNowOrWarn('t')" : 'pushNow()');
    w.eval(`salesLog = ${JSON.stringify(mkSales(200))}`);
    bodies.length = 0;
    await push();
    assert.equal(bodies.at(-1).salesLog.length, 150, 'first batch (newest first)');
    await push();
    assert.equal(bodies.at(-1).salesLog.length, 50, 'the rest');
    assert.equal(new Set(bodies.flatMap((b) => b.salesLog.map((s) => s.id))).size, 200, 'all 200, each once');
    await push();
    assert.equal(bodies.at(-1).salesLog.length, 0, 'nothing new -> nothing sent');
    w.eval(`salesLog.push(${JSON.stringify(mkSales(1, 200)[0])})`);
    await push();
    assert.deepEqual(bodies.at(-1).salesLog.map((s) => s.id), ['s200'], 'only the new sale');
    w.eval("salesLog[5].voided = true");
    await push();
    assert.deepEqual(bodies.at(-1).salesLog.map((s) => s.id), ['s5'], 'an old sale that changed (void) is sent');
    // a failed push must not be treated as delivered
    fail = true;
    w.eval(`salesLog.push(${JSON.stringify(mkSales(1, 201)[0])})`);
    await push();
    fail = false;
    await push();
    assert.deepEqual(bodies.at(-1).salesLog.map((s) => s.id), ['s201'], 'the record from the failed push is sent again');
    // a log with an id-less record is sent whole
    w.eval("salesLog.push({ note: 'no id' })");
    await push();
    assert.equal(bodies.at(-1).salesLog.length, 203, 'unmatched records -> whole log, as before');
    assert.deepEqual(errors, []);
    close();
  });
}

test('the server ends up with exactly the same history whether devices push everything or only deltas', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const run = async (mode) => {
    const kv = makeKV(); seedShop(kv, 'C1');
    const env = { mydukapos_kv: kv };
    const post = (b) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ businessName: 'Biz', ...b }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
    let log = mkSales(50);
    let acked = new Map();
    const send = async () => {
      const body = { updatedAt: Date.now(), salesLog: mode === 'delta' ? log.filter((s) => acked.get(s.id) !== JSON.stringify(s)) : log };
      await post(body);
      log.forEach((s) => acked.set(s.id, JSON.stringify(s)));
      return body.salesLog.length;
    };
    const sent = [await send()];
    log = log.concat(mkSales(3, 50)); sent.push(await send());
    log[7] = { ...log[7], voided: true }; sent.push(await send());
    log = log.concat(mkSales(2, 53)); sent.push(await send());
    const state = JSON.parse(kv.data.get('pos-data:state:C1').value);
    return { ids: state.salesLog.map((s) => s.id).sort(), voided: state.salesLog.filter((s) => s.voided).map((s) => s.id), sent };
  };
  const full = await run('full'), delta = await run('delta');
  assert.deepEqual(delta.ids, full.ids);
  assert.deepEqual(delta.voided, full.voided);
  assert.deepEqual(delta.sent, [50, 3, 1, 2], 'deltas are tiny');
  assert.deepEqual(full.sent, [50, 53, 53, 55]);
});
