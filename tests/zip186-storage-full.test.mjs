import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from './helpers.mjs';
import { sleep } from './e2e-harness.mjs';

// zip 186 (item 3): HTTP 507 / code storage_full = the server answered (the internet works) but its storage is full.
// It is shown as that, never as "offline" and never as plain "busy".
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fetch507 = async (url) => {
  const u = String(url);
  if (u.includes('/api/health')) return json({ ok: true, t: Date.now() });
  return json({ error: 'storage full', code: 'storage_full' }, 507);
};

for (const app of ['index.html', 'water/index.html']) test(`${app}: 507 storage_full is online-but-server-full, not offline, not busy`, async () => {
  const t = await boot(app, { fetch: fetch507, wait: 900, indexedDB: new IDBFactory(), storage: {} });
  t.w.__posNetInternetProbe = async () => true;
  t.w.eval("showToast = function () {}");
  t.w.eval("PosNet.reportHttp(507, 'storage_full')");
  assert.equal(t.w.eval('PosNet.state'), 'config_error');
  assert.equal(t.w.eval('PosNet._state.detail'), 'storage_full');
  assert.match(t.w.eval('PosNet.message()'), /storage is full/i);
  assert.doesNotMatch(t.w.eval('PosNet.message()'), /offline/i);
  t.w.eval("PosNet.reportHttp(507, '')");                               // a bare 507 with no code
  assert.equal(t.w.eval('PosNet._state.detail'), 'storage_full');
  t.w.eval("PosNet.reportHttp(200)");                                    // space freed: any good answer heals it
  assert.equal(t.w.eval('PosNet.state'), 'online');
  t.w.eval("PosNet.reportHttp(503, '')");                                // a plain 5xx is still just busy, never offline
  assert.notEqual(t.w.eval('PosNet.state'), 'offline');
  t.close();
});
