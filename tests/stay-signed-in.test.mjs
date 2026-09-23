import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The "Who's logging in?" screen used to come back after ANY reload of the page (a phone dropping the app to free memory, an installed app reopened, a refresh, an update).
// A successful login is now remembered on the device (never the password) and the picker is skipped while it is fresh.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapshot = (w) => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };
const screenUp = (d) => ['login-screen', 'registration-screen'].some((id) => { const el = d.getElementById(id); return el && el.style.display !== 'none' && el.style.display !== ''; });

async function firstVisit(app) {
  const aqua = app.startsWith('water');
  const PW = aqua ? 'aqua_pw_hash' : 'pos_pw_hash', ST = aqua ? 'aqua_staff' : 'pos_staff';
  // pos_stay_signed_in: '1' — the feature is OFF by default (a shop opts in
  // per device from Settings), so these tests, which are specifically about
  // what happens WHILE it's on, turn it on in the initial storage rather
  // than relying on a default that no longer exists. The dedicated
  // "off by default" test below covers the actual default.
  const b = await boot(app, { storage: { [aqua ? 'aqua_biz_name' : 'pos_biz_name']: 'Demo Shop', pos_owner_name: 'Sam', pos_stay_signed_in: '1' }, wait: 1500 });
  const { w, d } = b;
  await w.eval("(async () => { safeSetItem('" + PW + "', await hashPassword('secret123')); safeSetItem('" + ST + "', JSON.stringify([{ id: 's1', name: 'Jane', pinHash: await hashPassword('1234'), roles: [] }, { id: 's2', name: 'Peter', pinHash: await hashPassword('5678'), roles: [] }])); staff = JSON.parse(localStorage.getItem('" + ST + "')); })()");
  await sleep(100);
  w.eval("document.getElementById('registration-screen').style.display = 'none'; document.getElementById('login-screen').style.display = 'flex'; showLoginPickerStep()");
  return b;
}
const adminLogin = async (b) => { b.w.eval('selectLoginAdmin()'); b.d.getElementById('login-password-input').value = 'secret123'; await b.w.eval('loginSubmit()'); };

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'water/index.html']) {
  test(`${app}: after logging in as Admin the picker does not come back when the page is reloaded`, async () => {
    const a = await firstVisit(app);
    assert.ok(screenUp(a.d), 'a first visit shows the picker');
    await adminLogin(a);
    assert.ok(!screenUp(a.d));
    const saved = JSON.parse(a.w.localStorage.getItem('pos_session_keep'));
    assert.equal(saved.role, 'admin'); assert.ok(!JSON.stringify(saved).includes('secret123'), 'the password is never stored');
    const store = snapshot(a.w); await sleep(1500); a.close();       // (let the app finish its own start-up before the page is closed)
    const b = await boot(app, { storage: store, wait: 1800 });          // "reload": a brand-new page with the same device storage
    assert.ok(!screenUp(b.d), 'no login screen after the reload');
    assert.equal(b.w.eval('currentServer'), null, 'signed in as Admin');
    assert.equal(b.w.eval('window.__adminAuthed'), true);
    assert.deepEqual(b.errors, []);
    await sleep(1500);
    b.close();
  });
}

test('a staff member stays signed in too (as themselves), Clock out ends it, and the picker then returns', async () => {
  const a = await firstVisit('hotel/index.html');
  const { w, d } = a;
  w.eval("selectLoginStaff('s1')"); d.getElementById('login-staffpin-input').value = '1234'; await w.eval('submitLoginStaffPin()');
  assert.equal(w.eval('currentServer.name'), 'Jane');
  let saved = JSON.parse(w.localStorage.getItem('pos_session_keep')); assert.deepEqual([saved.role, saved.id], ['staff', 's1']);
  const b = await boot('hotel/index.html', { storage: snapshot(w), wait: 1800 });
  assert.ok(!screenUp(b.d)); assert.equal(b.w.eval('currentServer && currentServer.name'), 'Jane', 'still Jane, with her tabs');
  // clocking out ends the session: no auto-resume, and a reload shows the picker
  b.w.eval('logoutServer()');
  assert.equal(b.w.localStorage.getItem('pos_session_keep'), null);
  assert.ok(screenUp(b.d), 'after Clock out the picker is back');
  const c = await boot('hotel/index.html', { storage: snapshot(b.w), wait: 1500 });
  assert.ok(screenUp(c.d), 'and it stays until someone logs in');
  a.close(); b.close(); c.close();
});

