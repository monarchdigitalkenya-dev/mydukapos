// B1-U tests: Services home (#svc-root), New Service sheet, job drawer, Business Type page, sign-up question, terminology.
// Boots the real services/index.html with the real svc-* blocks (core, templates, form, store, ui-home, config-ui). Run one file at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const TYPES = ['phone_repair', 'car_wash', 'garage', 'salon', 'barber', 'laundry', 'cleaning', 'electronics_repair', 'tailoring', 'other'];
const J = (w, code) => JSON.parse(w.eval(`JSON.stringify((function () { ${code} })())`));
const LEGACY = { id: 'JOB-lg-abc123', createdAt: new Date(Date.now() - 86400000).toISOString(), clientName: 'Old Client', clientPhone: '0711000111', idNumber: '', itemDetails: 'iPhone 11, IMEI 356789012345678, cracked screen', servicesRequired: [], serviceNotes: '', quoteAmount: 0, promisedPickup: '', status: 'pending', components: [], laborFee: 0, finalAmount: null, saleId: null, billId: null, paymentMethod: '', completedAt: '' };
const VALID = {
  phone_repair: { cust_name: 'Jane', cust_phone: '0712345678', dev_type: 'phone', dev_brand: 'Samsung', dev_model: 'A12', rep_problem: 'Cracked screen', dev_imei: '356789012345678' },
  car_wash: { cust_name: 'Peter', cust_phone: '0722333444', veh_plate: 'KDA 123A', veh_make: 'Toyota', veh_model: 'Premio', veh_type: 'sedan' },
  other: { cust_name: 'Amina', cust_phone: '0733444555', oth_item: 'Sofa' },
};
const SERVICES = [{ name: 'Basic Wash', qty: 1, price: 500 }];

// the field ids each type may show: the golden file (B1-A) when it exists, else the resolved template itself
function fieldIdsOf(w, type, golden) {
  if (golden && golden[type]) { const g = golden[type]; if (Array.isArray(g)) return g; if (g.fields) return Array.isArray(g.fields) ? g.fields : Object.keys(g.fields); if (typeof g === 'object') return Object.keys(g); }
  return J(w, `var out = []; svcGetTemplate('${type}').sections.forEach(function (s) { s.fields.forEach(function (f) { out.push(f.id); }); }); return out;`);
}
const formIds = (d) => [...d.querySelectorAll('.svu-sheet [data-fid]')].map((e) => e.getAttribute('data-fid'));
const closeAll = (w) => w.eval("while (SVC_UI.stack.length) SVC_UI.stack[SVC_UI.stack.length - 1].close();");
function fill(d, fid, value) {
  const el = d.querySelector(`.svu-sheet [data-fid="${fid}"] input, .svu-sheet [data-fid="${fid}"] select, .svu-sheet [data-fid="${fid}"] textarea`);
  assert.ok(el, 'field ' + fid + ' is on the form');
  el.value = value;
  el.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
}
const click = (d, el) => el.dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

