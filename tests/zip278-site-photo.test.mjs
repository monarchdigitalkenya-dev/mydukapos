import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeKV } from './kv-fake.mjs';
import * as oa from '../functions/api/_owner-auth.js';
import { onRequestGet as get, onRequestPost as post } from '../functions/api/site-photo.js';

// zip 278 - the portfolio portrait is changed from the Owner Console: owner only, real pictures only, built-in photo until one is saved.
const jpeg = fs.readFileSync(new URL('../public-site/img/samuel-mogue.jpg', import.meta.url));
const url = 'data:image/jpeg;base64,' + jpeg.toString('base64');
async function world() {
  const env = { mydukapos_kv: makeKV() };
  const acct = await oa.createOwnerAccount(env, 'o@example.com', 'Sup3r-secret-pw');
  const tok = await oa.createOwnerSession(env, acct);
  const P = (body, auth = true) => post({ env, request: new Request('https://x.pages.dev/api/site-photo', { method: 'POST', headers: auth ? { Authorization: 'Bearer ' + tok } : {}, body: JSON.stringify(body) }) });
  const G = (h) => get({ env, request: new Request('https://x.pages.dev/api/site-photo', { headers: h || {} }) });
  return { env, P, G };
}

test('built-in photo until one is saved; then the saved one; reset goes back', async () => {
  const w = await world();
  let r = await w.G(); assert.equal(r.status, 302); assert.equal(r.headers.get('Location'), '/img/samuel-mogue.jpg');
  assert.equal((await w.P({ dataUrl: url })).status, 200);
  r = await w.G(); assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  assert.equal((await w.G({ 'If-None-Match': r.headers.get('ETag') })).status, 304);
  assert.equal((await w.P({ action: 'reset' })).status, 200); assert.equal((await w.G()).status, 302);
});

test('only the owner can change it; only real, small pictures are accepted', async () => {
  const w = await world();
  assert.equal((await w.P({ dataUrl: url }, false)).status, 401);
  assert.equal((await w.P({ dataUrl: 'data:text/html;base64,PGI+' })).status, 400, 'not an image type');
  assert.equal((await w.P({ dataUrl: 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400, 'wrong magic bytes');
  assert.equal((await w.P({ dataUrl: 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500 * 1024)]).toString('base64') })).status, 413, 'too large');
  assert.equal((await w.G()).status, 302, 'nothing stored by the refusals');
});

test('the Owner Console has the picker, compresses on the device, and the portfolio reads the stored photo', () => {
  const o = fs.readFileSync(new URL('../owner/index.html', import.meta.url), 'utf8');
  assert.match(o, /id="pp-file"/); assert.match(o, /toDataURL\('image\/jpeg'/); assert.match(o, /\/api\/site-photo/);
  assert.match(fs.readFileSync(new URL('../public-site/portfolio.html', import.meta.url), 'utf8'), /id="portrait-img" src="\/api\/site-photo"/);
});
