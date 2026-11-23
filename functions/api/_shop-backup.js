// functions/api/_shop-backup.js — shared helper, NOT a route. zip 259: PERMANENT SHOPS BACKUP & RESTORE (the logic behind owner-backup.js).
//
// WHAT A PERMANENT SHOP IS MADE OF (checked in the code, not assumed):
//   KV   license:<id> (the link record) + slug:<slug> (subdomain -> id) + the licence index (rebuilt by saveLicense) + every key that names the shop
//        (pos-data:state:<id> and its archives, pos-data:mode:<id>, receipts, QR menus, till / M-PESA records, staff & branch data, ledger outbox ...)
//   D1   LEDGER_DB tables with a client_id column (sales, payments, bills, returns, stock, orders, payroll, lpg, till ...) and
//        LEDGER_AUDIT_DB (append-only audit)
//   DO   "database" shops keep their working state in the ShopStore Durable Object (router Worker), not in KV
//   R2   pictures (shop/<id>/<kind>/<file>) in the MEDIA bucket (or in KV on a deployment without R2)
//   KV   the website sign-in account of each shop owner (demo-account:<email>: salt + password HASH; sessions are separate keys and not exported)
//
// SECRETS (zip 267, optional, only into a passphrase-protected package): each shop's payment-gateway, SMS, SHA, eTIMS and image-search credentials, its callback keys
// (so payment addresses already given to Safaricom / Paywave keep working), device pairing and staff signing keys. The gateway and SMS records are sealed in KV with this
// deployment's PAYMENT_SECRETS_KEY, so they are exported OPENED (the console then locks the whole package with the owner's passphrase) and SEALED AGAIN with the target
// deployment's key on restore: a restore into a deployment with a different key still works.
// PLATFORM BILLING (zip 267, optional): the Billing settings, discounts and their use counts, and the owner's payment ledger / audit trail / payment markers. A restore never
// overwrites what the target already has. The referral-code index is rebuilt from each shop's own record.
//
// NEVER EXPORTED (sessions and caches, and the platform owner's own sign-in): staff and website sessions, owner sessions and the owner account, OTPs, pairing codes,
// rate-limit counters, tokens, daily KV snapshot copies. They are listed (counted) in the package so nothing is silently missing.
//
// Every operation here is STATELESS and bounded (one page / one batch per call) so a large shop never has to fit in one request; the
// owner console drives the loop and assembles the package in the browser.
import { listClientSummaries, getLicense, saveLicense, claimSlug, productPath, clientLink, getRootDomain, shopDbAnswers, getBranchGroupMembers } from './_license.js';
import { openRecord, sealRecord } from './_secret-box.js';
import { shopMode, shopCall, MODE_PREFIX, forgetShopMode } from './_state-store.js';
import { getOwnerAccount } from './_owner-auth.js';
import { readIndex as readAccountIndex, getAccount, saveAccount } from './_account.js';
import { mediaPut, mediaBackend } from './_media.js';
import { ensureLedgerSchema } from './_ledger.js';
import { ensureAuditSchema } from './_audit-db.js';
import { ensurePayrollSchema } from './_payroll.js';
import { ensureEfficiencySchema } from './_write-fence.js';
import { ensureTillSchema } from './_till-store.js';

export const BACKUP_FORMAT = 'mydukapos-permanent-shops-backup';
export const BACKUP_VERSION = 1;
export const RESPONSE_BYTES = 3 * 1024 * 1024;     // one reply carries at most about this much
export const ROW_PAGE = 400;

// KV keys that are never exported (prefix match). Secrets, sessions, caches and rebuildable copies.
export const DENY_PREFIXES = [
  'license:', 'license-gone', 'license-index', 'slug:',                    // rebuilt from the shop record on restore
  'gateway-config:', 'sms-config:', 'sha-config:', 'sha-token:', 'etims-config:', 'email-config', 'payment-accounts:', 'image-search-config:', 'gemini', 'whatsapp',
  'callback-key:', 'device-auth:', 'pair-code:', 'staff-sess:', 'staff-key:', 'staff-auth-mode:', 'ai-capture-shop-config:', 'demo-account-session:', 'owner-', 'otp:', 'token:',
  'rl:', 'rl185:', 'public-demo-rate:', 'print-relay-devices:', 'barcode-cache:', 'till-purge:', 'till-payment-rejected:',
  'pos-data:backup:', 'pos-data:sizealert:', 'pay-change-log:',
];
export const denied = (key) => DENY_PREFIXES.some((p) => key.startsWith(p));