test('existing shop: classic counter + banner, Keep classic, Switch -> chooser -> engine without reload; old jobs stay reachable under All types', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500, storage: { pos_service_jobs: JSON.stringify([LEGACY]) } });
  try {
    w.__marker = 'same-page';
    // the hidden seam elements are revealed by the blocks
    assert.notEqual(d.getElementById('svc-settings-tab-btn').style.display, 'none', 'Settings > Services sub-tab is shown');
    assert.equal(d.getElementById('signup-biz-type-wrap').style.display, '', 'sign-up question is shown');
    const before = d.getElementById('services-counter-tab-btn').textContent;
    assert.match(before, /Services Counter/);

    d.getElementById('services-counter-tab-btn').click();
    const root = d.getElementById('svc-root');
    assert.match(root.textContent, /Choose your business type to switch on the new Services screens/);
    assert.ok(root.querySelector('[data-svc-act="switch"]') && root.querySelector('[data-svc-act="keep"]'));
    assert.notEqual(d.getElementById('svc-classic-wrap').style.display, 'none', 'classic counter untouched');
    assert.equal(d.getElementById('services-counter-tab-btn').textContent, before);
    assert.equal(J(w, 'return svcUiMode().engine;'), false);

    // Keep classic: banner gone and stays gone
    click(d, root.querySelector('[data-svc-act="keep"]'));
    assert.equal(root.querySelector('#svc-classic-banner'), null);
    w.eval('renderServicesCounter()');
    assert.equal(root.querySelector('#svc-classic-banner'), null, 'dismissed for this device');
    w.localStorage.removeItem('pos_svc_banner_off'); w.eval('svcRenderHome()');
    assert.ok(root.querySelector('#svc-classic-banner'), 're-offered once the dismissal is cleared');

    // Switch -> chooser with the 10 types, current highlighted, reassurance text
    click(d, root.querySelector('[data-svc-act="switch"]'));
    const ov = d.querySelector('.svu-ov');
    assert.ok(ov, 'chooser opens');
    assert.equal(ov.querySelectorAll('[data-svc-type]').length, 10);
    assert.match(ov.textContent, /never deletes or rewrites old jobs/);
    click(d, ov.querySelector('[data-svc-type="car_wash"]'));
    assert.equal(ov.querySelector('.is-sel').getAttribute('data-svc-type'), 'car_wash');
    click(d, ov.querySelector('[data-svc-act="use"]'));
    await tick();
    assert.equal(d.querySelector('.svu-ov'), null, 'chooser closes');
    assert.equal(w.__marker, 'same-page', 'no reload');
    assert.equal(J(w, 'return svcBusinessType();'), 'car_wash');
    assert.equal(J(w, 'return svcUiMode().engine;'), true);
    assert.ok(root.querySelector('.svu-home[data-svc-type="car_wash"]'), 'engine screen is drawn');
    assert.equal(root.querySelector('#svc-classic-banner'), null);
    assert.equal(d.getElementById('svc-classic-wrap').style.display, 'none', 'classic counter collapsed in engine mode');
    assert.match(d.getElementById('services-counter-tab-btn').textContent, /Wash Counter/);
    assert.equal(d.getElementById('svc-new-btn').textContent, '+ New Vehicle Job');

    // classic counter is still one tap away
    click(d, root.querySelector('[data-svc-act="classic"]'));
    assert.notEqual(d.getElementById('svc-classic-wrap').style.display, 'none');
    click(d, root.querySelector('[data-svc-act="classic"]'));

    // the legacy (phone repair era) job is history of ANOTHER type: hidden from the current list, reachable under All types, open ones announced
    assert.equal(root.querySelectorAll('.svu-card').length, 0);
    assert.match(root.textContent, /1 open job from another business type/);
    const all = root.querySelector('#svc-alltypes'); all.checked = true; all.dispatchEvent(new w.Event('change', { bubbles: true }));
    const cards = root.querySelectorAll('.svu-card');
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /Old Client/);
    assert.match(cards[0].textContent, /Classic job/);
    assert.equal(J(w, 'return serviceJobs.length;'), 1, 'legacy data untouched');
    assert.deepEqual(errors, []);
  } finally { close(); }
});

