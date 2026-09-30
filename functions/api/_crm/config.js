// functions/api/_crm/config.js — statuses / classifications / sources / lost reasons, products, settings (NOT a route).
import { E, json, all, first, st, many, now, newId, text, slug, auditSt, arr, money, oneOf, jparse } from './core.js';
import { cached, invalidate } from './cache.js';
import { listProducts } from '../_license.js';

const KINDS = { statuses: 'crm_statuses', classifications: 'crm_classifications', sources: 'crm_sources', 'lost-reasons': 'crm_lost_reasons', lostReasons: 'crm_lost_reasons' };
const cfgOut = (r) => ({ id: r.id, key: r.key, label: r.label, color: r.color, position: r.position, active: !!r.active, isSystem: !!r.is_system, ...('is_won' in r ? { isWon: !!r.is_won, isLost: !!r.is_lost } : {}) });
export const productOut = (r) => ({ id: r.id, key: r.key, label: r.label, description: r.description, price: r.price, licenseProduct: r.license_product, active: !!r.active, position: r.position });

// zip 161: the five config lists are ONE round trip (they were five), and are kept in the instance's memory for a short time (cache.js). Every write below drops the entry.
const CFG_TABLES = ['crm_statuses', 'crm_classifications', 'crm_sources', 'crm_lost_reasons'];
export const configStatements = (db, includeInactive) => {
  const w = includeInactive ? '' : 'WHERE active = 1';
  return [...CFG_TABLES.map((t) => st(db, `SELECT * FROM ${t} ${w} ORDER BY position, key`)), st(db, `SELECT * FROM crm_products ${w} ORDER BY position, label`)];
};
export const configFromRows = (r) => ({ statuses: r[0].map(cfgOut), classifications: r[1].map(cfgOut), sources: r[2].map(cfgOut), lostReasons: r[3].map(cfgOut), products: r[4].map(productOut) });
export async function getConfig(db, { all: includeInactive = true } = {}) {
  return cached(db, includeInactive ? 'cfg:all' : 'cfg:active', async () => configFromRows(await many(db, configStatements(db, includeInactive))));
}
export async function configRoute(ctx) { return getConfig(ctx.db); }

