// zip 362 — Car Wash: the Splash & Dash price list preloaded and edited in the "Price List" tab, the printables (client intake form /
// job card, till receipt, price list, A4 invoice), customer add / edit / delete in the Car Wash app AND in every other app, per-staff
// tabs in the Car Wash app and the staff tab editor of the other apps, and an old untouched catalogue being upgraded (an edited one kept).
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

test('the Splash & Dash price list is preloaded: sections, prices, vehicle types, one price for every vehicle type', async () => {
  const A = await open('carwash/index.html');
  const cfg = A.json('cwCfg()');
  const car = cfg.services.filter((s) => s.kind === 'car'), rug = cfg.services.filter((s) => s.kind === 'clean');
  assert.equal(car.length, 15); assert.equal(rug.length, 3);
  const price = (n) => cfg.services.find((s) => s.name === n).price;
  assert.equal(price('Wash Compact Vehicle'), 400); assert.equal(price('Wash Compact Vehicle with Vacuum'), 700);
  assert.equal(price('Wash Large Vehicle'), 500); assert.equal(price('Wash Large Vehicle with Vacuum'), 800);
  assert.equal(price('Body Polish Waxing'), 1000); assert.equal(price('Body Polish with Own Polish'), 500); assert.equal(price('Engine Wash Normal'), 500); assert.equal(price('Ceramic Coating'), 15000);
  assert.equal(price('Leather Polish'), 1000); assert.equal(price('Dressing'), 300); assert.equal(price('Interior Roof Wash'), 1000); assert.equal(price('Seats'), 4000);
  assert.equal(price('Floor Wash'), 1000); assert.equal(price('Buffing Compact Car'), 5000); assert.equal(price('Buffing Large Car'), 10000);
  assert.deepEqual(rug.map((s) => s.price), [1000, 1500, 2000]);
  assert.deepEqual([...new Set(car.map((s) => s.category))], ['Exterior', 'Interior', 'Other services']);
  assert.deepEqual(cfg.vehicleCats.map((c) => c.l), ['Compact', 'Large', 'SUV', 'Truck', 'Cab/Uber']);
  for (const k of ['compact', 'large', 'suv', 'truck', 'cab']) assert.equal(A.ev(`cwPriceFor(cwFind(cwCfg().services, 'sd-ceramic'), '${k}')`), 15000);
  // check-in lists the services grouped by section
  A.ev("CW_UI.route = 'checkin'; cwRenderShell(); cwRender();");
  const secs = [...A.d.querySelectorAll('#cw-ckgrid .cw-sec')].map((e) => e.textContent);
  assert.deepEqual(secs, ['Exterior', 'Interior', 'Other services']);
  assert.ok(A.d.getElementById('cw-ck-email') && A.d.getElementById('cw-ck-gender') && A.d.getElementById('cw-ck-pref') && A.d.getElementById('cw-ck-year'), 'intake-form fields on check-in');
  assert.deepEqual(A.errors, []);
  A.close();
});