// The per-shop secrets that can travel (a subset of DENY_PREFIXES; sessions, OTPs, pairing codes and caches never do).
export const SECRET_PREFIXES = ['gateway-config:', 'sms-config:', 'sha-config:', 'sha-token:', 'etims-config:', 'payment-accounts:', 'image-search-config:', 'callback-key:', 'device-auth:', 'staff-key:', 'staff-auth-mode:', 'ai-capture-shop-config:'];
export const isSecretKey = (key) => SECRET_PREFIXES.some((p) => String(key).startsWith(p));
// Platform billing keys (not tied to one shop). Restored only where the target has nothing yet.
export const PLATFORM_PREFIXES = ['billing-settings:', 'billing-offers:', 'billing-offer-used:', 'bill-evt:', 'bill-aud:', 'bill-ref:', 'bill-pay:', 'bill-pay-index:'];
// Platform-wide settings of the whole deployment (website text, catalogue, app releases, messages ...). Plain; put only where the target has nothing yet.
export const PLATFORM_SETTING_KEYS = ['website-content', 'website-marketing', 'catalog:v1', 'offers:v1', 'app-releases:v1', 'config:demo-duration-hours', 'storage_settings', 'owner-messages:v1', 'leads-whatsapp-ad-numbers', 'buy-index:v1'];
// Platform-wide secrets (Gemini key pool, e-mail sender): exported ONLY into a passphrase-locked package.
export const PLATFORM_SECRET_KEYS = ['gemini-capture-config:v1', 'email-config:v1'];
export const isPlatformKey = (key) => PLATFORM_PREFIXES.concat(PLATFORM_SETTING_KEYS, PLATFORM_SECRET_KEYS).some((p) => String(key).startsWith(p));
const SEALED_KINDS = { 'gateway-config:': { kind: 'gateway', aad: (id) => 'gateway|' + id }, 'sms-config:': { kind: 'sms', aad: (id) => 'sms|' + id } };
const sealedKind = (key) => { const p = Object.keys(SEALED_KINDS).find((x) => String(key).startsWith(x)); return p ? SEALED_KINDS[p] : null; };
const lastSegment = (key) => keySegments(key).pop();
const SHOP_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const keySegments = (key) => String(key).split(/[:/]/);
export function shopOfKey(key, idSet) { for (const s of keySegments(key)) if (idSet.has(s)) return s; return ''; }

const dbs = (env) => ({ ledger: env.LEDGER_DB || env.DB || null, audit: env.LEDGER_AUDIT_DB || null });
const json = (o) => o;
const b64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (t) => { const bin = atob(t); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const safeIdent = (s) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(s || ''));

// ---------------------------------------------------------------- EXPORT
export async function exportShops(env, { offset = 0, limit = 100 }) {
  const all = (await listClientSummaries(env)).filter((e) => e.type === 'permanent' && !e.deleted).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const owner = await getOwnerAccount(env).catch(() => null);
  const slice = all.slice(offset, offset + limit), shops = [], errors = [];
  for (const s of slice) {
    try {
      const rec = await getLicense(env, s.id);
      if (!rec) { errors.push({ shop: s.id, error: 'listed in the index but its record is missing' }); continue; }
      shops.push({ id: rec.id, slug: rec.slug || '', product: rec.product, label: rec.label || '', path: productPath(rec.product), link: clientLink(env, rec, ''), mode: await shopMode(env, rec.id), ownerConsoleShop: !!(owner && owner.ownerClientId === rec.id), record: rec });
    } catch (e) { errors.push({ shop: s.id, error: String((e && e.message) || e).slice(0, 160) }); }
  }
  return { ok: true, total: all.length, offset, shops, errors };
}

