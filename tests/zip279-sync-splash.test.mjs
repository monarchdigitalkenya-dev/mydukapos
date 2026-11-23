import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';

// zip 279 - (1) a change made on one device shows on the others quickly even when the read lags; (2) no "newer version" notice; (3) one loading screen.
const APPS = ['index.html', 'hotel', 'hospital', 'pharmacy', 'production', 'services', 'water'].map((a) => (a.endsWith('.html') ? a : a + '/index.html'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);

test('?fresh=1 waits (briefly) for the copy of the shop to be as new as the last save; a plain pull answers at once', async () => {
  const m = await load('pos-sync.js');
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1(), RETRY_BASE_MS: '0' };
  const post = (body) => m.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, waitUntil() {} });
  const get = (q) => m.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1' + q), env, waitUntil() {} }).then((r) => r.json());
  assert.equal((await post({ businessName: 'B', inventory: [{ code: 'A', name: 'Alpha', qty: 1, price: 5 }] })).status, 200);
  const before = (await get('')).updatedAt;
  assert.equal((await post({ businessName: 'B', inventory: [{ code: 'B', name: 'Bravo', qty: 2, price: 7 }] })).status, 200);
  // a lagging read: the first two reads of the shop return the OLD copy (what another KV location may still hold)
  const real = kv.getWithMetadata.bind(kv); const key = 'pos-data:state:C1'; const old = { value: kv.data.get(key).value, metadata: kv.data.get(key).metadata };
  const newer = JSON.parse(old.value); assert.ok(newer.updatedAt > before);
  const hist = []; kv.data.forEach((v, k) => { if (k === key) hist.push(v); });
  const oldCopy = JSON.stringify({ ...newer, updatedAt: before, inventory: newer.inventory.filter((i) => i.code === 'A') });
  const oldMeta = { ...(old.metadata || {}), ver: Math.max(0, ((old.metadata && old.metadata.ver) || 1) - 1), ua: before };
  let stale = 2;
  kv.getWithMetadata = async (k, o) => (k === key && stale-- > 0 ? { value: oldCopy, metadata: oldMeta } : real(k, o));
  const lagging = await get('&since=' + before);                            // no fresh: the lagging copy is believed
  assert.equal(lagging.unchanged, true, 'a plain poll answers from what it reads');
  stale = 2;
  const fresh = await get('&since=' + before + '&fresh=1');
  assert.ok(fresh.inventory && fresh.inventory.some((i) => i.code === 'B'), 'fresh: waited until the new copy was readable');
});

test('every app: a "something changed" poke asks for a fresh copy and looks again soon; the one-at-a-time guard never drops it', () => {
  for (const f of APPS) {
    const t = read(f);
    assert.ok(/function pullFreshAfterPoke\b/.test(t), f + ': pullFreshAfterPoke');
    assert.ok(/data\.poke\) \{[^\n]{0,200}pullFreshAfterPoke\(\); return; \}/.test(t), f + ': poke -> fresh pull');   // (Hotel also checks QR orders first)
    assert.ok(/'fresh=1'/.test(t), f + ': sends fresh=1');
    assert.ok(/__pokeRetries/.test(t) && /__pullAgain = true/.test(t), f + ': retries and does not drop a poke during a pull');
  }
});

test('the "A newer version of the app is ready" notice is gone from every app and the owner console', () => {
  for (const f of [...APPS, 'owner/index.html']) { const t = read(f); assert.ok(!/posnet-update-ready|A newer version of the app is ready/.test(t), f); }
});

test('one loading screen: first thing in <body> of every app, with its own CSS, an 8 s cap, and removed once the picker is on', () => {
  for (const f of APPS) {
    const t = read(f); const i = t.indexOf('\n<body>\n');
    assert.ok(i > 0 && t.slice(i, i + 200).includes('@shared-block:boot-splash:begin'), f + ': right after <body>');
    assert.ok(t.includes('id="boot-splash"') && t.includes('prefers-reduced-motion') && t.includes('setTimeout(done, 15000)') && t.includes('if (!parsed) return false') && t.includes("shown('login-screen')"), f);
    assert.ok(/\.skip-link\{position:absolute;left:12px;top:-64px\}/.test(t), f + ': the skip link is hidden from the first paint');
  }
  assert.ok(!read('owner/index.html').includes('id="boot-splash"'), 'the owner console keeps its own');
});
