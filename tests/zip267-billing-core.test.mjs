import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normaliseSettings, validateSettings, mergeSettings, describeEffect, subscriptionState, nextPaidThrough, allowances, discountOf, pickOffers, offerStatus, eatDateTime, eatDate, enforcementOn, DAY_MS } from '../functions/api/_billing-core.js';

const T = (s) => Date.parse(s);                                   // UTC instants
const NOW = T('2026-10-12T12:42:00Z');                            // 15:42 in Nairobi

test('defaults are the agreed ones and never hard-coded elsewhere', () => {
  const s = normaliseSettings(null);
  assert.deepEqual(s.prices, { link: 3000, subscription: 400, extraBranch: 1000, branchBundle: 3000, staffBlock: 500 });
  assert.equal(s.periodDays, 31); assert.equal(s.graceDays, 3); assert.equal(s.includedBranches, 3); assert.equal(s.includedStaffPerBranch, 5); assert.equal(s.bundleBranches, 3); assert.equal(s.staffBlockSize, 5);
  assert.equal(s.launchAt, 0, 'billing is OFF until the owner sets a launch date');
});

test('validation names the bad field; editing is partial; effect text says who is affected', () => {
  const bad = validateSettings({ prices: { link: -5, subscription: 'abc' }, graceDays: 99 });
  assert.equal(bad.ok, false); assert.ok(bad.errors.length >= 3);
  const merged = mergeSettings(DEFAULT_SETTINGS, { prices: { subscription: 450 } });
  assert.equal(merged.prices.link, 3000); assert.equal(merged.prices.subscription, 450);
  const v = validateSettings(merged); assert.equal(v.ok, true);
  const fx = describeEffect(DEFAULT_SETTINGS, v.settings);
  assert.equal(fx.length, 1); assert.match(fx[0], /400.*450/); assert.match(fx[0], /already agreed/);
  assert.match(describeEffect(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, launchAt: T('2026-11-01T00:00:00Z') }).join(' '), /1 Nov 2026/);
});

test('Nairobi display: 12:42Z is 15:42 on the 12th', () => {
  assert.match(eatDateTime(NOW), /12 Oct 2026.*15:42/); assert.equal(eatDate(T('2026-10-12T21:30:00Z')), '13 Oct 2026', 'after 21:00Z it is already tomorrow in Nairobi');
});

test('a purchase confirmed 12 Oct is due 12 Nov; early renewal extends from the paid-through date and never shortens', () => {
  const first = nextPaidThrough({ now: NOW });
  assert.equal(first, NOW + 31 * DAY_MS); assert.match(eatDate(first), /^12 Nov 2026$/);
  const early = nextPaidThrough({ paidThrough: first, now: NOW + 10 * DAY_MS });
  assert.equal(early, first + 31 * DAY_MS, 'continues from the existing date');
  assert.ok(early > first);
  const inGrace = nextPaidThrough({ paidThrough: first, now: first + 2 * DAY_MS, graceDays: 3 });
  assert.equal(inGrace, first + 31 * DAY_MS, 'a renewal inside grace is continuous');
  const lapsed = nextPaidThrough({ paidThrough: first, now: first + 10 * DAY_MS, graceDays: 3 });
  assert.equal(lapsed, first + 10 * DAY_MS + 31 * DAY_MS, 'a suspended shop starts again from now');
});