export async function exportSchema(env) {
  const out = { ok: true, resources: { kv: !!env.mydukapos_kv, ledger: !!dbs(env).ledger, audit: !!dbs(env).audit, shopStore: !!env.SHOP_STORE, media: mediaBackend(env) }, tables: [], notPerShop: [], rootDomain: getRootDomain(env) };
  for (const [name, db] of Object.entries(dbs(env))) {
    if (!db) continue;
    const { results } = await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name`).all();
    for (const t of results || []) {
      const cols = (await db.prepare(`PRAGMA table_info(${t.name})`).all()).results || [];
      const key = cols.some((c) => c.name === 'client_id') ? 'client_id' : (cols.some((c) => c.name === 'group_id') ? 'group_id' : '');       // zip 269: the branch-group store (store_items, store_movements) is keyed by group_id
      if (!key) { out.notPerShop.push({ db: name, table: t.name }); continue; }
      const idx = (await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).bind(t.name).all()).results || [];
      const fk = ((await db.prepare(`PRAGMA foreign_key_list(${t.name})`).all()).results || []).map((f) => f.table);
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      out.tables.push({ db: name, name: t.name, key, ddl: [t.sql].concat(idx.map((i) => i.sql)), cols: cols.map((c) => c.name), pk, fk });
    }
  }
  return out;
}

export async function exportKvScan(env, { cursor, ids }) {
  const idSet = new Set((ids || []).filter((i) => SHOP_ID_RE.test(i)));
  const page = await env.mydukapos_kv.list({ cursor: cursor || undefined, limit: 1000 });
  const keys = [], excluded = {};
  for (const k of page.keys) {
    const shop = shopOfKey(k.name, idSet);
    if (!shop) continue;
    if (denied(k.name)) { const p = DENY_PREFIXES.find((x) => k.name.startsWith(x)); excluded[p] = (excluded[p] || 0) + 1; continue; }
    keys.push({ k: k.name, shop });
  }
  return { ok: true, keys, excluded, cursor: page.list_complete ? '' : page.cursor, done: !!page.list_complete };
}

// The secret keys of the given shops (names only; the values come from exportSecretGet).
export async function exportSecretScan(env, { cursor, ids }) {
  const idSet = new Set((ids || []).filter((i) => SHOP_ID_RE.test(i)));
  const page = await env.mydukapos_kv.list({ cursor: cursor || undefined, limit: 1000 });
  const keys = [];
  for (const k of page.keys) { if (!isSecretKey(k.name)) continue; const shop = shopOfKey(k.name, idSet); if (shop) keys.push({ k: k.name, shop }); }
  return { ok: true, keys, cursor: page.list_complete ? '' : page.cursor, done: !!page.list_complete };
}
// The values, with the gateway and SMS records OPENED (plain JSON) so they can be sealed again with the target's key. A record that cannot be opened here (the key it was sealed with is
// gone) is exported as stored and flagged: it only works where that same key is set.
export async function exportSecretGet(env, { keys }) {
  const items = [];
  for (const key of (keys || []).slice(0, 60)) {
    if (!isSecretKey(key)) continue;
    const raw = await env.mydukapos_kv.get(key);
    if (raw == null) continue;
    const sk = sealedKind(key);
    if (sk) {
      const id = lastSegment(key), r = await openRecord(env, sk.aad(id), raw);
      if (r.ok) { items.push({ key, kind: sk.kind, value: JSON.stringify(r.value) }); continue; }
      items.push({ key, kind: 'raw', value: raw, unreadable: true }); continue;
    }
    items.push({ key, kind: 'raw', value: raw });
  }
  return { ok: true, items };
}
// Platform billing data, one bounded page per call: { p: index of the prefix, cursor } in, the next position out.
export async function exportPlatform(env, { p = 0, cursor, secrets }) {
  const items = []; let bytes = 0;
  const prefixes = PLATFORM_PREFIXES.concat(PLATFORM_SETTING_KEYS, secrets ? PLATFORM_SECRET_KEYS : []);
  while (p < prefixes.length) {
    const page = await env.mydukapos_kv.list({ prefix: prefixes[p], cursor: cursor || undefined, limit: 200 });
    for (const k of page.keys) {
      const v = await env.mydukapos_kv.get(k.name); if (v == null) continue;
      items.push({ key: k.name, value: v }); bytes += v.length;
    }
    if (page.list_complete) { p++; cursor = ''; } else cursor = page.cursor;
    if (bytes >= RESPONSE_BYTES / 2) break;
  }
  return { ok: true, items, p, cursor: cursor || '', done: p >= prefixes.length };
}

export async function exportKvGet(env, { keys }) {
  const items = []; let bytes = 0, i = 0;
  for (; i < keys.length && bytes < RESPONSE_BYTES; i++) {
    const key = String(keys[i]);
    if (denied(key)) continue;
    const binary = key.startsWith('shop/');
    const r = await env.mydukapos_kv.getWithMetadata(key, binary ? 'arrayBuffer' : 'text');
    if (r.value == null) { items.push({ key, missing: true }); continue; }
    const value = binary ? b64(r.value) : r.value;
    bytes += value.length;
    items.push({ key, value, enc: binary ? 'b64' : 'text', metadata: r.metadata == null ? undefined : r.metadata });
  }
  return { ok: true, items, rest: keys.slice(i) };
}

export async function exportRows(env, { db: dbName, table, shop, after, cols, pk, col }) {
  const db = dbs(env)[dbName];
  if (!db || !safeIdent(table) || !SHOP_ID_RE.test(shop)) return { ok: false, error: 'bad request' };
  const order = (pk && pk.length ? pk : ['rowid']).filter((c) => c === 'rowid' || safeIdent(c));
  const tuple = order.join(', ');
  const keyCol = col === 'group_id' ? 'group_id' : 'client_id';
  let sql = `SELECT ${order[0] === 'rowid' ? 'rowid AS _rid, ' : ''}* FROM ${table} WHERE ${keyCol} = ?`;
  const args = [shop];
  if (after && after.length) { sql += ` AND (${tuple}) > (${after.map(() => '?').join(', ')})`; args.push(...after); }
  sql += ` ORDER BY ${tuple} LIMIT ${ROW_PAGE}`;
  const { results } = await db.prepare(sql).bind(...args).all();
  const rows = results || [];
  const last = rows.length ? order.map((c) => rows[rows.length - 1][c === 'rowid' ? '_rid' : c]) : null;
  const clean = rows.map((r) => { const o = { ...r }; delete o._rid; return o; });
  return { ok: true, rows: clean, after: last, done: rows.length < ROW_PAGE };
}

export async function exportDoSlice(env, { shop, offset = 0, limit = 1024 * 1024 }) {
  if (!env.SHOP_STORE) return { ok: false, error: 'This deployment has no shop database (SHOP_STORE).' };
  const res = await shopCall(env, shop, 'export', {});
  if (!res.ok) return { ok: false, error: 'The shop database answered ' + res.status };
  const text = await res.text();
  return { ok: true, total: text.length, text: text.slice(offset, offset + limit), done: offset + limit >= text.length };
}

export async function exportMediaList(env, { shop, cursor }) {
  if (!SHOP_ID_RE.test(shop)) return { ok: false, error: 'bad request' };
  if (env.MEDIA && typeof env.MEDIA.list === 'function') {
    const r = await env.MEDIA.list({ prefix: `shop/${shop}/`, cursor: cursor || undefined, limit: 500 });
    return { ok: true, backend: 'r2', objects: r.objects.map((o) => ({ key: o.key, size: o.size, type: (o.httpMetadata && o.httpMetadata.contentType) || '' })), cursor: r.truncated ? r.cursor : '', done: !r.truncated };
  }
  return { ok: true, backend: 'kv', objects: [], cursor: '', done: true };     // KV-fallback pictures are ordinary shop/<id>/... KV keys: they travel with the KV keys
}
export async function exportMediaGet(env, { keys, shop }) {
  const items = []; let bytes = 0, i = 0;
  for (; i < keys.length && bytes < RESPONSE_BYTES; i++) {
    const key = String(keys[i]);
    if (!key.startsWith(`shop/${shop}/`)) continue;
    const o = await env.MEDIA.get(key);
    if (!o) { items.push({ key, missing: true }); continue; }
    const buf = await o.arrayBuffer(); const v = b64(buf); bytes += v.length;
    items.push({ key, b64: v, type: (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg', meta: o.customMetadata && Object.keys(o.customMetadata).length ? o.customMetadata : undefined });
  }
  return { ok: true, items, rest: keys.slice(i) };
}

export async function exportAccounts(env, { ids }) {
  const idSet = new Set(ids || []), idx = await readAccountIndex(env), accounts = [];
  for (const e of idx) {
    if (!e.demoClientId || !idSet.has(e.demoClientId)) continue;
    const a = await getAccount(env, e.email);
    if (a) accounts.push({ shop: e.demoClientId, account: a });
  }
  return { ok: true, accounts };
}
// zip 269: the e-mail + password record a shop's recovery pointer names (account-recovery-client:<id> -> e-mail -> account-recovery-account:<e-mail>). The pointer travels with the shop's keys; the record
// itself has no shop id in its key, so it is fetched through the pointer. It holds a salt and a password HASH (never a password), like the website account.
const RECOVERY_ACCOUNT = 'account-recovery-account:';
export async function exportRecovery(env, { ids }) {
  const items = [];
  for (const id of (ids || []).filter((i) => SHOP_ID_RE.test(i)).slice(0, 200)) {
    const email = await env.mydukapos_kv.get('account-recovery-client:' + id);
    if (!email || /[\s]/.test(email) || email.length > 200) continue;
    const v = await env.mydukapos_kv.get(RECOVERY_ACCOUNT + email);
    if (v != null) items.push({ shop: id, key: RECOVERY_ACCOUNT + email, value: v });
  }
  return { ok: true, items };
}
export async function restoreRecovery(env, { items }) {
  let put = 0, kept = 0;
  for (const it of items || []) {
    const key = String(it.key || '');
    if (!key.startsWith(RECOVERY_ACCOUNT) || key.length > 260) continue;
    if ((await env.mydukapos_kv.get(key)) != null) { kept++; continue; }          // never replace a record this deployment already has
    await env.mydukapos_kv.put(key, String(it.value)); put++;
  }
  return { ok: true, put, kept };
}
export async function exportBranchGroups(env, { groups }) {
  const out = [];
  for (const g of groups || []) { const m = await getBranchGroupMembers(env, g); out.push({ key: 'branch-group:' + g, value: JSON.stringify(m || []) }); }
  return { ok: true, groups: out };
}

// ---------------------------------------------------------------- RESTORE
export async function restoreCheck(env, { shops, tables, hasDo, hasMedia }) {
  const res = { kv: !!env.mydukapos_kv, ledger: !!dbs(env).ledger, audit: !!dbs(env).audit, shopStore: false, media: mediaBackend(env) };
  const blockers = [];
  if (!res.kv) blockers.push('KV namespace mydukapos_kv is not bound.');
  const usedDb = new Set((tables || []).map((t) => t.db));
  if (usedDb.has('ledger') && !res.ledger) blockers.push('The package has ledger data but LEDGER_DB (D1) is not bound.');
  if (usedDb.has('audit') && !res.audit) blockers.push('The package has audit data but LEDGER_AUDIT_DB (D1) is not bound.');
  if (hasDo) { res.shopStore = !!env.SHOP_STORE && (shops[0] ? await shopDbAnswers(env, 'restore-probe') : true); if (!res.shopStore) blockers.push('The package has database-mode shops but the shop database (SHOP_STORE / router Worker) is not reachable. Deploy the router Worker first.'); }
  if (hasMedia && res.media !== 'r2') blockers.push('The package has pictures but the MEDIA R2 bucket is not bound (they would be placed in KV instead).');
  const out = [], idx = await listClientSummaries(env), all = idx.concat(await listClientSummaries(env, { trashOnly: true }).catch(() => []));
  for (const s of shops || []) {
    const byId = all.find((e) => e.id === s.id), bySlug = s.slug ? all.find((e) => e.slug === s.slug) : null;
    let state = 'new', detail = '';
    if (byId) {
      if (byId.slug === s.slug && byId.type === 'permanent' && !byId.deleted) { state = 'exists'; detail = 'Already restored here (same id and subdomain). Restoring again only adds what is missing.'; }
      else { state = 'conflict'; detail = `This id already exists here as "${byId.label || byId.slug}" (${byId.type}${byId.deleted ? ', in Trash' : ''}).`; }
    } else if (bySlug) { state = 'conflict'; detail = `The subdomain "${s.slug}" is already used here by another shop ("${bySlug.label || bySlug.id}").`; }
    else if (s.slug && (await env.mydukapos_kv.get('slug:' + s.slug))) { state = 'conflict'; detail = `The subdomain "${s.slug}" is already claimed here.`; }
    out.push({ id: s.id, slug: s.slug, state, detail });
  }
  return { ok: true, resources: res, blockers, shops: out };
}

export async function restoreShop(env, { record, resolution }) {
  if (!record || !SHOP_ID_RE.test(record.id) || record.type !== 'permanent') return { ok: false, error: 'Not a permanent shop record.' };
  const cur = await getLicense(env, record.id);
  const slugOwner = record.slug ? await env.mydukapos_kv.get('slug:' + record.slug) : null;
  const clash = (cur && cur.slug !== record.slug) || (slugOwner && slugOwner !== record.id) || (cur && cur.type !== 'permanent');
  if (clash && resolution !== 'overwrite') return { ok: false, conflict: true, error: 'Conflicts with a shop already in this deployment.' };
  if (cur && !clash) { /* same shop restored again: keep what is newer, do not regress the record */ if ((cur.updatedAt || 0) > (record.updatedAt || 0) && resolution !== 'overwrite') return { ok: true, kept: true }; }
  const rec = { ...record }; delete rec.deleted; delete rec.deletedAt;
  await saveLicense(env, rec);
  if (rec.slug) await claimSlug(env, rec.slug, rec.id);
  // the shop's referral code lives in its record; the code -> shop index is rebuilt from it so a shared referral link keeps working after a migration
  if (rec.billing && /^[A-Z0-9]{6,12}$/.test(String(rec.billing.refCode || ''))) await env.mydukapos_kv.put('bill-refcode:' + rec.billing.refCode, rec.id);
  return { ok: true };
}

export async function restoreKv(env, { items, ids }) {
  const idSet = new Set(ids || []); let put = 0; const errors = [];
  for (const it of items || []) {
    try {
      const key = String(it.key || '');
      if (!shopOfKey(key, idSet) || denied(key)) { errors.push({ key, error: 'not an allowed key for this package' }); continue; }
      const opts = it.metadata != null ? { metadata: it.metadata } : {};
      await env.mydukapos_kv.put(key, it.enc === 'b64' ? unb64(it.value) : String(it.value), opts);
      put++;
      if (key.startsWith(MODE_PREFIX)) forgetShopMode(env, key.slice(MODE_PREFIX.length));
    } catch (e) { errors.push({ key: it.key, error: String((e && e.message) || e).slice(0, 160) }); }
  }
  return { ok: !errors.length, put, errors };
}
// Secrets back where they belong: only for shops in the package, only the allowed key families. Gateway / SMS records are SEALED with THIS deployment's key.
export async function restoreSecrets(env, { items, ids }) {
  const idSet = new Set(ids || []); let put = 0, sealed = 0; const errors = [];
  for (const it of items || []) {
    try {
      const key = String(it.key || '');
      if (!isSecretKey(key) || !shopOfKey(key, idSet)) { errors.push({ key, error: 'not an allowed secret for this package' }); continue; }
      const sk = sealedKind(key);
      if (sk && it.kind === sk.kind) { await env.mydukapos_kv.put(key, await sealRecord(env, sk.aad(lastSegment(key)), JSON.parse(it.value))); sealed++; }
      else await env.mydukapos_kv.put(key, String(it.value));
      put++;
    } catch (e) { errors.push({ key: it.key, error: String((e && e.message) || e).slice(0, 160) }); }
  }
  return { ok: !errors.length, put, sealed, errors };
}
// Platform billing data: never over what the target already has (settings, discounts, ledger lines and markers are put only when absent; use counts keep the larger number).
export async function restorePlatform(env, { items }) {
  let put = 0, kept = 0; const errors = [];
  for (const it of items || []) {
    try {
      const key = String(it.key || '');
      if (!isPlatformKey(key)) { errors.push({ key, error: 'not an allowed key for this package' }); continue; }
      const have = await env.mydukapos_kv.get(key);
      if (key.startsWith('billing-offer-used:')) { if (Number(it.value) > (Number(have) || 0)) { await env.mydukapos_kv.put(key, String(Number(it.value) || 0)); put++; } else kept++; continue; }
      if (have != null) { kept++; continue; }
      await env.mydukapos_kv.put(key, String(it.value)); put++;
    } catch (e) { errors.push({ key: it.key, error: String((e && e.message) || e).slice(0, 160) }); }
  }
  return { ok: !errors.length, put, kept, errors };
}
export async function restoreBranchGroup(env, { key, value }) {
  if (!/^branch-group:[A-Za-z0-9_-]{4,60}$/.test(String(key))) return { ok: false, error: 'bad key' };
  const cur = await env.mydukapos_kv.get(key); let list = []; try { list = cur ? JSON.parse(cur) : []; } catch (e) { list = []; }
  const add = JSON.parse(value || '[]');
  await env.mydukapos_kv.put(key, JSON.stringify(Array.from(new Set(list.concat(add)))));
  return { ok: true };
}

// zip 269: while rows are restored the ledger's audit triggers are switched off (ledger_meta audit_disabled) - otherwise every restored record writes a fresh audit row that takes an id the
// restored audit history needs, and part of that history is silently dropped. r-schema returns what the switch was, r-finish puts it back.
async function metaGet(db, k) { try { const r = await db.prepare('SELECT v FROM ledger_meta WHERE k = ?').bind(k).first(); return r ? r.v : null; } catch (e) { return null; } }
async function metaSet(db, k, v) { if (v == null) await db.prepare('DELETE FROM ledger_meta WHERE k = ?').bind(k).run(); else await db.prepare('INSERT OR REPLACE INTO ledger_meta (k, v) VALUES (?, ?)').bind(k, String(v)).run(); }
export async function restoreFinish(env, { auditPrev }) {
  const d = dbs(env);
  if (d.ledger && auditPrev !== undefined) await metaSet(d.ledger, 'audit_disabled', auditPrev);
  return { ok: true };
}
export async function restoreSchema(env) {
  const d = dbs(env), done = [];
  const tryDo = async (name, fn) => { try { await fn(); done.push(name); } catch (e) { done.push(name + ' (skipped: ' + String((e && e.message) || e).slice(0, 80) + ')'); } };
  if (d.ledger) { await tryDo('ledger', () => ensureLedgerSchema(d.ledger)); await tryDo('payroll', () => ensurePayrollSchema(d.ledger)); await tryDo('efficiency', () => ensureEfficiencySchema(d.ledger)); await tryDo('till', () => ensureTillSchema(d.ledger)); }
  if (d.audit) await tryDo('audit', () => ensureAuditSchema(d.audit));
  let auditPrev = null;
  if (d.ledger) { try { auditPrev = await metaGet(d.ledger, 'audit_disabled'); await metaSet(d.ledger, 'audit_disabled', '1'); } catch (e) { done.push('audit switch (skipped: ' + String((e && e.message) || e).slice(0, 60) + ')'); } }
  return { ok: true, done, auditPrev };
}

const DDL_OK = /^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s/i;
export async function restoreRows(env, { db: dbName, table, ddl, rows, ids, col }) {
  const db = dbs(env)[dbName];
  if (!db || !safeIdent(table)) return { ok: false, error: 'bad request' };
  const idSet = new Set(ids || []);
  for (const s of ddl || []) { if (!DDL_OK.test(s)) continue; try { await db.prepare(String(s).replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX))\s+(?!IF\s+NOT\s+EXISTS)/i, '$1 IF NOT EXISTS ')).run(); } catch (e) { /* already there */ } }
  const cols = ((await db.prepare(`PRAGMA table_info(${table})`).all()).results || []).map((c) => c.name);
  if (!cols.length) return { ok: false, error: `Table ${table} does not exist and could not be created.` };
  const keyCol = col === 'group_id' ? 'group_id' : 'client_id';
  const good = []; let skipped = 0;
  for (const r of rows || []) { if (!idSet.has(r[keyCol])) { skipped++; continue; } good.push(r); }
  let inserted = 0, ignored = 0, error = '';
  for (let i = 0; i < good.length; i += 25) {
    const part = good.slice(i, i + 25);
    const stmts = [db.prepare('PRAGMA defer_foreign_keys = on')];
    for (const r of part) {
      const use = Object.keys(r).filter((c) => cols.includes(c) && safeIdent(c));
      stmts.push(db.prepare(`INSERT OR IGNORE INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).bind(...use.map((c) => (r[c] === undefined ? null : r[c]))));
    }
    try { const res = await db.batch(stmts); for (const x of res.slice(1)) { if (x.meta && x.meta.changes) inserted += x.meta.changes; else ignored++; } }
    catch (e) {
      // zip 269: one refused row (a final payroll run on a RE-run: the table's trigger aborts the statement even under INSERT OR IGNORE) must not lose the other rows of the chunk: row by row,
      // a refusal because the row/run is already there counts as "already present"; anything else is a real error and stops here as before.
      let bad = '';
      for (const st of stmts.slice(1)) {
        try { const x = await st.run(); if (x.meta && x.meta.changes) inserted += x.meta.changes; else ignored++; }
        catch (e2) { const m = String((e2 && e2.message) || e2); if (/payroll_run_is_final|UNIQUE|already|constraint/i.test(m)) ignored++; else { bad = m.slice(0, 200); break; } }
      }
      if (bad) { error = bad; break; }
    }
  }
  return { ok: !error && !skipped, inserted, ignored, skipped, error: error || (skipped ? `${skipped} rows named a shop outside this package` : '') };
}