test('Price List tab: edit a price, set a per-type price, add, delete, discard, reload the standard list; jobs keep their price', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  // a job at the old price first
  const j = ev("cwCreateJob({ kind: 'car', customer: { name: 'Jane', phone: '0712000111' }, vehicle: { plate: 'KDA 111A', category: 'compact' }, items: [{ serviceId: 'sd-wash-compact', name: 'Wash Compact Vehicle', price: cwPriceFor(cwFind(cwCfg().services, 'sd-wash-compact'), 'compact'), qty: 1 }] })");
  assert.equal(j.ok, true);
  assert.ok(d.querySelector('#cw-app [data-r="prices"], #cw-app [data-cw="go"][data-r="prices"]') || d.querySelector('#cw-app').textContent.includes('Price List'), 'Price List in the menu');
  ev("CW_UI.route = 'prices'; cwRenderShell(); cwRender();");
  assert.ok(d.querySelector('tr[data-pl="sd-wash-compact"]'), 'service row');
  A.type(d.querySelector('tr[data-pl="sd-wash-compact"] input[data-k="price"]'), '450');
  assert.equal(json('CW_UI.pl.dirty'), true);
  assert.equal(json("cwFind(cwCfg().services, 'sd-wash-compact').price"), 400, 'nothing saved before Save');
  // per-type: SUV pays more for the compact wash? use the large wash: SUV 600
  A.click('[data-cw="plper"][data-id="sd-wash-large"]');
  A.type(d.querySelector('tr[data-plp="sd-wash-large"] input[data-k="price:suv"]'), '600');
  // the typed compact price survived the re-render (draft)
  assert.equal(d.querySelector('tr[data-pl="sd-wash-compact"] input[data-k="price"]').value, '450');
  // add a service
  A.click('[data-cw="pladd"][data-t="car"]');
  const newRow = [...d.querySelectorAll('tr[data-pl]')].find((tr) => tr.querySelector('input[data-k="name"]').value === 'New service');
  A.type(newRow.querySelector('input[data-k="name"]'), 'Tyre Shine');
  A.type(newRow.querySelector('input[data-k="price"]'), '200');
  // delete a service
  A.w.confirm = () => true;
  A.click('[data-cw="pldel"][data-id="sd-dressing"]');
  A.click('[data-cw="plsave"]');
  const cfg = json('cwCfg()');
  assert.equal(cfg.services.find((s) => s.id === 'sd-wash-compact').price, 450);
  assert.equal(ev("cwPriceFor(cwFind(cwCfg().services, 'sd-wash-large'), 'suv')"), 600);
  assert.equal(ev("cwPriceFor(cwFind(cwCfg().services, 'sd-wash-large'), 'compact')"), 500, 'blank per-type price = the main price');
  assert.ok(cfg.services.find((s) => s.name === 'Tyre Shine' && s.price === 200 && s.category === 'Other services'));
  assert.equal(cfg.services.some((s) => s.id === 'sd-dressing'), false);
  assert.equal(json('CW_UI.pl ? CW_UI.pl.dirty : false'), false, 'a fresh draft after save');
  assert.equal(json(`cwGetJob(${JSON.stringify(j.job.id)}).items[0].price`), 400, 'a job already checked in keeps its price');
  assert.ok(json("cwAudit.filter(function (a) { return a.act === 'prices.save'; }).length") >= 1, 'price change audited');
  // validation: a blank price is refused
  ev("cwRender();");
  A.type(d.querySelector('tr[data-pl="sd-seats"] input[data-k="price"]'), '');
  A.click('[data-cw="plsave"]');
  assert.match(json('window.__toasts.slice(-1)[0]'), /ERR Seats needs a price/);
  // discard
  A.click('[data-cw="pldiscard"]');
  assert.equal(json("cwFind(cwCfg().services, 'sd-seats').price"), 4000);
  // reload the standard list: Dressing comes back, the edited compact wash goes back to 400, Tyre Shine stays
  ev("cwRender();");
  A.click('[data-cw="plstd"]'); A.click('[data-cw="plsave"]');
  const c2 = json('cwCfg()');
  assert.equal(c2.services.find((s) => s.name === 'Wash Compact Vehicle').price, 400);
  assert.ok(c2.services.some((s) => s.name === 'Dressing'));
  assert.ok(c2.services.some((s) => s.name === 'Tyre Shine'));
  // vehicle types: add one
  ev("cwRender();"); A.w.prompt = () => 'Motorbike'; A.click('[data-cw="plcatadd"]'); A.click('[data-cw="plsave"]');
  assert.ok(json('cwCfg().vehicleCats').some((c) => c.k === 'motorbike' && c.l === 'Motorbike'));
  // the settings tab points to the Price List
  ev("CW_UI.route = 'settings'; CW_UI.setTab = 'services'; cwRenderShell(); cwRender();");
  A.click('[data-cw="goprices"]');
  assert.equal(json('CW_UI.route'), 'prices');
  assert.deepEqual(A.errors, []);
  A.close();
});

