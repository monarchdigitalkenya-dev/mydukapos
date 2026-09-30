import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, APPS } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';

// zip 161 - "Generate Invite Link is really hanging, I have to press it several times, and the Open button after the PIN too".
// Causes found (real Chromium + real server code): no feedback while the push waited (pre-pull up to 8 s, slow server, 503 "busy" retried 2 x ~1.5-2 s),
// every extra press pushed ANOTHER pending invite (5 presses = 5 invites), a pull landing meanwhile could replace the list and lose the invite, the invited
// person's "Create My Account" froze the same way, and a phone opening ?invite= before it had ever synced showed the normal login.
// These tests run the REAL app in jsdom against the REAL server code (fake KV / D1).

const INVITE_BTN = 'button[onclick^="generateInviteLink"]';
const posts = (server) => server.state.log.filter((l) => l.startsWith('POST')).length;

// a server whose answers can be slowed down, or refused with 503 "busy"
function shaky() {
  const server = makeServer({ d1: true });
  const ctl = { getDelay: 0, postDelay: 0, busy: 0, always503: false };
  const inner = server.fetch;
  server.fetch = async (url, opts = {}) => {
    const m = (opts.method || 'GET').toUpperCase();
    const sync = String(url).includes('/api/pos-sync');
    if (sync && m === 'GET' && ctl.getDelay) await sleep(ctl.getDelay);
    if (sync && m === 'POST' && ctl.postDelay) await sleep(ctl.postDelay);
    if (sync && m === 'POST' && (ctl.always503 || ctl.busy > 0)) {
      if (!ctl.always503) ctl.busy--;
      server.state.log.push('POST(503)');
      return new Response('{"error":"busy","code":"fence_busy"}', { status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '1' } });
    }
    return inner(url, opts);
  };
  return { server, ctl };
}
const seedShop = { pos_biz_name: 'Shop', pos_pw_hash: 'x' };
async function shop(app = 'index.html', s = shaky(), wait = 1200) {
  const dev = await openDevice(app, s.server, seedShop, wait);
  dev.w.eval("window.__toasts = []; const _st = showToast; showToast = function (m, e) { window.__toasts.push(m); return _st.apply(this, arguments); }");
  return { dev, ...s, w: dev.w, d: dev.d };
}
const fill = (d, name = 'Jane') => { d.getElementById('new-staff-name-input').value = name; };
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
const live = (d) => d.getElementById('invite-link-text').getAttribute('data-live');

test('5 rapid presses make exactly ONE invite and ONE push; the button answers at once (busy label, link box) and ends Ready', async () => {
  const { dev, server, ctl, w, d } = await shop();
  ctl.postDelay = 700;
  fill(d);
  const before = posts(server);
  const btn = d.querySelector(INVITE_BTN);
  const label = btn.textContent;
  const t0 = Date.now();
  btn.click();
  const took = Date.now() - t0;
  // right after the FIRST press, before anything has come back from the server:
  assert.ok(took < 300, `the press returns at once (${took} ms)`);
  assert.equal(btn.disabled, true, 'button disabled at once');
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(btn.textContent, 'Generating…');
  assert.equal(d.getElementById('invite-link-result').style.display, 'block', 'the link box is there at once');
  assert.equal(live(d), '0', 'but the link is NOT released yet');
  assert.match(d.getElementById('invite-link-status-msg').textContent, /Making it live/);
  assert.equal(d.querySelector('#invite-link-result button[onclick^="copyInviteLink"]').disabled, true, 'Copy waits for Ready');
  assert.equal(d.getElementById('invite-link-open').getAttribute('aria-disabled'), 'true', 'Open waits for Ready');
  for (let i = 0; i < 4; i++) { fill(d); btn.click(); await sleep(40); }          // four more presses while the first is running (even with the name typed again)
  assert.ok(await until(() => live(d) === '1'), 'ends Ready');
  await sleep(300);
  assert.equal(w.eval('pendingInvites.length'), 1, 'exactly one pending invite');
  assert.equal(posts(server) - before, 1, 'exactly one push');
  assert.equal(server.serverState().pendingInvites.length, 1, 'and the server has it');
  assert.equal(server.serverState().pendingInvites[0].token, w.eval('pendingInvites[0].token'));
  assert.equal(btn.disabled, false, 'restored');
  assert.equal(btn.textContent, label);
  assert.equal(btn.hasAttribute('aria-busy'), false);
  dev.close();
});