export async function restoreDo(env, { shop, text }) {
  if (!env.SHOP_STORE) return { ok: false, error: 'SHOP_STORE is not bound.' };
  let state; try { state = JSON.parse(text); } catch (e) { return { ok: false, error: 'The shop state in the package is not valid JSON.' }; }
  const parts = [], MAX = 600;
  const core = {};
  for (const [k, v] of Object.entries(state)) { if (Array.isArray(v) && v.length > MAX) for (let i = 0; i < v.length; i += MAX) parts.push({ [k]: v.slice(i, i + MAX) }); else core[k] = v; }
  parts.unshift(core);
  let n = 0;
  for (const p of parts) {
    const res = await shopCall(env, shop, 'import', { state: p });
    if (!res.ok) return { ok: false, error: 'The shop database refused part ' + (n + 1) + ' (' + res.status + ').', parts: n };
    n++;
  }
  return { ok: true, parts: n };
}

export async function restoreMedia(env, { items, shop }) {
  let put = 0; const errors = [];
  for (const it of items || []) {
    try {
      if (!String(it.key).startsWith(`shop/${shop}/`)) { errors.push({ key: it.key, error: 'wrong shop' }); continue; }
      await mediaPut(env, it.key, unb64(it.b64), it.type || 'image/jpeg', it.meta && typeof it.meta === 'object' ? it.meta : {}); put++;
    } catch (e) { errors.push({ key: it.key, error: String((e && e.message) || e).slice(0, 120) }); }
  }
  return { ok: !errors.length, put, errors };
}