test('an untouched zip 361 catalogue is upgraded to the standard list on start; an edited one is kept', async () => {
  const v1 = (edit) => {
    const car = (id, name, a, b, c, d2) => ({ id, kind: 'car', name, category: 'Wash', prices: { small: a, saloon: b, suv: c, van: d2 }, minutes: 20, loyalty: true, active: true });
    const cl = (id, name, p) => ({ id, kind: 'clean', name, cleanType: 'carpet', price: p, unit: 'per piece', minutes: 60, loyalty: true, active: true });
    const list = [car('svc-body', 'Body Wash', 250, 300, 400, 500), car('svc-fullbody', 'Full Body Wash', 400, 500, 700, 800), car('svc-interior', 'Interior Cleaning', 300, 400, 500, 600), car('svc-vacuum', 'Vacuum', 150, 200, 250, 300), car('svc-engine', 'Engine Cleaning', 400, 500, 700, 800), car('svc-under', 'Underwash', 300, 400, 500, 600), car('svc-buff', 'Buffing', 1500, 2000, 2500, 3000), car('svc-polish', 'Polishing', 1200, 1500, 2000, 2500), car('svc-intdetail', 'Interior Detailing', 2000, 2500, 3500, 4000), car('svc-fulldetail', 'Full Detailing', 4000, 5000, 7000, 8000), car('svc-upholstery', 'Upholstery Cleaning', 1500, 2000, 2500, 3000), cl('svc-carpet', 'Carpet Cleaning', 800), cl('svc-sofa', 'Sofa', 500), cl('svc-mattress', 'Mattress', 1500), cl('svc-house', 'House', 3500), cl('svc-office', 'Office', 5000)];
    if (edit) list[0].prices.saloon = 350;
    return JSON.stringify([{ id: 'cfg', v: 1, updatedAt: 5, services: list, vehicleCats: [{ k: 'small', l: 'Small' }, { k: 'saloon', l: 'Saloon' }, { k: 'suv', l: 'SUV' }, { k: 'van', l: 'Van' }], business: { name: 'X' } }]);
  };
  const A = await open('carwash/index.html', { storage: { pos_cw_config: v1(false) } });
  const a = A.json('cwCfg()');
  assert.equal(a.catalog, 'sd1'); assert.ok(a.services.some((s) => s.id === 'sd-ceramic')); assert.deepEqual(a.vehicleCats.map((c) => c.k), ['compact', 'large', 'suv', 'truck', 'cab']);
  assert.equal(A.ev("cwVehCatLabel(cwCfg(), 'saloon')"), 'Saloon', 'an older vehicle type keeps its label');
  A.close();
  const B = await open('carwash/index.html', { storage: { pos_cw_config: v1(true) } });
  const b = B.json('cwCfg()');
  assert.ok(b.services.some((s) => s.id === 'svc-body' && s.prices.saloon === 350), 'an edited catalogue is left alone');
  assert.equal(b.services.some((s) => s.id === 'sd-ceramic'), false);
  B.close();
});

