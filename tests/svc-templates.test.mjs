// svc-templates (B1-A): the ten declarative templates, reference data, lookups and the frozen golden field-id file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { loadSvc, toPlain } from './svc-helpers.mjs';

const S = loadSvc(['svc-core', 'svc-templates']);
const ORDER = toPlain(S.SVC_TYPE_ORDER);
const T = (k) => toPlain(S.SVC_TYPES[k]);
const ids = (k) => T(k).sections.flatMap((s) => s.fields.map((f) => f.id));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/svc-field-ids.json'), 'utf8'));

test('ten templates in the documented order, each valid against svcValidateTemplate', () => {
  assert.deepEqual(ORDER, ['phone_repair', 'car_wash', 'garage', 'salon', 'barber', 'laundry', 'cleaning', 'electronics_repair', 'tailoring', 'other']);
  assert.deepEqual(Object.keys(S.SVC_TYPES).sort(), ORDER.slice().sort());
  ORDER.forEach((k) => assert.deepEqual(toPlain(S.svcValidateTemplate(S.SVC_TYPES[k])), [], k));
  const prefixes = ORDER.map((k) => T(k).prefix);
  assert.equal(new Set(prefixes).size, 10);
  assert.deepEqual(prefixes, ['PR', 'CW', 'GR', 'SL', 'BB', 'LD', 'CN', 'ER', 'TL', 'SV']);
  ORDER.forEach((k) => assert.equal(T(k).key, k));
});
test('svcValidateTemplate catches real mistakes', () => {
  const t = T('car_wash');
  const mutate = (fn) => { const c = toPlain(t); fn(c); return toPlain(S.svcValidateTemplate(c)); };
  assert.ok(mutate((c) => { c.sections[1].fields.push(c.sections[1].fields[0]); }).some((e) => /duplicate field/.test(e)));
  assert.ok(mutate((c) => { c.statuses[0].next.push('ghost'); }).some((e) => /unknown ghost/.test(e)));
  assert.ok(mutate((c) => { c.initialStatus = 'ghost'; }).some((e) => /initialStatus/.test(e)));
  assert.ok(mutate((c) => { c.sections[1].fields[1].visibleWhen = { field: 'nope', eq: 1 }; }).some((e) => /unknown field nope/.test(e)));
  assert.ok(mutate((c) => { c.notify.events.ready.tpl = 'Hi {zzz}'; }).some((e) => /notify var zzz/.test(e)));
  assert.ok(mutate((c) => { c.statuses.push({ key: 'island', label: 'I', icon: '', color: '#000', group: '', phase: 1, scope: 'job', next: [], requires: [] }); }).some((e) => /unreachable status island/.test(e)));
  assert.ok(mutate((c) => { c.sections[0].fields[0].type = 'hologram'; }).some((e) => /field type/.test(e)));
  assert.ok(toPlain(S.svcValidateTemplate(null)).length > 0);
});

test('golden field ids and status keys only grow (R4/R5): nothing shipped disappeared or changed type', () => {
  assert.deepEqual(Object.keys(golden.types).sort(), ORDER.slice().sort());
  Object.keys(golden.types).forEach((k) => {
    const cur = {}; T(k).sections.forEach((s) => s.fields.forEach((f) => { cur[f.id] = f.type; }));
    Object.keys(golden.types[k].fields).forEach((id) => { assert.ok(id in cur, `${k}: field ${id} disappeared`); assert.equal(cur[id], golden.types[k].fields[id], `${k}: field ${id} changed type`); });
    const keys = T(k).statuses.map((s) => s.key);
    golden.types[k].statuses.forEach((sk) => assert.ok(keys.includes(sk), `${k}: status ${sk} disappeared`));
  });
});
test('field ids are unique within a template and follow the naming rule', () => {
  ORDER.forEach((k) => { const a = ids(k); assert.equal(new Set(a).size, a.length, k); a.forEach((id) => assert.match(id, /^[a-z][a-z0-9_]*$/)); });
});

test('irrelevant industry fields are absent: prefixes belong to one asset kind only', () => {
  const pre = (k, p) => ids(k).filter((i) => i.startsWith(p));
  ['salon', 'barber', 'phone_repair', 'laundry', 'cleaning', 'tailoring', 'other', 'electronics_repair'].forEach((k) => {
    ['veh_', 'cond_', 'val_', 'valuables'].forEach((p) => assert.deepEqual(pre(k, p), [], `${k} must not have ${p}`));
  });
  ['salon', 'barber', 'car_wash', 'garage', 'laundry', 'cleaning', 'tailoring', 'other'].forEach((k) => assert.deepEqual(pre(k, 'dev_'), [], `${k} dev_`));
  ['car_wash', 'garage', 'salon', 'barber'].forEach((k) => ['dev_imei', 'dev_serial', 'eq_serial'].forEach((i) => assert.ok(!ids(k).includes(i), `${k} ${i}`)));
  ['phone_repair', 'car_wash', 'garage', 'laundry', 'cleaning', 'tailoring', 'other', 'electronics_repair'].forEach((k) => ['appt_mode', 'appt_date', 'appt_special', 'appt_staff'].forEach((i) => assert.ok(!ids(k).includes(i), `${k} ${i}`)));
  assert.ok(!ids('phone_repair').some((i) => /^(veh|cond|val|appt|cmp|dx|ld|site|tl)_/.test(i)));
  assert.deepEqual(ids('car_wash').filter((i) => /^(dev|dx|cmp|appt|eq|tl|ld|site)_/.test(i)), []);
  assert.deepEqual(ids('electronics_repair').filter((i) => /^(veh|dev|imei)/.test(i)), []);
  assert.ok(!ids('electronics_repair').includes('dev_imei'));
});

