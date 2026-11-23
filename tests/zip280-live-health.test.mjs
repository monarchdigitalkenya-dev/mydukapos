import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT, until } from './helpers.mjs';

// zip 280 - the back-off of zips 260/261 never took effect (the flag it reads was never set). It now works, but only while the live connection PROVES it is
// alive (a ping answered by the server), and falls back to fast polling the moment it stops answering.
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* closed */ } } });
const fakeSock = () => { const l = []; return { readyState: 1, sent: [], closed: 0, addEventListener(t, f) { l.push(f); }, send(m) { this.sent.push(m); }, close() { this.closed++; this.readyState = 3; }, fire() { l.forEach((f) => f({ data: 'pong' })); } }; };

for (const app of APPS) {
  test(`${app}: a connection is trusted only after it answers a ping, and a silent one is closed (so it reconnects)`, async () => {
    const b = await boot(app, { wait: 300 }); opened.push(b); const { w } = b;
    // the app opens its OWN live connection while it starts up; the fake one is put in only after that, or the app's would replace it
    await until(() => w.document.readyState === 'complete', 20000); await new Promise((r) => setTimeout(r, 1500));
    w.eval('window.__sock = null; connectSyncSocket = function () {};');   // the app's own reconnect would replace the fake connection mid-test
    const s = fakeSock(); w.__s = s; w.eval('syncSocket = window.__s; wsHealthStart(window.__s)');
    await until(() => s.sent.length > 0, 10000);                    // "at once" = its first timer tick; a page still starting up runs it a little later
    assert.deepEqual(s.sent, ['ping'], 'a ping goes out at once');
    assert.equal(w.eval('window.__wsPongSeen'), false, 'not trusted before the first answer');
    s.fire();
    assert.equal(w.eval('window.__wsPongSeen'), true);
    // 50 s of silence from a connection that had answered: closed
    w.eval('window.__wsLastRxAt = Date.now() - 50000; window.__wsPongSeen = true');
    w.eval('clearInterval(window.__wsBeat)'); s.sent.length = 0;
    w.eval('wsHealthStart(window.__s)'); w.eval('window.__wsLastRxAt = Date.now() - 50000; window.__wsPongSeen = true');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(s.closed, 1, 'a connection that went quiet is closed');
    w.eval('clearInterval(window.__wsBeat)');
  });
}

test('every app calls wsHealthStart when its live connection opens', () => {
  for (const f of [...APPS, 'water/index.html']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /syncSocket\.onopen = \(\) => \{[^}]{0,80}wsHealthStart\(syncSocket\)/, f);
});

test('Aqua POS: the same rule (fast while unhealthy, 30 s when healthy, 5 min hidden), wired to the 7 s timer', () => {
  const t = fs.readFileSync(path.join(ROOT, 'water/index.html'), 'utf8');
  assert.match(t, /setInterval\(waterPollTick, 7000\)/);
  assert.match(t, /window\.__wsPongSeen && now - \(window\.__wsLastRxAt \|\| 0\) < 45000/);
  assert.match(t, /let every = live \? 30000 : 6500( \+ \(window\.__pullJit[^;]*)?;/);   // zip 381: zip 335 added a per-device spread
});

test('the router answers ping with pong by itself, and does not break where the runtime lacks the API', async () => {
  const m = await import(path.join(ROOT, 'wildcard-router/worker.js'));
  const pairs = []; globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.request = a; this.response = b; } };
  new m.SyncRoom({ setWebSocketAutoResponse: (p) => pairs.push(p) });
  assert.deepEqual([pairs[0].request, pairs[0].response], ['ping', 'pong']);
  assert.doesNotThrow(() => new m.SyncRoom({}), 'no API: constructs fine, devices just keep polling quickly');
  delete globalThis.WebSocketRequestResponsePair;
  assert.doesNotThrow(() => new m.SyncRoom({ setWebSocketAutoResponse() {} }));
});
