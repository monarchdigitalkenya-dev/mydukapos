import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 162 - Services engine end to end on the real page: business type -> job -> payment -> status -> reports/history/search -> custom fields -> appointments.
async function app() { const b = await boot('services/index.html', { wait: 1200 }); b.w.eval("showToast = function () {}; window.confirm = () => true"); return b; }
const ev = (b, js) => JSON.parse(b.w.eval(`JSON.stringify(${js})`));

test('car wash: job, deposit, balance, status, search, reports, history', async () => {
  const b = await app();
  b.w.eval("svcSetBusinessType('car_wash', { source: 'test' })");
  const c = ev(b, "svcCreateJob({ typeKey: 'car_wash', values: { cust_name: 'Wanjiku', cust_phone: '0712345678', veh_plate: 'kda 123a', veh_make: 'Toyota', veh_model: 'Premio', veh_type: 'sedan', services: [{ name: 'Full wash', qty: 1, price: 1500 }] }, services: [{ name: 'Full wash', qty: 1, price: 1500 }] })");
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 300));
  const id = c.job.id;
  assert.equal(ev(b, `svcTotals(svcGetJob('${id}')).total`), 1500);
  assert.equal(ev(b, `svcRecordPayment('${id}', { amount: 500, method: 'cash', kind: 'deposit' })`).ok, true);
  const t = ev(b, `svcTotals(svcGetJob('${id}'))`);
  assert.equal(t.paid, 500); assert.equal(t.balance, 1000);
  assert.equal(ev(b, `svcSetStatus('${id}', 'in_progress', {})`).ok, true);
  assert.ok(ev(b, "svcSearch('KDA')").some((x) => x.kind === 'job'));
  const rep = (k) => b.w.eval(`svcReportBuild('${k}', { from: 0, to: Date.now() + 1e9 }).html.replace(/<[^>]+>/g, ' ')`);
  assert.match(rep('svc_owed'), /Wanjiku[\s\S]*1,000/);
  assert.match(rep('svc_revenue'), /500/);
  assert.match(rep('svc_jobs'), /Created\s+1/);
  for (const k of ['svc_turnaround', 'svc_mix', 'svc_materials', 'svc_customers', 'svc_staff', 'svc_quotes', 'svc_appts', 'svc_cancel']) assert.ok(b.w.eval(`svcReportBuild('${k}', { from: 0, to: Date.now() + 1e9 }).html.length`) > 0, k);
  const hist = b.w.eval(`(function () { var d = document.createElement('div'); svcRenderHistory(d, { phoneKey: svcGetJob('${id}').customer.phoneKey }); return d.textContent; })()`);
  assert.match(hist, /1 visit/); assert.match(hist, /Owes/);
  assert.equal(typeof b.w.window.reportExtraBuilders.svc_jobs, 'function');
  assert.deepEqual(b.errors, []); b.close();
});

test('custom fields: validated, id never reused, switched off not deleted, form shows them only for chosen types', async () => {
  const b = await app();
  assert.equal(ev(b, "svcCustomFieldUpsert({ label: '', type: 'text', serviceTypes: ['car_wash'] })").ok, false);
  assert.equal(ev(b, "svcCustomFieldUpsert({ label: 'Pick', type: 'dropdown', options: 'only one', serviceTypes: ['car_wash'] })").ok, false);
  const r = ev(b, "svcCustomFieldUpsert({ label: 'Fuel level', type: 'dropdown', options: 'Empty\\nHalf\\nFull', serviceTypes: ['car_wash'] })");
  assert.equal(r.ok, true); assert.equal(r.field.id, 'cf_fuel_level');
  assert.equal(ev(b, "svcCustomFieldUpsert({ label: 'Fuel level', type: 'text', serviceTypes: ['garage'] })").field.id, 'cf_fuel_level_2');
  const has = (t) => b.w.eval(`svcGetTemplate('${t}').sections.some(function (s) { return s.fields.some(function (f) { return f.id === 'cf_fuel_level'; }); })`);
  assert.equal(has('car_wash'), true); assert.equal(has('salon'), false);
  b.w.eval("svcCustomFieldSetActive('cf_fuel_level', false)");
  assert.equal(has('car_wash'), false);
  assert.equal(b.w.eval("svcCuList().length"), 2, 'switched off, not removed');
  assert.deepEqual(b.errors, []); b.close();
});

test('appointments + photo queue + permission presets exist and behave', async () => {
  const b = await app();
  b.w.eval("svcSetBusinessType('salon', { source: 'test' })");
  const d = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const a = ev(b, `svcApptCreate({ customer: { name: 'Mary', phone: '0722000111' }, date: '${d}', start: '10:00', end: '11:00', services: [{ name: 'Braids', price: 800 }] })`);
  assert.equal(a.ok, true);
  assert.equal(b.w.eval("typeof svcFreeSlots + typeof svcPhotoAdd + typeof svcPhotoFlush + typeof svcPhotoUrl + typeof svcUseMaterial + typeof svcStaffPermHtml"), 'functionfunctionfunctionfunctionfunctionfunction');
  assert.equal(b.w.eval("svcPhotoAdd(null)  instanceof Promise"), true);
  assert.deepEqual(b.errors, []); b.close();
});
