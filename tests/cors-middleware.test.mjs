import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// Every /api endpoint that says "Access-Control-Allow-Origin: *" is narrowed to the shop's own domain family.
const mw = () => import(pathToFileURL(path.join(ROOT, 'functions/api/_middleware.js')).href);
const call = async (origin, next, env = { ROOT_DOMAIN: 'mydukapos.store' }) => {
  const { onRequest } = await mw();
  const headers = origin ? { Origin: origin } : {};
  return onRequest({ request: new Request('https://mydukapos.store/api/anything', { headers }), env, next });
};
const wildcard = () => new Response('{"ok":1}', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Content-Type': 'application/json' } });

test('a wildcard answer is narrowed to the shop\'s own domain family, for every endpoint', async () => {
  let r = await call('https://evil.example.com', async () => wildcard());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'another website gets nothing');
  assert.equal(r.headers.get('Access-Control-Allow-Methods'), null);
  assert.equal(await r.text(), '{"ok":1}', 'the body is untouched');
  r = await call('https://georgehardware.mydukapos.store', async () => wildcard());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://georgehardware.mydukapos.store');
  assert.match(r.headers.get('Vary'), /Origin/);
  r = await call('https://notmydukapos.store', async () => wildcard());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'suffix trick rejected');
  r = await call('http://localhost:8788', async () => wildcard());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8788');
});

test('server-to-server calls (webhooks) and endpoints without CORS headers are untouched, and WebSocket upgrades pass through', async () => {
  let r = await call(null, async () => wildcard());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'no Origin header (a webhook, curl) -> no CORS header needed');
  assert.equal(r.status, 200);
  const plain = new Response('x', { status: 201 });
  assert.equal(await call('https://evil.example.com', async () => plain), plain, 'nothing to rewrite -> the same response object');
  const ws = { status: 101, headers: new Headers({ 'Access-Control-Allow-Origin': '*' }), webSocket: {} };
  assert.equal(await call('https://evil.example.com', async () => ws), ws);
});