test('it ends when it should: too long idle, password changed, staff removed or locked, or the switch turned off', async () => {
  const a = await firstVisit('hotel/index.html');
  const { w, d } = a;
  await adminLogin(a);
  const good = snapshot(w);
  const tryBoot = async (store) => { const x = await boot('hotel/index.html', { storage: store, wait: 1500 }); const up = screenUp(x.d); x.close(); return up; };
  assert.equal(await tryBoot(good), false, 'baseline: resumes');
  assert.equal(await tryBoot({ ...good, pos_session_keep: JSON.stringify({ ...JSON.parse(good.pos_session_keep), at: Date.now() - 13 * 3600 * 1000 }) }), true, 'idle for 13 hours: log in again');
  assert.equal(await tryBoot({ ...good, pos_pw_hash: 'a-different-password-hash' }), true, 'the password changed: everyone signs in again');
  assert.equal(await tryBoot({ ...good, pos_stay_signed_in: '0' }), true, 'the switch is off: always ask');
  // a staff session for someone who has since been removed
  const staff = JSON.parse(good.pos_staff); staff[0].removed = true;
  assert.equal(await tryBoot({ ...good, pos_staff: JSON.stringify(staff), pos_session_keep: JSON.stringify({ at: Date.now(), fp: good.pos_pw_hash, role: 'staff', id: 's1', name: 'Jane' }) }), true, 'a removed staff member is not resumed');
  // the switch in Settings ▸ Security & Access exists and works
  assert.ok(d.getElementById('stay-signed-in-toggle'));
  d.getElementById('stay-signed-in-toggle').checked = false; d.getElementById('stay-signed-in-toggle').onchange();
  assert.equal(w.localStorage.getItem('pos_stay_signed_in'), '0'); assert.equal(w.localStorage.getItem('pos_session_keep'), null, 'turning it off forgets the session');
  a.close();
});

test('a wrong password never creates a session; a plain first visit still shows the picker', async () => {
  const a = await firstVisit('index.html');
  a.w.eval('selectLoginAdmin()'); a.d.getElementById('login-password-input').value = 'nope'; await a.w.eval('loginSubmit()');
  assert.equal(a.w.localStorage.getItem('pos_session_keep'), null);
  assert.ok(screenUp(a.d));
  a.close();
});

test('off by default: a device that never touched the setting does not resume, even right after a successful login', async () => {
  const b = await boot('index.html', { storage: { pos_biz_name: 'Demo Shop', pos_owner_name: 'Sam' }, wait: 1500 }); // no pos_stay_signed_in at all — a genuinely untouched device
  const { w, d } = b;
  await w.eval("(async () => { safeSetItem('pos_pw_hash', await hashPassword('secret123')); })()");
  await sleep(100);
  w.eval("document.getElementById('registration-screen').style.display = 'none'; document.getElementById('login-screen').style.display = 'flex'; showLoginPickerStep()");
  assert.equal(w.localStorage.getItem('pos_stay_signed_in'), null, 'genuinely untouched, not merely falsy');
  w.eval('selectLoginAdmin()'); d.getElementById('login-password-input').value = 'secret123'; await w.eval('loginSubmit()');
  assert.ok(!screenUp(d), 'logged in fine this once');
  assert.equal(w.localStorage.getItem('pos_session_keep'), null, 'but nothing was remembered — the setting was never turned on');
  const store = snapshot(w); await sleep(1500); b.close();
  const c = await boot('index.html', { storage: store, wait: 1800 }); // "reload"
  assert.ok(screenUp(c.d), 'the picker is back — off by default means off, not "on until explicitly disabled"');
  c.close();
});
