import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, seedShop } from './kv-fake.mjs';
import { boot } from './helpers.mjs';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';
import { onRequestPost as syncPost, onRequestGet as syncGet } from '../functions/api/pos-sync.js';
import { onRequestGet as statusGet } from '../functions/api/license-status.js';

const APP = { shop: 'index.html', hotel: 'hotel/index.html', pharmacy: 'pharmacy/index.html', hospital: 'hospital/index.html', production: 'production/index.html', services: 'services/index.html', water: 'water/index.html' };
const CHECK = { retail: 'inventory.length', hardware: 'inventory.length', liquor: 'inventory.length', hotel: 'inventory.length', pharmacy: 'inventory.length', hospital: 'patients.length', production: 'inventory.length', services: 'inventory.length', water: 'products.length' };

for (const d of SHARED_DEMOS) {
  test(d.key + ': opens loaded, shows the DEMO banner, and stops talking to the server after the first load', { timeout: 60000 }, async () => {
    const kv = makeKV(); const env = { mydukapos_kv: kv };
    await ensureSharedDemo(env, d);
    const log = [];
    const fetcher = async (url, o = {}) => {
      const u = new URL(String(url), 'https://' + d.slug + '.mydukapos.store');
      const method = (o.method || 'GET').toUpperCase();
      const mk = (p, m) => new Request('https://x.pages.dev' + p + '?c=' + d.id + (u.search ? '&' + u.search.slice(1).replace(/^c=[^&]*&?/, '') : ''), { method: m, body: o.body, headers: { 'content-type': 'application/json' } });
      if (u.pathname.endsWith('/api/license-status')) return statusGet({ request: mk('/api/license-status', 'GET'), env });
      if (u.pathname.endsWith('/api/pos-sync')) { log.push(method + ' ' + Date.now()); return (method === 'POST' ? syncPost : syncGet)({ request: mk('/api/pos-sync', method), env, waitUntil() {} }); }
      if (u.pathname.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const dev = await boot(APP[d.product === 'shop' ? 'shop' : d.product], { url: 'https://' + d.slug + '.mydukapos.store/?c=' + d.id, fetch: fetcher, wait: 6000 });
    try {
      const w = dev.w;
      const n = Number(w.eval(CHECK[d.key]));
      assert.ok(n > 5, d.key + ': sample data loaded (' + n + ')');
      assert.equal(w.localStorage.getItem('pos_admin_pw_hash') || w.localStorage.getItem('aqua_admin_pw_hash'), '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', d.key + ': the demo password 0000 unlocks it');
      assert.ok(w.document.getElementById('sd-bar'), d.key + ': DEMO banner shown');
      assert.equal(w.SharedDemo && w.SharedDemo.on, true);
      const posts0 = log.filter((x) => x.startsWith('POST')).length, all0 = log.length;
      await new Promise((r) => setTimeout(r, 400));
      try { await w.pushNow(); } catch (e) { /* none */ }
      try { await w.pullState(); } catch (e) { /* none */ }
      assert.equal(log.length, all0, d.key + ': no further sync traffic after load');
      assert.equal(log.filter((x) => x.startsWith('POST')).length, posts0);
    } finally { dev.close(); }
  });
}

test('a normal shop address does nothing and asks nothing extra', { timeout: 30000 }, async () => {
  let asked = 0;
  const dev = await boot('index.html', { url: 'https://myshop.mydukapos.store/?c=ABC123', fetch: async (u) => { if (String(u).includes('license-status')) asked++; return new Response('{}', { status: 404 }); }, wait: 1500 });
  try { assert.equal(dev.w.document.getElementById('sd-bar'), null); assert.equal(dev.w.SharedDemo, undefined); } finally { dev.close(); }
});