test('states: grandfathered when billing is absent or empty; active; grace keeps it online; suspended only after grace', () => {
  for (const rec of [null, {}, { billing: null }, { billing: {} }, { billing: { cohort: 'grandfathered' } }, { billing: { cohort: 'new' } }, { billing: { cohort: 'new', paidThrough: 0 } }])
    assert.equal(subscriptionState(rec, NOW).blocking, false, JSON.stringify(rec));
  assert.equal(subscriptionState({}, NOW).state, 'grandfathered');
  const paid = NOW + 31 * DAY_MS, rec = { billing: { cohort: 'new', paidThrough: paid, graceDays: 3, price: 400 } };
  assert.equal(subscriptionState(rec, NOW).state, 'active');
  assert.equal(subscriptionState(rec, paid).state, 'active', 'due time itself is still paid');
  const g = subscriptionState(rec, paid + 1); assert.equal(g.state, 'grace'); assert.equal(g.blocking, false); assert.equal(g.graceEndsAt, paid + 3 * DAY_MS);
  assert.equal(subscriptionState(rec, paid + 3 * DAY_MS).state, 'grace');
  const s = subscriptionState(rec, paid + 3 * DAY_MS + 1); assert.equal(s.state, 'suspended'); assert.equal(s.blocking, true);
  assert.equal(subscriptionState({ billing: { ...rec.billing, comped: true } }, paid + 99 * DAY_MS).blocking, false, 'comped is never blocked');
  assert.equal(subscriptionState({ billing: { ...rec.billing, exempt: true } }, paid + 99 * DAY_MS).state, 'exempt');
  assert.equal(subscriptionState({ billing: { ...rec.billing, suspended: true } }, NOW).blocking, true, 'owner suspension');
});

test('allowances: 3 branches and 5 staff each included; extras and blocks add on', () => {
  assert.deepEqual(allowances({}, DEFAULT_SETTINGS), { branches: 3, staff: 15, includedBranches: 3, includedStaffPerBranch: 5, extraBranches: 0, staffBlocks: 0 });
  const a = allowances({ addons: { branches: 3, staffBlocks: 2 } }, DEFAULT_SETTINGS);
  assert.equal(a.branches, 6); assert.equal(a.staff, 6 * 5 + 2 * 5);
});

test('discounts: percent and fixed, capped, never negative, one offer unless stacking', () => {
  assert.equal(discountOf(3000, { type: 'percent', value: 20 }), 600);
  assert.equal(discountOf(3000, { type: 'percent', value: 20, maxDiscount: 500 }), 500);
  assert.equal(discountOf(400, { type: 'fixed', value: 1000 }), 400, 'cannot exceed the amount');
  assert.equal(discountOf(0, { type: 'percent', value: 50 }), 0);
  const base = { appliesTo: ['link'], beneficiary: 'buyer', state: 'active', cohort: 'all' };
  const a = { ...base, id: 'a', type: 'percent', value: 20 }, b = { ...base, id: 'b', type: 'fixed', value: 300 };
  const one = pickOffers([a, b], { applies: 'link', amount: 3000, now: NOW });
  assert.equal(one.picked.length, 1); assert.equal(one.discount, 600, 'the better one');
  const both = pickOffers([{ ...a, stackable: true }, { ...b, stackable: true }], { applies: 'link', amount: 3000, now: NOW });
  assert.equal(both.picked.length, 2); assert.equal(both.discount, 600 + 300 * 1);
  assert.equal(pickOffers([{ ...a, appliesTo: ['renewal'] }], { applies: 'link', amount: 3000, now: NOW }).discount, 0);
  assert.equal(pickOffers([{ ...a, code: 'SAVE' }], { applies: 'link', amount: 3000, now: NOW }).discount, 0, 'a coded offer needs its code');
  assert.equal(pickOffers([{ ...a, code: 'SAVE' }], { applies: 'link', amount: 3000, code: ' save ', now: NOW }).discount, 600);
  assert.equal(pickOffers([{ ...a, beneficiary: 'referrer' }], { applies: 'link', amount: 3000, now: NOW }).discount, 0);
  assert.equal(offerStatus({ ...a, startsAt: NOW + 1 }, NOW), 'scheduled'); assert.equal(offerStatus({ ...a, endsAt: NOW }, NOW), 'expired');
  assert.equal(offerStatus({ ...a, limitTotal: 2, used: 2 }, NOW), 'used up'); assert.equal(offerStatus({ ...a, state: 'paused' }, NOW), 'paused');
});

test('enforcement needs a launch date in the past and the kill switch on', () => {
  assert.equal(enforcementOn(normaliseSettings(null), NOW), false);
  assert.equal(enforcementOn({ launchAt: NOW - 1, enforce: true }, NOW), true);
  assert.equal(enforcementOn({ launchAt: NOW + 1, enforce: true }, NOW), false);
  assert.equal(enforcementOn({ launchAt: NOW - 1, enforce: false }, NOW), false);
});
