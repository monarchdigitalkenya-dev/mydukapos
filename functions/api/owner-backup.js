// functions/api/owner-backup.js — Cloudflare Pages Function. zip 259.
//
// PERMANENT SHOPS BACKUP & RESTORE for the platform owner console. Owner session only (requireOwnerAuth): a shop owner, a staff member or a
// shop link can never reach it. POST only; every reply is `no-store`; nothing in a request or reply is logged or cached by this code.
// Each call is one bounded step (a page of keys, a batch of rows ...) - the console drives the loop and builds / reads the package file in the
// browser, so a large deployment never has to fit in one request. The logic is in _shop-backup.js (read its header for what is / is not exported).
import { requireOwnerAuth } from './_owner-auth.js';
import * as B from './_shop-backup.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, private', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: HEADERS });

const OPS = {
  'x-shops': B.exportShops, 'x-schema': B.exportSchema, 'x-kv-scan': B.exportKvScan, 'x-kv-get': B.exportKvGet, 'x-rows': B.exportRows,
  'x-do': B.exportDoSlice, 'x-secret-scan': B.exportSecretScan, 'x-secret-get': B.exportSecretGet, 'x-platform': B.exportPlatform, 'x-media-list': B.exportMediaList, 'x-media-get': B.exportMediaGet, 'x-accounts': B.exportAccounts, 'x-branches': B.exportBranchGroups,
  'r-check': B.restoreCheck, 'r-schema': B.restoreSchema, 'r-shop': B.restoreShop, 'r-kv': B.restoreKv, 'r-branch': B.restoreBranchGroup, 'r-rows': B.restoreRows,
  'r-do': B.restoreDo, 'r-secrets': B.restoreSecrets, 'r-platform': B.restorePlatform, 'r-media': B.restoreMedia, 'r-accounts': B.restoreAccounts, 'r-verify': B.restoreVerify,
};

export async function onRequestOptions() { return new Response(null, { status: 204, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } }); }
export async function onRequestGet() { return reply({ error: 'Use the Owner Console.' }, 405); }

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return reply({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const fn = body && OPS[body.op];
  if (!fn) return reply({ error: 'Unknown step.' }, 400);
  try { return reply(await fn(env, body)); }
  catch (e) { return reply({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 500); }
}
