import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 260: the 7 s timer only goes to the server when needed - every tick while the live connection is down (the old behaviour), a 45 s safety
// poll while it is healthy (zip 280: healthy = it answered a ping within 45 s; the safety poll is every 30 s), a 5 min check in a hidden tab. A dropped connection returns to fast polling at once.
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html'];
const opened = [];
after(() => { for (const b of opened) { try { b.close(); } catch (e) { /* closed */ } } });

for (const app of APPS) {
  test(`${app}: poll tick backs off only while the live connection is healthy`, async () => {
    const b = await boot(app, { wait: 300 }); opened.push(b); const { w } = b;
    w.eval('window.__n = 0; pullState = function () { window.__n++; window.__pullStartedAt = Date.now(); return Promise.resolve(); }');
    const tick = (agoMs) => { w.eval(`window.__pullStartedAt = Date.now() - ${agoMs}`); const before = w.eval('window.__n'); w.eval('syncPollTick()'); return w.eval('window.__n') - before; };
    // no connection: every tick pulls (old behaviour)
    w.eval('syncSocket = null');
    assert.equal(tick(9000), 1, 'no socket: pull on the tick');   // zip 381: zip 335 spreads the fast poll over 6.5-8 s per device
    assert.equal(tick(2000), 0, 'a pull 2 s ago is enough');
    // healthy socket (open 20 s)
    w.eval('syncSocket = { readyState: 1 }; window.__wsOpenedAt = Date.now() - 20000; window.__wsPongSeen = true; window.__wsLastRxAt = Date.now() - 5000');
    assert.equal(tick(10000), 0, 'healthy: no pull after 10 s');
    assert.equal(tick(25000), 0, 'healthy: no pull after 25 s');
    assert.equal(tick(31000), 1, 'healthy: safety poll after 30 s');
    // open but never answered a ping (an old router, or a half-dead link): not trusted, fast polling
    w.eval('window.__wsPongSeen = false');
    assert.equal(tick(9000), 1, 'no pong yet: still polling fast');
    w.eval('window.__wsPongSeen = true; window.__wsLastRxAt = Date.now() - 60000');
    assert.equal(tick(9000), 1, 'silent for 60 s: still polling fast');
    w.eval('window.__wsLastRxAt = Date.now() - 5000');
    // a socket that only just (re)opened is not trusted yet
    w.eval('window.__wsOpenedAt = Date.now() - 5000');
    assert.equal(tick(10000), 1, 'just reconnected: still polling fast');
    // the connection drops: back to fast polling at once
    w.eval('window.__wsOpenedAt = Date.now() - 20000; syncSocket = { readyState: 3 }');
    assert.equal(tick(9000), 1, 'closed: fast polling again');
    w.eval('syncSocket = { readyState: 0 }');
    assert.equal(tick(9000), 1, 'connecting: fast polling');
    // hidden tab: only a 5 minute check (the foreground catch-up does the rest)
    w.eval("Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); syncSocket = null");
    assert.equal(tick(60000), 0, 'hidden: no pull after 1 min');
    assert.equal(tick(301000), 1, 'hidden: check after 5 min');
    // the timer itself is wired to the tick, not straight to pullState
    assert.match(w.eval('startPolling.toString()'), /setInterval\(syncPollTick, 7000\)/);
  });
}