test('New Service: the ONE form shows the right fields per business type and none of the others', async () => {
  const gp = path.join(ROOT, 'tests/fixtures/svc-field-ids.json');
  const golden = fs.existsSync(gp) ? JSON.parse(fs.readFileSync(gp, 'utf8')) : null;
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500 });
  try {
    const sets = {}; TYPES.forEach((t) => { sets[t] = fieldIdsOf(w, t, golden); });
    const exclusive = (t) => { const others = new Set(); TYPES.filter((u) => u !== t).forEach((u) => sets[u].forEach((i) => others.add(i))); return sets[t].filter((i) => !others.has(i)); };
    const expectIds = {
      phone_repair: ['cust_name', 'dev_type', 'dev_brand', 'dev_model', 'rep_problem', 'rep_diagnosis', 'parts', 'rep_tech', 'quote', 'payment', 'status'],
      car_wash: ['cust_name', 'veh_plate', 'veh_make', 'veh_model', 'veh_type', 'services', 'cond_scratches', 'valuables', 'staff', 'parts', 'quote', 'payment', 'status'],
      garage: ['cust_name', 'veh_plate', 'cmp_problem', 'dx_diagnosis', 'parts', 'quote', 'payment', 'status'],
      salon: ['cust_name', 'appt_mode', 'services', 'staff', 'parts', 'quote', 'payment', 'status'],
    };
    const NONE = { phone_repair: /^(veh_|cond_|appt_|val)/, car_wash: /^(dev_|appt_|rep_)/, garage: /^(dev_|appt_|cond_)/, salon: /^(veh_|dev_|cond_|cmp_|dx_)/ };
    for (const t of TYPES) {
      const r = J(w, `return svcSetBusinessType('${t}', { source: 'settings' });`); assert.ok(r.ok, t);
      const rec = w.eval('svcOpenNewJob()'); assert.ok(rec, t + ' sheet opens');
      const ids = formIds(d);
      assert.ok(ids.length > 5, t + ' has a form');
      ids.forEach((id) => assert.ok(sets[t].includes(id), `${t}: ${id} is one of its own fields`));
      const foreign = ids.filter((id) => TYPES.some((u) => u !== t && exclusive(u).includes(id)));
      assert.deepEqual(foreign, [], t + ' shows no field that belongs only to another type');
      (expectIds[t] || []).forEach((id) => assert.ok(ids.includes(id), `${t}: ${id} present`));
      if (NONE[t]) assert.deepEqual(ids.filter((id) => NONE[t].test(id)), [], t + ' irrelevant-industry fields are absent from the DOM');
      assert.match(d.querySelector('.svu-sheet .svu-title').textContent, new RegExp(J(w, `return svcGetTemplate('${t}').terms.newButton;`).replace(/^\+\s*/, '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
      closeAll(w);
    }
    // phone_repair: IMEI only for phones / tablets, sections come in the template order
    w.eval("svcSetBusinessType('phone_repair')"); w.eval('svcOpenNewJob()');
    fill(d, 'dev_type', 'laptop');
    assert.ok(!formIds(d).includes('dev_imei'), 'no IMEI for a device type that has none');
    fill(d, 'dev_type', 'phone');
    assert.ok(formIds(d).includes('dev_imei'));
    const order = formIds(d); assert.ok(order.indexOf('cust_name') < order.indexOf('dev_type') && order.indexOf('dev_type') < order.indexOf('rep_problem') && order.indexOf('rep_problem') < order.indexOf('status'));
    closeAll(w);
    // salon / car wash: quick mode is the minimal set
    w.eval("svcSetBusinessType('car_wash')"); w.eval("svcOpenNewJob(null, { quick: true })");
    assert.deepEqual(formIds(d).sort(), ['services', 'veh_plate'], 'quick car wash = plate + services');
    click(d, d.querySelector('.svu-sheet [data-svc-act="mode"][data-mode="create"]'));
    assert.ok(formIds(d).includes('veh_make') && formIds(d).includes('cond_scratches'), 'switching to full details keeps the sheet and shows everything');
    closeAll(w);
    w.eval("svcSetBusinessType('salon')"); w.eval("svcOpenNewJob(null, { quick: true })");
    assert.deepEqual(formIds(d).sort(), ['cust_name', 'services']);
    closeAll(w);
    assert.equal(d.querySelector('.svu-ov'), null);
    assert.deepEqual(errors, []);
  } finally { close(); }
});

test('New Service: validation blocks, Save creates once (double tap) and opens the drawer with the Overview', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500 });
  try {
    w.eval("svcSetBusinessType('other')");
    w.eval('svcOpenNewJob()');
    const sheet = d.querySelector('.svu-sheet');
    click(d, sheet.querySelector('[data-role="submit"]'));
    assert.match(sheet.querySelector('.svu-errs').textContent, /required/i, 'required fields are listed');
    assert.equal(J(w, 'return svcAllJobs({}).length;'), 0, 'nothing saved');
    fill(d, 'cust_name', 'Amina'); fill(d, 'cust_phone', '0733444555'); fill(d, 'oth_item', 'Sofa set');
    const btn = sheet.querySelector('[data-role="submit"]');
    click(d, btn); click(d, btn); click(d, sheet.querySelector('.svu-ph [data-svc-act="save"]'));
    await tick();
    assert.equal(J(w, 'return svcAllJobs({}).length;'), 1, 'double tap creates ONE job');
    const job = J(w, 'return svcAllJobs({})[0];');
    assert.equal(job.serviceType, 'other'); assert.equal(job.customer.name, 'Amina');
    assert.equal(d.querySelector('.svu-sheet'), null, 'sheet closed');
    const drawer = d.querySelector('.svu-drawer');
    assert.ok(drawer, 'drawer opens on the new job');
    assert.match(drawer.textContent, new RegExp(job.no));
    assert.match(drawer.textContent, /Sofa set/); assert.match(drawer.textContent, /Amina/);
    assert.equal(d.querySelectorAll('#svc-root .svu-card').length, 1, 'the home list shows it');
    // the Android back button (popstate) and Escape close the overlay instead of leaving the app
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    assert.equal(d.querySelector('.svu-drawer'), null, 'back closes the drawer');
    w.eval(`svcOpenJob('${job.id}')`); assert.ok(d.querySelector('.svu-drawer'));
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(d.querySelector('.svu-drawer'), null, 'Escape closes the drawer');
    assert.equal(d.body.classList.contains('svu-lock'), false, 'page scroll is released');
    assert.deepEqual(errors, []);
  } finally { close(); }
});

