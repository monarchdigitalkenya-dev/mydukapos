import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, sleep, closeWhenIdle } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// zip 162, job 6: a FRESH water phone (nothing in storage) opening ?invite= or ?staff= must land on that link's own screen after its first sync.
const APP = 'water/index.html';
const disp = (d, id) => d.getElementById(id).style.display;

async function seeded() {
  const server = makeServer({ d1: true });
  const a = await openDevice(APP, server, {}, 600);
  a.w.eval(`businessName = 'Aqua Shop'; safeSetItem('aqua_biz_name', businessName); safeSetItem('aqua_pw_hash', 'pwh'); safeSetItem('aqua_admin_pw_hash', 'awh');
    staff = [{ id: 'st-w1', name: 'Wanjiru', pinHash: 'p1', roles: [], updatedAt: Date.now() }];
    pendingInvites = [{ token: 'tokw1', name: 'Joe', roles: [], updatedAt: Date.now() }];
    saveAllLocal();`);
  await a.w.eval("pushNowOrWarn('seed')");
  await sleep(200);
  await closeWhenIdle(a);
  return server;
}

test('water: fresh device + ?invite= shows the invite screen after its first sync', { timeout: 60000 }, async () => {
  const server = await seeded();
  assert.ok((server.serverState().pendingInvites || []).length === 1, 'the invite reached the server');
  const b = await openDevice(APP, server, {}, 300, { url: 'https://demo.mydukapos.store/?invite=tokw1' });
  assert.ok(await until(() => disp(b.d, 'invite-screen') === 'flex', 8000), 'invite screen up; registration=' + disp(b.d, 'registration-screen') + ' login=' + disp(b.d, 'login-screen'));
  assert.equal(b.d.getElementById('invite-staff-name').innerText, 'Joe');
  assert.notEqual(disp(b.d, 'login-screen'), 'flex');
  await closeWhenIdle(b);
});

test('water: fresh device + ?staff= shows that person\'s PIN screen after its first sync', { timeout: 60000 }, async () => {
  const server = await seeded();
  const b = await openDevice(APP, server, {}, 300, { url: 'https://demo.mydukapos.store/?staff=st-w1' });
  assert.ok(await until(() => disp(b.d, 'staff-login-screen') === 'flex', 8000), 'PIN screen up; registration=' + disp(b.d, 'registration-screen') + ' login=' + disp(b.d, 'login-screen'));
  assert.equal(b.d.getElementById('staff-login-name').innerText, 'Wanjiru');
  await closeWhenIdle(b);
});

test('water: two overlapping pushes both succeed and the in-flight counter returns to 0', { timeout: 60000 }, async () => {
  const server = makeServer({ d1: true });
  const a = await openDevice(APP, server, {}, 600);
  a.w.eval("safeSetItem('aqua_pw_hash','x'); businessName='S'; showToast = function(){}");
  await sleep(100);
  const before = server.state.log.filter((l) => l.startsWith('POST')).length;
  const p = await Promise.all([a.w.eval("pushNowOrWarn('a')"), a.w.eval("pushNowOrWarn('b')")]);
  const posts = server.state.log.filter((l) => l.startsWith('POST')).length - before;
  assert.ok(posts >= 1 && posts <= 2, 'two overlapping pushes send at most two requests, posts=' + posts);
  assert.ok(p.every((x) => x !== false), 'both report success');
  assert.equal(a.w.eval('window.__pushInFlight'), 0, 'in-flight counter returns to 0');
  await closeWhenIdle(a);
});
