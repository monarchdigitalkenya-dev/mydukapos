// End-to-end harness: a REAL app in jsdom talking to the REAL pos-sync function over a fake KV — so "I changed something, refreshed,
// and it was back to how it was" can be reproduced and tested instead of guessed at.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';

export function makeServer() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const state = { down: false, status: null, log: [] };
  const env = { mydukapos_kv: kv };
  const handler = async (url, opts = {}) => {
    const u = new URL(String(url), 'https://shop.mydukapos.store');
    if (state.down) throw new Error('offline');
    if (!u.pathname.endsWith('/api/pos-sync')) return new Response('{}', { status: 404 });
    const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
    const method = (opts.method || 'GET').toUpperCase();
    state.log.push(method + ' ' + u.search);
    if (method === 'POST' && state.status) return new Response(JSON.stringify({ error: 'forced' }), { status: state.status, headers: { 'content-type': 'application/json' } });
    const request = new Request('https://x.pages.dev/api/pos-sync?c=C1' + (u.search ? '&' + u.search.slice(1).replace(/^c=[^&]*&?/, '') : ''), { method, body: opts.body, headers: { 'content-type': 'application/json' } });
    const fn = method === 'POST' ? m.onRequestPost : m.onRequestGet;
    return fn({ request, env, waitUntil() {} });
  };
  return { kv, env, state, fetch: handler, serverState: () => JSON.parse(kv.data.get('pos-data:state:C1')?.value || '{}') };
}

// everything a device has in localStorage (raw, so compressed slices survive a "refresh")
export const deviceStorage = (w) => JSON.parse(w.eval("JSON.stringify(Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)).map(k => [k, (window.__lsRawGet || (k2 => localStorage.getItem(k2)))(k)])))"));

export async function openDevice(app, server, storage = {}, wait = 900) {
  return boot(app, { storage, fetch: server.fetch, wait });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