test('drawer: Overview groups fields, status buttons are the legal transitions, history timeline, registered tabs, classic rows delegate', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500, storage: { pos_service_jobs: JSON.stringify([LEGACY]) } });
  try {
    w.eval("svcSetBusinessType('phone_repair')");
    const r = J(w, `return svcCreateJob({ typeKey: 'phone_repair', values: ${JSON.stringify(VALID.phone_repair)} });`);
    assert.ok(r.ok, JSON.stringify(r)); const id = r.job.id;
    await tick();
    // the list: a card with status pill, asset and customer
    const card = d.querySelector('#svc-root .svu-card[data-id="' + id + '"]');
    assert.ok(card); assert.match(card.textContent, /Jane/); assert.match(card.textContent, /Samsung A12/i); assert.match(card.querySelector('.svu-pill').textContent, /Received/);
    assert.ok(d.querySelector('#svc-root .svu-card[data-id="' + LEGACY.id + '"]'), 'phone_repair shop: the legacy job is the same type, shown with the new ones');
    click(d, card);
    const drawer = d.querySelector('.svu-drawer'); const body = drawer.querySelector('.svu-pbody');
    assert.match(body.textContent, /Device/); assert.match(body.textContent, /IMEI/); assert.match(body.textContent, /356789012345678/);
    assert.match(body.textContent, /Reported problem|Problem/i);
    assert.ok(!/Number plate|Appointment/.test(body.textContent), 'only the job type\'s own sections');
    assert.ok(drawer.querySelectorAll('.svu-tl li').length >= 1 || body.querySelectorAll('.svu-tl li').length >= 1, 'timeline shows');
    const allowed = J(w, `return svcAllowedNext(svcGetJob('${id}'));`);
    const keys = [...body.querySelectorAll('[data-svc-act="status"]')].map((b) => b.getAttribute('data-key'));
    assert.deepEqual(keys.sort(), allowed.slice().sort(), 'only legal transitions are offered');
    assert.ok(!keys.includes('completed') && !keys.includes('collected'));
    // move it
    click(d, body.querySelector('[data-svc-act="status"][data-key="diagnosing"]'));
    await tick();
    assert.equal(J(w, `return svcGetJob('${id}').status;`), 'diagnosing');
    const tl = [...drawer.querySelectorAll('.svu-tl li')].map((li) => li.textContent);
    assert.equal(tl.length, 2); assert.match(tl[0], /Diagnosing/); assert.match(tl[1], /Received/);
    assert.match(drawer.querySelector('.svu-hpill').textContent, /Diagnosing/);
    assert.match(d.querySelector('#svc-root .svu-card[data-id="' + id + '"] .svu-pill').textContent, /Diagnosing/, 'home list refreshed');
    // footer "Next" button advances too
    click(d, drawer.querySelector('.svu-pfoot [data-svc-act="status"]'));
    await tick();
    assert.notEqual(J(w, `return svcGetJob('${id}').status;`), 'diagnosing');
    // tab registry: B2/B3 add tabs, visibleWhen filters, render errors are contained
    w.eval("svcDrawerRegister('payments', { label: 'Payments', order: 30, render: function (job, el) { el.innerHTML = '<p id=\"pay-tab\">pay ' + job.no + '</p>'; } })");
    w.eval("svcDrawerRegister('hidden', { label: 'Nope', order: 40, visibleWhen: function () { return false; }, render: function () {} })");
    w.eval("svcDrawerRegister('boom', { label: 'Boom', order: 50, render: function () { throw new Error('tab broke'); } })");
    w.eval(`svcOpenJob('${id}')`);
    const tabs = [...d.querySelectorAll('.svu-drawer .svu-tabs button')].map((b) => b.textContent);
    assert.deepEqual(tabs.filter((t) => ['Overview', 'Payments', 'Boom'].includes(t)), ['Overview', 'Payments', 'Boom']);
    click(d, d.querySelector('.svu-drawer [data-svc-act="tab"][data-key="payments"]'));
    assert.match(d.getElementById('pay-tab').textContent, /pay PR-/);
    click(d, d.querySelector('.svu-drawer [data-svc-act="tab"][data-key="boom"]'));
    assert.match(d.querySelector('.svu-drawer .svu-pbody').textContent, /tab broke/);
    closeAll(w);
    // a classic (legacy) job: same drawer, old vocabulary, routed to the old function
    w.eval(`svcOpenJob('${LEGACY.id}')`);
    const lb = d.querySelector('.svu-drawer .svu-pbody');
    assert.match(lb.textContent, /Old Client/); assert.match(lb.textContent, /IMEI 356789012345678|cracked screen/);
    const lkeys = [...lb.querySelectorAll('[data-svc-act="status"]')].map((b) => b.getAttribute('data-key'));
    assert.deepEqual(lkeys, ['in_progress', 'ready', 'completed', 'collected']);
    click(d, lb.querySelector('[data-svc-act="status"][data-key="ready"]'));
    assert.equal(J(w, 'return serviceJobs[0].status;'), 'ready', 'setJobStatusQuick did the write');
    closeAll(w);
    assert.equal(d.querySelector('.svu-ov'), null);
    assert.deepEqual(errors, []);
  } finally { close(); }
});

