import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeKV, seedShop } from './kv-fake.mjs';

// Zip 151 — "sales made on device A and device B: each device only shows its own". A device that had never pulled (new device, cleared
// browser data, marker reset) pushed its sales first; the server merged them into what the other device had already sent and answered
// with `prev` (the server's time before this push). pushNow() only treated `prev` as "I missed something" when the device already held
// an earlier marker (`heldUpTo > 0`), so a brand-new device moved its marker straight to the merged time, every later pull answered
// "unchanged", and the other device's sales never arrived. Runs the REAL server code and the REAL rule taken from the shared source.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/shared/functions.js'), 'utf8');
const line = src.split('\n').find((l) => l.includes('const missedSomething = movedStock ||'));
assert.ok(line, 'pushNow still decides missedSomething');
const rule = new Function('data', 'heldUpTo', 'movedStock', line.trim().replace(/^const missedSomething = /, 'return ').replace(/;\s*$/, ';'));

test('the rule: a device that never pulled (marker 0) must fetch what the server already held', () => {
  assert.equal(rule({ prev: 1000 }, 0, false), true, 'never pulled + server had data -> pull');
  assert.equal(rule({ prev: 0 }, 0, false), false, 'brand-new shop, nothing to fetch');
  assert.equal(rule({ prev: 1000 }, 1000, false), false, 'nothing newer than what this device already held');
  assert.equal(rule({ prev: 2000 }, 1000, false), true, 'another device changed things in between');
});

test('two devices, real server: a new device that sells before its first pull still ends up with the other device\'s sales', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);
  const kv = makeKV(); seedShop(kv, 'C1'); const env = { mydukapos_kv: kv };
  const req = (method, body, q = '') => new Request('https://x.pages.dev/api/pos-sync?c=C1' + q, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
  const device = () => ({
    sales: [], marker: 0,
    async push() {
      const r = await (await m.onRequestPost({ request: req('POST', { businessName: 'Biz', updatedAt: Date.now(), salesLog: this.sales }), env, waitUntil() {} })).json();
      if (rule(r, this.marker, false)) await this.pull(); else this.marker = r.updatedAt;
    },
    async pull() {
      const d = await (await m.onRequestGet({ request: req('GET', null, this.marker > 0 ? '&since=' + this.marker : ''), env })).json();
      if (d.unchanged) return;
      if (d.updatedAt > this.marker) { const have = new Set(d.salesLog.map((s) => s.id)); this.sales = d.salesLog.concat(this.sales.filter((s) => !have.has(s.id))); this.marker = d.updatedAt; }
    },
  });
  const A = device(), B = device();
  A.sales.push({ id: 'A1', timestamp: new Date().toISOString(), items: [], total: 100 }); await A.push(); await wait();
  B.sales.push({ id: 'B1', timestamp: new Date().toISOString(), items: [], total: 200 }); await B.push(); await wait();
  for (let i = 0; i < 3; i++) { await A.pull(); await B.pull(); await wait(); }
  assert.deepEqual(A.sales.map((s) => s.id).sort(), ['A1', 'B1']);
  assert.deepEqual(B.sales.map((s) => s.id).sort(), ['A1', 'B1'], 'the new device sees the first device\'s sale');
});
