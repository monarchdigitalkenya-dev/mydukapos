// zip 363 - Car Wash: services picked by typing or drop-down, Price List edits, sign-in like the other apps, phone layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.mjs';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ADMIN = { pos_pw_hash: sha('admin-pass'), pos_admin_pw_hash: sha('admin-pass'), pos_biz_name: 'Lavington Splash & Dash' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = [];
test.afterEach(() => { while (OPEN.length) { try { OPEN.pop().close(); } catch (e) { /* closed */ } } });

async function open(file, opts = {}) {
  const fetch = () => Promise.reject(new Error('offline'));
  const b = await boot(file, { storage: { ...ADMIN, ...(opts.storage || {}) }, fetch, wait: 1300, webcrypto: true });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.__prints = []; window.open = function () { var doc = { html: '', open: function () {}, write: function (h) { doc.html += h; }, close: function () { window.__prints.push(doc.html); } }; return { document: doc }; };");
  b.d.getElementById('login-password-input').value = 'admin-pass';
  await b.w.eval('loginSubmit()');
  await wait(800);
  OPEN.push(b);
  b.ev = (s) => b.w.eval(s);
  b.json = (s) => JSON.parse(b.w.eval('JSON.stringify(' + s + ')'));
  b.click = (sel) => { const el = b.d.querySelector(sel); assert.ok(el, 'element ' + sel); el.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true })); };
  b.type = (el, v, ev = 'input') => { el.value = v; el.dispatchEvent(new b.w.Event(ev, { bubbles: true })); };
  return b;
}


test('services: pick by TYPING (suggestions, Enter) or from the DROP-DOWN at check-in, in a cleaning job and when editing a job', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  ev("CW_UI.route = 'checkin'; cwRenderShell(); cwRender();");
  const q = d.querySelector('[data-spq="ck"]'); assert.ok(q, 'type box');
  A.type(q, 'polish wax');
  const sug = [...d.querySelectorAll('#cw-spres-ck button')].map((b) => b.getAttribute('data-id'));
  assert.deepEqual(sug, ['sd-polish-wax']);
  assert.ok(d.getElementById('cw-spres-ck').classList.contains('on'));
  q.dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(json("!!CW_UI.ck.items['sd-polish-wax']"), true, 'Enter picks the first suggestion');
  // typing keeps the other check-in fields
  A.type(d.getElementById('cw-ck-name'), 'Kevin');
  const sel = d.querySelector('[data-sps="ck"]'); assert.ok(sel.querySelector('optgroup[label="Interior"]'), 'drop-down grouped by section');
  A.type(sel, 'sd-seats', 'change');
  assert.equal(json("!!CW_UI.ck.items['sd-seats']"), true, 'drop-down adds');
  assert.equal(d.getElementById('cw-ck-name').value, 'Kevin', 'typed customer kept');
  A.type(d.querySelector('[data-spq="ck"]'), 'eng');
  A.click('#cw-spres-ck button[data-id="sd-engine"]');
  assert.equal(json("Object.keys(CW_UI.ck.items).sort().join()"), 'sd-engine,sd-polish-wax,sd-seats');
  A.type(d.querySelector('[data-spq="ck"]'), 'zzzz');
  assert.match(d.getElementById('cw-spres-ck').textContent, /No service matches/);
  // cleaning job: typing sets the price-list item and price
  ev('cwOpenCleanForm()');
  A.type(d.querySelector('[data-spq="cl"]'), 'rug large');
  A.click('#cw-spres-cl button[data-id="sd-rug-large"]');
  assert.equal(d.getElementById('cw-cl-svc').value, 'sd-rug-large');
  assert.equal(d.getElementById('cw-cl-price').value, '2000');
  // edit a job: add a line from the price list
  const j = json("cwCreateJob({ kind: 'car', customer: { name: 'Edd', phone: '0711999888' }, vehicle: { plate: 'KDE 555E', category: 'compact' }, items: [{ serviceId: 'sd-wash-compact', name: 'Wash Compact Vehicle', price: 400, qty: 1 }] })");
  ev(`cwOpenEditJob(${JSON.stringify(j.job.id)})`);
  A.type(d.querySelector('[data-sps="ej"]'), 'sd-dressing', 'change');
  A.click('[data-cw="ejsave"]');
  const items = json(`cwGetJob(${JSON.stringify(j.job.id)}).items`);
  assert.equal(items.length, 2); assert.equal(items[1].serviceId, 'sd-dressing'); assert.equal(items[1].price, 300);
  assert.deepEqual(A.errors, []);
});

