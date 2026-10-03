import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// "It says Syncing / Offline although there is internet, and a hard refresh (or several) is needed to get Online."
// The badge must follow whether the server actually answers, and recover by itself.
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
// The indicator is a dot with no words: its title says what it shows. It changes calmly (a moment's delay), so the tests shorten that delay.
const badge = (dev) => String(dev.w.document.getElementById('sync-status').title || '');
const dot = async (dev) => { await sleep(150); return badge(dev); };
const bad = () => new TypeError('Failed to fetch');
const APPS = ['index.html', 'hotel/index.html'];

async function device(app, hooks = {}, storage = {}) {
  const s = makeServer();
  const state = { down: false, delayGet: 0, getStatus: 0, postStatus: 0, hangPost: false };
  const wrapped = async (url, opts = {}) => {
    if (state.down) throw bad();
    const method = (opts.method || 'GET').toUpperCase();
    const isProbe = String(url).includes('since=99999999999999');
    if (method === 'POST' && state.hangPost) return new Promise((_, rej) => opts.signal && opts.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    if (method === 'GET' && !isProbe && state.getStatus) return { ok: false, status: state.getStatus, json: async () => ({}) };
    if (method === 'POST' && state.postStatus) return { ok: false, status: state.postStatus, json: async () => ({}) };
    if (method === 'GET' && !isProbe && state.delayGet) {
      await new Promise((resolve, rej) => { const t = setTimeout(resolve, state.delayGet); if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }); });
    }
    return s.fetch(url, opts);
  };
  const dev = await openDevice(app, { fetch: wrapped, serverState: s.serverState, env: s.env }, storage, 2500);
  dev.w.eval("showToast = function () {}; window.__syncDotOfflineMs = 40; window.__syncDotDelayMs = 40");
  return { dev, s, state };
}

for (const app of APPS) {
  test(`${app}: after a dropped connection the badge comes back to Online by itself, even while the retry wait is long — no refresh`, async () => {
    const { dev, s, state } = await device(app);
    await dev.w.eval('pushNow()'); await dev.w.eval('pullState()');
    assert.match(await dot(dev), /Online/);
    state.down = true;
    dev.w.eval("paymentDetails = 'Till 5'; safeSetItem('pos_payment_details', paymentDetails); queuePush()");
    await dev.w.eval('pushNow()');
    assert.match(await dot(dev), /Offline/, 'really offline: says so');
    dev.w.eval('window.__pushFails = 6; window.__pushBackoffUntil = Date.now() + 60000');          // a long wait after repeated failures
    state.down = false;                                                                           // the internet is back
    await dev.w.eval('pullState()');                                                              // the very next poll
    assert.match(await dot(dev), /Online/, 'Online at once, not after the wait');
    assert.equal(s.serverState().paymentDetails, 'Till 5', 'and the change made while offline reached the server');
    dev.close();
  });
}

test('a pull slower than the old 3.5 s limit (a cold server, a slow mobile line) ends Online, not Offline', async () => {
  const { dev, s, state } = await device('index.html');
  await dev.w.eval('pushNow()');
  dev.w.eval("paymentDetails = 'Till 9'; safeSetItem('pos_payment_details', paymentDetails)"); await dev.w.eval('pushNow()');
  const other = await device('index.html');                                                        // (separate shop — this one only proves the timing)
  state.delayGet = 4500;
  dev.w.localStorage.setItem('pos_last_synced_at', '0');                                          // a full pull, as on a fresh load
  dev.w.eval("paymentDetails = ''");
  await dev.w.eval('pullState()');
  assert.match(await dot(dev), /Online/, 'waited long enough for the answer');
  assert.equal(dev.w.eval('paymentDetails'), 'Till 9', 'and applied it');
  dev.close(); other.dev.close();
});

