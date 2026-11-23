import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { onRequestGet as statusGet, sharedDemoKeyFor } from '../functions/api/license-status.js';
import { ROOT } from './helpers.mjs';

// zip 281: a shared demo address that was never prepared answers with the demo (it used to say "link code not recognised")
const env = () => { const kv = makeKV(); seedShop(kv, 'REAL1', { type: 'permanent', createdAt: Date.UTC(2026, 9, 20) }); return { mydukapos_kv: kv }; };

test('opening demo_hospital directly prepares the shared demo and confirms the link', async () => {
  const e = env();
  assert.equal(e.mydukapos_kv.data.get('license:demo_hospital'), undefined, 'not prepared yet');
  const r = await statusGet({ request: new Request('https://x.pages.dev/api/license-status?c=demo_hospital'), env: e });
  const j = await r.json();
  assert.equal(j.valid, true); assert.equal(j.sharedDemo, true); assert.equal(j.clientId, 'demo_hospital'); assert.equal(j.product, 'hospital');
  assert.ok(e.mydukapos_kv.data.get('pos-data:state:demo_hospital'), 'the sample data is loaded');
  const again = await (await statusGet({ request: new Request('https://x.pages.dev/api/license-status?c=demo_hospital'), env: e })).json();
  assert.equal(again.valid, true, 'a second open finds it');
});

test('only the fixed demo names heal; unknown codes and real shops are untouched', async () => {
  const e = env();
  const j = await (await statusGet({ request: new Request('https://x.pages.dev/api/license-status?c=demo_nosuch'), env: e })).json();
  assert.equal(j.valid, false);
  assert.equal(e.mydukapos_kv.data.get('license:demo_nosuch'), undefined);
  const k = await (await statusGet({ request: new Request('https://x.pages.dev/api/license-status?c=somethingelse'), env: e })).json();
  assert.equal(k.valid, false);
  assert.equal(sharedDemoKeyFor(new Request('https://x.pages.dev/?c=demo_hotel'), {}, ''), 'hotel');
  assert.equal(sharedDemoKeyFor(new Request('https://x.pages.dev/?c=demo_hotel2'), {}, ''), '');
});

test('a demo address owned by another shop is never taken over', async () => {
  const e = env();
  e.mydukapos_kv.data.set('slug:demo-hotel', { value: 'REAL1' });
  const j = await (await statusGet({ request: new Request('https://x.pages.dev/api/license-status?c=demo_hotel'), env: e })).json();
  assert.equal(j.valid, false);
  assert.equal(e.mydukapos_kv.data.get('license:demo_hotel'), undefined);
});

test('hotel: Sell at the bar is on the Bar Orders board and reuses the order + settle path', () => {
  const t = fs.readFileSync(ROOT + '/hotel/index.html', 'utf8');
  assert.ok(t.includes("station === 'bar' && !full ? '<button type=\"button\" class=\"kf-btn kf-sell\" onclick=\"barSellOpen()\">"));
  const fn = t.slice(t.indexOf('function barSellCharge()'), t.indexOf('function barSellCharge()') + 1600);
  assert.ok(fn.includes('appendOrderToTab(tab, barSellEntries())') && fn.includes("'SERVED'") && fn.includes('settleTabDirect(tab.id)') && fn.includes("hospCan('payments')") && fn.includes('hospSettleForBilling(tab.id)'));
  assert.ok(t.includes("if (window.__barSaleNoSlip) return;"), 'no bar slip for a drink poured on the spot');
  assert.ok(t.includes("hospStationFor(p.code, p.name) !== 'bar'"), 'only bar items are offered');
});