test('switching business type keeps history intact; list, search, status chips, All types', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500 });
  try {
    // zip 361: a car_wash Services shop now sees "Car Wash has its own app" (svc-carwash-moved, tested in zip361-carwash). This test is about the
    // engine's history mechanics, which still read old car wash jobs, so the notice is switched off here.
    w.eval('SVC_MOVED_TYPES.length = 0;');
    w.eval("svcSetBusinessType('phone_repair')");
    const a = J(w, `return svcCreateJob({ typeKey: 'phone_repair', values: ${JSON.stringify(VALID.phone_repair)} });`);
    const b = J(w, `return svcCreateJob({ typeKey: 'car_wash', values: ${JSON.stringify(Object.assign({}, VALID.car_wash, { services: SERVICES }))} });`);
    assert.ok(a.ok && b.ok, JSON.stringify([a.errors, b.errors]));
    await tick();
    const root = d.getElementById('svc-root');
    assert.equal(root.querySelectorAll('.svu-card').length, 1, 'current type only');
    w.eval("svcSetBusinessType('car_wash')"); await tick();
    assert.equal(root.querySelectorAll('.svu-card').length, 1);
    assert.match(root.textContent, /Premio/); assert.ok(!/Samsung/.test(root.textContent));
    assert.match(root.textContent, /1 open job from another business type/);
    click(d, root.querySelector('[data-svc-act="showall"]'));
    assert.equal(root.querySelectorAll('.svu-card').length, 2, 'All types shows the phone repair job too');
    assert.match(root.textContent, /Samsung/);
    // nothing about the old job changed
    const old = J(w, `return svcGetJob('${a.job.id}');`);
    assert.equal(old.serviceType, 'phone_repair'); assert.equal(old.status, 'received'); assert.equal(old.customer.name, 'Jane');
    // opening the old job while the shop is car_wash renders ITS template (device fields, no vehicle fields)
    click(d, root.querySelector(`.svu-card[data-id="${a.job.id}"]`));
    assert.match(d.querySelector('.svu-drawer .svu-pbody').textContent, /IMEI/);
    assert.ok(!/Number plate/.test(d.querySelector('.svu-drawer .svu-pbody').textContent));
    closeAll(w);
    // search (built-in filter, or svcSearch when the board block is present): plate, phone digits, no match, clear
    const q = root.querySelector('#svc-q');
    const type = async (v) => { q.value = v; q.dispatchEvent(new w.Event('input', { bubbles: true })); await tick(220); };
    await type('kda123'); assert.equal(root.querySelectorAll('.svu-card').length, 1); assert.match(root.textContent, /KDA/);
    await type('0712 345 678'); assert.equal(root.querySelectorAll('.svu-card').length, 1); assert.match(root.textContent, /Samsung/);
    await type('zzzzqq'); assert.equal(root.querySelectorAll('.svu-card').length, 0); assert.match(root.textContent, /Nothing matches/);
    click(d, root.querySelector('[data-svc-act="clear"]')); assert.equal(root.querySelectorAll('.svu-card').length, 2);
    // status chips come from the template
    const chips = [...root.querySelectorAll('.svu-chip')].map((c) => c.getAttribute('data-key'));
    assert.ok(chips.includes('') && chips.includes('received') && chips.includes('waiting'), 'chips: All + statuses of the viewed list');
    click(d, root.querySelector('.svu-chip[data-key="received"]')); assert.equal(root.querySelectorAll('.svu-card').length, 1);
    click(d, root.querySelector('.svu-chip[data-key=""]'));
    // switch back: phone repair shop sees the repair job again, car wash job is history
    w.eval("svcSetBusinessType('phone_repair')"); await tick();
    assert.equal(J(w, 'return svcAllJobs({}).length;'), 2);
    assert.equal(J(w, `return svcGetJob('${b.job.id}').serviceType;`), 'car_wash');
    assert.deepEqual(errors, []);
  } finally { close(); }
});