test('Open: a real link with its href set before it is enabled, target=_blank rel=noopener; Copy enabled too - on the first press', async () => {
  const { dev, w, d } = await shop();
  fill(d);
  d.querySelector(INVITE_BTN).click();
  const open = d.getElementById('invite-link-open');
  const token = w.eval('pendingInvites[0].token');
  assert.match(open.getAttribute('href'), new RegExp(`\\?invite=${token}$`), 'href is there before it is enabled');
  assert.equal(open.getAttribute('aria-disabled'), 'true');
  assert.ok(await until(() => live(d) === '1'));
  assert.equal(open.getAttribute('aria-disabled'), 'false');
  assert.equal(open.getAttribute('target'), '_blank');
  assert.match(open.getAttribute('rel'), /noopener/);
  assert.equal(open.getAttribute('href'), d.getElementById('invite-link-text').value);
  assert.equal(d.querySelector('#invite-link-result button[onclick^="copyInviteLink"]').disabled, false);
  // pressing Open while it is not released does nothing but explain (the click is cancelled)
  w.eval("inviteUiSet('retry', 'x')");
  let cancelled = false;
  open.addEventListener('click', (e) => { cancelled = e.defaultPrevented; }, { once: false });
  open.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(cancelled, true, 'not released: the click is cancelled');
  dev.close();
});

test('a slow server: the box says "Making it live", the wait is bounded, and the link is released only when the server has it', async () => {
  const { dev, server, ctl, w, d } = await shop();
  ctl.postDelay = 1500;
  fill(d);
  d.querySelector(INVITE_BTN).click();
  await sleep(600);
  assert.equal(live(d), '0', 'still not released at 0.6 s');
  assert.equal(server.serverState().pendingInvites?.length || 0, 0, 'and it really is not on the server yet');
  assert.ok(await until(() => live(d) === '1', 8000));
  assert.equal(server.serverState().pendingInvites.length, 1, 'released = on the server');
  dev.close();
});