test('Car Wash customers: add with email / gender / contact, edit, delete (blocked while a job is open), vehicle year and delete', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  A.w.confirm = () => true;
  ev("cwOpenNewCustomer()");
  A.type(d.getElementById('cw-nc-name'), 'Mary Wanjiku'); A.type(d.getElementById('cw-nc-phone'), '0722 555 666');
  A.type(d.getElementById('cw-nc-email'), 'Mary@Example.com'); d.getElementById('cw-nc-gender').value = 'female'; d.getElementById('cw-nc-pref').value = 'whatsapp';
  A.click('[data-cw="custcreate"]');
  const c = json("cwCustomers.find(function (x) { return x.name === 'Mary Wanjiku'; })");
  assert.equal(c.email, 'mary@example.com'); assert.equal(c.gender, 'female'); assert.equal(c.contactPref, 'whatsapp');
  // bad email refused
  assert.equal(json(`cwUpsertCustomer({ id: ${JSON.stringify(c.id)}, email: 'not-an-email' })`).ok, false);
  // edit from the profile
  ev(`cwOpenCustomer(${JSON.stringify(c.id)})`);
  A.type(d.getElementById('cw-cu-name'), 'Mary W. Wanjiku'); d.getElementById('cw-cu-pref').value = 'call';
  A.click('[data-cw="custsave"]');
  assert.equal(json(`cwFind(cwCustomers, ${JSON.stringify(c.id)}).name`), 'Mary W. Wanjiku');
  assert.equal(json(`cwFind(cwCustomers, ${JSON.stringify(c.id)}).contactPref`), 'call');
  // vehicle with year
  const v = json(`cwUpsertVehicle({ plate: 'KDC 222C', make: 'Toyota', model: 'Prado', year: '2016', category: 'suv', customerId: ${JSON.stringify(c.id)} })`);
  assert.equal(v.ok, true); assert.equal(v.vehicle.year, '2016');
  assert.equal(json(`cwUpsertVehicle({ plate: 'KDC 222C', year: '16' })`).ok, false, 'a 2-digit year is refused');
  // an open job blocks the delete
  const j = json(`cwCreateJob({ kind: 'car', customer: { id: ${JSON.stringify(c.id)}, phone: '0722555666' }, vehicle: { plate: 'KDC 222C' }, items: [{ serviceId: 'sd-wash-large', name: 'Wash Large Vehicle', price: 500, qty: 1 }] })`);
  assert.equal(j.ok, true);
  const blocked = json(`cwDeleteCustomer(${JSON.stringify(c.id)})`);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /in progress/);
  // finish the job, then delete from the profile button
  ev(`cwRecordPayment({ jobId: ${JSON.stringify(j.job.id)}, amount: 500, method: 'cash' }); ['washing','completed','collected'].forEach(function (s) { cwSetStatus(${JSON.stringify(j.job.id)}, s, { force: true }); });`);
  assert.equal(json(`cwGetJob(${JSON.stringify(j.job.id)}).status`), 'collected');
  ev(`cwOpenCustomer(${JSON.stringify(c.id)})`);
  A.click('[data-cw="custdel"]');
  assert.equal(json(`cwFind(cwCustomers, ${JSON.stringify(c.id)})._deleted`), true);
  assert.equal(json(`cwFind(cwVehicles, ${JSON.stringify(v.vehicle.id)})._deleted`), true, 'their vehicles go with them');
  assert.equal(json('cwLive(cwCustomers).length'), 0);
  assert.equal(json(`cwJobCustomer(cwGetJob(${JSON.stringify(j.job.id)})).name`), 'Mary W. Wanjiku', 'past jobs keep the name');
  const sync = json('cwSyncCollect()');
  assert.ok(sync.cwCustomers.some((x) => x.id === c.id && x._deleted === true), 'the deletion is synced as a tombstone');
  // a vehicle can be deleted on its own
  const c2 = json("cwUpsertCustomer({ name: 'Tom', phone: '0733000999' })").customer;
  const v2 = json(`cwUpsertVehicle({ plate: 'KBB 333B', customerId: ${JSON.stringify(c2.id)} })`).vehicle;
  assert.equal(json(`cwDeleteVehicle(${JSON.stringify(v2.id)})`).ok, true);
  assert.equal(json(`cwVehiclesOf(${JSON.stringify(c2.id)}).length`), 0);
  // a cashier cannot delete customers
  ev("currentServer = null;");
  assert.deepEqual(A.errors, []);
  A.close();
});

test('Car Wash staff: the owner picks the tabs each person can open; the menu and routes follow it', async () => {
  const A = await open('carwash/index.html');
  const { ev, json, d } = A;
  const r = await ev("cwAddStaff({ name: 'Ann Cashier', pin: '2580', role: 'cashier' })");
  assert.equal(r.ok, true);
  const id = json("staff.find(function (m) { return m.name === 'Ann Cashier'; }).id");
  // the staff editor shows the tab boxes ticked from the role
  ev(`cwOpenStaff(${JSON.stringify(id)})`);
  const ticked = [...d.querySelectorAll('.cw-st-tab')].filter((x) => x.checked).map((x) => x.value);
  assert.deepEqual(ticked, json("cwRoleTabs('cashier')"));
  assert.ok(!ticked.includes('prices') && !ticked.includes('settings'));
  // give Price List, take Billing away
  d.querySelector('.cw-st-tab[value="prices"]').checked = true;
  d.querySelector('.cw-st-tab[value="payments"]').checked = false;
  A.click('[data-cw="staffsave"]');
  const m = json(`staff.find(function (x) { return x.id === ${JSON.stringify(id)}; })`);
  assert.ok(m.cwTabs.includes('prices')); assert.ok(!m.cwTabs.includes('payments'));
  // as Ann
  ev(`currentServer = { id: ${JSON.stringify(id)}, name: 'Ann Cashier' };`);
  const me = json('cwMe()');
  assert.equal(ev('cwRouteAllowed("prices", cwMe())'), true);
  assert.equal(ev('cwRouteAllowed("payments", cwMe())'), false);
  assert.equal(ev('cwCan("prices")'), true, 'the tab grants its screen');
  assert.equal(ev('cwCan("payments")'), false, 'a tab taken away takes its screen away');
  assert.equal(ev('cwCan("customers.edit")'), true, 'actions still follow the role');
  assert.equal(me.role, 'cashier');
  ev('cwRenderShell(); cwRender();');
  const nav = d.querySelector('#cw-app .cw-nav').textContent;
  assert.ok(nav.includes('Price List')); assert.ok(!nav.includes('Billing & Payments'));
  // back to the role default: the own list is dropped
  ev('currentServer = null;');
  assert.equal(json(`cwUpdateStaff(${JSON.stringify(id)}, { tabs: cwRoleTabs('cashier') }).ok`), true);
  assert.equal(json(`'cwTabs' in staff.find(function (x) { return x.id === ${JSON.stringify(id)}; })`), false, 'same as the role = no own list');
  assert.equal(json(`cwUpdateStaff(${JSON.stringify(id)}, { tabs: [] }).ok`), false, 'at least one tab');
  assert.deepEqual(A.errors, []);
  A.close();
});