export async function putConfig(ctx) {
  const { db, actor, params } = ctx;
  actor.require('settings.statuses', 'settings.manage');
  const table = KINDS[params.kind];
  if (!table) throw E.notFound('unknown config list', 'unknown_kind');
  const body = await ctx.json();
  const items = arr(body.items, 100);
  if (!items.length) throw E.bad('items is required', 'invalid_items');
  const isStatus = table === 'crm_statuses';
  const existing = await all(db, `SELECT * FROM ${table}`);
  const byId = new Map(existing.map((r) => [r.id, r])), byKey = new Map(existing.map((r) => [r.key, r]));
  const usedKeys = new Set(existing.map((r) => r.key));
  const t = now(), stmts = [], seen = new Set();
  let pos = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') throw E.bad('each item must be an object', 'invalid_items');
    const label = text(it.label, 60);
    if (!label) throw E.bad('each item needs a label', 'invalid_items');
    const color = it.color == null || it.color === '' ? null : (/^#[0-9a-fA-F]{6}$/.test(it.color) ? it.color : (() => { throw E.bad('color must look like #aabbcc', 'invalid_color'); })());
    const active = it.active === false || it.active === 0 ? 0 : 1;
    const won = isStatus && it.isWon ? 1 : 0, lost = isStatus && it.isLost ? 1 : 0;
    if (won && lost) throw E.bad('a status cannot be both won and lost', 'invalid_items');
    const cur = (it.id && byId.get(it.id)) || (it.key && byKey.get(it.key)) || null;
    if (seen.has(cur ? cur.id : null) && cur) throw E.bad('an item is listed twice', 'invalid_items');
    if (cur) {
      seen.add(cur.id);
      if (cur.is_system && !active) throw E.bad(`"${cur.label}" is built in and cannot be deactivated`, 'system_item');
      if (isStatus && cur.is_system && (won !== cur.is_won || lost !== cur.is_lost) && ('isWon' in it || 'isLost' in it)) throw E.bad(`"${cur.label}" is built in: its won/lost meaning cannot change`, 'system_item');
      const next = { label, color, active, position: pos, ...(isStatus ? { is_won: cur.is_system ? cur.is_won : won, is_lost: cur.is_system ? cur.is_lost : lost } : {}) };
      const prev = { label: cur.label, color: cur.color, active: cur.active, position: cur.position, ...(isStatus ? { is_won: cur.is_won, is_lost: cur.is_lost } : {}) };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        stmts.push(st(db, `UPDATE ${table} SET label = ?, color = ?, active = ?, position = ?, ${isStatus ? 'is_won = ?, is_lost = ?, ' : ''}updated_at = ? WHERE id = ?`, label, color, active, pos, ...(isStatus ? [next.is_won, next.is_lost] : []), t, cur.id));
        stmts.push(auditSt(db, actor, 'config_update', 'config:' + params.kind, cur.key, prev, next, t));
      }
    } else {
      let key = it.key ? String(it.key) : slug(label);
      if (!/^[a-z0-9_]{2,40}$/.test(key)) key = slug(label) || 'item';
      let k = key, n = 2; while (usedKeys.has(k)) k = `${key}_${n++}`;
      usedKeys.add(k);
      const id = 'cfg_' + newId().slice(0, 12);
      stmts.push(st(db, `INSERT INTO ${table} (id, key, label, color, position, active, is_system, ${isStatus ? 'is_won, is_lost, ' : ''}created_at, updated_at) VALUES (?,?,?,?,?,?,0,${isStatus ? '?,?,' : ''}?,?)`, id, k, label, color, pos, active, ...(isStatus ? [won, lost] : []), t, t));
      stmts.push(auditSt(db, actor, 'config_create', 'config:' + params.kind, k, null, { label, color, active, position: pos, ...(isStatus ? { is_won: won, is_lost: lost } : {}) }, t));
    }
    pos++;
  }
  for (const r of existing.filter((r) => !seen.has(r.id)).sort((a, b) => a.position - b.position)) {   // not mentioned: keep, after the listed ones
    if (r.position !== pos) stmts.push(st(db, `UPDATE ${table} SET position = ?, updated_at = ? WHERE id = ?`, pos, t, r.id));
    pos++;
  }
  if (stmts.length) { await db.batch(stmts); invalidate(db, 'cfg:'); }
  return getConfig(db).then((c) => ({ items: c[params.kind === 'lost-reasons' || params.kind === 'lostReasons' ? 'lostReasons' : params.kind] }));
}

// ---------- products ----------
export async function listProductsRoute(ctx) {
  const rows = await all(ctx.db, `SELECT * FROM crm_products ${ctx.actor.has('settings.products') ? '' : 'WHERE active = 1'} ORDER BY position, label`);
  return { items: rows.map(productOut) };
}
function productFields(b, partial) {
  const o = {};
  if (!partial || 'label' in b) { o.label = text(b.label, 80); if (!o.label) throw E.bad('label is required', 'invalid_label'); }
  if ('description' in b) o.description = text(b.description, 500);
  if ('price' in b) o.price = b.price == null || b.price === '' ? null : money(b.price, 'price');
  if ('licenseProduct' in b) {
    if (b.licenseProduct == null || b.licenseProduct === '') o.license_product = null;
    else { if (!listProducts().some((p) => p.id === b.licenseProduct)) throw E.bad('licenseProduct is not a MyDuka product', 'invalid_license_product'); o.license_product = b.licenseProduct; }
  }
  if ('active' in b) o.active = b.active ? 1 : 0;
  return o;
}
export async function createProduct(ctx) {
  const { db, actor } = ctx; actor.require('settings.products');
  const b = await ctx.json(); const f = productFields(b, false);
  let key = /^[a-z0-9_]{2,40}$/.test(b.key || '') ? b.key : slug(f.label) || 'product';
  let k = key, n = 2; while (await first(db, `SELECT 1 FROM crm_products WHERE key = ?`, k)) k = `${key}_${n++}`;
  const t = now(), id = 'pr_' + newId().slice(0, 12);
  const pos = ((await first(db, `SELECT MAX(position) m FROM crm_products`)) || {}).m;
  await db.batch([
    st(db, `INSERT INTO crm_products (id, key, label, description, price, license_product, active, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, id, k, f.label, f.description ?? null, f.price ?? null, f.license_product ?? null, f.active ?? 1, (pos == null ? -1 : pos) + 1, t, t),
    auditSt(db, actor, 'product_create', 'product', id, null, { key: k, ...f }, t),
  ]);
  invalidate(db, 'cfg:');
  return json({ product: productOut(await first(db, `SELECT * FROM crm_products WHERE id = ?`, id)) }, 201);
}
export async function patchProduct(ctx) {
  const { db, actor, params } = ctx; actor.require('settings.products');
  const cur = await first(db, `SELECT * FROM crm_products WHERE id = ?`, params.id);
  if (!cur) throw E.notFound('product not found');
  const f = productFields(await ctx.json(), true);
  const keys = Object.keys(f);
  if (!keys.length) throw E.bad('nothing to change', 'no_changes');
  const prev = {}; keys.forEach((k) => { prev[k] = cur[k]; });
  const t = now();
  await db.batch([
    st(db, `UPDATE crm_products SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), t, cur.id),
    auditSt(db, actor, 'product_update', 'product', cur.id, prev, f, t),
  ]);
  invalidate(db, 'cfg:');
  return { product: productOut(await first(db, `SELECT * FROM crm_products WHERE id = ?`, cur.id)) };
}