test('phone_repair: device + repair structure, required fields, IMEI only for phone/tablet (warn), legacy ids', () => {
  const t = T('phone_repair'), f = (id) => t.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  ['cust_name', 'cust_phone', 'dev_type', 'dev_brand', 'dev_model', 'rep_problem'].forEach((id) => assert.ok(f(id).required === true || f(id).required === 'quickOff', id));
  assert.equal(f('cust_phone').required, 'quickOff');
  ['dev_imei', 'dev_imei2', 'dev_serial', 'dev_color', 'dev_condition', 'dev_accessories', 'dev_passcode', 'rep_diagnosis', 'rep_recommended', 'rep_labour', 'rep_tech', 'parts', 'services', 'quote', 'payment', 'status', 'cust_alt_phone', 'cust_email', 'cust_notes'].forEach((id) => assert.ok(f(id), id));
  assert.deepEqual(f('dev_imei').visibleWhen, { field: 'dev_type', in: ['phone', 'tablet'] });
  assert.equal(f('dev_imei').validate, 'imei'); assert.equal(f('dev_imei').level, 'warn');
  assert.equal(f('dev_passcode').sensitive, true);
  assert.deepEqual(f('dev_type').options.map((o) => o.l), ['Phone', 'Tablet', 'Laptop', 'Smartwatch', 'Other']);
  assert.deepEqual(f('dev_accessories').options.map((o) => o.l), ['Charger', 'SIM', 'SD card', 'Case', 'Battery']);
  assert.equal(f('dev_brand').optionsFrom, 'phoneBrands');
  assert.deepEqual(toPlain(S.SVC_PHONE_BRANDS), ['Samsung', 'Apple', 'Tecno', 'Infinix', 'Itel', 'Xiaomi', 'Oppo', 'Vivo', 'Huawei', 'Nokia', 'Realme', 'Google', 'OnePlus', 'Other']);
  // legacy record keys -> engine fields (old data maps 1:1)
  assert.deepEqual(Object.keys(t.legacyMap.fields).sort(), ['clientName', 'clientPhone', 'idNumber', 'itemDetails', 'laborFee', 'promisedPickup', 'quoteAmount', 'serviceNotes']);
  ['leg_id_number', 'leg_item_details', 'leg_notes'].forEach((id) => assert.ok(f(id), id));
  assert.equal(t.legacyMap.status.pending, 'received');
  Object.values(t.legacyMap.status).forEach((k) => assert.ok(t.statuses.some((s) => s.key === k), k));
});
test('phone_repair statuses are exactly the documented workflow', () => {
  assert.deepEqual(T('phone_repair').statuses.map((s) => s.key), ['received', 'diagnosing', 'awaiting_approval', 'awaiting_parts', 'in_progress', 'ready', 'completed', 'collected', 'cancelled']);
  assert.deepEqual(T('phone_repair').statuses.map((s) => s.label), ['Received', 'Diagnosing', 'Awaiting Approval', 'Awaiting Parts', 'In Progress', 'Ready', 'Completed', 'Collected', 'Cancelled']);
  // legacy keys (pending maps to received)
  ['in_progress', 'ready', 'completed', 'collected'].forEach((k) => assert.ok(T('phone_repair').statuses.some((s) => s.key === k)));
});

