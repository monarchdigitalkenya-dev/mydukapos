import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 374: the delivery guard - orders / bills must not silently stop arriving.
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];
const base = { now: 1000000, lastOk: 1000000, unsyncedSince: 0, hidden: false, online: true, lastKick: 0, lastReconnect: 0, lastReset: 0 };

test('decide: healthy does nothing; stale escalates pull -> reconnect -> reset; hidden never acts', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w; const D = (o) => J(w, `DeliveryGuard.decide(${JSON.stringify({ ...base, ...o })})`);
    let r = D({}); assert.deepEqual([r.state, r.pull, r.reconnect, r.reset], ['ok', false, false, false]);
    r = D({ lastOk: base.now - 31000 }); assert.equal(r.pull, true, '30 s without an answer: ask the server even if the socket looks healthy'); assert.equal(r.state, 'warn'); assert.equal(r.reconnect, false);
    r = D({ lastOk: base.now - 50000 }); assert.equal(r.reconnect, true, '45 s: throw the connection away and open a new one');
    r = D({ lastOk: base.now - 61000 }); assert.equal(r.state, 'stale');
    r = D({ lastOk: base.now - 61000, online: false }); assert.equal(r.state, 'offline');
    r = D({ lastOk: base.now - 100000 }); assert.equal(r.reset, true, '90 s: clear every pause and back-off');
    r = D({ lastOk: base.now - 100000, lastReset: base.now - 5000 }); assert.equal(r.reset, false, 'but not in a storm');
    r = D({ lastOk: base.now - 100000, lastKick: base.now - 3000, lastReconnect: base.now - 3000 }); assert.equal(r.pull, false, 'no more than one catch-up per 10 s');
    r = D({ unsyncedSince: base.now - 45000 }); assert.equal(r.push, true, 'an unsent change for 40 s is pushed again');
    r = D({ lastOk: base.now - 500000, hidden: true }); assert.deepEqual([r.pull, r.reconnect, r.reset, r.state], [false, false, false, 'ok']);
  } finally { d.close && d.close(); }
});

test('live: a successful pull is noted, a silent one forces a catch-up and reconnect - and (zip 378) shows NOTHING on screen', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    assert.equal(w.eval('typeof DeliveryGuard'), 'object');
    assert.equal(w.eval('typeof window.pullState'), 'function');
    assert.equal(w.eval('!!window.fetch.__dg'), true, 'server answers are watched');
    w.eval('DeliveryGuard._S.lastOk = 1'); w.eval("DeliveryGuard.noteFetch(SYNC_URL + '?since=5', 'POST', 200)"); assert.equal(w.eval('DeliveryGuard._S.lastOk'), 1, 'a push does not count as hearing from the server');
    w.eval("DeliveryGuard.noteFetch(SYNC_URL + '?since=5', 'GET', 503)"); assert.equal(w.eval('DeliveryGuard._S.lastOk'), 1, 'a server error does not count');
    w.eval("DeliveryGuard.noteFetch(SYNC_URL + '?since=5', 'GET', 200)"); assert.ok(w.eval('DeliveryGuard._S.lastOk') > 1000, 'an answered pull counts');
    w.eval(`(function(){ window.__t = { pulls: 0, conn: 0 }; var f = window.flushThenPull; window.flushThenPull = function(){ window.__t.pulls++; }; var c = window.connectSyncSocket; window.connectSyncSocket = function(){ window.__t.conn++; };
      DeliveryGuard._S.lastOk = Date.now() - 70000; try { pollTimer = pollTimer || 1; } catch (e) {} DeliveryGuard._S.lastKick = 0; DeliveryGuard._S.lastReconnect = 0; DeliveryGuard._S.lastReset = Date.now(); })()`);
    w.eval('DeliveryGuard.tick()');
    await new Promise((r) => setTimeout(r, 700));
    const t = J(w, 'window.__t'); assert.equal(t.pulls, 1, 'catch-up asked'); assert.equal(t.conn, 1, 'new connection opened');
    assert.equal(w.document.getElementById('dg-bar'), null, 'zip 378: no red bar');
    assert.equal(w.document.getElementById('dg-pill'), null, 'zip 378: no status pill');
  } finally { d.close && d.close(); }
});

test('every app carries the guard; keep-awake can be turned off and the choice is kept', async () => {
  const fs = await import('node:fs');
  for (const a of APPS) assert.ok(fs.readFileSync(a, 'utf8').includes('window.DeliveryGuard = {'), a + ' carries the guard');
  for (const a of ['index.html']) {
    const d = await boot(a, { storage: { pos_biz_name: 'Biz' }, wait: 600 });
    try { assert.equal(d.w.eval('typeof DeliveryGuard'), 'object', a); assert.equal(d.w.document.getElementById('dg-pill'), null, a + ' no pill (zip 378)'); }
    finally { d.close && d.close(); }
  }
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 600 });
  try { d.w.eval('DeliveryGuard.setKeepAwake(false)'); assert.equal(d.w.localStorage.getItem('pos_keepawake_v1'), '0'); }
  finally { d.close && d.close(); }
});
