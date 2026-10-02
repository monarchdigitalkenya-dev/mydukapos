import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// zip 185: receipt/bill date and time use the shop's time zone, not the printing device's.
const src = fs.readFileSync(new URL('../src/shared/functions.js', import.meta.url), 'utf8');
function grab(name) {
  const i = src.indexOf('//@fn ' + name + '\n');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\n//@fn ', i + 5);
  return src.slice(i, j < 0 ? undefined : j);
}
function ctxWith(tzValue) {
  const store = tzValue === undefined ? {} : { pos_business_tz: tzValue };
  const sandbox = { window: {}, Date, localStorage: { getItem: (k) => (k in store ? store[k] : null) } };
  vm.createContext(sandbox);
  vm.runInContext(grab('bizTzOffsetMin') + '\n' + grab('bizReceiptStamp'), sandbox);
  return sandbox;
}
const T = Date.UTC(2026, 9, 2, 11, 28, 5);          // 11:28:05 UTC = 14:28:05 in Nairobi

test('default shop zone (East Africa): 14:28:05 whatever the device zone is', () => {
  const s = ctxWith(undefined);
  const out = vm.runInContext(`bizReceiptStamp(${T})`, s);
  assert.equal(out.date, '02/10/2026');
  assert.equal(out.time, '14:28:05');
});
test('a date after midnight in Nairobi rolls to the next day', () => {
  const s = ctxWith(undefined);
  const out = vm.runInContext(`bizReceiptStamp(${Date.UTC(2026, 9, 2, 21, 30, 0)})`, s);   // 00:30 on 3 Oct in Nairobi
  assert.equal(out.date, '03/10/2026'); assert.equal(out.time, '00:30:00');
});
test('"device" zone keeps the old behaviour; invalid date does not throw', () => {
  const s = ctxWith('device');
  const out = vm.runInContext(`bizReceiptStamp(${T})`, s);
  assert.equal(out.time, new Date(T).toLocaleTimeString('en-GB'));
  assert.doesNotThrow(() => vm.runInContext('bizReceiptStamp(NaN)', s));
});