test('car_wash / garage: vehicle fields, 11 vehicle types, 20 makes, models, plate is the asset key', () => {
  ['car_wash', 'garage'].forEach((k) => {
    const f = (id) => T(k).sections.flatMap((s) => s.fields).find((x) => x.id === id);
    ['veh_plate', 'veh_make', 'veh_model', 'veh_type'].forEach((id) => assert.equal(f(id).required, true, k + id));
    ['veh_color', 'veh_year', 'veh_odometer', 'veh_notes'].forEach((id) => assert.ok(f(id), id));
    assert.equal(f('veh_plate').type, 'plate'); assert.equal(f('veh_plate').validate, 'plate'); assert.equal(f('veh_plate').level, 'warn');
    assert.equal(f('veh_plate').assetAttr, 'plate'); assert.equal(f('veh_plate').autocomplete, 'asset');
    assert.equal(f('veh_model').optionsFrom, 'vehicleModels:veh_make');
    assert.equal(f('veh_type').options.length, 11);
  });
  assert.deepEqual(toPlain(S.svcVehicleTypes()).map((x) => x.l), ['Sedan', 'Hatchback', 'SUV', 'Crossover', 'Pickup', 'Van', 'Minibus', 'Bus', 'Truck', 'Motorcycle', 'Other']);
  const makes = toPlain(S.svcVehicleMakes());
  assert.equal(makes.length, 20); assert.equal(makes[makes.length - 1], 'Other');
  ['Toyota', 'Nissan', 'Subaru', 'Mazda', 'Honda', 'Mercedes-Benz', 'BMW', 'Volkswagen', 'Mitsubishi', 'Isuzu', 'Ford', 'Hyundai', 'Kia', 'Suzuki', 'Peugeot', 'Land Rover', 'Lexus', 'Audi', 'Volvo'].forEach((m) => assert.ok(makes.includes(m), m));
  assert.ok(toPlain(S.svcVehicleModels('Toyota')).includes('Premio'));
  assert.ok(toPlain(S.svcVehicleModels('Nissan')).includes('X-Trail'));
  assert.deepEqual(toPlain(S.svcVehicleModels('Other')), []);
  assert.deepEqual(toPlain(S.svcVehicleModels('Nothing')), []);
  Object.keys(toPlain(S.SVC_VEHICLE_MAKES)).forEach((m) => assert.ok(toPlain(S.svcVehicleMakes()).includes(m)));
});
test('vehicle config overrides (cfg-vehicle) extend and hide without mutating the built-ins', () => {
  const cfg = { makes: [{ name: 'Daihatsu', models: ['Mira', 'Terios'] }, { name: 'Toyota', models: ['Crown Athlete'] }, { name: 'Kia', hidden: true }], hiddenMakes: ['Audi'], types: [{ v: 'tuktuk', l: 'Tuk-tuk' }, { v: 'bus', hidden: true }, { v: 'suv', l: 'SUV / 4x4' }] };
  const makes = toPlain(S.svcVehicleMakes(cfg));
  assert.ok(makes.includes('Daihatsu') && !makes.includes('Audi') && !makes.includes('Kia') && makes[makes.length - 1] === 'Other');
  assert.ok(toPlain(S.svcVehicleModels('Toyota', cfg)).includes('Crown Athlete'));
  assert.ok(toPlain(S.svcVehicleModels('Daihatsu', cfg)).includes('Terios'));
  const types = toPlain(S.svcVehicleTypes(cfg));
  assert.ok(types.some((x) => x.v === 'tuktuk') && !types.some((x) => x.v === 'bus') && types.find((x) => x.v === 'suv').l === 'SUV / 4x4' && types[types.length - 1].v === 'other');
  assert.equal(toPlain(S.svcVehicleMakes()).length, 20);                        // untouched
  assert.ok(!toPlain(S.svcVehicleModels('Toyota')).includes('Crown Athlete'));
  assert.ok(toPlain(S.svcVehicleMakes({ value: { hiddenMakes: ['Ford'] } })).indexOf('Ford') === -1);      // config record shape
});
test('car wash valuables, condition and disclaimer configuration', () => {
  const t = T('car_wash'), f = (id) => t.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  assert.deepEqual(['cond_scratches', 'cond_dents', 'cond_damage', 'cond_broken', 'cond_other', 'cond_photos'].filter((id) => !f(id)), []);
  assert.equal(f('cond_photos').type, 'photo'); assert.equal(f('cond_photos').multiple, true);
  assert.equal(f('valuables').widget, 'valuables');
  assert.deepEqual(f('val_ack').visibleWhen, { field: 'valuables', truthy: true });
  assert.deepEqual(f('val_ack').requiredWhen, { field: 'valuables', truthy: true });
  assert.deepEqual(toPlain(S.SVC_VALUABLE_KINDS).map((x) => x.l), ['Cash', 'Laptop', 'Phone', 'Bags', 'Documents', 'Electronics', 'Jewellery', 'Other']);
  assert.deepEqual(t.valuables.kinds.map((x) => x.v), toPlain(S.SVC_VALUABLE_KINDS).map((x) => x.v));
  assert.equal(t.valuables.banner, 'CUSTOMER VALUABLES RECORDED');
  assert.ok(t.conditionChecklist.length >= 8 && t.conditionChecklist.every((c) => c.id && c.label));
  assert.match(t.disclaimers.valuables, /not responsible/i); assert.equal(t.disclaimers.requireAck, true);
  assert.equal(toPlain(S.SVC_DISCLAIMER_DEFAULT).valuables, t.disclaimers.valuables);
  assert.equal(T('garage').sections.some((s) => s.id === 'valuables'), false);
});
test('car wash quick mode, staff per task, walk-in label, queue counters', () => {
  const t = T('car_wash');
  assert.deepEqual(t.quick.fields, ['veh_plate', 'services']); assert.deepEqual(t.quick.required, ['veh_plate']);
  assert.equal(t.staffAssignment.mode, 'multi'); assert.equal(t.staffAssignment.perTask, true); assert.deepEqual(t.staffAssignment.taskLabels, ['Exterior', 'Interior', 'Engine', 'Finishing']);
  assert.deepEqual(t.statuses.map((s) => s.key), ['waiting', 'in_progress', 'ready', 'completed', 'cancelled']);
  assert.deepEqual(t.queueGroups.filter((g) => !g.hidden).map((g) => g.label), ['Waiting', 'In Progress', 'Ready', 'Completed']);
  assert.deepEqual(t.counters.map((c) => c.key), ['total', 'remaining', 'waiting', 'assigned', 'in_progress', 'ready', 'completed', 'cancelled']);
  assert.ok(!t.counters.some((c) => c.key === 'awaiting_parts' || c.key === 'no_show'));
  assert.deepEqual(T('garage').counters.map((c) => c.key), ['total', 'remaining', 'assigned', 'in_progress', 'awaiting_approval', 'awaiting_parts', 'ready', 'completed', 'cancelled']);
});

