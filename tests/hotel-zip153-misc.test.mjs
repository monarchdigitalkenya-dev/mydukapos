import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 153 — hotel: half shot, facility ticket day pricing, a failing printer never loses the order, no card option.
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const app = async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify([]) }, wait: 1500 });
  b.w.eval("window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true;");
  return b;
};

test('half shot is a standard serving, exactly half the shot', async () => {
  const b = await app();
  const z = J(b.w, 'hospPourSizes().map(x => [x.id, x.ml])');
  const shot = z.find((x) => x[0] === 'shot')[1];
  assert.equal(z.find((x) => x[0] === 'half-shot')[1], Math.round(shot / 2));
  b.close();
});

test('a facility ticket is one flat price OR weekday/weekend (Sat/Sun, East Africa Time), per person', async () => {
  const b = await app(); const { w } = b;
  w.eval(`window.__r = hospAddResource({ name: 'Swimming Pool', type: 'pool', capacity: 50, passes: [
    { id: 'flat', name: 'Day ticket', price: 300, dayPricing: 'flat', perPerson: true },
    { id: 'wk', name: 'Split ticket', dayPricing: 'weekday_weekend', weekdayPrice: 200, weekendPrice: 500, perPerson: true } ] })`);
  const rid = w.eval('window.__r.id');
  const at = (iso) => Date.parse(iso);
  const sell = (pass, iso, people) => J(w, `(function (p) { return p && { charge: p.charge, day: p.dayType }; })(hospSellPass('${rid}', '${pass}', { people: ${people}, at: ${at(iso)}, tabLabel: 'T${Math.random()}' }))`);
  assert.deepEqual(sell('flat', '2026-09-26T10:00:00+03:00', 2), { charge: 600, day: 'flat' });
  assert.deepEqual(sell('wk', '2026-09-29T10:00:00+03:00', 3), { charge: 600, day: 'weekday' }, 'Tuesday');
  assert.deepEqual(sell('wk', '2026-09-26T10:00:00+03:00', 3), { charge: 1500, day: 'weekend' }, 'Saturday');
  assert.deepEqual(sell('wk', '2026-09-27T23:30:00+03:00', 1), { charge: 500, day: 'weekend' }, 'Sunday late evening is still Sunday in EAT');
  b.close();
});

test('a printer that fails is reported and remembered; the order is not lost', async () => {
  const b = await app(); const { w } = b;
  await w.eval("hospTrackPrint('kitchen', Promise.reject(new Error('printer not answering')))");
  assert.equal(J(w, 'window.__hospPrintStatus.kitchen.ok'), false);
  assert.ok(J(w, 'window.__toasts').some((t) => /did NOT print/.test(t) && /order is safe/.test(t)));
  await w.eval("hospTrackPrint('kitchen', Promise.resolve(1))");
  assert.equal(J(w, 'window.__hospPrintStatus.kitchen.ok'), true, 'a later good print clears the warning');
  b.close();
});

test('there is no card payment option anywhere in the hotel till', async () => {
  const b = await app(); const { w } = b;
  w.eval('hospHideCardControls()');
  assert.equal(w.document.querySelectorAll('option[value="card"]').length, 0);
  const vis = [...w.document.querySelectorAll('button[onclick*="\'card\'"]')].filter((x) => x.style.display !== 'none');
  assert.equal(vis.length, 0);
  b.close();
});