test('printables: client intake form (filled and blank), till receipt, price list, A4 invoice', async () => {
  const A = await open('carwash/index.html');
  const { ev, json } = A;
  ev("cwSaveCfg({ business: Object.assign({}, cwCfg().business, { name: 'Lavington Splash & Dash', phone: '0181 976 434', email: 'info@example.co.ke', location: 'Muthangari Gardens' }) }, 'Business');");
  const j = json("cwCreateJob({ kind: 'car', customer: { name: 'Peter Otieno', phone: '0711222333', email: 'p@x.co', gender: 'male', contactPref: 'sms' }, vehicle: { plate: 'KDG 456G', make: 'Mazda', model: 'Demio', year: '2014', colour: 'Blue', category: 'compact' }, items: [{ serviceId: 'sd-wash-compact-vac', name: 'Wash Compact Vehicle with Vacuum', price: 700, qty: 1 }, { serviceId: 'sd-dressing', name: 'Dressing', price: 300, qty: 1 }] })");
  ev(`cwRecordPayment({ jobId: ${JSON.stringify(j.job.id)}, amount: 1000, method: 'mpesa', ref: 'QAB12CD34' })`);
  ev(`cwIntakeForm(${JSON.stringify(j.job.id)})`);
  let h = json('window.__prints.slice(-1)[0]');
  assert.match(h, /CLIENT INTAKE FORM/); assert.match(h, /Lavington Splash &amp; Dash/); assert.match(h, /Muthangari Gardens/);
  assert.match(h, /Peter Otieno/); assert.match(h, /KDG 456G/); assert.match(h, /2014/); assert.match(h, /Mazda/);
  assert.match(h, /<span class="bx">✓<\/span>Compact/, 'vehicle type ticked');
  assert.match(h, /<span class="bx">✓<\/span>Male/, 'gender ticked');
  assert.match(h, /<span class="bx">✓<\/span><span class="nm">Wash Compact Vehicle with Vacuum<\/span><span class="pr">ksh 700\/=/);
  assert.match(h, /<span class="bx"><\/span><span class="nm">Ceramic Coating<\/span><span class="pr">ksh 15,000\/=/);
  assert.match(h, /<span class="bx">✓<\/span>MPESA/); assert.match(h, /Manager Name/); assert.match(h, /Signature/);
  assert.match(h, /Small \(Ksh 1,000\)/);
  ev('cwIntakeForm(null)');
  h = json('window.__prints.slice(-1)[0]');
  assert.match(h, /CLIENT INTAKE FORM/); assert.equal(/<span class="bx">✓/.test(h), false, 'a blank form has nothing ticked');
  ev(`cwReceipt(${JSON.stringify(j.job.id)})`);
  h = json('window.__prints.slice(-1)[0]');
  assert.match(h, /size:80mm auto/); assert.match(h, /TOTAL KES<\/b><b>1,000/); assert.match(h, /BALANCE<\/b><b>0/); assert.match(h, /QAB12CD34/);
  ev('cwPrintPriceList()');
  h = json('window.__prints.slice(-1)[0]');
  assert.match(h, /PRICE LIST/); assert.match(h, /Exterior/); assert.match(h, /Carpet\/Rug Large/); assert.match(h, /15,000/);
  ev(`cwInvoice(${JSON.stringify(j.job.id)})`);
  h = json('window.__prints.slice(-1)[0]');
  assert.match(h, /INVOICE/); assert.match(h, /p@x\.co/); assert.match(h, /Compact/); assert.match(h, /2014/);
  // job drawer offers the three documents
  ev(`cwOpenJob(${JSON.stringify(j.job.id)})`);
  for (const a of ['jobcard', 'receipt', 'invoice']) assert.ok(A.d.querySelector(`#cw-modal [data-cw="${a}"]`), a + ' button');
  assert.deepEqual(A.errors, []);
  A.close();
});

