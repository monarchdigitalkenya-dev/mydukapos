// B1-S seam tests for the Services engine (SERVICES_ARCHITECTURE.md 3.4, 2.6, 5.1, Appendix A).
// Everything here is ADDITIVE and INERT for classic shops; assertions describe durable contracts and hold whether an svc-* block is still a marker-only stub or already filled.
//   A. tools: `only:[...]` in SHARED_BLOCKS / sync-shared.mjs (real sync + --check run against a throw-away copy of the repo)
//   B. the 18 stubs + marker pairs exist ONLY in services/index.html; no other app carries any Services seam
//   C. services/index.html seams: classic counter intact, hooks fire when a block defines them, never when it throws
//   D. shared-code hooks (slimPayloadForPush, reportsGenerate, registerSyncedField) and the other six apps stay untouched in behaviour
//   E. server merge: MERGE_BY_ID_FIELDS, FINAL_TOMBSTONE_FIELDS, NESTED_MERGE.svcJobs/svcAssets, end-to-end through pos-sync.js
//   F. archive (server splitOldHistory + client storageAutoArchive) keeps svc lists sane: open work never archived
//   G. sign-up business type: page plumbing + licence / demo-account / license-status round trip
// Run one file at a time (jsdom boots of the 3 MB pages are heavy).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { boot, ROOT, APPS, until } from './helpers.mjs';
import { makeKV } from './kv-fake.mjs';
import { blockNames } from './svc-helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const SVC = blockNames();
const OTHERS = APPS.filter((a) => a !== 'services/index.html');
const ORDER = 'SERVICES_ARCHITECTURE.md 2.1';

// =============================================================================================================================================
// A + B. tools and files
// =============================================================================================================================================
test('B. the 18 blocks are registered in SHARED_BLOCKS with only:[services/index.html], in the order of 2.1 (svc-custom last)', async () => {
  const lib = await imp('tools/lib.mjs');
  assert.deepEqual(SVC, ['svc-core', 'svc-templates', 'svc-form', 'svc-store', 'svc-ui-home', 'svc-metrics', 'svc-ui-board', 'svc-appts', 'svc-reports', 'svc-catalog',
    'svc-inventory', 'svc-quote', 'svc-pay', 'svc-notify', 'svc-perms', 'svc-config-ui', 'svc-photos', 'svc-custom'], ORDER);
  SVC.forEach((n) => {
    const def = lib.SHARED_BLOCKS[n];
    assert.ok(def, n + ' registered');
    assert.deepEqual(def.only, ['services/index.html'], n);
    assert.ok(!def.owner && !def.perModule, n + ' is not an owner-console or per-module block');
    assert.ok(fs.existsSync(path.join(lib.BLOCK_DIR, n + '.html')), n + ' file exists');
  });
  assert.deepEqual(Object.keys(lib.SHARED_BLOCKS).filter((k) => k.startsWith('svc-')), SVC, 'registration order = page order');
});

test('B. every block has a header comment naming its owner and contract, and (once filled) balanced script / style elements', () => {
  SVC.forEach((n) => {
    const t = read(`src/shared/blocks/${n}.html`);
    assert.match(t, /^<!-- SVC [A-Z ]+ -/, n + ' starts with its SVC header comment (the block startMarker)');
    assert.match(t, /OWNER: B[1-4]-[A-Z]/, n + ' names its owner');
    assert.match(t, /CONTRACT: \S/, n + ' states its contract');
    assert.match(t, /SPEC: SERVICES_ARCHITECTURE\.md/, n);
    // durable: a block may still be a stub or already filled; either way its script / style elements must be balanced
    ['script', 'style'].forEach((tag) => {
      const open = (t.match(new RegExp('<' + tag + '[\\s>]', 'gi')) || []).length, close = (t.match(new RegExp('</' + tag + '>', 'gi')) || []).length;
      assert.equal(open, close, n + ': <' + tag + '> elements are balanced');
    });
  });
});

test('B. services/index.html carries each marker pair once, in order, after the main script; it equals the block text; no other app has any', () => {
  const page = read('services/index.html');
  let last = -1;
  SVC.forEach((n) => {
    const b = `<!-- @shared-block:${n}:begin -->`, e = `<!-- @shared-block:${n}:end -->`;
    assert.equal(page.split(b).length - 1, 1, n + ' begin once');
    assert.equal(page.split(e).length - 1, 1, n + ' end once');
    const i = page.indexOf(b);
    assert.ok(i > last, n + ' is after the previous block (dependency order)');
    last = i;
    assert.ok(i > page.indexOf('<!-- @shared-block:receipt-size:end -->'), n + ' is in the block area that follows the main script');
    const canon = read(`src/shared/blocks/${n}.html`).replace(/\n+$/, '');
    assert.equal(page.slice(i, page.indexOf(e) + e.length), `${b}\n${canon}\n${e}`, n + ' region = the stub file');
  });
  [...OTHERS, 'owner/index.html'].forEach((f) => {
    const t = read(f);
    assert.ok(!/@shared-block:svc-/.test(t), f + ' has no svc marker');
    assert.ok(!/SVC [A-Z]+ ---/.test(t), f + ' has no svc block text');
  });
});

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-seams-'));
  const cp = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel)); };
  ['package.json', 'tools/lib.mjs', 'tools/sync-shared.mjs', 'src/shared/functions.js', ...fs.readdirSync(path.join(ROOT, 'src/shared/blocks')).filter((f) => f.endsWith('.html')).map((f) => 'src/shared/blocks/' + f),
    ...fs.readdirSync(path.join(ROOT, 'src/shared/blocks/guide-data')).map((f) => 'src/shared/blocks/guide-data/' + f), ...APPS, 'owner/index.html'].forEach(cp);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const run = (...args) => spawnSync(process.execPath, ['tools/sync-shared.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  const snap = () => Object.fromEntries([...APPS, 'owner/index.html'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  return { dir, run, snap, rd: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'), wr: (rel, t) => fs.writeFileSync(path.join(dir, rel), t) };
}