test('Price List: rename, change duration, price, section; add and delete; the change reaches check-in', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  A.w.confirm = () => true;
  ev("CW_UI.route = 'prices'; cwRenderShell(); cwRender();");
  const row = () => d.querySelector('tr[data-pl="sd-floor"]');
  A.type(row().querySelector('[data-k="name"]'), 'Floor Mat Wash');
  A.type(row().querySelector('[data-k="minutes"]'), '45');
  A.type(row().querySelector('[data-k="price"]'), '1200');
  A.type(row().querySelector('[data-k="category"]'), 'Interior');
  const lo = row().querySelector('[data-k="loyalty"]'); lo.checked = false; lo.dispatchEvent(new A.w.Event('change', { bubbles: true }));
  A.click('[data-cw="plsave"]');
  const s = json("cwFind(cwCfg().services, 'sd-floor')");
  assert.deepEqual([s.name, s.minutes, s.price, s.category, s.loyalty], ['Floor Mat Wash', 45, 1200, 'Interior', false]);
  ev("CW_UI.route = 'checkin'; cwRenderShell(); cwRender();");
  A.type(d.querySelector('[data-spq="ck"]'), 'floor mat');
  assert.match(d.getElementById('cw-spres-ck').textContent, /Floor Mat Wash/);
  assert.match(d.getElementById('cw-spres-ck').textContent, /1,200/);
  assert.deepEqual(A.errors, []);
});

test('sign-in: the person signed in shows in the top bar; Switch user returns to Who\'s logging in; the bottom bar follows the tabs', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  assert.match(d.getElementById('cw-who').textContent, /Admin/);
  A.click('#cw-who');
  assert.match(d.getElementById('cw-modal').textContent, /Switch user/);
  // a cashier with own tabs: the bottom bar only shows screens she may open
  await ev("cwAddStaff({ name: 'Ruth Till', pin: '4321', role: 'cashier', tabs: ['payments', 'customers', 'prices'] })");
  const id = json("staff.find(function (m) { return m.name === 'Ruth Till'; }).id");
  ev(`currentServer = { id: ${JSON.stringify(id)}, name: 'Ruth Till' }; cwCloseModal(); CW_UI.meKey = ''; cwTick();`);
  const bar = [...d.querySelectorAll('#cw-bottom button')].map((b) => b.getAttribute('data-r'));
  assert.deepEqual(bar, ['customers', 'payments', '__more']);
  assert.match(d.getElementById('cw-who').textContent, /Ruth/);
  assert.equal(json('CW_UI.route'), 'customers', 'starts on a screen she may open');
  // the base app's own sign-out is what Switch user calls
  let called = '';
  A.w.logoutServer = () => { called = 'server'; };
  A.click('#cw-who'); A.click('#cw-modal [data-cw="logout"]');
  assert.equal(called, 'server');
  assert.deepEqual(A.errors, []);
});

test('phone: tables read as labelled cards; job header actions wrap; nothing hides behind a modal', async () => {
  const A = await open('carwash/index.html');
  const { ev, d } = A;
  ev("CW_UI.route = 'staff'; cwRenderShell(); cwRender();");
  const tb = d.querySelector('#cw-main table.cw-tbl');
  assert.ok(tb.classList.contains('cw-stack'));
  const td = tb.querySelector('tbody tr td');
  assert.ok(td.getAttribute('data-l'), 'cell labelled with its column');
  ev("cwOpenJob(cwJobs.filter(function (j) { return !cwIsClosed(j); })[0] ? cwJobs.filter(function (j) { return !cwIsClosed(j); })[0].id : cwCreateJob({ kind: 'car', customer: { name: 'P', phone: '0711222000' }, vehicle: { plate: 'KDA 999Z' }, items: [{ serviceId: 'sd-dressing', name: 'Dressing', price: 300, qty: 1 }] }).job.id)");
  assert.ok(d.querySelector('#cw-modal .cw-ph .cw-phx [data-cw="jobcard"]'), 'header actions in their own wrapping row');
  assert.ok(d.body.classList.contains('cw-mopen'));
  ev('cwCloseModal()');
  assert.equal(d.body.classList.contains('cw-mopen'), false);
  assert.deepEqual(A.errors, []);
});
