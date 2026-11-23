import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// zip 335: fewer wasted writes and calls (print relay), a default time limit on API calls, and no full push on every focus when nothing is waiting.

test('print relay: an empty poll and a quick second heartbeat write nothing to KV', async () => {
  const { makeKV, seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1');
  let puts = 0; const realPut = kv.put.bind(kv); kv.put = (...a) => { puts++; return realPut(...a); };
  const env = { mydukapos_kv: kv };
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/print-relay.js')).href);
  const call = async (body) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/print-relay?c=C1', { method: 'POST', body: JSON.stringify(body) }), env })).json();
  await call({ action: 'registerDevice', deviceId: 'dev-p', name: 'Printer', station: 'Front Counter', printerMode: 'usb', hasPrinter: true, acceptsRelay: true });
  await call({ action: 'poll', deviceId: 'dev-p' });
  const before = puts;
  for (let i = 0; i < 5; i++) assert.deepEqual((await call({ action: 'poll', deviceId: 'dev-p' })).jobs, []);
  await call({ action: 'heartbeat', deviceId: 'dev-p' });
  assert.equal(puts, before, 'empty polls / quick heartbeat must not write');
  // a job still gets through and is claimed (this does write)
  assert.equal((await call({ action: 'submit', jobType: 'receipt', text: 'R1' })).ok, true);
  const jobs = (await call({ action: 'poll', deviceId: 'dev-p' })).jobs;
  assert.deepEqual(jobs.map((j) => j.text), ['R1']);
  // the device still shows online
  const list = (await call({ action: 'listDevices' })).devices;
  assert.equal(list.find((d) => d.deviceId === 'dev-p').online, true);
});

test('legacy (Aqua) poller with no deviceId is still registered as online', async () => {
  const { makeKV, seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/print-relay.js')).href);
  const call = async (body) => (await m.onRequestPost({ request: new Request('https://x.pages.dev/api/print-relay?c=C1', { method: 'POST', body: JSON.stringify(body) }), env })).json();
  await call({ action: 'poll' });
  await call({ action: 'poll' });
  const list = (await call({ action: 'listDevices' })).devices;
  assert.equal(list.length, 1); assert.equal(list[0].online, true);
});

test('every app: focus / reconnect pushes only when something is waiting (or 5 minutes passed); API calls get a default time limit', () => {
  for (const app of ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
    const s = fs.readFileSync(path.join(ROOT, app), 'utf8');
    assert.match(s, /mustPush = hasUnsyncedWork\(\) \|\| \(window\.__ftpN = \(window\.__ftpN \|\| 0\) \+ 1\) <= 5 \|\| \(Date\.now\(\) - \(window\.__ftpLastPush \|\| 0\)\) > 300000/, app + ' push guard');
    assert.match(s, /if \(mustPush\)/, app);
    assert.match(s, /dlCtl = new AbortController\(\)/, app + ' default timeout');
    assert.match(s, /25000\)/, app);
    assert.match(s, /window\.__pullJit/, app + ' retry spread');
  }
});