// ---------- settings (non-secret) ----------
const SETTING_DEFS = {
  companyName: { dflt: '', check: (v) => text(v, 80) || '' },
  currency: { dflt: 'KES', check: (v) => { const s = text(v, 3); if (!s || !/^[A-Za-z]{3}$/.test(s)) throw E.bad('currency must be a 3-letter code', 'invalid_setting'); return s.toUpperCase(); } },
  defaultDuplicatePolicy: { dflt: 'skip', check: (v) => oneOf(v, ['skip', 'update', 'create'], 'defaultDuplicatePolicy') },
  defaultRemindMinutes: { dflt: 15, check: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 10080) throw E.bad('defaultRemindMinutes must be 0-10080', 'invalid_setting'); return n; } },
  autoUnassignedLeadMinutes: { dflt: 30, check: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 10080) throw E.bad('autoUnassignedLeadMinutes must be 0-10080 (0 switches it off)', 'invalid_setting'); return n; } },   // zip 158: Automation rules (automation.js)
  autoFollowupOverdueMinutes: { dflt: 15, check: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 10080) throw E.bad('autoFollowupOverdueMinutes must be 0-10080 (0 switches it off)', 'invalid_setting'); return n; } },
  firstContactTargetMinutes: { dflt: 30, check: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 10080) throw E.bad('firstContactTargetMinutes must be 1-10080', 'invalid_setting'); return n; } },
};
export async function readSettings(db) {
  return cached(db, 'settings', async () => {
    const rows = await all(db, `SELECT k, v FROM crm_settings`);
    const out = {}; for (const [k, d] of Object.entries(SETTING_DEFS)) out[k] = d.dflt;
    for (const r of rows) if (r.k in SETTING_DEFS) out[r.k] = jparse(r.v, SETTING_DEFS[r.k].dflt);
    return out;
  });
}
export const integrationStatus = (env) => ({
  whatsappInbound: !!(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN),
  whatsappApi: !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
  metaWebhook: !!(env.META_APP_SECRET || env.WHATSAPP_APP_SECRET),
  metaGraph: !!env.META_PAGE_TOKEN,
});
export async function getSettings(ctx) {
  const out = { settings: await readSettings(ctx.db) };
  if (ctx.actor.has('settings.manage') || ctx.actor.has('settings.integrations')) out.integrations = integrationStatus(ctx.env);
  return out;
}
export async function putSettings(ctx) {
  const { db, actor } = ctx; actor.require('settings.manage');
  const b = await ctx.json(); invalidate(db, 'settings'); const cur = await readSettings(db);       // a write always compares with the database, never with the memory
  const next = {}, prev = {}, stmts = [], t = now();
  for (const [k, v] of Object.entries(b.settings && typeof b.settings === 'object' ? b.settings : b)) {
    if (!(k in SETTING_DEFS)) continue;
    const val = SETTING_DEFS[k].check(v);
    if (JSON.stringify(val) === JSON.stringify(cur[k])) continue;
    prev[k] = cur[k]; next[k] = val;
    stmts.push(st(db, `INSERT INTO crm_settings (k, v, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, k, JSON.stringify(val), t, actor.id));
  }
  if (stmts.length) { stmts.push(auditSt(db, actor, 'settings_update', 'settings', null, prev, next, t)); await db.batch(stmts); invalidate(db, 'settings'); }
  return { settings: await readSettings(db) };
}