test('Settings > Services > Business Type, sign-up question plumbing, terminology', async () => {
  const { w, d, errors, close } = await boot('services/index.html', { wait: 500 });
  try {
    // sign-up select: 10 options, other by default, the choice is published for finishDirectAuth and becomes the default
    const sel = d.getElementById('signup-biz-type');
    assert.deepEqual([...sel.options].map((o) => o.value).sort(), TYPES.slice().sort());
    assert.equal(sel.value, 'other'); assert.equal(d.getElementById('signup-biz-type-wrap').style.display, '');
    assert.match(d.querySelector('label[for="signup-biz-type"]').textContent, /What type of business do you operate\?/);
    sel.value = 'salon'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(w.__svcSignupType, 'salon');
    w.eval('submitDirectSignup()'); assert.equal(w.__svcSignupType, 'salon');
    assert.ok(J(w, 'return svcApplySignupType().ok;'));
    assert.equal(J(w, 'return svcBusinessType();'), 'salon');
    await tick();
    d.getElementById('services-counter-tab-btn').click();
    assert.ok(d.querySelector('#svc-root .svu-home[data-svc-type="salon"]'), 'a new sign-up lands in the engine, not classic');
    assert.equal(d.getElementById('svc-new-btn').textContent, '+ Walk-In');

    // settings page
    w.eval("showSettingsSection('settings-section-services')");
    const page = d.getElementById('svc-settings-root');
    assert.match(page.textContent, /Business type/i);
    assert.equal(page.querySelectorAll('[data-svc-type]').length, 10, 'ten type cards with icon + description');
    assert.ok([...page.querySelectorAll('.svu-type')].every((c) => c.querySelector('.ic').textContent.trim() && c.querySelector('small').textContent.trim()));
    assert.equal(page.querySelector('.svu-type.is-sel').getAttribute('data-svc-type'), 'salon');
    assert.match(page.querySelector('.svu-type.is-sel').textContent, /Current/);
    assert.match(page.textContent, /never deletes or rewrites old jobs/);
    assert.equal(page.querySelector('#svc-bt-save').disabled, true, 'nothing to change yet');
    click(d, page.querySelector('[data-svc-type="garage"]'));
    const save = d.querySelector('#svc-bt-save'); assert.equal(save.disabled, false); assert.match(save.textContent, /Garage/);
    let asked = ''; w.confirm = (m) => { asked = m; return true; };
    click(d, save); await tick();
    assert.match(asked, /never deletes or rewrites old jobs/);
    assert.equal(J(w, 'return svcBusinessType();'), 'garage');
    assert.equal(d.querySelector('#svc-settings-root .svu-type.is-sel').getAttribute('data-svc-type'), 'garage');
    assert.match(d.getElementById('services-counter-tab-btn').textContent, /Garage|Repair/);
    assert.equal(d.getElementById('svc-new-btn').textContent, '+ New Repair Job');
    // the page registry: other blocks add pages
    w.eval("svcSettingsRegister('extra', { label: 'Extra page', order: 5, render: function (el) { el.innerHTML = '<p id=\"extra-p\">hello</p>'; } })");
    w.eval('svcRenderSettings()');
    const nav = [...d.querySelectorAll('#svc-settings-root .svu-setnav button')].map((b) => b.textContent);
    assert.deepEqual(nav.filter((t) => ['Business Type', 'Extra page'].includes(t)), ['Business Type', 'Extra page']);
    click(d, d.querySelector('#svc-settings-root [data-svc-page="extra"]')); assert.ok(d.getElementById('extra-p'));

    // terminology follows the type: buttons, title, tab labels (ids untouched); data-svc-term elements
    const want = { phone_repair: ['+ New Repair', 'Repair Counter'], car_wash: ['+ New Vehicle Job', 'Wash Counter'], garage: ['+ New Repair Job', null], salon: ['+ Walk-In', 'Salon Counter'] };
    for (const t of Object.keys(want)) {
      w.eval(`svcSetBusinessType('${t}')`); await tick();
      assert.equal(d.getElementById('svc-new-btn').textContent, want[t][0], t);
      if (want[t][1]) assert.match(d.getElementById('services-counter-tab-btn').textContent, new RegExp(want[t][1]), t);
      assert.equal(d.getElementById('services-counter-tab-btn').getAttribute('data-tab'), 'services-counter-tab');
      assert.equal(d.querySelector('#svc-root .svu-h2').textContent, J(w, `return svcGetTemplate('${t}').terms.queue;`));
    }
    d.body.insertAdjacentHTML('beforeend', '<i id="t1" data-svc-term="job"></i><i id="t2" data-svc-term="job" data-svc-term-type="car_wash"></i>');
    w.eval('svcApplyTerms(document.body)');
    assert.equal(d.getElementById('t2').textContent, 'Wash Job');
    assert.equal(d.getElementById('t1').textContent, J(w, "return svcGetTemplate('salon').terms.job;"));
    // classic escape hatch restores the old labels
    w.localStorage.setItem('pos_svc_ui', 'classic'); w.eval('svcRenderHome()');
    assert.match(d.getElementById('services-counter-tab-btn').textContent, /Services Counter/);
    assert.notEqual(d.getElementById('svc-classic-wrap').style.display, 'none');
    assert.deepEqual(errors, []);
  } finally { close(); }
});