test('the server answers 503 busy twice: it is retried visibly and ends Ready within the bound, still one invite', async () => {
  const { dev, server, ctl, w, d } = await shop();
  ctl.busy = 2;
  fill(d);
  const t0 = Date.now();
  d.querySelector(INVITE_BTN).click();
  let sawRetryText = false;
  const seen = () => { const m = d.getElementById('invite-link-status-msg'); if (m && /busy — trying again/.test(m.textContent)) sawRetryText = true; };
  const obs = new d.defaultView.MutationObserver(seen);
  obs.observe(d.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const ok = await until(() => { seen(); return live(d) === '1'; }, 15000);
  obs.disconnect();
  assert.ok(ok, 'Ready after two busy answers');
  assert.ok(sawRetryText, 'the retry was shown, not silent');
  assert.ok(Date.now() - t0 < 12500, 'within the bound');
  assert.equal(w.eval('pendingInvites.length'), 1);
  assert.equal(server.serverState().pendingInvites.length, 1);
  dev.close();
});

test('the server stays busy: after the bound the box offers "Try again" (link still held back); pressing Generate again re-sends the SAME invite; Try again then makes it Ready', async () => {
  const { dev, server, ctl, w, d } = await shop();
  ctl.always503 = true;
  fill(d);
  const btn = d.querySelector(INVITE_BTN);
  btn.click();
  assert.ok(await until(() => btn.disabled === false, 20000), 'the button comes back (bounded)');
  const retry = d.getElementById('invite-link-retry');
  assert.equal(live(d), '0');
  assert.notEqual(retry.style.display, 'none', 'Try again is visible');
  assert.match(d.getElementById('invite-link-status-msg').textContent, /Saved on this device, but not on the server yet/);
  assert.equal(d.getElementById('invite-link-open').getAttribute('aria-disabled'), 'true');
  const token = w.eval('pendingInvites[0].token');
  // press Generate again with the same name: the same invite, not a second person
  fill(d, 'Jane');
  btn.click();
  assert.equal(w.eval('pendingInvites.length'), 1, 'still one invite');
  assert.equal(w.eval('pendingInvites[0].token'), token, 'the same token');
  assert.ok(await until(() => btn.disabled === false, 20000));
  ctl.always503 = false;
  retry.click();
  assert.ok(await until(() => live(d) === '1', 8000), 'Try again -> Ready');
  assert.equal(server.serverState().pendingInvites.length, 1);
  assert.equal(server.serverState().pendingInvites[0].token, token);
  dev.close();
});

test('offline: the box shows Try again quickly (no long silent wait) and the invite is kept', async () => {
  const { dev, server, w, d } = await shop();
  server.state.down = true;
  fill(d);
  const t0 = Date.now();
  d.querySelector(INVITE_BTN).click();
  assert.ok(await until(() => /Saved on this device/.test(d.getElementById('invite-link-status-msg').textContent), 15000));
  assert.ok(Date.now() - t0 < 12500);
  assert.equal(w.eval('pendingInvites.length'), 1);
  assert.equal(live(d), '0');
  dev.close();
});

test('a pull that is already on its way does not swallow the invite, and does not make the press wait for it (no pre-pull)', async () => {
  const { dev, server, ctl, w, d } = await shop();
  ctl.getDelay = 2500;
  w.eval('window.__pullOkOnce = false; pullState();');
  await sleep(100);
  fill(d);
  const t0 = Date.now();
  d.querySelector(INVITE_BTN).click();
  assert.ok(await until(() => live(d) === '1', 10000));
  assert.ok(Date.now() - t0 < 1500, `not held behind the 2.5 s pull (${Date.now() - t0} ms)`);
  const token = w.eval('pendingInvites[0].token');
  await sleep(3200);                                                        // the slow pull answers now
  assert.ok(w.eval(`pendingInvites.some(i => i.token === ${JSON.stringify(token)})`), 'still in the list after the pull applied');
  assert.ok(server.serverState().pendingInvites.some((i) => i.token === token), 'and on the server');
  dev.close();
});

test('pushNow(opts): skipPrePull / maxAttempts / timeoutMs; a click event handed to pushNow is ignored', async () => {
  const { dev, server, ctl, w } = await shop();
  w.eval('window.__pullOkOnce = false');
  ctl.getDelay = 3000;
  let t0 = Date.now();
  assert.equal(await w.eval('pushNow({ skipPrePull: true })'), true);
  assert.ok(Date.now() - t0 < 1500, 'skipPrePull does not wait for the pull');
  ctl.getDelay = 0; w.eval('window.__pullOkOnce = true');
  ctl.busy = 1;
  const before = posts(server);
  t0 = Date.now();
  assert.equal(await w.eval('pushNow({ maxAttempts: 1 })'), false, 'one attempt: the busy answer is reported, not retried inside');
  assert.equal(posts(server) - before, 1);
  assert.ok(Date.now() - t0 < 1200);
  assert.equal(typeof (await w.eval('pushNow({ type: "click" })')), 'boolean', 'an event object is not options');
  dev.close();
});

test('a phone that opens ?invite= before it has ever synced still gets the invite screen once the first pull lands; the invited person\'s Create My Account answers at once even on a slow server', async () => {
  const s = shaky();
  const owner = await openDevice('index.html', s.server, seedShop, 1200);
  owner.d.getElementById('new-staff-name-input').value = 'Zawadi';
  await owner.w.eval('generateInviteLink()');
  const token = owner.w.eval('pendingInvites[0].token');
  assert.equal(s.server.serverState().pendingInvites[0].token, token);
  owner.close();
  const phone = await openDevice('index.html', s.server, {}, 2500, { url: `https://shop.mydukapos.store/?invite=${token}` });      // brand-new phone: nothing stored
  assert.equal(phone.d.getElementById('invite-screen').style.display, 'flex', 'the invite screen, not the normal login');
  assert.match(phone.d.getElementById('invite-staff-name').innerText, /Zawadi/);
  s.ctl.postDelay = 2500;
  phone.d.getElementById('invite-pin-input').value = '4321';
  phone.d.getElementById('invite-pin-confirm-input').value = '4321';
  const btn = phone.d.querySelector('#invite-screen .btn-main');
  const t0 = Date.now();
  btn.click();
  assert.equal(btn.disabled, true, 'busy at once');
  assert.match(btn.textContent, /Creating/);
  btn.click(); btn.click();                                                 // more taps: nothing happens (and nothing is made twice)
  assert.ok(await until(() => phone.d.getElementById('invite-screen').style.display === 'none', 8000));
  assert.ok(Date.now() - t0 < 1500, `the screen moves on without waiting for the slow server (${Date.now() - t0} ms)`);
  assert.equal(phone.w.eval("staff.filter(s => s.name === 'Zawadi').length"), 1);
  assert.equal(btn.disabled, false);
  assert.ok(await until(() => (s.server.serverState().staff || []).some((x) => x.name === 'Zawadi'), 10000), 'and the account still reaches the server');
  phone.close();
});

test('every app: one real "Open" link per person on both staff screens and the invite box, after generating', async () => {
  for (const app of APPS) {
    const { dev, w, d } = await shop(app, shaky(), 700);
    fill(d);
    d.querySelector(INVITE_BTN).click();
    assert.ok(await until(() => live(d) === '1', 8000), `${app}: Ready`);
    const open = d.getElementById('invite-link-open');
    assert.ok(open, `${app}: has an Open link`);
    assert.equal(open.getAttribute('href'), d.getElementById('invite-link-text').value, `${app}: href set`);
    assert.equal(open.getAttribute('target'), '_blank');
    assert.equal(w.eval('pendingInvites.length'), 1, `${app}: one invite`);
    dev.close();
  }
});

// ---------- the click guard ----------

async function guardPage() {
  const s = shaky();
  const dev = await openDevice('index.html', s.server, seedShop, 900);
  const { w, d } = dev;
  w.eval("window.__toasts = []; showToast = function (m, e) { window.__toasts.push(m); }");
  const add = (id, html) => { const b = d.createElement('button'); b.id = id; b.setAttribute('onclick', html); b.textContent = 'Go ' + id; d.body.appendChild(b); return b; };
  return { dev, w, d, add };
}

test('click guard: a second press while the first is pending does nothing; busy state only after 250 ms; label restored', async () => {
  const { dev, w, d, add } = await guardPage();
  w.eval("window.__calls = 0; window.slowOne = async function () { window.__calls++; await new Promise((r) => setTimeout(r, 700)); }");
  const b = add('g1', 'slowOne()');
  b.click(); b.click(); b.click();
  assert.equal(w.eval('window.__calls'), 1, 're-entrancy blocked from the very first moment');
  assert.equal(b.hasAttribute('aria-busy'), false, 'no busy look before 250 ms (no flicker)');
  await sleep(350);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.ok(b.classList.contains('cg-busy'));
  assert.match(b.textContent, /Go g1 …$/, 'label suffix');
  d.body.appendChild(add('g1b', 'slowOne2()'));                              // another button is never blocked by this one
  w.eval("window.slowOne2 = async function () { window.__other = 1; }");
  d.getElementById('g1b').click();
  assert.equal(w.eval('window.__other'), 1, 'other buttons are not blocked');
  await sleep(600);
  assert.equal(b.hasAttribute('aria-busy'), false);
  assert.equal(b.classList.contains('cg-busy'), false);
  assert.equal(b.textContent, 'Go g1', 'label restored');
  b.click();
  assert.equal(w.eval('window.__calls'), 2, 'after it settled a new press runs');
  dev.close();
});

test('click guard: a rejection becomes a message (not a silent console line); the button is released', async () => {
  const { dev, w, add } = await guardPage();
  w.eval("window.boom = async function () { await new Promise((r) => setTimeout(r, 30)); throw new Error('server said no'); }");
  const b = add('g2', 'boom()');
  b.click();
  await sleep(200);
  assert.ok(w.eval('window.__toasts').some((m) => /did not go through: server said no/.test(m)), 'shown as a toast: ' + JSON.stringify(w.eval('window.__toasts')));
  assert.equal(b.hasAttribute('aria-busy'), false);
  b.click();                                                                  // and it can be pressed again
  await sleep(120);
  assert.equal(w.eval('window.__toasts.filter((m) => /server said no/.test(m)).length'), 2);
  dev.close();
});

test('click guard: exception list (window.__noClickGuard, data-no-click-guard) and non-async / quick functions are left alone', async () => {
  const { dev, w, d, add } = await guardPage();
  w.eval(`window.__n = { deny: 0, plain: 0, quick: 0, attr: 0 };
    window.__noClickGuard = ['denied'];
    window.denied = async function () { window.__n.deny++; await new Promise((r) => setTimeout(r, 300)); };
    window.plain = function () { window.__n.plain++; };
    window.quick = async function () { window.__n.quick++; };
    window.attr = async function () { window.__n.attr++; await new Promise((r) => setTimeout(r, 300)); };`);
  const plainBefore = w.eval('window.plain');
  const bd = add('g3', 'denied()'); bd.click(); bd.click();
  assert.equal(w.eval('window.__n.deny'), 2, 'on the exception list: both presses run');
  const bp = add('g4', 'plain()'); bp.click(); bp.click(); bp.click();
  assert.equal(w.eval('window.__n.plain'), 3);
  assert.equal(w.eval('window.plain'), plainBefore, 'a non-async function is never wrapped');
  const ba = add('g5', 'attr()'); ba.setAttribute('data-no-click-guard', ''); ba.click(); ba.click();
  assert.equal(w.eval('window.__n.attr'), 2, 'data-no-click-guard');
  // a function that settles at once (an add-to-cart, a +/- button) stays re-entrant after it has proved quick
  const bq = add('g6', 'quick()');
  for (let i = 0; i < 6; i++) { bq.click(); await sleep(5); }
  assert.equal(w.eval('window.__n.quick'), 6, 'quick async functions keep working press after press');
  for (let i = 0; i < 5; i++) bq.click();                                     // even five presses in the same tick once it is known to be quick
  assert.equal(w.eval('window.__n.quick'), 11);
  await sleep(50);
  assert.equal(d.querySelectorAll('.cg-busy').length, 0);
  dev.close();
});

test('click guard: still pending after ~6 s shows "Still working…" and never blocks other buttons', async () => {
  const { dev, w, d, add } = await guardPage();
  w.eval("window.longOne = async function () { await new Promise((r) => setTimeout(r, 6600)); }; window.other = function () { window.__o = (window.__o || 0) + 1; };");
  const b = add('g7', 'longOne()');
  const o = add('g8', 'other()');
  b.click();
  await sleep(6200);
  assert.equal(b.textContent, 'Still working…');
  assert.ok(w.eval('window.__toasts').some((m) => /Still working/.test(m)));
  o.click(); o.click();
  assert.equal(w.eval('window.__o'), 2, 'other buttons work while it is pending');
  await sleep(700);
  assert.equal(b.textContent, 'Go g7', 'restored when it finally settles');
  dev.close();
});

test('every app installs the click guard at boot and it wraps a real slow handler', async () => {
  for (const app of APPS) {
    const dev = await openDevice(app, shaky().server, seedShop, 500);
    assert.equal(dev.w.eval('!!window.__clickGuardInstalled'), true, `${app}: guard installed`);
    dev.close();
  }
  const dev = await openDevice('owner/index.html', shaky().server, seedShop, 500);
  assert.equal(dev.w.eval('!!window.__clickGuardInstalled'), true, 'owner console: guard installed');
  dev.close();
});

test('the audit script passes (exit 0) and every app has the guard', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/audit-buttons.mjs'), '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'audit exit code: ' + r.stdout.slice(-400) + r.stderr.slice(-400));
  const j = JSON.parse(r.stdout);
  assert.equal(j.apps.length, 8);
  assert.ok(j.apps.every((a) => a.hasGuard), 'every app installs the guard');
  assert.equal(j.findings.filter((f) => f.fails).length, 0);
});