test('salon: workflow Booking > Confirmed > Checked In > Waiting > In Progress > Completed / Cancelled / No Show; appointments; no vehicle or device fields', () => {
  const t = T('salon');
  assert.deepEqual(t.statuses.map((s) => s.label), ['Booking', 'Confirmed', 'Checked In', 'Waiting', 'In Progress', 'Completed', 'Cancelled', 'No Show']);
  assert.deepEqual(t.statuses.map((s) => s.key), ['booked', 'confirmed', 'checked_in', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show']);
  assert.equal(t.statuses.find((s) => s.key === 'no_show').scope, 'appt');
  assert.equal(t.initialStatus, 'waiting'); assert.equal(t.appointmentInitialStatus, 'checked_in'); assert.equal(t.appointmentBookedStatus, 'booked');
  assert.equal(t.appointments.mode, 'primary'); assert.equal(t.hasAppointments, true);
  const f = (id) => t.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  ['appt_mode', 'appt_date', 'appt_time', 'appt_staff', 'appt_notes', 'appt_special', 'appt_deposit'].forEach((id) => assert.ok(f(id), id));
  assert.deepEqual(f('appt_date').visibleWhen, { field: 'appt_mode', eq: 'booking' });
  assert.equal(f('appt_date').required, true);
  assert.equal(f('services').required, true);
  assert.equal(t.terms.newButton, '+ Walk-In'); assert.equal(t.terms.walkInButton, '+ Walk-In'); assert.equal(t.terms.bookingButton, '+ Booking');
  assert.deepEqual(t.staffRoles.map((r) => r.label).slice(0, 6), ['Hair Stylist', 'Braider', 'Loctician', 'Makeup Artist', 'Nail Technician', 'Barber']);
  assert.deepEqual(toPlain(S.SVC_SALON_SPECIALTIES).map((r) => r.label), ['Hair Stylist', 'Braider', 'Loctician', 'Makeup Artist', 'Nail Technician', 'Barber']);
  assert.ok(t.catalog.seeds.find((s) => s.name === 'Dreadlocks Retwist').staffRole === 'loctician');
  assert.ok(t.counters.some((c) => c.key === 'no_show') && t.counters.some((c) => c.key === 'cancelled'));
  assert.ok(t.dashboard.some((d) => d.metric === 'appointments_upcoming') && t.dashboard.some((d) => d.metric === 'noshows_today') && t.dashboard.some((d) => d.metric === 'available_staff'));
  assert.ok(ids('salon').includes('parts'));        // salon records products used
});

test('walk-in button labels and terminology follow the master prompt', () => {
  const walk = { salon: '+ Walk-In', car_wash: '+ New Vehicle Job', garage: '+ New Repair Job', phone_repair: '+ New Repair', barber: '+ Walk-In', electronics_repair: '+ New Repair' };
  Object.keys(walk).forEach((k) => { assert.equal(T(k).terms.walkInButton, walk[k], k); assert.equal(T(k).walkInButton, walk[k], k); assert.equal(S.svcTerm('walkInButton', k), walk[k], k); });
  assert.equal(S.svcTerm('staff', 'phone_repair'), 'Technician'); assert.equal(S.svcTerm('asset', 'phone_repair'), 'Device'); assert.equal(S.svcTerm('job', 'phone_repair'), 'Repair Job');
  assert.equal(S.svcTerm('staff', 'salon'), 'Stylist'); assert.equal(S.svcTerm('customer', 'salon'), 'Client'); assert.equal(S.svcTerm('appointment', 'salon'), 'Appointment'); assert.equal(S.svcTerm('service', 'salon'), 'Service');
  assert.equal(S.svcTerm('staff', 'garage'), 'Mechanic'); assert.equal(S.svcTerm('asset', 'garage'), 'Vehicle'); assert.equal(S.svcTerm('job', 'garage'), 'Repair Job');
  assert.equal(S.svcTerm('staff', 'car_wash'), 'Assigned Staff'); assert.equal(S.svcTerm('asset', 'car_wash'), 'Vehicle'); assert.equal(S.svcTerm('job', 'car_wash'), 'Wash Job');
  ORDER.forEach((k) => Object.keys(toPlain(S.SVC_GENERIC_TERMS)).forEach((tk) => assert.ok(T(k).terms[tk], `${k}.${tk}`)));
});
test('svcTerm fallback chain: override -> template -> generic -> key; tolerant of swapped arguments; default type from svcBusinessType', () => {
  assert.equal(S.svcTerm('job', 'car_wash', { job: 'Wash Ticket' }), 'Wash Ticket');
  assert.equal(S.svcTerm('job', 'nonsense'), 'Job');
  assert.equal(S.svcTerm('totallyUnknownKey', 'salon'), 'totallyUnknownKey');
  assert.equal(S.svcTerm('car_wash', 'job'), 'Wash Job');
  assert.equal(S.svcTerm('job'), 'Job');
  const s2 = loadSvc(['svc-core', 'svc-templates'], { svcBusinessType: () => 'garage' });
  assert.equal(s2.svcTerm('job'), 'Repair Job');
});

test('statuses: every status reachable, phases/terminals consistent, closed statuses never lead to open ones', () => {
  ORDER.forEach((k) => {
    const t = T(k), by = {}; t.statuses.forEach((s) => { by[s.key] = s; });
    assert.ok(toPlain(S.svcReachableStatuses(S.SVC_TYPES[k])).length === t.statuses.length, k);
    t.statuses.forEach((s) => {
      assert.equal(s.terminal, s.phase >= 3, `${k}.${s.key}`);
      assert.equal(s.successful, s.phase === 3 ? true : s.phase === 4 ? false : null, `${k}.${s.key}`);
      if (s.phase === 4) assert.deepEqual(s.next, [], `${k}.${s.key}`);
      if (s.phase >= 3) s.next.forEach((n) => assert.ok(by[n].phase >= 3, `${k}.${s.key}->${n}`));
    });
    assert.ok(t.statuses.some((s) => s.phase === 2) || ['salon', 'barber', 'cleaning'].includes(k), k + ' has a ready phase');
    assert.ok(by[t.initialStatus].phase <= 1, k);
    // a path from the initial status to a closed-success status exists
    const seen = new Set([t.initialStatus]), q = [t.initialStatus];
    while (q.length) { const x = q.shift(); by[x].next.forEach((n) => { if (!seen.has(n)) { seen.add(n); q.push(n); } }); }
    assert.ok([...seen].some((x) => by[x].phase === 3), `${k}: initial status can reach a finished status`);
  });
});
test('documented status workflows per type', () => {
  const keys = (k) => T(k).statuses.map((s) => s.key);
  assert.deepEqual(keys('garage'), ['received', 'inspection', 'diagnosing', 'awaiting_approval', 'awaiting_parts', 'in_progress', 'ready', 'completed', 'cancelled']);
  assert.deepEqual(keys('laundry'), ['received', 'sorting', 'washing', 'drying', 'ironing', 'ready', 'collected', 'cancelled']);
  assert.deepEqual(keys('cleaning'), ['booked', 'scheduled', 'on_the_way', 'in_progress', 'completed', 'cancelled', 'no_show']);
  assert.deepEqual(keys('tailoring'), ['received', 'measured', 'cutting', 'stitching', 'fitting', 'alteration', 'ready', 'collected', 'cancelled']);
  assert.deepEqual(keys('other'), ['received', 'in_progress', 'ready', 'completed', 'cancelled']);
  assert.deepEqual(keys('electronics_repair'), keys('phone_repair'));
  assert.deepEqual(keys('barber'), keys('salon'));
});
test('status helpers: next, check, phase, unknown keys, initial status, queue group', () => {
  const tpl = S.svcGetTemplate('car_wash');
  assert.deepEqual(toPlain(S.svcStatusNext(tpl, 'waiting')), ['in_progress', 'ready', 'cancelled']);
  assert.deepEqual(toPlain(S.svcStatusCheck(tpl, 'waiting', 'in_progress')), { ok: true, noop: false, direct: true, needsReason: false, perm: 'svc:status', requires: [], code: '' });
  const jump = toPlain(S.svcStatusCheck(tpl, 'completed', 'in_progress'));
  assert.deepEqual([jump.ok, jump.direct, jump.needsReason, jump.perm], [true, false, true, 'svc:edit']);
  assert.equal(S.svcStatusCheck(tpl, 'waiting', 'waiting').noop, true);
  assert.equal(S.svcStatusCheck(tpl, 'waiting', 'flying').ok, false);
  assert.equal(S.svcStatusPhase(tpl, 'ready'), 2); assert.equal(S.svcStatusLabel(tpl, 'in_progress'), 'In Progress');
  const unk = toPlain(S.svcStatusDef(tpl, 'x_old_status'));
  assert.equal(unk.unknown, true); assert.equal(unk.label, 'Old Status');
  assert.equal(S.svcInitialStatus(S.svcGetTemplate('salon'), 'walkin'), 'waiting'); assert.equal(S.svcInitialStatus(S.svcGetTemplate('salon'), 'appointment'), 'checked_in');
  assert.equal(S.svcQueueGroupOf(tpl, 'in_progress').key, 'working');
  assert.deepEqual(toPlain(S.svcStatusesForScope(S.svcGetTemplate('salon'), 'appt')).map((s) => s.key), ['booked', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']);
  assert.deepEqual(toPlain(S.svcStatusesForScope(S.svcGetTemplate('salon'), 'job')).map((s) => s.key), ['checked_in', 'waiting', 'in_progress', 'completed', 'cancelled']);
  assert.equal(S.svcIsClosedPhase(3), true); assert.equal(S.svcIsClosedPhase(2), false);
});

test('notifications: ready-for-collection text is the master prompt example; every event exists with known variables only', () => {
  const ready = S.svcDefaultNotifyText('car_wash', 'ready');
  assert.equal(ready, 'Hello {first_name}, your vehicle {plate} is ready for collection from {business}. Total amount due: {amount}. Thank you.');
  assert.equal(S.svcFillVars(ready, { first_name: 'John', plate: 'KDA 123A', business: 'Shine Car Wash', amount: 'KSh 1,500' }),
    'Hello John, your vehicle KDA 123A is ready for collection from Shine Car Wash. Total amount due: KSh 1,500. Thank you.');
  assert.equal(S.svcDefaultNotifyText('garage', 'ready'), ready);
  assert.match(S.svcDefaultNotifyText('phone_repair', 'ready'), /your \{device\} is ready for collection from \{business\}/);
  assert.match(S.svcDefaultNotifyText('salon', 'appointment_confirmed'), /\{date\}.*\{time\}/);
  assert.equal(S.svcFillVars('Hi {first_name} {unknown}', { first_name: 'A' }), 'Hi A {unknown}');
  ORDER.forEach((k) => toPlain(S.SVC_NOTIFY_EVENTS).forEach((e) => assert.ok(T(k).notify.events[e].tpl.length > 10, k + e)));
  ['customer', 'plate', 'business', 'amount', 'device'].forEach((v) => assert.ok(toPlain(S.SVC_NOTIFY_VARS).includes(v), v));
  assert.equal(S.svcDefaultNotifyText('nope', 'ready'), S.svcDefaultNotifyText('other', 'ready'));
  assert.equal(S.svcDefaultNotifyText('car_wash', 'no_such_event'), '');
});

test('catalog seeds: master prompt services, deterministic ids, durations, staff types, consumption', () => {
  const names = (k) => T(k).catalog.seeds.map((s) => s.name);
  ['Basic Wash', 'Premium Wash', 'Exterior Wash', 'Interior Cleaning', 'Vacuum', 'Waxing', 'Full Detailing', 'Engine Cleaning', 'Tyre Shine', 'Other'].forEach((n) => assert.ok(names('car_wash').includes(n), n));
  ['Hair Styling', 'Braiding', 'Dreadlocks', 'Dreadlocks Retwist', 'Twists', 'Wig Installation', 'Wig Styling', 'Makeup', 'Nails', 'Hair Treatment', 'Hair Coloring', 'Barber Services', 'Other'].forEach((n) => assert.ok(names('salon').includes(n), n));
  const pw = T('car_wash').catalog.seeds.find((s) => s.name === 'Premium Wash');
  assert.equal(pw.id, 'sc-seed-car_wash-premium_wash'); assert.equal(pw.price, 1500); assert.equal(pw.durationMin, 60); assert.equal(pw.priceByAssetType.sedan, 1500); assert.ok(pw.priceByAssetType.suv > 1500 && pw.priceByAssetType.motorcycle < 1500);
  assert.deepEqual(Object.keys(pw.priceByAssetType).sort(), toPlain(S.SVC_VEHICLE_TYPES).map((x) => x.v).sort());
  assert.deepEqual(pw.consumption.map((c) => c.name), ['Shampoo', 'Interior cleaner', 'Tyre shine', 'Wax']);
  assert.equal(T('car_wash').catalog.seeds.find((s) => s.name === 'Interior Cleaning').price, 500);
  assert.equal(T('salon').catalog.seeds.find((s) => s.name === 'Braiding').staffRole, 'braider');
  ORDER.forEach((k) => { const all = T(k).catalog.seeds; assert.equal(new Set(all.map((s) => s.id)).size, all.length, k); all.forEach((s) => { assert.deepEqual(s.serviceTypes, [k]); assert.equal(s.active, true); assert.ok(s.durationMin > 0); }); });
  assert.ok(T('car_wash').catalog.seeds.find((s) => s.name === 'Other').priceMode === 'variable');
  assert.deepEqual(T('car_wash').catalog.categories, ['Wash', 'Interior', 'Exterior', 'Detailing', 'Add-ons']);
});
test('inventory, quote, pricing and appointment rules per type', () => {
  assert.equal(T('car_wash').inventory.partsLabel, 'Products used');
  assert.equal(T('phone_repair').inventory.chargeableDefault, true); assert.equal(T('car_wash').inventory.chargeableDefault, false);
  assert.deepEqual(T('car_wash').quote.requireApprovalWhen, { additionalOver: 500 }); assert.equal(T('cleaning').quote.mode, 'required');
  assert.equal(T('garage').pricing.labour, true); assert.equal(T('car_wash').pricing.labour, false);
  const modes = Object.fromEntries(ORDER.map((k) => [k, T(k).appointments.mode]));
  assert.deepEqual(modes, { phone_repair: 'off', car_wash: 'optional', garage: 'optional', salon: 'primary', barber: 'optional', laundry: 'off', cleaning: 'primary', electronics_repair: 'off', tailoring: 'optional', other: 'optional' });
  ORDER.forEach((k) => assert.equal(T(k).hasAppointments, modes[k] !== 'off'));
});
test('dashboards match the master prompt cards', () => {
  const lab = (k) => T(k).dashboard.map((d) => d.label);
  ['Vehicles remaining', 'Waiting', 'In progress', 'Ready', 'Completed', "Today's jobs", 'Current queue'].forEach((l) => assert.ok(lab('car_wash').includes(l), l));
  ['Vehicles received', 'Diagnosing', 'Awaiting approval', 'Awaiting parts', 'In progress', 'Ready'].forEach((l) => assert.ok(lab('garage').includes(l), l));
  ['Devices received', 'Diagnosing', 'Awaiting parts', 'In progress', 'Ready for collection'].forEach((l) => assert.ok(lab('phone_repair').includes(l), l));
  ['Upcoming appointments', 'Walk-ins today', 'Waiting clients', 'In progress', 'Completed', 'No shows', 'Available staff'].forEach((l) => assert.ok(lab('salon').includes(l), l));
});

test('svcGetTemplate: unknown type falls back to other, result is deep-frozen and memoised', () => {
  assert.equal(S.svcGetTemplate('hologram_studio').key, 'other');
  assert.equal(S.svcGetTemplate(undefined).key, 'other');
  const a = S.svcGetTemplate('salon'), b = S.svcGetTemplate('salon');
  assert.ok(a === b);
  assert.equal(Object.isFrozen(a), true); assert.equal(Object.isFrozen(a.sections[0].fields[0]), true);
  assert.throws(() => { 'use strict'; a.label = 'x'; });
  assert.equal(S.SVC_TYPES.salon.label, 'Salon / Beauty');                        // the source data is not the frozen copy
  assert.deepEqual(toPlain(a), T('salon'));
});
test('svcGetTemplate: status label / hide / custom status overrides keep keys stable (R5)', () => {
  const cfg = { statuses: { labels: { waiting: 'In the queue', in_progress: '' }, hidden: ['ready', 'waiting'], custom: [{ key: 'x_drying', label: 'Drying', after: 'in_progress', group: 'working' }, { key: 'BAD KEY', label: 'nope' }] } };
  const t = toPlain(S.svcGetTemplate('car_wash', cfg));
  assert.equal(t.statuses.find((s) => s.key === 'waiting').label, 'In the queue');
  assert.equal(t.statuses.find((s) => s.key === 'waiting').hidden, undefined);      // the initial status can never be hidden
  assert.equal(t.statuses.find((s) => s.key === 'in_progress').label, 'In Progress');
  assert.equal(t.statuses.find((s) => s.key === 'ready').hidden, true);
  assert.deepEqual(t.statuses.map((s) => s.key), ['waiting', 'in_progress', 'x_drying', 'ready', 'completed', 'cancelled']);
  assert.ok(t.statuses.find((s) => s.key === 'in_progress').next.includes('x_drying'));
  assert.deepEqual(t.statuses.find((s) => s.key === 'x_drying').next.filter((k) => k !== 'in_progress').sort(), ['cancelled', 'completed', 'ready', 'waiting']);
  assert.ok(t.queueGroups.find((g) => g.key === 'working').statuses.includes('x_drying'));
  assert.deepEqual(toPlain(S.svcValidateTemplate(S.svcGetTemplate('car_wash', cfg))), []);
  assert.deepEqual(toPlain(S.svcStatusNext(S.svcGetTemplate('car_wash', cfg), 'waiting')), ['in_progress', 'cancelled']);   // hidden status is not offered
  assert.equal(toPlain(S.svcGetTemplate('car_wash', { 'cfg-statuses-car_wash': { value: { labels: { waiting: 'Queue' } } } })).statuses[0].label, 'Queue');
  assert.equal(S.svcGetTemplate('car_wash').statuses[0].label, 'Waiting');            // unaffected
});
test('svcGetTemplate: custom fields are injected only into their own types, in order, with stable cf_ ids', () => {
  const cfg = { customFields: [
    { id: 'cf_fuel_level', label: 'Fuel level', type: 'dropdown', options: ['Empty', '1/4', { v: 'full', l: 'Full' }], serviceTypes: ['car_wash'], order: 2 },
    { id: 'cf_engine_size', label: 'Engine size', type: 'text', serviceTypes: ['garage'], required: true, order: 1 },
    { id: 'cf_hair_length', label: 'Hair length', type: 'dropdown', options: ['Short', 'Long'], serviceTypes: ['salon', 'barber'] },
    { id: 'cf_old', label: 'Old', type: 'text', serviceTypes: ['car_wash'], active: false },
    { id: 'cf_photo', label: 'Reg. card', type: 'photo', serviceTypes: ['car_wash'], order: 3 },
    { id: 'veh_plate', label: 'Clash', type: 'text', serviceTypes: ['car_wash'] },
    { id: 'bad id', label: 'Bad', type: 'text', serviceTypes: ['car_wash'] },
    { id: 'cf_nowhere', label: 'Nowhere', type: 'text', serviceTypes: [] }] };
  const cw = toPlain(S.svcGetTemplate('car_wash', cfg)), extra = cw.sections[cw.sections.length - 1];
  assert.equal(extra.id, 'extra'); assert.deepEqual(extra.fields.map((f) => f.id), ['cf_fuel_level', 'cf_photo']);
  assert.deepEqual(extra.fields[0].options.map((o) => o.v), ['empty', '1_4', 'full']);
  assert.equal(extra.fields[1].type, 'photo'); assert.equal(extra.fields[1].storesIn, 'job');
  assert.equal(extra.fields[0].storesIn, 'data'); assert.equal(extra.fields[0].custom, true);
  assert.deepEqual(toPlain(S.svcGetTemplate('garage', cfg)).sections.pop().fields.map((f) => [f.id, f.required]), [['cf_engine_size', true]]);
  assert.deepEqual(toPlain(S.svcGetTemplate('salon', cfg)).sections.pop().fields.map((f) => f.id), ['cf_hair_length']);
  assert.equal(toPlain(S.svcGetTemplate('phone_repair', cfg)).sections.some((s) => s.id === 'extra'), false);
  assert.deepEqual(toPlain(S.svcValidateTemplate(S.svcGetTemplate('car_wash', cfg))), []);
  assert.equal(toPlain(S.svcGetTemplate('car_wash', { 'cfg-customFields': { value: { fields: cfg.customFields } } })).sections.pop().fields.length, 2);
  assert.equal(S.svcGetTemplate('car_wash', cfg) === S.svcGetTemplate('car_wash', cfg), true);             // memoised per config signature
});
test('svcGetTemplate reads svcConfig through svcConfigGet when no override is passed', () => {
  const recs = { 'cfg-statuses-salon': { updatedAt: 5, rev: 1, value: { labels: { waiting: 'Seated' } } } };
  const s2 = loadSvc(['svc-core', 'svc-templates'], { svcConfigGet: (id) => recs[id] || null });
  assert.equal(toPlain(s2.svcGetTemplate('salon')).statuses.find((s) => s.key === 'waiting').label, 'Seated');
  recs['cfg-statuses-salon'] = { updatedAt: 9, rev: 2, value: { labels: { waiting: 'Sitting' } } };
  assert.equal(toPlain(s2.svcGetTemplate('salon')).statuses.find((s) => s.key === 'waiting').label, 'Sitting');
  const s3 = loadSvc(['svc-core', 'svc-templates'], { svcConfigGet: () => { throw new Error('store not ready'); } });
  assert.equal(s3.svcGetTemplate('salon').key, 'salon');
});

test('svcFillTypeSelect fills the sign-up select with the ten types and shows the wrapper', () => {
  const sel = { value: 'other', innerHTML: '<option value="other">Other</option>' }, wrap = { style: { display: 'none' } };
  const doc = { getElementById: (id) => (id === 'signup-biz-type' ? sel : id === 'signup-biz-type-wrap' ? wrap : null) };
  const s2 = loadSvc(['svc-core', 'svc-templates'], { document: doc });
  assert.equal(s2.svcFillTypeSelect('signup-biz-type'), true);
  const values = [...sel.innerHTML.matchAll(/value="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ORDER);
  assert.equal(sel.value, 'other'); assert.equal(wrap.style.display, '');
  assert.match(sel.innerHTML, /Garage \/ Auto Repair/);
  assert.equal(S.svcFillTypeSelect('signup-biz-type'), false);                   // no DOM in node: a harmless no-op
  assert.equal(toPlain(S.svcTypeList()).length, 10);
});

test('template lookups: field ids, find, scope of asset kinds, roles with permission bundles', () => {
  const tpl = S.svcGetTemplate('car_wash');
  assert.ok(toPlain(S.svcFieldIds(tpl)).includes('veh_plate'));
  assert.equal(S.svcFindField(tpl, 'veh_plate').type, 'plate'); assert.equal(S.svcFindField(tpl, 'nope'), null);
  assert.deepEqual(ORDER.map((k) => T(k).assetKind), ['phone', 'vehicle', 'vehicle', 'none', 'none', 'garment', 'none', 'equipment', 'garment', 'none']);
  ORDER.forEach((k) => T(k).staffRoles.forEach((r) => { assert.ok(toPlain(S.SVC_PERM_BUNDLES)[r.bundle], `${k}.${r.key}`); }));
  toPlain(S.SVC_PERM_BUNDLES).supervisor.concat(toPlain(S.SVC_PERM_BUNDLES).worker).forEach((p) => assert.ok(toPlain(S.SVC_PERMS).includes(p), p));
});
test('the required fields of a type are only that type\'s own (full form and quick form)', () => {
  const req = (k, quick) => { const t = T(k), fields = t.sections.flatMap((s) => s.fields); return quick ? t.quick.required : fields.filter((f) => f.required === true).map((f) => f.id); };
  assert.deepEqual(req('car_wash', true), ['veh_plate']);
  assert.deepEqual(req('car_wash').sort(), ['services', 'veh_make', 'veh_model', 'veh_plate', 'veh_type']);
  assert.deepEqual(req('garage').sort(), ['cmp_problem', 'cust_name', 'veh_make', 'veh_model', 'veh_plate', 'veh_type']);
  assert.deepEqual(req('phone_repair').sort(), ['cust_name', 'dev_brand', 'dev_model', 'dev_type', 'rep_problem']);
  assert.deepEqual(req('salon').sort(), ['appt_date', 'appt_time', 'services']);          // date/time only when appt_mode = booking (visibleWhen)
  assert.deepEqual(req('salon', true), ['services']);
});