test('a pull that runs out of patience while the server is reachable says Syncing and retries with more time, then ends Online', async () => {
  const { dev, state } = await device('index.html');
  await dev.w.eval('pushNow()'); await dev.w.eval('pullState()');
  dev.w.localStorage.setItem('pos_last_synced_at', '0');
  state.delayGet = 700; dev.w.eval('window.__pullTimeoutMs = 150');
  await dev.w.eval('pullState()');                                                                // first try aborts at 150 ms
  assert.match(await dot(dev), /Syncing/, 'not "Offline": the server answers, it is only slow');
  assert.ok(await until(() => /Online/.test(badge(dev)), 20000), 'patience doubled (300, 600, 1200 ms) until it got through');
  dev.close();
});

test('a server error is "Sync Error", not "Offline"; only no answer at all is Offline', async () => {
  const { dev, state } = await device('index.html');
  await dev.w.eval('pushNow()'); await dev.w.eval('pullState()');
  state.getStatus = 503;
  await dev.w.eval('pullState()');
  assert.match(await dot(dev), /Sync problem/);
  state.getStatus = 0; state.down = true;
  await dev.w.eval('pullState()');
  assert.match(await dot(dev), /Offline/);
  dev.close();
});

test('a push that never gets an answer gives up (it does not sit on "Syncing…" forever) and frees the queue', async () => {
  const { dev, state } = await device('index.html');
  await dev.w.eval('pushNow()');
  state.hangPost = true; dev.w.eval('window.__pushTimeoutMs = 300');
  dev.w.eval("paymentDetails = 'Till 3'; safeSetItem('pos_payment_details', paymentDetails)");
  const ok = await dev.w.eval('pushNow()');
  assert.equal(ok, false);
  // a pull that was already on its way sends the unsent change first (one more try, as designed: "no answer" is not delayed); let that try give up too
  await sleep(900);
  await until(() => !(dev.w.eval('window.__pushInFlight') > 0) && !dev.w.eval('window.__pullInFlight'), 8000);
  assert.doesNotMatch(await dot(dev), /Syncing/);
  assert.equal(dev.w.eval('window.__pushInFlight'), 0, 'nothing is left "in flight"');
  state.hangPost = false; dev.w.eval('window.__pushBackoffUntil = 0');
  assert.equal(await dev.w.eval('pushNow()'), true, 'and the next attempt goes through');
  dev.close();
});

test('the browser\'s navigator.onLine saying "offline" is only a hint: if the server answers, the badge says Online', async () => {
  const { dev } = await device('index.html');
  await dev.w.eval('pushNow()');
  Object.defineProperty(dev.w.navigator, 'onLine', { get: () => false, configurable: true });
  await dev.w.eval('pullState()');
  assert.match(await dot(dev), /Online/);
  dev.close();
});

test('Aqua POS: a dropped connection recovers to Online on the next poll, a slow pull ends Online, a server error is a Sync Error', async () => {
  const { dev, s, state } = await device('water/index.html');
  await dev.w.eval('doPush()'); await dev.w.eval('pullFromServer()');
  assert.match(await dot(dev), /Online/);
  state.down = true;
  dev.w.eval("queuePush && queuePush()");
  await dev.w.eval('doPush()');
  assert.match(await dot(dev), /Offline/);
  dev.w.eval('window.__pushFails = 6; window.__pushBackoffUntil = Date.now() + 60000; window.__pushFailed = true');
  state.down = false;
  await dev.w.eval('pullFromServer()');
  assert.match(await dot(dev), /Online/, 'no refresh needed');
  state.getStatus = 503;
  await dev.w.eval('pullFromServer()');
  assert.match(await dot(dev), /Sync problem/);
  state.getStatus = 0; state.delayGet = 4500;
  dev.w.localStorage.setItem('aqua_last_synced_at', '0');
  await dev.w.eval('pullFromServer()');
  assert.match(await dot(dev), /Online/, 'a pull slower than 3.5 s');
  dev.close();
});
