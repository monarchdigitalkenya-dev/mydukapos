import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// A database shop sends only a recent window of the big logs. A device must keep the older history it already holds.
const DAY = 86400000;
const rec = (id, age, extra = {}) => ({ id, timestamp: new Date(Date.now() - age * DAY).toISOString(), ...extra });

for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: pulling a recent window keeps the older history this device has, and the server's copy of a record wins`, async () => {
    const { w, errors, close } = await boot(app, { wait: 300 });
    w.eval(`salesLog = ${JSON.stringify([rec('old', 400), rec('shared', 1, { note: 'local' })])}`);
    const data = { updatedAt: 5, salesLog: [rec('shared', 1, { note: 'server' }), rec('brand-new', 0)], inventory: [{ code: 'A' }] };
    const out = JSON.parse(w.eval(`JSON.stringify(preparePulledPayload(${JSON.stringify(data)}))`));
    assert.deepEqual(out.salesLog.map((s) => s.id), ['old', 'shared', 'brand-new'], 'chronological, nothing forgotten');
    assert.equal(out.salesLog.find((s) => s.id === 'shared').note, 'server', 'the server wins on a record both have');
    assert.deepEqual(out.inventory, [{ code: 'A' }], 'everything else passes through untouched');
    assert.equal(w.eval('salesLog.length'), 2, 'the device itself is not changed until the payload is applied');
    assert.deepEqual(errors, []);
    close();
  });
}

test('a payload with no logs, or a device with none, passes through unchanged', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  const a = { updatedAt: 1, staff: [] };
  assert.deepEqual(JSON.parse(w.eval(`JSON.stringify(preparePulledPayload(${JSON.stringify(a)}))`)), a);
  w.eval('salesLog = []');
  const b = { salesLog: [rec('x', 1)] };
  assert.deepEqual(JSON.parse(w.eval(`JSON.stringify(preparePulledPayload(${JSON.stringify(b)}))`)), b);
  assert.equal(w.eval('preparePulledPayload(null)'), null);
  close();
});

for (const [app, pull] of [['index.html', 'pullState'], ['water/index.html', 'pullFromServer']]) {
  test(`${app}: a poke from the server makes the device pull; a message with data is still applied as before`, async () => {
    const { w, close } = await boot(app, { wait: 300 });
    w.WebSocket = class { constructor() { this.readyState = 0; } close() {} };
    w.WebSocket.OPEN = 1; w.WebSocket.CONNECTING = 0;
    w.eval(`window.__pulls = 0; ${pull} = async function () { window.__pulls++; }; connectSyncSocket();`);
    w.eval('window.__pushQueued = false; window.__pushFailed = false');                // nothing unsent
    w.eval("syncSocket.onmessage({ data: JSON.stringify({ poke: true }) })");
    assert.equal(w.eval('window.__pulls'), 1, 'poke -> pull');
    // with an unsent edit the device sends it FIRST, then pulls (so the incoming copy cannot land on top of it)
    w.eval('window.__pushQueued = true; window.__order = []; ' + (pull === 'pullFromServer' ? 'doPush' : 'pushNow') + ' = async function () { window.__order.push("push"); window.__pushQueued = false; return true; }');
    w.eval(`${pull} = async function () { window.__order.push("pull"); }`);
    w.eval("syncSocket.onmessage({ data: JSON.stringify({ poke: true }) })");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(JSON.parse(w.eval('JSON.stringify(window.__order)')), ['push', 'pull'], 'unsent edit first, then the pull');
    w.eval("syncSocket.onmessage({ data: 'not json' })");
    assert.equal(w.eval('window.__pulls'), 1, 'garbage is ignored');
    close();
  });
}