const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];
for (const file of APPS) {
  test(`${file}: add, edit and delete a customer; edit a staff member's tabs`, async () => {
    const A = await open(file);
    const { ev, json, d } = A;
    A.w.confirm = () => true;
    ev("typeof openAddCustomerModal === 'function' && openAddCustomerModal()");
    d.getElementById('add-customer-name-input').value = 'Grace Achieng';
    d.getElementById('add-customer-phone-input').value = '0745123456';
    await ev('saveNewCustomer()');
    await wait(50);
    let c = json("customers.find(function (x) { return x && x.name === 'Grace Achieng'; }) || null");
    assert.ok(c, 'customer added');
    // the profile shows Edit + Delete
    ev(`openCustomerProfileModal(${JSON.stringify(c.id)})`);
    await wait(30);
    const edit = d.querySelector('#fr-profile.fr-open .cm-edit') || d.querySelector('#customer-profile-modal .cm-edit');
    assert.ok(edit, 'Edit details button on the profile');
    const del = d.querySelector('#fr-profile.fr-open .cm-del') || [...d.querySelectorAll('#customer-profile-modal button')].find((b) => /Remove Customer/.test(b.textContent));
    assert.ok(del, 'Delete button on the profile');
    // edit
    edit.dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
    const nm = d.getElementById('cp-e-name') || d.getElementById('cm-e-name');
    assert.ok(nm, 'edit dialog');
    nm.value = 'Grace A. Achieng';
    (d.getElementById('cp-e-save') || d.getElementById('cm-e-save')).dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
    await wait(30);
    c = json(`customers.find(function (x) { return x && x.id === ${JSON.stringify(c.id)}; }) || null`);
    assert.equal(c.name, 'Grace A. Achieng');
    const key = file === 'water/index.html' ? 'aqua_customers' : 'pos_customers';
    assert.ok(A.w.localStorage.getItem(key).includes('Grace A. Achieng'), 'saved');
    // delete
    ev(`openCustomerProfileModal(${JSON.stringify(c.id)})`); await wait(30);
    const del2 = d.querySelector('#fr-profile.fr-open .cm-del') || [...d.querySelectorAll('#customer-profile-modal button')].find((b) => /Remove Customer/.test(b.textContent));
    del2.dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
    await wait(30);
    assert.equal(json(`customers.some(function (x) { return x && x.id === ${JSON.stringify(c.id)} && !x._deleted; })`), false, 'customer deleted');
    assert.equal(A.w.localStorage.getItem(key).includes('Grace A. Achieng'), false, 'deleted in storage');
    // staff tabs
    ev("staff.push({ id: 'st-t1', name: 'Tabby', roles: [], lockedDates: [], salesTabMigrated: true, updatedAt: 1 }); safeSetItem('pos_staff', JSON.stringify(staff));");
    const tab = json('ROLE_TABS.filter(function (t) { return t.id !== "profits-tab"; })[0].id');
    ev(`updateStaffRole('st-t1', ${JSON.stringify(tab)}, true)`);
    assert.ok(json("staff.find(function (s) { return s.id === 'st-t1'; }).roles").includes(tab), 'tab given');
    ev(`updateStaffRole('st-t1', ${JSON.stringify(tab)}, false)`);
    assert.equal(json("staff.find(function (s) { return s.id === 'st-t1'; }).roles").includes(tab), false, 'tab taken away');
    assert.deepEqual(A.errors, []);
    A.close();
  });
}