export async function restoreAccounts(env, { accounts }) {
  let put = 0;
  for (const a of accounts || []) {
    const acc = a.account; if (!acc || !acc.email) continue;
    const cur = await getAccount(env, acc.email);
    if (cur && cur.demoClientId && cur.demoClientId !== acc.demoClientId) continue;          // never replace a different person's login
    await saveAccount(env, acc); put++;
  }
  return { ok: true, put };
}

export async function restoreVerify(env, { shop, keys, tables }) {
  const out = { ok: true, license: false, slug: false, kvMissing: 0, tables: {} };
  const rec = await getLicense(env, shop); out.license = !!rec && rec.type === 'permanent';
  out.slug = !!rec && (!rec.slug || (await env.mydukapos_kv.get('slug:' + rec.slug)) === shop);
  for (const k of (keys || []).slice(0, 400)) if ((await env.mydukapos_kv.get(k)) == null) out.kvMissing++;
  for (const t of tables || []) {
    const db = dbs(env)[t.db]; if (!db || !safeIdent(t.name)) { out.tables[t.name] = -1; continue; }
    const keyCol = t.col === 'group_id' ? 'group_id' : 'client_id';
    out.tables[t.name] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${keyCol} = ?`).bind(t.id || shop).first()).n;
  }
  return out;
}
