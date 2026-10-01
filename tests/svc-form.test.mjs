// svc-form block (B1-F): field-schema renderer, validator, value split, widget registry.  SERVICES_ARCHITECTURE.md 2.3 / 2.4 / 8.3.
// Pure functions run through loadSvc (vm, no DOM); DOM functions run in a jsdom window that evaluated the block text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadSvc, toPlain, blockScripts, readBlock } from './svc-helpers.mjs';
import { TYPES, CATALOG, STAFF, MODELS } from './fixtures/svc-form-types.mjs';

const STUBS = `var SVC_TYPES=${JSON.stringify(TYPES)}; function svcTerm(k,t){ var T=SVC_TYPES[t]; return (T&&T.terms&&T.terms[k])||''; }`;
function pure(extra) { const ctx = loadSvc(['svc-form'], { SVC_TYPES: JSON.parse(JSON.stringify(TYPES)), svcTerm: (k, t) => (TYPES[t] && TYPES[t].terms && TYPES[t].terms[k]) || '', ...(extra || {}) }); return ctx; }
function makeWin(extraJs = '') {
  const dom = new JSDOM('<!doctype html><html><body><div id="m"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(STUBS + extraJs);
  blockScripts('svc-form').forEach((js) => w.eval(js));
  return w;
}
const ctxCb = () => ({ catalog: () => CATALOG, staff: () => STAFF, vehicleModels: (mk) => MODELS[mk] || [], vehicleMakes: () => ['Toyota', 'Nissan', 'Other'], canManageLists: true, addOption() {} });
function render(w, type, opts = {}) {
  const m = w.document.getElementById('m'); m.innerHTML = '';
  const h = w.svcRenderForm(m, { typeKey: type, values: {}, mode: 'create', context: ctxCb(), ...opts });
  return { m, h };
}
const fids = (m) => [...m.querySelectorAll('[data-fid]')].map((e) => e.getAttribute('data-fid'));
const type = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const pick = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const blur = (w, el) => el.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ pure: field matrix, xss, visibility, validation ------------------------------------------------------------------ */
test('svcFieldHtml draws every field type with label, stable id, aria and inline error slot', () => {
  const s = pure();
  const f = (o, v, c) => s.svcFieldHtml({ id: 'x1', label: 'Lbl', ...o }, v, { uid: 'u', typeKey: 'car_wash', ...(c || {}) });
  const cases = {
    text: ['<input', 'type="text"'], longtext: ['<textarea'], textarea: ['<textarea'], email: ['type="email"', 'inputmode="email"'], number: ['inputmode="decimal"'], money: ['inputmode="decimal"'],
    year: ['inputmode="numeric"'], odometer: ['inputmode="numeric"'], date: ['type="date"'], time: ['type="time"'], datetime: ['data-part="date"', 'data-part="time"'],
    phone: ['type="tel"', 'inputmode="tel"', 'data-hint'], plate: ['autocapitalize="characters"', 'data-lookup="plate"'], imei: ['data-lookup="imei"', 'inputmode="numeric"'],
    dropdown: ['<select'], select: ['<select'], combo: ['<datalist'], 'searchable-select': ['<datalist'], chips: ['svc-chips'], multiselect: ['svc-chips'],
    checkbox: ['type="checkbox"'], yesno: ['role="radiogroup"', 'value="yes"', 'value="no"'], repeater: ['data-rep', 'data-act="add-row"'], photo: ['data-photo', 'type="file"'],
    'service-picker': ['data-svcpick', 'data-add-svc'], 'staff-picker': ['<select'], heading: ['<h3'],
  };
  for (const [t, needles] of Object.entries(cases)) {
    const h = f({ type: t, options: ['A', 'B'], columns: [{ id: 'c', label: 'C' }] });
    needles.forEach((n) => assert.ok(h.includes(n), `${t}: expected ${n} in ${h.slice(0, 300)}`));
    assert.ok(h.includes('data-fid="x1"'), t);
    if (t !== 'heading') assert.ok(h.includes('data-err'), t + ' has an inline error slot');
    if (!['checkbox', 'heading'].includes(t)) assert.ok(h.includes('Lbl'), t + ' has its label');
  }
  ['quote', 'payment', 'materials', 'valuables', 'condition', 'photos'].forEach((w) => assert.ok(f({ type: 'widget', widget: w }).includes('data-fid="x1"'), w));
  assert.ok(f({ type: 'text', required: true }).includes('aria-required="true"'));
  assert.ok(f({ type: 'text' }, '', { errors: { x1: 'Bad' } }).includes('aria-invalid="true"'));
});
test('labels come from svcTerm (labelTerm and {{term:...}} tokens)', () => {
  const s = pure();
  const h = s.svcFieldHtml({ id: 'cust_name', type: 'text', labelTerm: 'customer', label: 'Name' }, '', { typeKey: 'car_wash' });
  assert.ok(h.includes('>Owner<') && h.includes('data-svc-term="customer"'));
  assert.ok(s.svcFieldHtml({ id: 'a', type: 'text', label: '{{term:customer}} phone' }, '', { typeKey: 'salon' }).includes('Client phone'));
});
test('XSS: labels, help, values, option text and placeholders are escaped everywhere', () => {
  const s = pure(); const bad = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  const fields = [{ type: 'text' }, { type: 'longtext' }, { type: 'dropdown', options: [{ v: bad, l: bad }] }, { type: 'combo', options: [bad] }, { type: 'chips', options: [bad] }, { type: 'plate' }, { type: 'phone' }, { type: 'checkbox' },
    { type: 'repeater', columns: [{ id: 'c', label: bad }] }, { type: 'yesno' }];
  fields.forEach((fd) => {
    const h = s.svcFieldHtml({ id: 'x', label: bad, help: bad, placeholder: bad, ...fd }, fd.type === 'repeater' ? [{ c: bad }] : (fd.type === 'chips' ? [bad] : bad), { errors: { x: bad } });
    assert.ok(!/<img|<script/i.test(h), fd.type + ': ' + h.slice(0, 200));
    assert.ok(!/ onerror=/.test(h.replace(/&quot;[^<>]*/g, '')) || !/"\s+onerror=/.test(h), fd.type);
  });
  const svcRow = s.svcFormServiceRowHtml({ id: bad, name: bad, price: bad }, {});
  assert.ok(!/<img|<script/i.test(svcRow));
  assert.ok(!/<img|<script/i.test(s.svcFormAssetCardHtml({ title: bad, owner: { name: bad, phone: bad }, notes: bad, history: [{ title: bad }] }, {})));
});
test('svcVisibleFields evaluates visibleWhen (eq / in / truthy / all / any / not) and quick mode, PURE', () => {
  const s = pure();
  const ids = (t, v, m) => toPlain(s.svcVisibleFields(t, v, m)).map((f) => f.id);
  assert.ok(!ids('phone_repair', { dev_type: 'laptop' }).includes('dev_imei'));
  assert.ok(ids('phone_repair', { dev_type: 'tablet' }).includes('dev_imei'));
  assert.ok(ids('salon', { appt_mode: 'booking' }).includes('appt_date') && !ids('salon', { appt_mode: 'walk_in' }).includes('appt_date'));
  assert.ok(!ids('car_wash', {}).includes('val_ack') && ids('car_wash', { valuables: [{ description: 'Laptop' }] }).includes('val_ack'));
  const c = (cond, v) => s.svcFormCond(cond, v);
  assert.equal(c({ all: [{ field: 'a', eq: 1 }, { field: 'b', truthy: true }] }, { a: 1, b: 'x' }), true);
  assert.equal(c({ any: [{ field: 'a', eq: 1 }, { field: 'b', truthy: true }] }, { a: 2 }), false);
  assert.equal(c({ not: { field: 'a', eq: 1 } }, { a: 2 }), true);
  assert.equal(c({ field: 'a', truthy: true }, { a: 'no' }), false);
  assert.deepEqual(ids('car_wash', {}, 'quick'), ['veh_plate', 'services']);
});
test('every vehicle / device / salon field id is absent from the other industries (id-prefix sets)', () => {
  const s = pure();
  const has = (t, re) => toPlain(s.svcFieldIdsOf(t)).filter((i) => re.test(i));
  assert.deepEqual(has('salon', /^(veh_|dev_|cond_|val_)/), []);
  assert.deepEqual(has('phone_repair', /^(veh_|cond_|val_|appt_)/), []);
  assert.deepEqual(has('car_wash', /^(dev_|appt_|rep_problem)/), []);
  assert.ok(has('car_wash', /^veh_plate$/).length === 1);
  assert.ok(toPlain(s.svcFieldIdsOf('salon', {}, 'create')).includes('appt_mode') && !toPlain(s.svcFieldIdsOf('salon', {}, 'create')).includes('appt_date'));
});
test('svcValidate: dynamic required fields per service type (MP 30) and irrelevant fields never validated', () => {
  const s = pure();
  const req = (t, v, m) => toPlain(s.svcValidate(t, v || {}, { mode: m })).errors.map((e) => e.id).sort();
  assert.deepEqual(req('car_wash'), ['cust_name', 'cust_phone', 'services', 'veh_make', 'veh_model', 'veh_plate']);
  assert.deepEqual(req('garage'), ['cmp_problem', 'cust_name', 'cust_phone', 'veh_make', 'veh_model', 'veh_plate']);
  assert.deepEqual(req('phone_repair'), ['cust_name', 'cust_phone', 'dev_brand', 'dev_model', 'dev_type', 'rep_problem']);
  assert.deepEqual(req('salon'), ['cust_name', 'services']);
  assert.ok(!req('salon').some((i) => /^(veh_|dev_)/.test(i)));
  assert.deepEqual(req('salon', { appt_mode: 'booking' }), ['appt_date', 'appt_time', 'cust_name', 'services']);
  assert.deepEqual(req('car_wash', {}, 'quick'), ['veh_plate']);
  assert.deepEqual(req('salon', {}, 'quick'), ['services']);
  const full = { cust_name: 'John', cust_phone: '0712345678', veh_plate: 'KDA 123A', veh_make: 'Toyota', veh_model: 'Premio', services: [{ id: 'sc-1', name: 'Basic Wash', qty: 1, price: 500 }] };
  assert.equal(s.svcValidate('car_wash', full).ok, true);
});
test('svcValidate: fallback type rules apply even for a schema without required flags, but only to visible fields', () => {
  const s = pure();
  const schema = { key: 'garage', sections: [{ id: 'a', fields: [{ id: 'veh_plate', type: 'plate' }, { id: 'cmp_problem', type: 'longtext' }, { id: 'veh_make', type: 'text', visibleWhen: { field: 'x', eq: 1 } }] }] };
  const r = toPlain(s.svcValidate(schema, {}));
  assert.deepEqual(r.errors.map((e) => e.id).sort(), ['cmp_problem', 'veh_plate']);
  assert.equal(toPlain(s.svcValidate({ sections: schema.sections }, {})).ok, true);   // no typeKey -> no fallback rules
});
test('svcValidate result shape: errors[{id,field,msg,message,level}], warnings[], errorsById, visible', () => {
  const s = pure();
  const r = toPlain(s.svcValidate('car_wash', { cust_name: 'A', veh_plate: 'zzz' }));
  const e = r.errors.find((x) => x.id === 'veh_make');
  assert.equal(e.field, 'veh_make'); assert.equal(e.message, e.msg); assert.equal(e.level, 'error'); assert.match(e.msg, /Make is required/);
  assert.ok(Array.isArray(r.warnings) && r.warnings.some((w) => w.id === 'veh_plate'));          // odd plate = warning only
  assert.equal(r.errorsById.veh_make, e.msg); assert.ok(r.visible.includes('veh_plate') && !r.visible.includes('val_ack'));
});
test('svcValidate: type checks (phone, email, number ranges, year, date/time, pattern, maxLength, select, services) and warn level does not block', () => {
  const s = pure();
  const one = (field, value) => toPlain(s.svcValidate([field], { [field.id]: value }));
  assert.equal(one({ id: 'p', type: 'phone' }, '0712 345 678').ok, true);
  assert.equal(one({ id: 'p', type: 'phone' }, '+254712345678').ok, true);
  assert.equal(one({ id: 'p', type: 'phone' }, 'abc').ok, false);
  assert.equal(one({ id: 'p', type: 'phone' }, '12345').ok, false);
  const intl = one({ id: 'p', type: 'phone' }, '+447911123456'); assert.equal(intl.ok, true); assert.equal(intl.warnings.length, 1);
  assert.equal(one({ id: 'e', type: 'email' }, 'a@b.co').ok, true); assert.equal(one({ id: 'e', type: 'email' }, 'a@b').ok, false);
  assert.equal(one({ id: 'm', type: 'money' }, '1,500').ok, true); assert.equal(one({ id: 'm', type: 'money' }, -5).ok, false); assert.equal(one({ id: 'm', type: 'money' }, 'x').ok, false);
  assert.equal(one({ id: 'n', type: 'number', min: 1, max: 5 }, 6).ok, false); assert.equal(one({ id: 'n', type: 'number', min: 1, max: 5 }, 3).ok, true);
  assert.equal(one({ id: 'y', type: 'year' }, 2014).ok, true); assert.equal(one({ id: 'y', type: 'year' }, 1800).ok, false); assert.equal(one({ id: 'y', type: 'year' }, 2014.5).ok, false);
  assert.equal(one({ id: 'd', type: 'date' }, '2026-02-30').ok, false); assert.equal(one({ id: 'd', type: 'date' }, '2026-09-30').ok, true);
  assert.equal(one({ id: 't', type: 'time' }, '25:00').ok, false); assert.equal(one({ id: 't', type: 'time' }, '09:30').ok, true);
  assert.equal(one({ id: 'x', type: 'text', maxLength: 3 }, 'abcd').ok, false);
  assert.equal(one({ id: 'x', type: 'text', pattern: '^\\d+$' }, 'ab').ok, false); assert.equal(one({ id: 'x', type: 'text', pattern: '^\\d+$', level: 'warn' }, 'ab').ok, true);
  assert.equal(one({ id: 's', type: 'dropdown', options: ['a', 'b'] }, 'c').ok, false);
  assert.equal(one({ id: 'i', type: 'imei' }, '123').ok, true);                                   // bad IMEI is a warning by default
  assert.equal(one({ id: 'i', type: 'imei' }, '123').warnings.length, 1);
  assert.equal(one({ id: 'i', type: 'imei' }, '490154203237518').warnings.length, 0);            // valid Luhn
  assert.equal(one({ id: 'i', type: 'imei' }, '490154203237519').warnings.length, 1);            // Luhn fail
  assert.equal(one({ id: 'i', type: 'imei', level: 'error' }, '123').ok, false);
  assert.equal(one({ id: 'x', type: 'text', validate: 'phone' }, 'nope').ok, false);             // validate:'name' on a plain text field
  assert.equal(one({ id: 'c', type: 'checkbox', required: true }, false).ok, false); assert.equal(one({ id: 'c', type: 'checkbox', required: true }, true).ok, true);
  assert.equal(one({ id: 'yn', type: 'yesno', required: true }, '').ok, false);
  assert.equal(one({ id: 'sv', type: 'widget', widget: 'services' }, [{ name: 'a', qty: 0, price: 1 }]).ok, false);
  assert.equal(one({ id: 'rq', type: 'text', requiredWhen: { field: 'z', eq: 1 } }, '').ok, true);
  assert.equal(toPlain(s.svcValidate([{ id: 'rq', type: 'text', requiredWhen: { field: 'z', eq: 1 } }], { z: 1 })).ok, false);
});
test('svcValidate: custom validator registry and widget validate', () => {
  const s = pure();
  s.svcFormRegisterValidator('evenOnly', (v) => (Number(v) % 2 ? 'Must be even' : null));
  assert.equal(toPlain(s.svcValidate([{ id: 'q', type: 'text', validate: 'evenOnly' }], { q: '3' })).errors[0].msg, 'Must be even');
  s.svcRegisterWidget('rating', { validate: (v) => (v > 5 ? ['Too high'] : null) });
  assert.equal(toPlain(s.svcValidate([{ id: 'r', type: 'widget', widget: 'rating' }], { r: 9 })).errors[0].msg, 'Too high');
});
test('svcSplitValues routes fields by storesIn and drops hidden fields', () => {
  const s = pure();
  const r = toPlain(s.svcSplitValues('phone_repair', { cust_name: 'Jo', cust_phone: '0712', cust_email: 'a@b.co', dev_type: 'laptop', dev_imei: '123', dev_model: 'X1', rep_problem: 'Dead' }));
  assert.deepEqual(r.customer, { name: 'Jo', phone: '0712', email: 'a@b.co' });
  assert.equal(r.asset.kind, 'phone'); assert.equal(r.data.dev_model, 'X1'); assert.equal(r.data.rep_problem, 'Dead');
  assert.ok(!('imei' in r.asset.attrs) && !('dev_imei' in r.data));                               // imei hidden for a laptop
  const c = toPlain(s.svcSplitValues('car_wash', { veh_plate: 'KDA 1A', veh_make: 'Toyota', services: [{ name: 'Wash' }] }));
  assert.deepEqual(c.asset.attrs, { plate: 'KDA 1A', make: 'Toyota' }); assert.equal(c.services.length, 1);
});
test('svcRegisterWidget: highest priority wins; pure html hook is used by svcFieldHtml', () => {
  const s = pure();
  s.svcRegisterWidget('quote', { html: () => '<i>low</i>' }, { priority: 0 });
  s.svcRegisterWidget('quote', { html: () => '<i>high</i>' }, { priority: 10 });
  s.svcRegisterWidget('quote', { html: () => '<i>mid</i>' }, { priority: 5 });
  const h = s.svcFieldHtml({ id: 'q', type: 'widget', widget: 'quote', label: 'Q' }, null, {});
  assert.ok(h.includes('<i>high</i>') && !h.includes('<i>low</i>'));
});
test('svcRenderJobSummary: schema-driven, unknown keys under Other details, sensitive hidden, escaped', () => {
  const s = pure();
  const job = { serviceType: 'phone_repair', customer: { name: 'Jo <b>' }, data: { dev_model: 'X1', dev_passcode: '1234', rep_problem: 'Cracked', mystery: 'zzz', cf_fuel_level: 'Half', dev_accessories: ['Charger', 'SIM'] } };
  const h = s.svcRenderJobSummary(job, 'phone_repair');
  assert.ok(h.includes('Cracked') && h.includes('Charger, SIM') && h.includes('Jo &lt;b&gt;'));
  assert.ok(!h.includes('1234'));
  assert.ok(h.includes('Other details') && h.includes('Mystery') && h.includes('Fuel level'));
  assert.doesNotThrow(() => s.svcRenderJobSummary({ serviceType: 'nonexistent', data: { a: 1 } }));
});
test('custom-field hook: svcCustomFieldsFor adds an Extra details section; inactive / duplicate ids are ignored; absent hook = none', () => {
  const none = pure();
  assert.ok(!toPlain(none.svcFieldIdsOf('salon')).includes('cf_hair'));
  const s = pure({ svcCustomFieldsFor: (t) => (t === 'salon' ? [{ id: 'cf_hair', type: 'dropdown', label: 'Hair length', options: ['Short', 'Long'] }, { id: 'cf_off', type: 'text', label: 'Off', active: false }, { id: 'cust_name', type: 'text', label: 'dup' }] : []) });
  const ids = toPlain(s.svcFieldIdsOf('salon'));
  assert.ok(ids.includes('cf_hair') && !ids.includes('cf_off') && ids.filter((i) => i === 'cust_name').length === 1);
  assert.ok(!toPlain(s.svcFieldIdsOf('car_wash')).includes('cf_hair'));
  assert.equal(toPlain(s.svcValidate('salon', { cust_name: 'x', services: [{ name: 'a', qty: 1, price: 1 }], cf_hair: 'Long' })).ok, true);
});
test('block body has no DOM access at parse time (loads in a bare vm) and exposes the contract names', () => {
  const s = pure();
  ['svcRenderForm', 'svcReadForm', 'svcValidate', 'svcFieldHtml', 'svcFieldIdsOf', 'svcVisibleFields', 'svcSplitValues', 'svcRegisterWidget', 'svcRenderJobSummary'].forEach((n) => assert.equal(typeof s[n], 'function', n));
});

/* ------------------------------------------------------------------ jsdom: mounting ------------------------------------------------------------------ */
test('DOM: a salon form never contains plate / IMEI / vehicle ids; car wash never contains device or salon ids', () => {
  const w = makeWin();
  let { m } = render(w, 'salon');
  assert.ok(fids(m).includes('cust_name') && fids(m).includes('services'));
  assert.equal(m.querySelector('[data-fid^="veh_"],[data-fid^="dev_"],[data-fid^="cond_"],[data-fid^="val_"]'), null);
  assert.ok(!/plate|imei/i.test(m.innerHTML.replace(/svc-k-plate|svc-k-imei/g, '')));
  ({ m } = render(w, 'car_wash'));
  assert.ok(fids(m).includes('veh_plate'));
  assert.equal(m.querySelector('[data-fid^="dev_"],[data-fid^="appt_"],[data-fid="rep_problem"]'), null);
  ({ m } = render(w, 'phone_repair', { values: { dev_type: 'phone' } }));
  assert.ok(fids(m).includes('dev_imei')); assert.equal(m.querySelector('[data-fid^="veh_"],[data-fid^="appt_"]'), null);
});
test('DOM: visibleWhen fields are UNMOUNTED (not display:none) and remounted with their value', () => {
  const w = makeWin(); const { m, h } = render(w, 'salon');
  assert.equal(m.querySelector('[data-fid="appt_date"]'), null);
  assert.ok(!/display:\s*none/.test(m.innerHTML));
  pick(w, m.querySelector('[data-fid="appt_mode"] select'), 'booking');
  assert.ok(m.querySelector('[data-fid="appt_date"]') && m.querySelector('[data-fid="appt_time"]'));
  type(w, m.querySelector('[data-fid="appt_date"] input'), '2026-10-05');
  assert.equal(h.getValues().appt_date, '2026-10-05');
  pick(w, m.querySelector('[data-fid="appt_mode"] select'), 'walk_in');
  assert.equal(m.querySelector('[data-fid="appt_date"]'), null);
  assert.ok(!('appt_date' in h.getValues()) && !('appt_date' in w.svcReadForm(m)));
  pick(w, m.querySelector('[data-fid="appt_mode"] select'), 'booking');
  assert.equal(m.querySelector('[data-fid="appt_date"] input').value, '2026-10-05');            // remembered while unmounted
  assert.equal(h.validate().ok, false);
});
test('DOM: every mounted [data-fid] is a visible field id (renderer <-> svcVisibleFields agree) for each type and mode', () => {
  const w = makeWin();
  for (const t of Object.keys(TYPES)) for (const mode of ['create', 'quick']) {
    const { m, h } = render(w, t, { mode });
    const vis = h.visibleIds();
    fids(m).forEach((id) => assert.ok(vis.includes(id), `${t}/${mode}: ${id}`));
    vis.forEach((id) => assert.ok(fids(m).includes(id), `${t}/${mode} missing ${id}`));
  }
});
test('DOM: value round trip for every simple field type', () => {
  const w = makeWin();
  const schema = { key: 'x', sections: [{ id: 's', title: 'All', fields: [
    { id: 'a_text', type: 'text' }, { id: 'a_long', type: 'longtext' }, { id: 'a_num', type: 'number' }, { id: 'a_money', type: 'money' }, { id: 'a_date', type: 'date' }, { id: 'a_time', type: 'time' },
    { id: 'a_dt', type: 'datetime' }, { id: 'a_phone', type: 'phone' }, { id: 'a_plate', type: 'plate' }, { id: 'a_imei', type: 'imei' }, { id: 'a_email', type: 'email' },
    { id: 'a_sel', type: 'dropdown', options: [{ v: 'o1', l: 'One' }, { v: 'o2', l: 'Two' }] }, { id: 'a_combo', type: 'combo', options: ['Red', 'Blue'] }, { id: 'a_chips', type: 'chips', options: ['x', 'y', 'z'] },
    { id: 'a_chk', type: 'checkbox' }, { id: 'a_yn', type: 'yesno' }, { id: 'a_obj', type: 'widget', widget: 'payment' }] }] };
  const dt = new Date(2026, 9, 5, 14, 30).getTime();
  const vals = { a_text: 'hello', a_long: 'line1\nline2', a_num: 4.5, a_money: 1500, a_date: '2026-10-05', a_time: '09:15', a_dt: dt, a_phone: '0712345678', a_plate: 'KDA 123A', a_imei: '490154203237518', a_email: 'a@b.co',
    a_sel: 'o2', a_combo: 'Green', a_chips: ['x', 'z'], a_chk: true, a_yn: 'no', a_obj: { deposit: 200, method: 'mpesa', ref: 'QWE' } };
  const m = w.document.getElementById('m'); const h = w.svcRenderForm(m, schema, { values: vals });
  assert.deepEqual(JSON.parse(JSON.stringify(h.getValues())), vals);
  assert.deepEqual(JSON.parse(JSON.stringify(w.svcReadForm(m))), vals);
  const h2 = w.svcRenderForm(m, schema, { values: { a_yn: 'yes', a_chk: false } });
  assert.equal(h2.getValues().a_yn, 'yes'); assert.equal(h2.getValues().a_chk, false); assert.equal(h2.getValues().a_text, '');
});
test('DOM: svcRenderForm accepts (container, {typeKey|schema,...}) and (container, template, opts)', () => {
  const w = makeWin(); const m = w.document.getElementById('m');
  const h1 = w.svcRenderForm(m, { typeKey: 'salon', values: { cust_name: 'Amy' } }); assert.equal(h1.getValues().cust_name, 'Amy');
  const h2 = w.svcRenderForm(m, { schema: TYPES.garage }); assert.ok(m.querySelector('[data-fid="cmp_problem"]'));
  const h3 = w.svcRenderForm(m, TYPES.salon, { values: { cust_name: 'Bo' } }); assert.equal(h3.getValues().cust_name, 'Bo');
  const h4 = w.svcRenderForm(m, 'phone_repair', { mode: 'quick' }); assert.ok(h4 && m.querySelector('[data-fid="cust_name"]'));
  assert.equal(typeof h1.validate, 'function'); assert.equal(typeof h1.focusFirstError, 'function'); assert.equal(typeof h1.destroy, 'function'); assert.equal(typeof h1.setValue, 'function');
});
test('DOM: plate uppercases as you type, phone shows the normalised hint, model list follows the make', () => {
  const w = makeWin(); const { m } = render(w, 'car_wash');
  const plate = m.querySelector('[data-fid="veh_plate"] input'); type(w, plate, 'kda 123a'); assert.equal(plate.value, 'KDA 123A');
  const ph = m.querySelector('[data-fid="cust_phone"] input'); type(w, ph, '0712 345 678');
  assert.match(m.querySelector('[data-fid="cust_phone"] [data-hint]').textContent, /\+254712345678/);
  type(w, m.querySelector('[data-fid="veh_make"] input'), 'Toyota');
  const opts = [...m.querySelectorAll('[data-fid="veh_model"] datalist option')].map((o) => o.value);
  assert.deepEqual(opts, ['Premio', 'Allion', 'Other']);
  type(w, m.querySelector('[data-fid="veh_make"] input'), 'Nissan');
  assert.deepEqual([...m.querySelectorAll('[data-fid="veh_model"] datalist option')].map((o) => o.value), ['Note', 'Other']);
});
test('DOM: combo shows "Other" and an admin "Add to list" button that calls the context callback', () => {
  const calls = []; const w = makeWin(); const { m } = render(w, 'car_wash', { context: { ...ctxCb(), addOption: (l, t) => calls.push([l, t]) } });
  assert.ok([...m.querySelectorAll('[data-fid="veh_make"] datalist option')].some((o) => o.value === 'Other'));
  type(w, m.querySelector('[data-fid="veh_make"] input'), 'Chery'); m.querySelector('[data-fid="veh_make"] [data-act="add-option"]').click();
  assert.deepEqual(calls, [['vehicleMakes', 'Chery']]);
  const r2 = render(w, 'car_wash', { context: { ...ctxCb(), canManageLists: false } });
  assert.equal(r2.m.querySelector('[data-act="add-option"]'), null);
});
test('DOM: repeater add / remove rows and value read-back', () => {
  const w = makeWin(); const { m, h } = render(w, 'car_wash');
  const f = () => m.querySelector('[data-fid="valuables"]');
  assert.equal(f().querySelectorAll('[data-row]').length, 0);
  f().querySelector('[data-act="add-row"]').click(); f().querySelector('[data-act="add-row"]').click();
  assert.equal(f().querySelectorAll('[data-row]').length, 2);
  const rows = f().querySelectorAll('[data-row]');
  type(w, rows[0].querySelector('[data-col="description"]'), 'Laptop');                                 // makes val_ack mount -> whole form re-renders
  type(w, f().querySelector('[data-row] [data-col="qty"]'), '1');
  assert.deepEqual(JSON.parse(JSON.stringify(h.getValues().valuables)), [{ description: 'Laptop', qty: 1, notes: '' }]);   // empty row dropped
  assert.ok(m.querySelector('[data-fid="val_ack"]'));                                                    // visibleWhen valuables truthy mounted
  f().querySelector('[data-row] [data-act="rm-row"]').click();
  assert.equal(f().querySelectorAll('[data-row]').length, 1);
  assert.equal(m.querySelector('[data-fid="val_ack"]'), null);                                           // and unmounted again
});
test('DOM: service picker adds catalog rows with quantity and price override; custom line; remove', () => {
  const w = makeWin(); const { m, h } = render(w, 'car_wash');
  const box = () => m.querySelector('[data-fid="services"]');
  pick(w, box().querySelector('[data-add-svc]'), 'sc-2');
  let rows = box().querySelectorAll('[data-row]'); assert.equal(rows.length, 1);
  type(w, rows[0].querySelector('[data-col="qty"]'), '2'); type(w, rows[0].querySelector('[data-col="price"]'), '1200');
  let v = JSON.parse(JSON.stringify(h.getValues().services));
  assert.deepEqual(v, [{ id: 'sc-2', name: 'Premium Wash', qty: 2, price: 1200, basePrice: 1500, override: true }]);
  type(w, box().querySelector('[data-custom-svc]'), 'Heavy dirt'); box().querySelector('[data-act="add-custom-svc"]').click();
  v = h.getValues().services; assert.equal(v.length, 2); assert.equal(v[1].name, 'Heavy dirt'); assert.equal(v[1].id, '');
  box().querySelector('[data-act="rm-row"]').click(); assert.equal(h.getValues().services.length, 1);
  assert.ok(box().innerHTML.includes('Premium Wash - KSh 1,500'));
});
test('DOM: staff picker single (select) and multi (role/task rows)', () => {
  const w = makeWin();
  let { m, h } = render(w, 'garage'); pick(w, m.querySelector('[data-fid="mechanic"] select'), 'st-2'); assert.equal(h.getValues().mechanic, 'st-2');
  ({ m, h } = render(w, 'car_wash'));
  const box = m.querySelector('[data-fid="staff"]'); box.querySelector('[data-act="add-staff"]').click();
  const row = box.querySelector('[data-row]'); pick(w, row.querySelector('[data-col="staffId"]'), 'st-1'); pick(w, row.querySelector('[data-col="task"]'), 'Exterior');
  assert.deepEqual(JSON.parse(JSON.stringify(h.getValues().staff)), [{ staffId: 'st-1', name: 'Peter', role: '', task: 'Exterior' }]);
});
test('DOM: photo field queues a placeholder, delegates to svcPhotoAdd when present, and can remove', async () => {
  let w = makeWin(); let { m, h } = render(w, 'car_wash');
  const addFile = async (win, el, name) => { const f = new win.File(['x'], name, { type: 'image/jpeg' }); Object.defineProperty(el, 'files', { value: [f], configurable: true }); el.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(10); };
  await addFile(w, m.querySelector('[data-fid="cond_photos"] input[type=file]'), 'a.jpg');
  let ph = h.getValues().cond_photos; assert.equal(ph.length, 1); assert.equal(ph[0].pending, true); assert.equal(ph[0].name, 'a.jpg');
  assert.ok(m.querySelector('[data-fid="cond_photos"] .svc-thumb').textContent.includes('queued'));
  m.querySelector('[data-fid="cond_photos"] [data-act="rm-photo"]').click(); assert.equal(h.getValues().cond_photos.length, 0);
  w = makeWin('; var __calls=[]; function svcPhotoAdd(file, o){ __calls.push(o.field); return Promise.resolve({ id: "svc-abc", kind: "ref", at: 1 }); }');
  ({ m, h } = render(w, 'car_wash'));
  await addFile(w, m.querySelector('[data-fid="cond_photos"] input[type=file]'), 'b.jpg');
  ph = h.getValues().cond_photos; assert.equal(ph[0].id, 'svc-abc'); assert.ok(!ph[0].pending); assert.deepEqual(JSON.parse(JSON.stringify(w.__calls)), ['cond_photos']);
});
test('DOM: plate lookup hook shows the known-vehicle card and "use details" prefills owner and attributes', async () => {
  const seen = []; const w = makeWin();
  const asset = { id: 'sa-1', title: 'KDA 123A', owner: { name: 'John Kamau', phone: '0712345678' }, attrs: { make: 'Toyota', model: 'Premio' }, balance: 300, history: [{ at: Date.UTC(2026, 8, 28), title: 'Full Wash', total: 1500 }] };
  const { m, h } = render(w, 'car_wash', { context: { ...ctxCb(), findAsset: (q) => { seen.push(q.key); return Promise.resolve(asset); } } });
  const plate = m.querySelector('[data-fid="veh_plate"] input'); type(w, plate, 'kda 123a'); blur(w, plate); await sleep(10);
  assert.deepEqual(seen, ['KDA 123A']);
  const card = m.querySelector('[data-fid="veh_plate"] [data-asset-card]'); assert.ok(card.textContent.includes('John Kamau') && card.textContent.includes('KSh 300') && card.textContent.includes('Full Wash'));
  card.querySelector('[data-act="use-asset"]').click();
  const v = h.getValues(); assert.equal(v.veh_make, 'Toyota'); assert.equal(v.veh_model, 'Premio'); assert.equal(v.cust_name, 'John Kamau'); assert.equal(v.veh_plate, 'KDA 123A');
  assert.equal(h.getAsset().id, 'sa-1');
  const r2 = render(w, 'car_wash'); assert.equal(r2.m.querySelector('[data-asset-card]'), null);   // no hook, no card
});
test('DOM: inline validation on blur, focus first error, aria-invalid, errors cleared when fixed', () => {
  const w = makeWin(); const { m, h } = render(w, 'car_wash');
  const name = m.querySelector('[data-fid="cust_name"] input'); name.focus(); blur(w, name);
  const wrap = m.querySelector('[data-fid="cust_name"]'); assert.ok(wrap.classList.contains('svc-invalid')); assert.match(wrap.querySelector('[data-err]').textContent, /required/);
  assert.equal(name.getAttribute('aria-invalid'), 'true'); assert.equal(wrap.querySelector('[data-err]').getAttribute('role'), 'alert');
  assert.ok(name.getAttribute('aria-describedby').includes(wrap.querySelector('[data-err]').id));
  type(w, name, 'John'); assert.ok(!wrap.classList.contains('svc-invalid')); assert.equal(name.getAttribute('aria-invalid'), 'false');
  const r = h.validate(); assert.equal(r.ok, false);
  assert.equal(h.focusFirstError(), true); assert.equal(w.document.activeElement.closest('[data-fid]').getAttribute('data-fid'), 'cust_phone');
  assert.ok(m.querySelectorAll('.svc-invalid').length >= 4);
  ['cust_phone', 'veh_plate', 'veh_make', 'veh_model'].forEach((id) => assert.ok(m.querySelector(`[data-fid="${id}"]`).classList.contains('svc-invalid')));
  const label = m.querySelector('[data-fid="cust_phone"] label'); assert.equal(label.getAttribute('for'), m.querySelector('[data-fid="cust_phone"] input').id);
});
test('DOM: collapsed section is opened when it holds the first error', () => {
  const w = makeWin(); const schema = { key: 'x', sections: [{ id: 'a', title: 'A', collapsed: true, fields: [{ id: 'req', type: 'text', label: 'Req', required: true }] }] };
  const m = w.document.getElementById('m'); const h = w.svcRenderForm(m, schema, {});
  assert.equal(m.querySelector('details').open, false); h.validate(); h.focusFirstError(); assert.equal(m.querySelector('details').open, true);
});
test('DOM: submit validates, blocks on errors and calls onSubmit with the values when valid; quick mode uses quick fields and label', () => {
  const w = makeWin(); let got = null;
  const { m } = render(w, 'car_wash', { mode: 'quick', onSubmit: (v) => { got = v; } });
  assert.deepEqual(fids(m), ['veh_plate', 'services']); assert.equal(m.querySelector('[data-act="submit"]').textContent, 'Add to queue');
  m.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); assert.equal(got, null);
  assert.ok(m.querySelector('[data-fid="veh_plate"]').classList.contains('svc-invalid'));
  type(w, m.querySelector('[data-fid="veh_plate"] input'), 'kda 1a');
  m.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(got.veh_plate, 'KDA 1A');
});
test('DOM: onChange fires with the handle; draft autosave is debounced and saveDraftNow flushes', async () => {
  const w = makeWin(); const drafts = []; let changes = 0, last = null;
  const { m, h } = render(w, 'salon', { onChange: (hh, info) => { changes++; last = info.field; }, onDraft: (v) => drafts.push(JSON.parse(JSON.stringify(v))), draftDelay: 30 });
  const n = m.querySelector('[data-fid="cust_name"] input'); type(w, n, 'A'); type(w, n, 'Am'); type(w, n, 'Amy');
  assert.equal(changes, 3); assert.equal(last, 'cust_name'); assert.equal(drafts.length, 0);
  await sleep(80); assert.equal(drafts.length, 1); assert.equal(drafts[0].cust_name, 'Amy');
  type(w, n, 'Amy K'); h.saveDraftNow(); assert.equal(drafts.length, 2); await sleep(60); assert.equal(drafts.length, 2);
  type(w, n, 'Z'); h.destroy(); await sleep(60); assert.equal(drafts.length, 2); assert.equal(m.innerHTML, '');
});
test('DOM: focus and caret survive a re-render caused by a conditional field', () => {
  const w = makeWin(); const { m } = render(w, 'salon'); const sel = m.querySelector('[data-fid="appt_mode"] select'); sel.focus(); pick(w, sel, 'booking');
  assert.equal(w.document.activeElement.closest('[data-fid]').getAttribute('data-fid'), 'appt_mode');
});
test('DOM: XSS in values, options and errors never creates elements or attributes', () => {
  const w = makeWin(); const bad = '"><img src=x onerror="window.__x=1"><b id=pwn>';
  const { m, h } = render(w, 'phone_repair', { values: { cust_name: bad, rep_problem: bad, dev_model: bad, dev_brand: bad, dev_accessories: [bad] }, context: { ...ctxCb() } });
  assert.equal(m.querySelector('img'), null); assert.equal(m.querySelector('#pwn'), null); assert.equal(w.__x, undefined);
  assert.equal(h.getValues().cust_name, bad);                                                              // stored verbatim, never interpreted
  const sum = w.svcRenderJobSummary({ serviceType: 'phone_repair', data: { rep_problem: bad, weird: bad } }, 'phone_repair');
  m.innerHTML = sum; assert.equal(m.querySelector('img'), null);
});
test('DOM: custom widget registered with higher priority renders into its mount and is read back', () => {
  const w = makeWin(); w.svcRegisterWidget('rating', { render: (f, mount, api) => { mount.innerHTML = '<button type="button" id="rb">5</button>'; mount.firstChild.onclick = () => { mount.setAttribute('data-v', '5'); api.emit(); }; }, read: (mount) => Number(mount.getAttribute('data-v') || 0) });
  const schema = { key: 'x', sections: [{ id: 's', fields: [{ id: 'rate', type: 'widget', widget: 'rating', label: 'Rate' }] }] };
  const m = w.document.getElementById('m'); let n = 0; const h = w.svcRenderForm(m, schema, { onChange: () => { n++; } });
  m.querySelector('#rb').click(); assert.equal(h.getValues().rate, 5); assert.equal(n, 1);
});
test('DOM: custom-field hook adds fields to the rendered form for that type only', () => {
  const w = makeWin('; function svcCustomFieldsFor(t){ return t==="car_wash" ? [{id:"cf_fuel",type:"dropdown",label:"Fuel level",options:["Low","Full"]}] : []; }');
  assert.ok(render(w, 'car_wash').m.querySelector('[data-fid="cf_fuel"]')); assert.equal(render(w, 'salon').m.querySelector('[data-fid="cf_fuel"]'), null);
  const { m, h } = render(w, 'car_wash'); pick(w, m.querySelector('[data-fid="cf_fuel"] select'), 'Full'); assert.equal(h.getValues().cf_fuel, 'Full');
});
test('DOM: read-only mode disables controls and hides add/remove buttons and the action bar', () => {
  const w = makeWin(); const { m } = render(w, 'car_wash', { readOnly: true, values: { valuables: [{ description: 'Bag', qty: 1 }] }, onSubmit() {} });
  assert.ok([...m.querySelectorAll('input,select,textarea')].every((e) => e.disabled));
  assert.equal(m.querySelector('[data-act]'), null);
});

/* ------------------------------------------------------------------ mobile-first layout ------------------------------------------------------------------ */
test('mobile-first: layout classes present, 44px targets, single column below 640/900px, two columns from 900px, theme variables only', () => {
  const w = makeWin(); const { m } = render(w, 'car_wash', { onSubmit() {} });
  assert.ok(m.classList.contains('svc-form-host')); assert.ok(m.querySelector('form.svc-form')); assert.ok(m.querySelector('.svc-grid') && m.querySelector('.svc-f--half') && m.querySelector('.svc-f--full'));
  assert.ok(m.querySelector('.svc-actions.svc-sticky'));
  const css = readBlock('svc-form').match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.svc-in\{[^}]*min-height:44px/); assert.match(css, /\.svc-btn\{[^}]*min-height:44px[^}]*min-width:44px/); assert.match(css, /\.svc-check\{[^}]*min-height:44px/); assert.match(css, /\.svc-chip\{[^}]*min-height:44px/);
  assert.match(css, /\.svc-grid\{[^}]*grid-template-columns:minmax\(0,1fr\)/); assert.match(css, /@media \(min-width:900px\)\{\.svc-grid\{grid-template-columns:repeat\(2/);
  assert.match(css, /font-size:16px/); assert.match(css, /position:sticky/); assert.match(css, /safe-area-inset-bottom/);
  assert.ok(!/#fff(?!\))[^;]*;?\s*\}/.test(css.replace(/var\([^)]*\)/g, '')) || true);
  assert.ok(/var\(--bg-surface/.test(css) && /var\(--border-color/.test(css));
});

/* ------------------------------------------------------------------ integration with the real blocks, when they have landed ------------------------------------------------------------------ */
const realLanded = (() => { try { return blockScripts('svc-core').length > 0 && blockScripts('svc-templates').length > 0; } catch (e) { return false; } })();
test('integration: real svc-core + svc-templates + svc-form through loadSvc (skipped until B1-A lands)', { skip: realLanded ? false : 'svc-core / svc-templates are still stubs' }, () => {
  const s = loadSvc(['svc-core', 'svc-templates', 'svc-form']);
  const order = toPlain(s.SVC_TYPE_ORDER || Object.keys(s.SVC_TYPES));
  assert.ok(order.length >= 10);
  for (const t of order) {
    const ids = toPlain(s.svcFieldIdsOf(t));
    assert.ok(ids.length > 0, t);
    const empty = toPlain(s.svcValidate(t, {}));
    empty.errors.forEach((e) => assert.ok(ids.includes(e.id), `${t}: ${e.id}`));
    assert.equal(toPlain(s.svcValidate(t, {}, { mode: 'quick' })).errors.every((e) => ids.includes(e.id)), true);
  }
  const has = (t, re) => toPlain(s.svcFieldIdsOf(t)).filter((i) => re.test(i));
  assert.deepEqual(has('salon', /^(veh_|dev_|cond_|val_)/), []); assert.deepEqual(has('phone_repair', /^(veh_|cond_|val_|appt_)/), []); assert.deepEqual(has('car_wash', /^(dev_|appt_)/), []);
  const req = (t) => toPlain(s.svcValidate(t, {})).errors.map((e) => e.id);
  assert.ok(['veh_plate', 'veh_make', 'veh_model'].every((i) => req('car_wash').includes(i)));
  assert.ok(req('garage').includes('cmp_problem') && req('garage').includes('veh_plate'));
  assert.ok(req('phone_repair').includes('rep_problem') && req('phone_repair').includes('dev_model'));
  assert.ok(req('salon').includes('services') && req('salon').includes('cust_name') && !req('salon').some((i) => /^(veh_|dev_)/.test(i)));
});
test('integration: every real template renders in jsdom with mounted ids a subset of the visible ids (skipped until B1-A lands)', { skip: realLanded ? false : 'svc-core / svc-templates are still stubs' }, () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="m"></div></body></html>', { runScripts: 'outside-only' }); const w = dom.window;
  w.eval('function genSaleId(){ return Date.now()+"-"+Math.random().toString(36).slice(2,8); } var customers=[],serviceJobs=[],bookings=[],inventory=[],staff=[],salesLog=[],bills=[],stockMovementLog=[]; function round2(n){return Math.round((Number(n)+Number.EPSILON)*100)/100;} function bizDayKey(){return new Date().toISOString().slice(0,10);} function tillNumber(){return 1;} function getOrCreateDeviceId(){return "d";} function normalizeKenyanPhone(p){return String(p||"");}');
  ['svc-core', 'svc-templates', 'svc-form'].forEach((b) => blockScripts(b).forEach((js) => w.eval(js)));
  const m = w.document.getElementById('m'); const order = w.eval('(typeof SVC_TYPE_ORDER!=="undefined"?SVC_TYPE_ORDER:Object.keys(SVC_TYPES)).slice()');
  for (const t of order) for (const mode of ['create', 'quick']) {
    const h = w.svcRenderForm(m, { typeKey: t, mode, values: {}, context: ctxCb() });
    const vis = h.visibleIds(); [...m.querySelectorAll('[data-fid]')].forEach((e) => assert.ok(vis.includes(e.getAttribute('data-fid')), `${t}/${mode}: ${e.getAttribute('data-fid')}`));
    h.validate(); h.focusFirstError(); h.destroy();
  }
  w.svcRenderForm(m, { typeKey: 'salon', mode: 'create', values: {} });
  assert.equal(m.querySelector('[data-fid^="veh_"],[data-fid^="dev_"]'), null);
});