test('online round trip through the real sync server: price list, customer edit and delete, staff tabs reach a second device', async () => {
  const path = await import('node:path'); const { pathToFileURL } = await import('node:url'); const { ROOT } = await import('./helpers.mjs');
  const { makeKV, seedShop } = await import('./kv-fake.mjs');
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const push = async (b) => {
    const body = JSON.parse(b.w.eval('JSON.stringify(collectSyncPayload())'));
    const r = await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ ...body, updatedAt: Date.now() }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
    assert.ok(r.status < 300, 'push accepted ' + r.status);
  };
  const pull = async (b) => {
    const st = await (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1&hot=all'), env, waitUntil() {} })).json();
    b.w.eval('applyRemotePayload(' + JSON.stringify(st) + ')');
    return st;
  };
  const A = await open('carwash/index.html'); const B = await open('carwash/index.html');
  A.w.confirm = () => true;
  // device A works OFFLINE (every fetch fails): customer, job, price change, staff tabs
  const c = A.json("cwUpsertCustomer({ name: 'Brian Kip', phone: '0799111222', email: 'brian@x.co', gender: 'male' }).customer");
  const c2 = A.json("cwUpsertCustomer({ name: 'Lucy Moraa', phone: '0799333444' }).customer");
  A.ev("CW_UI.route = 'prices'; cwRenderShell(); cwRender();");
  A.type(A.d.querySelector('tr[data-pl="sd-engine"] input[data-k="price"]'), '650');
  A.click('[data-cw="plsave"]');
  const add = await A.ev("cwAddStaff({ name: 'Sam Field', pin: '1357', role: 'attendant' })");
  assert.equal(add.ok, true);
  const sid = A.json("staff.find(function (m) { return m.name === 'Sam Field'; }).id");
  assert.equal(A.json(`cwUpdateStaff(${JSON.stringify(sid)}, { tabs: ['myjobs', 'customers'] }).ok`), true);
  assert.equal(A.json("cwFind(cwCfg().services, 'sd-engine').price"), 650, 'saved on the device while offline');
  // back online: push, the other device pulls
  await push(A); await pull(B);
  assert.equal(B.json("cwFind(cwCfg().services, 'sd-engine').price"), 650, 'price list reached device B');
  assert.equal(B.json(`cwFind(cwCustomers, ${JSON.stringify(c.id)}).email`), 'brian@x.co');
  assert.deepEqual(B.json(`staff.find(function (m) { return m.id === ${JSON.stringify(sid)}; }).cwTabs`), ['myjobs', 'customers'], 'staff tabs reached device B');
  // B edits Lucy, A deletes Brian; both push; both pull
  assert.equal(B.json(`cwUpsertCustomer({ id: ${JSON.stringify(c2.id)}, name: 'Lucy N. Moraa' }).ok`), true);
  assert.equal(A.json(`cwDeleteCustomer(${JSON.stringify(c.id)}).ok`), true);
  await push(B); await push(A); await pull(A); await pull(B);
  for (const X of [A, B]) {
    assert.equal(X.json(`cwFind(cwCustomers, ${JSON.stringify(c2.id)}).name`), 'Lucy N. Moraa', 'edit everywhere');
    assert.equal(X.json(`cwLive(cwCustomers).some(function (x) { return x.id === ${JSON.stringify(c.id)}; })`), false, 'delete everywhere');
  }
  // a stale copy of Brian (device B never saw the delete before editing) cannot bring him back
  const stale = { ...B.json(`cwFind(cwCustomers, ${JSON.stringify(c.id)})`), _deleted: false, name: 'Brian again', updatedAt: Date.now() + 5000 };
  await sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), cwCustomers: [stale] }), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  await pull(A);
  assert.equal(A.json(`cwLive(cwCustomers).some(function (x) { return x.id === ${JSON.stringify(c.id)}; })`), false, 'a deleted customer stays deleted');
  assert.deepEqual(A.errors, []); assert.deepEqual(B.errors, []);
});