test('A. sync-shared honours only:[...] — svc blocks sync into services/index.html and nowhere else; --check works with it', () => {
  const r = tmpRepo();
  try {
    let o = r.run('--check');
    assert.equal(o.status, 0, 'a clean tree passes --check: ' + o.stdout + o.stderr);
    const before = r.snap();

    // a marker pair planted in ANOTHER app is ignored: `only` skips it (it would be filled otherwise)
    const water = before['water/index.html'];
    const k = water.lastIndexOf('</body>');
    r.wr('water/index.html', water.slice(0, k) + '<!-- @shared-block:svc-core:begin -->\n<!-- @shared-block:svc-core:end -->\n' + water.slice(k));
    const plantedWater = r.rd('water/index.html');
    o = r.run('--check');
    assert.equal(o.status, 0, 'an only-block in a non-target app is not checked: ' + o.stdout + o.stderr);

    // the owner edits a stub: --check fails and names ONLY services/index.html
    const core = r.rd('src/shared/blocks/svc-core.html');
    r.wr('src/shared/blocks/svc-core.html', core + '\n<!-- owner edit -->\n');
    o = r.run('--check');
    assert.equal(o.status, 1, '--check fails when a block file changed: ' + o.stdout);
    assert.match(o.stdout, /OUT OF SYNC: services\/index\.html/);
    assert.equal((o.stdout.match(/OUT OF SYNC/g) || []).length, 1, 'only one app is out of sync: ' + o.stdout);
    assert.ok(!r.rd('services/index.html').includes('<!-- owner edit -->'), '--check wrote nothing');

    o = r.run();
    assert.equal(o.status, 0, o.stderr);
    assert.match(o.stdout, /updated: services\/index\.html/);
    assert.equal((o.stdout.match(/updated:/g) || []).length, 1, 'sync rewrote only services/index.html: ' + o.stdout);
    assert.ok(r.rd('services/index.html').includes('<!-- owner edit -->'), 'the edit reached services');
    const after = r.snap();
    OTHERS.concat('owner/index.html').forEach((f) => assert.equal(after[f], f === 'water/index.html' ? plantedWater : before[f], f + ' is byte-for-byte unchanged'));
    assert.equal(r.run('--check').status, 0, 'in sync again');

    // a hand edit inside the services region is caught
    r.wr('services/index.html', r.rd('services/index.html').replace('<!-- owner edit -->', '<!-- hand edit -->'));
    assert.equal(r.run('--check').status, 1, 'hand edit detected');

    // a missing marker pair in services is a hard error (exit 2), not silent
    r.run();
    r.wr('services/index.html', r.rd('services/index.html').replace('<!-- @shared-block:svc-custom:end -->', ''));
    o = r.run('--check');
    assert.equal(o.status, 2);
    assert.match(o.stderr, /services\/index\.html: block "svc-custom" markers not found/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('A. the real tree is in sync (npm run check) and extract-shared skips only-blocks', () => {
  const o = spawnSync(process.execPath, ['tools/sync-shared.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(read('tools/extract-shared.mjs'), /if \(def\.only\) continue;/);
  assert.match(read('tools/sync-shared.mjs'), /SHARED_BLOCKS\[name\]\.only && !SHARED_BLOCKS\[name\]\.only\.includes\(m\)/);
});

// =============================================================================================================================================
// C + D. services/index.html in a real (jsdom) page
// =============================================================================================================================================
const J = (w, code) => JSON.parse(w.eval(`JSON.stringify((function(){ ${code} })())`));

test('C. services/index.html boots in classic mode for an existing shop: classic counter intact, banner (never engine UI) until the owner opts in, svcBoot called once', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500, beforeParse(win) { win.__booted = 0; win.svcBoot = () => { win.__booted++; }; } });
  try {
    assert.deepEqual(errors, [], 'no page error');
    const tab = d.getElementById('services-counter-tab');
    const root = d.getElementById('svc-root'), wrap = d.getElementById('svc-classic-wrap');
    assert.ok(root && wrap && tab.contains(root) && tab.contains(wrap), 'svc-root + svc-classic-wrap live inside #services-counter-tab');
    // classic mode (no business type chosen yet): #svc-root holds at most the opt-in banner, never the engine UI
    w.eval('renderServicesCounter()');
    assert.ok(!root.querySelector('.svu-home, #svc-kpis, #svc-views'), 'no engine UI until the owner opts in');
    assert.ok(root.innerHTML === '' || root.querySelector('#svc-classic-banner'), '#svc-root is empty or shows the classic-mode banner: ' + root.innerHTML.slice(0, 80));
    assert.notEqual(wrap.style.display, 'none', 'the classic counter stays visible in classic mode');
    assert.ok(root.compareDocumentPosition(wrap) & 4, '#svc-root comes first');
    assert.equal(wrap.children.length, 1, 'the wrapper holds exactly the old grid');
    assert.ok(wrap.firstElementChild.classList.contains('pos-grid'));
    ['services-counter-client-name', 'services-counter-client-phone', 'services-counter-item-details', 'services-counter-quote', 'services-counter-status'].forEach((id) =>
      assert.ok(wrap.querySelector('#' + id), 'classic field #' + id + ' still inside the wrapper'));
    assert.ok(d.getElementById('services-counter-leftitem-modal'), 'the Full Intake Form modal is untouched');
    ['completeServiceJob', 'printIntakeTag', 'renderServicesCounter', 'renderClientRegistry', 'setJobStatusQuick', 'getDueServiceJobs'].forEach((f) => assert.equal(w.eval('typeof ' + f), 'function', f));
    assert.equal(d.getElementById('svc-dash-cards').innerHTML, '');
    // the page ships the tab button / sign-up question hidden; they are shown only by the owning blocks, and the sign-up select always has the static 'other' option
    const tabBtn = d.getElementById('svc-settings-tab-btn');
    assert.ok(tabBtn && ['none', ''].includes(tabBtn.style.display), 'settings tab button exists (hidden, or shown by svc-config-ui)');
    const opts = Array.from(d.getElementById('signup-biz-type').options).map((o) => o.value);
    assert.ok(opts.includes('other'), 'sign-up select always offers other');
    if (opts.length < 2) assert.equal(d.getElementById('signup-biz-type-wrap').style.display, 'none', 'an unfilled sign-up question stays hidden');
    // svcBoot seam: the DOMContentLoaded handler calls it once (a real block replaces the planted counter)
    assert.match(read('services/index.html'), /typeof svcBoot === 'function'/, 'the page guards the svcBoot call with typeof');
    if (w.eval('typeof SVC_UI') === 'object') assert.equal(w.eval('SVC_UI.booted'), true, 'the real svcBoot ran');
    else assert.equal(w.__booted, 1, 'svcBoot is called once at DOMContentLoaded');
    const payload = J(w, 'var p = collectSyncPayload(); return { sj: Array.isArray(p.serviceJobs), bk: Array.isArray(p.bookings) };');
    assert.ok(payload.sj && payload.bk, 'legacy serviceJobs / bookings still synced as before');
    // classic mode adds no svc list to the payload while every svc list is empty
    if (w.eval("typeof svcJobs") === 'object') assert.deepEqual(J(w, 'return Object.keys(collectSyncPayload()).filter(function (k) { return /^svc[A-Z]/.test(k) && Array.isArray(collectSyncPayload()[k]) && collectSyncPayload()[k].length; });'), [], 'no svc records in the payload of a fresh shop');
    assert.ok(J(w, 'return ADMIN_GRANTABLE_SETTINGS_SECTIONS.map(function (s) { return s.id; });').includes('settings-section-services'));
  } finally { close(); }
});

test('C. seams fire when a block defines them, and a throwing block never breaks the app', async () => {
  const { w, d, close } = await boot('services/index.html', { wait: 500 });
  try {
    // --- collectSyncPayload / applyRemotePayload
    w.eval("window.svcSyncCollect = function () { return { svcJobs: [{ id: 'sj-1', updatedAt: 1 }], svcConfig: [] }; }");
    assert.deepEqual(J(w, 'var p = collectSyncPayload(); return [p.svcJobs, p.svcConfig, typeof p.updatedAt];'), [[{ id: 'sj-1', updatedAt: 1 }], [], 'number']);
    w.eval("window.__applied = null; window.svcSyncApply = function (data) { window.__applied = Object.keys(data).length; }");
    w.eval('applyRemotePayload(collectSyncPayload())');
    assert.ok(w.eval('window.__applied') > 10, 'svcSyncApply received the whole pulled payload');
    w.eval("window.svcSyncApply = function () { throw new Error('boom'); }");
    w.eval("localStorage.removeItem('pos_last_synced_at')");
    w.eval('applyRemotePayload(collectSyncPayload())');
    assert.ok(w.localStorage.getItem('pos_last_synced_at'), 'a throwing svcSyncApply did not abort applyRemotePayload');
    w.eval("delete window.svcSyncCollect; delete window.svcSyncApply");

    // --- settings section
    w.eval("window.__renderSettings = 0; window.svcRenderSettings = function () { window.__renderSettings++; }");
    w.eval("showSettingsSection('settings-section-services')");
    assert.equal(w.eval('window.__renderSettings'), 1);
    assert.ok(d.getElementById('settings-section-services').classList.contains('active'));
    w.eval("window.svcRenderSettings = function () { throw new Error('boom'); }");
    w.eval("showSettingsSection('settings-section-general')");
    w.eval("showSettingsSection('settings-section-services')");
    assert.ok(d.getElementById('settings-section-services').classList.contains('active'), 'a throwing page render leaves the section open');

    // --- due jobs bell
    w.eval("serviceJobs = [{ id: 'JOB-old', clientName: 'Old', itemDetails: 'legacy', promisedPickup: new Date(Date.now() - 3600000).toISOString(), status: 'pending' }]");
    assert.deepEqual(J(w, 'return getDueServiceJobs().map(function (j) { return j.id; });'), ['JOB-old'], 'legacy list unchanged while svcDueJobs is absent');
    w.eval("window.svcDueJobs = function () { return [{ id: 'sj-9', clientName: 'Eng', itemDetails: 'engine', promisedPickup: new Date(Date.now() - 1000).toISOString() }]; }");
    assert.deepEqual(J(w, 'return getDueServiceJobs().map(function (j) { return j.id; });'), ['JOB-old', 'sj-9'], 'engine jobs join the same bell list');
    w.eval("window.svcDueJobs = function () { throw new Error('boom'); }");
    assert.deepEqual(J(w, 'return getDueServiceJobs().map(function (j) { return j.id; });'), ['JOB-old']);
    w.eval("window.svcDueJobs = function () { return 'nope'; }");
    assert.deepEqual(J(w, 'return getDueServiceJobs().map(function (j) { return j.id; });'), ['JOB-old']);
    w.eval('delete window.svcDueJobs; serviceJobs = []');

    // --- dashboard cards
    w.eval("window.svcDashboardHtml = function () { return '<b id=\"svc-card\">cards</b>'; }");
    w.eval('renderShopDashboard()');
    assert.equal(d.getElementById('svc-dash-cards').innerHTML, '<b id="svc-card">cards</b>');
    w.eval("window.svcDashboardHtml = function () { throw new Error('boom'); }");
    w.eval('renderShopDashboard()');
    assert.ok(d.getElementById('dash-today-revenue').textContent.startsWith('KES'), 'the rest of the dashboard still renders');
    w.eval('delete window.svcDashboardHtml');

    // --- audit
    w.eval("window.svcAuditEvents = function () { return [{ at: 5, user: 'Amina', module: 'Services', action: 'Job created', detail: 'CW-1', ref: 'sj-1' }]; }");
    assert.ok(J(w, "return buildAuditEvents().some(function (e) { return e.module === 'Services' && e.ref === 'sj-1'; });"));
    assert.ok(Array.from(d.getElementById('audit-module-select').options).some((o) => o.value === 'Services'), 'Audit module filter offers Services');
    w.eval("window.svcAuditEvents = function () { throw new Error('boom'); }");
    assert.ok(J(w, 'return Array.isArray(buildAuditEvents());'));
    w.eval('delete window.svcAuditEvents');
  } finally { close(); }
});

test('C. staff panel hook: svcStaffPermHtml(member) is appended to each member card; a throwing hook renders nothing', async () => {
  const { w, d, close } = await boot('services/index.html', { wait: 500 });
  try {
    w.eval("staff = [{ id: 'st1', name: 'Wanjiru', pinHash: 'x', roles: [], adminPermissions: [] }]");
    w.eval('renderStaffPanel()');
    assert.ok(!d.body.innerHTML.includes('SVC-PERM-HOOK'));
    w.eval("window.svcStaffPermHtml = function (m) { return '<div class=\"svc-perm-hook\">SVC-PERM-HOOK ' + m.id + '</div>'; }");
    w.eval('renderStaffPanel()');
    const hook = d.querySelector('.svc-perm-hook');
    assert.ok(hook && hook.textContent === 'SVC-PERM-HOOK st1');
    assert.ok(hook.previousElementSibling.classList.contains('role-checkbox-grid'), 'appended right after the "Allowed tabs" checkbox grid');
    w.eval("window.svcStaffPermHtml = function () { throw new Error('boom'); }");
    w.eval('renderStaffPanel()');
    assert.ok(!d.querySelector('.svc-perm-hook') && d.querySelector('.staff-roster-card'), 'the card still renders');
  } finally { close(); }
});

test('C. sign-up: #signup-biz-type is read into window.__svcSignupType (client side only) and svcApplySignupType runs BEFORE the first push', async () => {
  const { w, d, close } = await boot('services/index.html', { wait: 500 });
  try {
    w.eval('submitDirectSignup()');
    const first = w.eval('window.__svcSignupType');
    const offered = Array.from(d.getElementById('signup-biz-type').options).map((o) => o.value);
    if (offered.length > 1) assert.equal(first, 'other', 'list filled -> the default choice is other');
    else assert.equal(first, '', 'nothing offered (list not filled) -> no choice');
    d.getElementById('signup-biz-type').innerHTML = '<option value="other">Other</option><option value="car_wash">Car Wash</option><option value="salon">Salon</option>';
    d.getElementById('signup-biz-type').value = 'car_wash';
    w.eval('submitDirectSignup()');
    assert.equal(w.eval('window.__svcSignupType'), 'car_wash');
    assert.ok(read('services/index.html').includes("body: JSON.stringify({ action: 'register', fullName, phone, email, password, confirmPassword: passwordConfirm })"), 'the /api/demo-account register body is NOT changed');
    w.eval("window.__order = []; window.pushNowOrWarn = async function () { window.__order.push('push'); }; window.svcApplySignupType = function () { window.__order.push('apply:' + window.__svcSignupType); }");
    await w.eval("finishDirectAuth('Biz', 'pw1234')");
    assert.deepEqual(J(w, 'return window.__order;'), ['apply:car_wash', 'push'], 'applied before pushNowOrWarn so the choice rides the first push');
    assert.ok(w.localStorage.getItem('pos_pw_hash'));
    w.eval("window.__order = []; window.svcApplySignupType = function () { throw new Error('boom'); }");
    await w.eval("finishDirectAuth('Biz2', 'pw1234')");
    assert.deepEqual(J(w, 'return window.__order;'), ['push'], 'a throwing hook never blocks sign-up');
    assert.equal(w.localStorage.getItem('pos_biz_name'), 'Biz2');
  } finally { close(); }
});

test('D. shared hooks in services: slimPayloadForPush, registerSyncedField stamping, reportsGenerate extra builders', async () => {
  const { w, d, close } = await boot('services/index.html', { wait: 500 });
  try {
    // slimPayloadForPush: svcJobs / svcAppointments are delta-pushed (acked records dropped), all five are "MERGED" (no whole-value _fieldTimes)
    const r = J(w, `
      var jobs = [1, 2, 3].map(function (i) { return { id: 'sj-' + i, createdAt: Date.now(), updatedAt: i, rev: 1 }; });
      var p = { updatedAt: 1, svcJobs: jobs, svcAppointments: [{ id: 'sp-1', updatedAt: 1 }], svcAssets: [{ id: 'sa-1', updatedAt: 1 }], svcCatalog: [{ id: 'sc-1', updatedAt: 1 }], svcConfig: [{ id: 'cfg-business', updatedAt: 1 }] };
      var s1 = slimPayloadForPush(p);
      var out = { first: [s1.body.svcJobs.length, s1.body.svcAppointments.length, s1.body.svcAssets.length] };
      s1.commit();
      p.svcAssets[0].label = 'changed'; p.svcConfig[0].value = { a: 1 }; p.svcCatalog[0].price = 9;
      var s2 = slimPayloadForPush(p);
      out.second = [s2.body.svcJobs.length, s2.body.svcAppointments.length];
      out.ft = Object.keys(s2.body._fieldTimes || {}).filter(function (k) { return /^svc/.test(k); });
      out.assets = s2.body.svcAssets.length;
      return out;`);
    assert.deepEqual(r.first, [3, 1, 1]);
    assert.deepEqual(r.second, [0, 0], 'acknowledged svcJobs / svcAppointments are not re-sent');
    assert.deepEqual(r.ft, [], 'none of the five lists is a whole-value field (they merge per record)');
    assert.equal(r.assets, 1, 'svcAssets is sent whole each push (small)');
    // the cap: 130 new jobs -> 120 per batch, more:true
    const cap = J(w, `var p = { updatedAt: 1, svcJobs: Array.from({ length: 130 }, function (x, i) { return { id: 'sj-c' + i, updatedAt: i }; }) }; var s = slimPayloadForPush(p); return [s.body.svcJobs.length, s.more];`);
    assert.deepEqual(cap, [120, true], 'CAP.svcJobs = 120');

    // registerSyncedField: svcAssets/svcCatalog/svcConfig get the belt-and-braces stamp, svcJobs does not (extraRecSig would hash every job on every push)
    const st = J(w, `
      /* unqualified assignment: works whether the list is a module-scope let (svc-store) or not declared yet (creates a global) */
      svcAssets = [{ id: 'sa1', label: 'A', updatedAt: 5 }]; svcCatalog = [{ id: 'sc1', price: 1, updatedAt: 5 }]; svcConfig = [{ id: 'cfg-business', value: {}, updatedAt: 5 }];
      svcJobs = [{ id: 'sj1', note: 'a', updatedAt: 5 }];
      snapshotExtraSyncedFields();
      svcAssets[0].label = 'B'; svcCatalog[0].price = 2; svcConfig[0].value = { x: 1 }; svcJobs[0].note = 'b';
      collectSyncPayload();
      return { a: svcAssets[0].updatedAt > 5, c: svcCatalog[0].updatedAt > 5, cfg: svcConfig[0].updatedAt > 5, job: svcJobs[0].updatedAt };`);
    assert.deepEqual(st, { a: true, c: true, cfg: true, job: 5 });
    w.eval('svcAssets = []; svcCatalog = []; svcConfig = []; svcJobs = []');

    // reportsGenerate: extra kinds are consulted for UNKNOWN kinds only; a legacy kind can never be replaced; reportNoRange
    w.eval("window.reportExtraBuilders = { svcdemo: function (range) { return { title: 'Svc Demo', html: '<p id=\"svcdemo-body\">body</p>', csv: [['a', 'b']] }; }, sales: function () { return { title: 'HIJACKED', html: '', csv: [] }; }, notfn: 5 }");
    w.eval("reportsGenerate('svcdemo')");
    const out = d.getElementById('reports-output');
    assert.ok(out.querySelector('#svcdemo-body'), 'extra builder rendered');
    assert.match(out.innerHTML, /Svc Demo/);
    assert.match(out.innerHTML, /<span|—/, 'has a range line');
    assert.equal(w.eval("window.__reportKind"), 'svcdemo');
    assert.deepEqual(J(w, 'return window.__reportCsv;'), [['a', 'b']]);
    assert.ok(!/as at today/.test(out.innerHTML), 'ranged by default');
    w.eval("window.reportNoRange = ['svcdemo']");
    w.eval("reportsGenerate('svcdemo')");
    assert.match(out.innerHTML, /as at today/, 'reportNoRange honoured');
    w.eval("reportsGenerate('sales')");
    assert.ok(!/HIJACKED/.test(out.innerHTML), 'a built-in kind is never replaced by an extra builder');
    w.eval("window.__reportKind = 'keep'; reportsGenerate('notfn'); reportsGenerate('nope')");
    assert.equal(w.eval('window.__reportKind'), 'keep', 'unknown / non-function kinds are still a no-op');
    w.eval("window.reportExtraBuilders = { svcboom: function () { throw new Error('bad'); } }; reportsGenerate('svcboom')");
    assert.match(out.innerHTML, /could not be built: bad/, 'a throwing extra builder shows the normal error');
  } finally { close(); }
});

test('D. the other six apps: no Services seam, same behaviour (slimPayloadForPush / reportsGenerate / archive accessors are inert)', async () => {
  for (const app of OTHERS) {
    const { w, d, errors, close } = await boot(app, { wait: 300 });
    try {
      assert.deepEqual(errors, [], app + ': no page error');
      assert.equal(d.getElementById('svc-root'), null, app);
      assert.equal(d.getElementById('settings-section-services'), null, app);
      assert.equal(d.getElementById('signup-biz-type'), null, app);
      assert.equal(w.eval('typeof svcBoot + typeof svcSyncCollect + typeof svcSyncApply'), 'undefinedundefinedundefined', app);
      ['svcBoot', 'svcSyncCollect', 'svcSyncApply', 'svcRenderSettings', 'svcDueJobs', 'svcDashboardHtml', 'svcAuditEvents', 'svcStaffPermHtml', 'svcApplySignupType', 'svcFillTypeSelect', 'svcCommit'].forEach((n) => assert.ok(!(n in w), app + ': no ' + n));
      const r = J(w, `var p = { updatedAt: 1, salesLog: [{ id: 'a', timestamp: new Date().toISOString() }] }; var s = slimPayloadForPush(p); return { keys: Object.keys(s.body).filter(function (k) { return /^svc/.test(k); }), sales: s.body.salesLog.length, collect: Object.keys(collectSyncPayload()).filter(function (k) { return /^svc/.test(k); }) };`);
      assert.deepEqual(r, { keys: [], sales: 1, collect: [] }, app);
      if (d.getElementById('reports-output')) {
        w.eval("window.__reportKind = 'keep'; reportsGenerate('svcdemo')");
        assert.equal(w.eval('window.__reportKind'), 'keep', app + ': an unknown report kind is still a no-op');
      }
    } finally { close(); }
    await new Promise((r) => setTimeout(r, 350));        // let the closed window go before the next boot (memory)
  }
});

// =============================================================================================================================================
// E. server merge
// =============================================================================================================================================
const job = (o) => ({ id: 'sj-1', no: 'CW-1', serviceType: 'car_wash', templateVersion: 1, createdAt: 1000, status: 'waiting', phase: 0, closedAt: null, updatedAt: 10, rev: 1,
  statusHistory: [], charges: [], materials: [], payments: [], audit: [], notify: [], jobStaff: [], valuables: [], photos: [], quoteVersions: [], quoteLog: [], ...o });

test('E. _merge.js registers the five lists, final tombstones for jobs/appointments/catalog, and leaves the legacy lists whole-value', async () => {
  const m = await imp('functions/api/_merge.js');
  ['svcJobs', 'svcAssets', 'svcCatalog', 'svcAppointments', 'svcConfig'].forEach((f) => assert.ok(m.MERGE_BY_ID_FIELDS.includes(f), f + ' merged by id'));
  ['svcJobs', 'svcAppointments', 'svcCatalog'].forEach((f) => assert.ok(m.FINAL_TOMBSTONE_FIELDS.includes(f), f + ' has final tombstones'));
  ['svcAssets', 'svcConfig'].forEach((f) => assert.ok(!m.FINAL_TOMBSTONE_FIELDS.includes(f), f + ' has no final tombstone'));
  assert.ok(!m.MERGE_BY_ID_FIELDS.includes('serviceJobs') && !m.MERGE_BY_ID_FIELDS.includes('bookings'), 'legacy serviceJobs / bookings are deliberately NOT merged per record (R4)');
  assert.deepEqual(m.NESTED_MERGE.svcJobs.arrays, ['statusHistory', 'charges', 'materials', 'payments', 'audit', 'notify', 'jobStaff', 'valuables', 'photos', 'quoteVersions', 'quoteLog']);
  assert.equal(m.NESTED_MERGE.svcJobs.rankBy, 'phase');
  assert.deepEqual(m.NESTED_MERGE.svcAssets.arrays, ['history', 'ownerHistory']);
  assert.ok(m.NESTED_MERGE.tabs && m.NESTED_MERGE.kegs && m.NESTED_MERGE.cashShifts && m.NESTED_MERGE.radiologyOrders, 'the existing specs are intact');
});

test('E. NESTED_MERGE.svcJobs: two tills adding to the same job both survive; closed never reopens; in-place edits by rev / void; scalars newest-wins', async () => {
  const { mergeNestedRecord, mergeRecordsById } = await imp('functions/api/_merge.js');
  const a = job({ updatedAt: 100, rev: 2, payments: [{ id: 'p1', amount: 500 }], charges: [{ id: 'c1', label: 'Heavy dirt', amount: 300, rev: 1 }], statusHistory: [{ id: 'h1', s: 'waiting', at: 1 }], notes: 'till A' });
  const b = job({ updatedAt: 200, rev: 2, payments: [{ id: 'p2', amount: 1000 }], charges: [{ id: 'c1', label: 'Heavy dirt', amount: 300, rev: 1 }, { id: 'c2', label: 'Wax', amount: 200, rev: 1 }],
    statusHistory: [{ id: 'h1', s: 'waiting', at: 1 }, { id: 'h2', s: 'in_progress', at: 2 }], status: 'in_progress', phase: 1, notes: 'till B' });
  const m1 = mergeNestedRecord('svcJobs', a, b), m2 = mergeNestedRecord('svcJobs', b, a);
  [m1, m2].forEach((m) => {
    assert.deepEqual(m.payments.map((p) => p.id).sort(), ['p1', 'p2'], 'both payments kept');
    assert.deepEqual(m.charges.map((p) => p.id).sort(), ['c1', 'c2']);
    assert.deepEqual(m.statusHistory.map((p) => p.id).sort(), ['h1', 'h2']);
    assert.equal(m.notes, 'till B', 'scalars: newest updatedAt wins, whichever arrives first');
    assert.equal(m.status, 'in_progress');
  });
  // a closed job is never put back to open by a stale copy, even one with a NEWER updatedAt (rankBy phase)
  const closed = job({ updatedAt: 300, rev: 5, status: 'collected', phase: 3, closedAt: 999, payments: [{ id: 'p1', amount: 500 }] });
  const stale = job({ updatedAt: 900, rev: 3, status: 'in_progress', phase: 1, payments: [{ id: 'p9', amount: 50 }] });
  [mergeNestedRecord('svcJobs', closed, stale), mergeNestedRecord('svcJobs', stale, closed)].forEach((m) => {
    assert.equal(m.status, 'collected'); assert.equal(m.phase, 3); assert.equal(m.closedAt, 999);
    assert.deepEqual(m.payments.map((p) => p.id).sort(), ['p1', 'p9'], 'but the late payment is still kept');
  });
  // the same element edited in place: higher rev wins; a void wins over a live copy
  const x = job({ payments: [{ id: 'p1', amount: 500, rev: 1 }], charges: [{ id: 'c1', amount: 300, rev: 1 }] });
  const y = job({ payments: [{ id: 'p1', amount: 500, rev: 1, voidedAt: 7 }], charges: [{ id: 'c1', amount: 250, rev: 2 }] });
  [mergeNestedRecord('svcJobs', x, y), mergeNestedRecord('svcJobs', y, x)].forEach((m) => {
    assert.equal(m.payments.length, 1); assert.equal(m.payments[0].voidedAt, 7, 'void wins');
    assert.equal(m.charges[0].rev, 2); assert.equal(m.charges[0].amount, 250, 'higher rev wins');
  });
  // missing arrays tolerated (R6: an older release / a legacy view never wrote them)
  const bare = { id: 'sj-1', updatedAt: 1, phase: 0 };
  const m3 = mergeNestedRecord('svcJobs', bare, job({ payments: [{ id: 'p1' }] }));
  assert.equal(m3.payments.length, 1);
  // per-record merge at list level: different jobs both survive, a job missing from a push stays, a final tombstone is final
  const list = mergeRecordsById([job({ id: 'sj-a' }), job({ id: 'sj-b', payments: [{ id: 'pb' }] })], [job({ id: 'sj-a', updatedAt: 50, payments: [{ id: 'pa' }] }), job({ id: 'sj-c' })], true, 'svcJobs');
  assert.deepEqual(list.map((r) => r.id).sort(), ['sj-a', 'sj-b', 'sj-c']);
  assert.deepEqual(list.find((r) => r.id === 'sj-a').payments.map((p) => p.id), ['pa']);
  const dead = mergeRecordsById([{ id: 'sj-a', _deleted: true, updatedAt: 500 }], [job({ id: 'sj-a', updatedAt: 9999 })], true, 'svcJobs');
  assert.equal(dead[0]._deleted, true, 'a deleted job stays deleted even when a stale till touches it (FINAL_TOMBSTONE_FIELDS)');
});

test('E. svcAssets history unions by id across tills; svcConfig / svcCatalog merge per record', async () => {
  const { mergeNestedRecord, mergeRecordsById } = await imp('functions/api/_merge.js');
  const a = { id: 'sa-vehicle-KDA123A', updatedAt: 10, label: 'Toyota', history: [{ id: 'sj-1', at: 1, total: 500 }] };
  const b = { id: 'sa-vehicle-KDA123A', updatedAt: 20, label: 'Toyota Premio', history: [{ id: 'sj-1', at: 5, total: 600 }, { id: 'sj-2', at: 2, total: 100 }] };
  const m = mergeNestedRecord('svcAssets', a, b);
  assert.equal(m.label, 'Toyota Premio');
  assert.deepEqual(m.history.map((h) => h.id).sort(), ['sj-1', 'sj-2']);
  assert.equal(m.history.find((h) => h.id === 'sj-1').total, 600, 'newer `at` wins for the same entry');
  const cfg = mergeRecordsById([{ id: 'cfg-business', updatedAt: 5, value: { businessType: 'salon' } }, { id: 'cfg-notify', updatedAt: 5, value: { a: 1 } }],
    [{ id: 'cfg-business', updatedAt: 9, value: { businessType: 'car_wash' } }, { id: 'cfg-vehicle', updatedAt: 1, value: {} }], false, 'svcConfig');
  assert.deepEqual(cfg.map((r) => r.id).sort(), ['cfg-business', 'cfg-notify', 'cfg-vehicle']);
  assert.equal(cfg.find((r) => r.id === 'cfg-business').value.businessType, 'car_wash', 'per-record newest wins; other kinds untouched');
  const older = mergeRecordsById([{ id: 'cfg-business', updatedAt: 9, value: { businessType: 'car_wash' } }], [{ id: 'cfg-business', updatedAt: 5, value: { businessType: 'salon' } }], false, 'svcConfig');
  assert.equal(older[0].value.businessType, 'car_wash', 'a stale copy never wins');
});

test('E. end to end through pos-sync.js: two devices push different payments on the same job; both come back; svc fields ride in the state', async () => {
  const { onRequestGet, onRequestPost } = await imp('functions/api/pos-sync.js');
  const store = new Map();
  const kv = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async list() { return { keys: [] }; } };
  store.set('license:C1', JSON.stringify({ id: 'C1', type: 'permanent', slug: 'shop' }));
  store.set('license-index:v1', JSON.stringify([{ id: 'C1', slug: 'shop', type: 'permanent', businessName: 'Shop A' }]));
  const env = { mydukapos_kv: kv };
  const call = (fn, url, method = 'GET', body) => fn({ request: new Request('https://x.pages.dev' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const push = (extra) => call(onRequestPost, '/api/pos-sync?c=C1', 'POST', { updatedAt: Date.now(), businessName: 'Shop A', pwHash: 'h1', adminPwHash: 'h1', ...extra }).then((r) => r.json());
  await push({ svcJobs: [job({ updatedAt: Date.now() - 5000 })], svcConfig: [{ id: 'cfg-business', kind: 'business', updatedAt: Date.now() - 5000, value: { businessType: 'car_wash', chosen: true } }] });
  await push({ svcJobs: [job({ updatedAt: Date.now() - 2000, payments: [{ id: 'pA', amount: 500 }] })] });                      // till A
  await push({ svcJobs: [job({ updatedAt: Date.now() - 1000, payments: [{ id: 'pB', amount: 700 }], status: 'ready', phase: 2 })], svcAssets: [{ id: 'sa-vehicle-K1', updatedAt: Date.now(), history: [{ id: 'sj-1', at: 1 }] }] });   // till B
  const full = await (await call(onRequestGet, '/api/pos-sync?c=C1')).json();
  assert.equal(full.svcJobs.length, 1);
  assert.deepEqual(full.svcJobs[0].payments.map((p) => p.id).sort(), ['pA', 'pB'], 'both tills\' payments are on the server job');
  assert.equal(full.svcJobs[0].status, 'ready');
  assert.equal(full.svcConfig[0].value.businessType, 'car_wash');
  assert.equal(full.svcAssets[0].id, 'sa-vehicle-K1');
  // a till that still holds the job as it was (older, open, no payments) must not undo anything
  await push({ svcJobs: [job({ updatedAt: Date.now() + 10, phase: 0, status: 'waiting' })] });
  const again = await (await call(onRequestGet, '/api/pos-sync?c=C1')).json();
  assert.equal(again.svcJobs[0].phase, 2, 'a stale open copy cannot move the job backwards (rankBy phase)');
  assert.equal(again.svcJobs[0].payments.length, 2);
  // a field missing from a push leaves the stored list (union, never a deletion)
  await push({ inventory: [] });
  assert.equal((await (await call(onRequestGet, '/api/pos-sync?c=C1')).json()).svcJobs.length, 1);
});

// =============================================================================================================================================
// F. archive
// =============================================================================================================================================
test('F. server archive: finished svc jobs / appointments are archivable, open ones never; the list names are in ARCHIVE_LOG_FIELDS', async () => {
  const s = await imp('functions/api/_state-store.js');
  assert.ok(s.ARCHIVE_LOG_FIELDS.includes('svcJobs') && s.ARCHIVE_LOG_FIELDS.includes('svcAppointments'));
  assert.ok(!s.ARCHIVE_LOG_FIELDS.includes('svcAssets') && !s.ARCHIVE_LOG_FIELDS.includes('svcConfig') && !s.ARCHIVE_LOG_FIELDS.includes('svcCatalog'), 'assets / config / catalog are never archived');
  const DAY = 86400000, now = Date.now(), cutoff = now - 30 * DAY;
  const state = {
    svcJobs: [job({ id: 'old-closed', createdAt: now - 100 * DAY, closedAt: now - 99 * DAY, phase: 3 }), job({ id: 'old-open', createdAt: now - 100 * DAY, closedAt: null }),
      job({ id: 'new-closed', createdAt: now - 2 * DAY, closedAt: now - DAY, phase: 3 }), job({ id: 'old-deleted', createdAt: now - 100 * DAY, closedAt: null, _deleted: true })],
    svcAppointments: [{ id: 'sp-old-done', createdAt: now - 90 * DAY, date: '2020-01-01', closedAt: now - 89 * DAY }, { id: 'sp-old-open', createdAt: now - 90 * DAY, date: '2020-01-02', closedAt: null }],
    svcAssets: [{ id: 'sa-1', createdAt: 1 }], svcConfig: [{ id: 'cfg-business', createdAt: 1 }], salesLog: [],
  };
  assert.equal(s.isOpenRecord('svcJobs', state.svcJobs[1]), true);
  assert.equal(s.isOpenRecord('svcJobs', state.svcJobs[3]), false, 'a tombstone is not open work');
  const { keep, old, moved } = s.splitOldHistory(state, cutoff);
  assert.deepEqual(old.svcJobs.map((r) => r.id).sort(), ['old-closed', 'old-deleted']);
  assert.deepEqual(keep.svcJobs.map((r) => r.id).sort(), ['new-closed', 'old-open'], 'the open job stays live whatever its age');
  assert.deepEqual(old.svcAppointments.map((r) => r.id), ['sp-old-done']);
  assert.deepEqual(keep.svcAppointments.map((r) => r.id), ['sp-old-open']);
  assert.equal(keep.svcAssets.length, 1); assert.equal(keep.svcConfig.length, 1); assert.equal(old.svcAssets, undefined);
  assert.equal(moved, 3);
});

test('F. client archive (storage-and-photos) archives finished svc jobs once the server has them, keeps open jobs, persists to pos_svc_jobs', async () => {
  const { w, errors, close } = await boot('services/index.html', { indexedDB: new IDBFactory(), wait: 400 });
  try {
    const DAY = 86400000, now = Date.now();
    const hard = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x4000)); return s; };
    const mk = (id, ageDays, closed) => ({ id, no: id, serviceType: 'car_wash', createdAt: now - ageDays * DAY, updatedAt: now - ageDays * DAY, phase: closed ? 3 : 1, closedAt: closed ? now - (ageDays - 1) * DAY : null, payments: [] });
    const jobs = [mk('sj-old-closed-1', 300, true), mk('sj-old-closed-2', 250, true), mk('sj-old-open', 280, false), mk('sj-new-closed', 3, true)];
    w.eval(`svcJobs = ${JSON.stringify(jobs)}; svcAppointments = [];`);
    assert.equal(w.eval("window.__LOG_KEYS.svcJobs"), 'pos_svc_jobs');
    w.eval("safeSetItem('pos_svc_jobs', JSON.stringify(svcJobs))");
    w.eval(`safeSetItem('pos_filler_for_test', ${JSON.stringify(hard(3300000))})`);          // push the device past 80% so the periodic check archives
    assert.ok(w.eval('__storageUsedChars()') >= 4000000, 'device is ~80% full');
    assert.equal(await w.eval("storageAutoArchive('check')"), false, 'nothing moves while the server has not acknowledged the records (they are what gets sent)');
    assert.equal(w.eval('svcJobs.length'), 4);
    w.eval("ackServerRecords('svcJobs', svcJobs)");                                       // the first sync confirms the server holds them
    w.eval('__resetAutoArchiveThrottle()');
    assert.equal(await w.eval("storageAutoArchive('check')"), true);
    assert.deepEqual(J(w, 'return svcJobs.map(function (j) { return j.id; }).sort();'), ['sj-new-closed', 'sj-old-open'], 'finished old jobs archived; the open one and the recent one stay');
    assert.deepEqual(JSON.parse(w.localStorage.getItem('pos_svc_jobs')).map((j) => j.id).sort(), ['sj-new-closed', 'sj-old-open'], 'persisted without the archived ones');
    const list = JSON.parse(await w.eval("storageLocalArchives().then(function (l) { return JSON.stringify(l); })"));
    assert.equal(list.reduce((n, a) => n + (a.counts.svcJobs || 0), 0), 2, 'the two finished jobs are in the device archive — none lost');
    assert.deepEqual(errors, []);
  } finally { close(); }
});

// =============================================================================================================================================
// G. sign-up business type through the licence
// =============================================================================================================================================
test('G. licence plumbing: createClient stores svcType for Services links only; license-status echoes it; demo-account register passes it through', async () => {
  const lic = await imp('functions/api/_license.js');
  assert.deepEqual(lic.SVC_BUSINESS_TYPES, ['phone_repair', 'car_wash', 'garage', 'salon', 'barber', 'laundry', 'cleaning', 'electronics_repair', 'tailoring', 'other']);
  assert.equal(lic.normalizeSvcType('Car_Wash'), 'car_wash');
  assert.equal(lic.normalizeSvcType(' salon '), 'salon');
  assert.equal(lic.normalizeSvcType('bakery'), 'other', 'unknown text becomes other');
  assert.equal(lic.normalizeSvcType(''), '');
  assert.equal(lic.normalizeSvcType(undefined), '');
  assert.equal(lic.normalizeSvcType(42), '');
  const kv = makeKV(), env = { mydukapos_kv: kv };
  const a = await lic.createClient(env, 'demo', 'Sparkle Wash', 'services', { svcType: 'car_wash' });
  assert.equal(a.svcType, 'car_wash');
  assert.equal((await lic.getLicense(env, a.id)).svcType, 'car_wash', 'stored in the licence record');
  assert.equal((await lic.createClient(env, 'demo', 'Odd Ones', 'services', { svcType: 'bakery' })).svcType, 'other');
  assert.equal((await lic.createClient(env, 'demo', 'No Answer', 'services', {})).svcType, '', 'not chosen -> empty, the app asks the owner itself');
  assert.equal((await lic.createClient(env, 'demo', 'Hardware', 'shop', { svcType: 'salon' })).svcType, '', 'other products never carry a business type');

  const status = await imp('functions/api/license-status.js');
  const get = async (id) => (await status.onRequestGet({ request: new Request('https://x.pages.dev/api/license-status?c=' + id), env })).json();
  const s1 = await get(a.id);
  assert.equal(s1.svcType, 'car_wash', 'license-status echoes svcType');
  assert.equal(s1.product, 'services'); assert.equal(s1.valid, true);
  const plain = await lic.createClient(env, 'demo', 'Hardware 2', 'shop');
  assert.equal((await get(plain.id)).svcType, '', 'and an empty string for everything else');

  // the owner console: POST /api/owner-clients {product:'services', svcType}
  const oc = await imp('functions/api/owner-clients.js');
  kv.data.set('owner-session:tok1', { value: '1' });
  const res = await oc.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-clients', { method: 'POST', headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'permanent', label: 'Cuts Barber', product: 'services', svcType: 'barber' }) }), env });
  const made = await res.json();
  assert.equal(made.client.svcType, 'barber');
  assert.equal((await get(made.client.id)).svcType, 'barber', 'owner-generated link round-trips');
  const denied = await oc.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-clients', { method: 'POST', body: '{}' }), env });
  assert.equal(denied.status, 401);

  // the public demo register (optional passthrough; the in-app sign-up body is not changed)
  const da = await imp('functions/api/demo-account.js');
  const reg = await da.onRequestPost({ request: new Request('https://x.pages.dev/api/demo-account', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
    body: JSON.stringify({ action: 'register', fullName: 'Jane Doe', phone: '0712345678', email: 'jane@example.com', password: 'pw1234', confirmPassword: 'pw1234', product: 'services', businessName: 'Jane Salon', svcType: 'salon' }) }), env, waitUntil() {} });
  assert.equal(reg.status, 200, await reg.clone().text());
  const licKeys = [...kv.data.keys()].filter((k) => k.startsWith('license:'));
  const rec = licKeys.map((k) => JSON.parse(kv.data.get(k).value)).find((r) => r.label === 'Jane Salon');
  assert.ok(rec, 'the demo link was created');
  assert.equal(rec.product, 'services');
  assert.equal(rec.svcType, 'salon', 'register passed svcType into the licence record');
  assert.ok(!('password' in rec));
});

test('G. the page can read the licence business type: licenseInfo.svcType after a license-status poll', async () => {
  const fetchFn = (u) => {
    if (String(u).includes('/api/license-status')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ valid: true, reason: 'ok', type: 'permanent', product: 'services', svcType: 'garage', clientId: 'C9', slug: 'g', serverNow: Date.now(), expiresAt: null, remainingMs: null }) });
    return Promise.reject(new Error('offline'));
  };
  const { w, close } = await boot('services/index.html', { fetch: fetchFn, wait: 500 });
  try {
    await until(() => w.eval("typeof licenseInfo !== 'undefined' && licenseInfo && licenseInfo.svcType") === 'garage', 8000);
    assert.equal(w.eval('licenseInfo.svcType'), 'garage', 'svc-store / svc-ui-home can pre-select it when cfg-business is absent');
  } finally { close(); }
});

test('E/F. wildcard-router shop store uses the same constants (one edit covers both backends)', () => {
  const t = read('wildcard-router/shop-store.js');
  assert.match(t, /MERGE_BY_ID_FIELDS[\s\S]*from '\.\.\/functions\/api\/_merge\.js'/);
  assert.match(t, /import \{ ARCHIVE_LOG_FIELDS, recordTime \} from '\.\.\/functions\/api\/_state-store\.js'/);
  assert.ok(!/svcJobs/.test(t), 'no per-list edit needed there');
});
