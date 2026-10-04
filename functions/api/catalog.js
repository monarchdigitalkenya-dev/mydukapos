// functions/api/catalog.js — the public website's product catalogue (zip 204). Products, categories, offers and complete systems are DATA the
// owner manages from the Owner Console (Catalogue tab); nothing about them is hard-coded in the pages.
//
//   GET  /api/catalog                 public -> { ok, now, configured, categories, products, systems }  (published only; prices, offer state,
//                                     discount, savings and system "individual value" are computed here against the SERVER clock). Cached 30 s.
//   GET  /api/catalog?img=<id>        public -> the picture (immutable, cacheable; used in <img>)
//   POST { action: 'list' }           owner  -> everything incl. drafts (+ now)
//   POST { action: 'saveCategory', category }       / 'deleteCategory' {id} / 'reorderCategories' {ids}
//   POST { action: 'saveProduct', product }         / 'patchProduct' {id, patch} / 'deleteProduct' {id} / 'reorderProducts' {ids}
//   POST { action: 'saveSystem', system }           / 'patchSystem' {id, patch}  / 'deleteSystem' {id}  / 'reorderSystems' {ids}
//   POST { action: 'uploadImage', dataUrl }         -> { id, url }   / 'deleteImage' {id}
//   POST { action: 'import', categories, products } -> adds starter items (skips names that already exist)
//
// Money is whole Kenya shillings. price === null means "Get a quote". A system REFERENCES products by id (it never copies them), so a change
// to a product's price changes the system's individual value and the saving shown. Times are epoch ms; the console enters them as Nairobi time.
import { requireOwnerAuth } from './_owner-auth.js';
import { MEDIA_ID_RE, mediaKey, mediaPut, mediaOpen, mediaDelete, decodeImageDataUrl } from './_media.js';

const KEY = 'catalog:v1';
const MAX_PRODUCTS = 2000, MAX_SYSTEMS = 300, MAX_CATEGORIES = 120, MAX_IMAGE_BYTES = 900 * 1024;
const STOCK = ['in', 'low', 'out', 'order'];
const KINDS = ['pos', 'printer', 'label', 'scanner', 'monitor', 'laptop', 'desktop', 'drawer', 'router', 'display', 'accessory', 'keyboard', 'mouse', 'ups', 'bundle', 'bundle2', 'bundle3'];
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (b, s = 200, extra = {}) => new Response(JSON.stringify(b), { status: s, headers: { ...H, ...extra } });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const para = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null; };
const ms = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
function uniqueSlug(base, taken) { let s = base, i = 2; while (taken.has(s)) s = base + '-' + i++; return s; }

export const emptyCatalog = () => ({ rev: 0, categories: [], products: [], systems: [] });
// A missing key is an empty catalogue; a read or parse that FAILS throws, so a write can never replace a real catalogue with an empty one.
async function loadStrict(env) { const r = await env.mydukapos_kv.get(KEY); if (r == null) return null; const c = JSON.parse(r); if (!c || !Array.isArray(c.products)) throw new Error('catalogue unreadable'); return { ...emptyCatalog(), ...c }; }
async function load(env) { try { return await loadStrict(env); } catch (e) { return null; } }
const MAX_BYTES = 20 * 1024 * 1024;       // Workers KV values stop at 25 MiB
async function store(env, c) {
  c.rev = (c.rev || 0) + 1; c.updatedAt = Date.now(); c.configured = true;
  const body = JSON.stringify(c);
  if (body.length > MAX_BYTES) { const e = new Error('The catalogue is too large to save. Remove some long descriptions or products.'); e.status = 413; throw e; }
  await env.mydukapos_kv.put(KEY, body);
}

// ---- the money rules (one place; the pages only display what this says) ----
export function offerActive(x, now) {
  return !!(x.onOffer && x.price > 0 && x.offerPrice > 0 && x.offerPrice < x.price && (!x.offerStart || now >= x.offerStart) && (!x.offerEnd || now < x.offerEnd));
}
export function priceView(x, now) {
  const on = offerActive(x, now);
  const price = x.price > 0 ? x.price : null;
  const eff = on ? x.offerPrice : price;
  const out = { price, eff, onOffer: on, offerEnd: on ? (x.offerEnd || 0) : 0, discount: 0, pct: 0, was: null };
  if (on) { out.discount = x.price - x.offerPrice; out.pct = Math.round((out.discount / x.price) * 100); out.was = x.price; }
  else if (price && x.prevPrice > price) { out.was = x.prevPrice; out.discount = x.prevPrice - price; out.pct = Math.round((out.discount / x.prevPrice) * 100); }
  return out;
}
export function systemView(s, byId, now) {
  const base = priceView(s, now);
  let value = 0, complete = s.components.length > 0;
  const comps = s.components.map((c) => {
    const p = byId.get(c.productId); const pv = p ? priceView(p, now) : null;
    const unit = pv && pv.eff ? pv.eff : null;
    if (unit) value += unit * c.qty; else complete = false;
    return { id: c.productId, qty: c.qty, name: p ? p.name : 'Unavailable item', unit, image: p && p.images && p.images[0] || '', kind: p ? p.kind : 'accessory' };
  });
  const saving = complete && base.eff && value > base.eff ? value - base.eff : 0;
  return { ...base, components: comps, individualValue: complete ? value : null, saving, savingPct: saving ? Math.round((saving / value) * 100) : 0 };
}

// ---- cleaning what the owner sends ----
function cleanSpecs(a) { return (Array.isArray(a) ? a : []).slice(0, 40).map((r) => ({ k: txt(r && r.k, 60), v: txt(r && r.v, 200) })).filter((r) => r.k && r.v); }
function cleanIds(a, max) { return [...new Set((Array.isArray(a) ? a : []).map(String).filter((i) => MEDIA_ID_RE.test(i)))].slice(0, max); }
function cleanOffer(x) { return { onOffer: !!x.onOffer, offerPrice: money(x.offerPrice), offerStart: ms(x.offerStart), offerEnd: ms(x.offerEnd) }; }
function checkOffer(o, price) {
  if (!o.onOffer) return '';
  if (!price) return 'An offer needs a regular price first.';
  if (!o.offerPrice) return 'Give the offer price.';
  if (o.offerPrice >= price) return 'The offer price must be lower than the regular price.';
  if (o.offerStart && o.offerEnd && o.offerEnd <= o.offerStart) return 'The offer must end after it starts.';
  return '';
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const img = u.searchParams.get('img');
  if (img !== null) {
    if (!MEDIA_ID_RE.test(img)) return json({ error: 'Not found.' }, 404);
    const inm = request.headers.get('If-None-Match') || '';
    const f = await mediaOpen(env, mediaKey('site', 'c', img), { ifNoneMatch: inm });
    if (!f) return json({ error: 'Not found.' }, 404);
    const h = { 'Cache-Control': 'public, max-age=31536000, immutable', ...(f.etag ? { ETag: f.etag } : {}) };
    if (f.notModified) return new Response(null, { status: 304, headers: h });
    return new Response(f.body, { status: 200, headers: { ...h, 'Content-Type': f.type, ...(f.size != null ? { 'Content-Length': String(f.size) } : {}) } });
  }
  const now = Date.now();
  const c = await load(env);
  if (!c || (!c.configured && !c.products.length && !c.systems.length && !c.categories.length)) return json({ ok: true, now, configured: false, categories: [], products: [], systems: [] }, 200, { 'Cache-Control': 'public, max-age=30' });
  return json(publicView(c, now), 200, { 'Cache-Control': 'public, max-age=30' });
}

export function publicView(c, now) {
  const live = new Set(c.products.filter((p) => p.published).map((p) => p.id));
  const byId = new Map(c.products.filter((p) => p.published).map((p) => [p.id, p]));      // a hidden product's name and price never reach the public list
  const products = c.products.filter((p) => p.published).map((p, i) => ({
    id: p.id, slug: p.slug, name: p.name, sku: p.sku, cat: p.categoryId, kind: p.kind, stock: p.stock, blurb: p.blurb, description: p.description,
    specs: p.specs, images: p.images, featured: !!p.featured, related: (p.related || []).filter((r) => live.has(r)), createdAt: p.createdAt, pos: i, ...priceView(p, now),
  }));
  const systems = c.systems.filter((s) => s.published).map((s, i) => ({
    id: s.id, slug: s.slug, name: s.name, cat: s.categoryId, kind: s.kind || 'bundle', stock: s.stock, blurb: s.blurb, description: s.description, specs: s.specs,
    images: s.images, featured: !!s.featured, createdAt: s.createdAt, pos: i, ...systemView(s, byId, now),
  }));
  const usedP = new Set(products.map((p) => p.cat)), usedS = new Set(systems.map((s) => s.cat));
  const categories = c.categories.filter((k) => (k.scope === 'system' ? usedS : usedP).has(k.id)).map((k) => ({ id: k.id, name: k.name, slug: k.slug, scope: k.scope }));
  return { ok: true, now, configured: true, rev: c.rev || 0, categories, products, systems };
}

export async function onRequestPost(context) {
  try { return await handlePost(context); }
  catch (e) { return json({ error: e && e.status ? e.message : 'The catalogue could not be saved just now. Nothing was changed. Try again.' }, e && e.status ? e.status : 500); }
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
async function handlePost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Sign in as the owner.' }, 401);
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  if (!isObj(b)) return json({ error: 'Invalid request.' }, 400);
  const now = Date.now();
  let c; try { c = (await loadStrict(env)) || emptyCatalog(); } catch (e) { return json({ error: 'The catalogue could not be read just now, so nothing was changed. Try again in a moment.' }, 503); }
  const act = b.action;
  const mutating = act !== 'list' && act !== 'uploadImage' && act !== 'deleteImage';
  // Two windows (or a double tap) must not overwrite each other: the page sends the revision it was looking at.
  if (mutating && b.baseRev != null && Number(b.baseRev) !== (c.rev || 0)) return json({ error: 'The catalogue was changed in another window. It has been reloaded - please redo that change.', stale: true, ...{ ok: false, now, rev: c.rev, categories: c.categories, products: c.products, systems: c.systems } }, 409);
  const view = () => ({ ok: true, now, rev: c.rev, categories: c.categories, products: c.products, systems: c.systems });
  const dropped = [];                                           // pictures to remove AFTER the catalogue is safely saved
  const refd = (id) => c.products.some((p) => (p.images || []).includes(id)) || c.systems.some((s) => (s.images || []).includes(id));
  const done = async () => {
    await store(env, c);
    for (const im of dropped) if (!refd(im)) await mediaDelete(env, mediaKey('site', 'c', im)).catch(() => {});
    return json(view());
  };
  const fail = (m, s = 400) => json({ error: m }, s);

  if (act === 'list') return json(view());

  // ---------- categories ----------
  if (act === 'saveCategory') {
    const x = isObj(b.category) ? b.category : {}; const name = txt(x.name, 60);
    if (!name) return fail('Give the category a name.');
    const i = x.id ? c.categories.findIndex((k) => k.id === x.id) : -1;
    if (x.id && i < 0) return fail('Category not found.', 404);
    const scope = i >= 0 ? c.categories[i].scope : (x.scope === 'system' ? 'system' : 'product');      // a category keeps its kind once created
    if (i < 0 && c.categories.length >= MAX_CATEGORIES) return fail('That is the maximum number of categories.');
    if (c.categories.some((k, j) => j !== i && k.scope === scope && k.name.toLowerCase() === name.toLowerCase())) return fail('There is already a category with that name.');
    if (i >= 0) c.categories[i] = { ...c.categories[i], name, scope };
    else c.categories.push({ id: newId(), name, scope, slug: uniqueSlug(slugify(name), new Set(c.categories.map((k) => k.slug))) });
    return done();
  }
  if (act === 'deleteCategory') {
    if (!c.categories.some((k) => k.id === b.id)) return fail('Category not found.', 404);
    c.categories = c.categories.filter((k) => k.id !== b.id);
    c.products.forEach((p) => { if (p.categoryId === b.id) p.categoryId = ''; });
    c.systems.forEach((s) => { if (s.categoryId === b.id) s.categoryId = ''; });
    return done();
  }
  const reorder = (list, ids) => { const pos = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i])); return list.map((x, i) => [x, pos.has(x.id) ? pos.get(x.id) : 1e6 + i]).sort((p, q) => p[1] - q[1]).map((p) => p[0]); };
  if (act === 'reorderCategories') { c.categories = reorder(c.categories, b.ids); return done(); }
  if (act === 'reorderProducts') { c.products = reorder(c.products, b.ids); return done(); }
  if (act === 'reorderSystems') { c.systems = reorder(c.systems, b.ids); return done(); }

  // ---------- products ----------
  const common = (x, prev, scope) => {
    const name = txt(x.name, 120); if (!name) return { error: 'Give it a name.' };
    const price = money(x.price);
    const offer = cleanOffer(x); const oe = checkOffer(offer, price); if (oe) return { error: oe };
    const prevPrice = money(x.prevPrice);
    if (prevPrice && price && prevPrice <= price) return { error: 'The previous price must be higher than the price (or leave it empty).' };
    const categoryId = c.categories.some((k) => k.id === x.categoryId && k.scope === scope) ? x.categoryId : '';
    return { rec: {
      name, price, prevPrice: prevPrice || null, ...offer, categoryId, sku: txt(x.sku, 60), kind: KINDS.includes(x.kind) ? x.kind : (prev && prev.kind) || 'accessory',
      stock: STOCK.includes(x.stock) ? x.stock : 'in', blurb: txt(x.blurb, 200), description: para(x.description, 4000), specs: cleanSpecs(x.specs),
      images: cleanIds(x.images, 12), featured: !!x.featured, published: x.published !== false,
    } };
  };
  if (act === 'saveProduct') {
    const x = isObj(b.product) ? b.product : {}; const i = x.id ? c.products.findIndex((p) => p.id === x.id) : -1;
    if (x.id && i < 0) return fail('Product not found.', 404);
    if (i < 0 && c.products.length >= MAX_PRODUCTS) return fail('That is the maximum number of products.');
    const r = common(x, i >= 0 ? c.products[i] : null, 'product'); if (r.error) return fail(r.error);
    const taken = new Set(c.products.filter((_, j) => j !== i).map((p) => p.slug));
    const related = cleanIds(x.related, 12).filter((id) => id !== x.id && c.products.some((p) => p.id === id));
    if (i >= 0) {
      const old = c.products[i];
      c.products[i] = { ...old, ...r.rec, related, slug: old.slug, updatedAt: now };      // the address never changes after creation, so links already shared keep working
      for (const im of old.images || []) if (!c.products[i].images.includes(im)) dropped.push(im);
    } else c.products.push({ id: newId(), slug: uniqueSlug(slugify(r.rec.name), taken), related, createdAt: now, updatedAt: now, ...r.rec });
    return done();
  }
  if (act === 'patchProduct') {
    const i = c.products.findIndex((p) => p.id === b.id); if (i < 0) return fail('Product not found.', 404);
    const p = c.products[i], q = isObj(b.patch) ? b.patch : {};
    const next = { ...p };
    if ('published' in q) next.published = !!q.published;
    if ('featured' in q) next.featured = !!q.featured;
    if ('stock' in q && STOCK.includes(q.stock)) next.stock = q.stock;
    if ('onOffer' in q) { next.onOffer = !!q.onOffer; const e = checkOffer(next, next.price); if (e) return fail(e); }
    c.products[i] = { ...next, updatedAt: now }; return done();
  }
  if (act === 'deleteProduct') {
    const i = c.products.findIndex((p) => p.id === b.id); if (i < 0) return fail('Product not found.', 404);
    const users = c.systems.filter((s) => s.components.some((k) => k.productId === b.id));
    if (users.length) return fail('This product is a part of the system' + (users.length > 1 ? 's' : '') + ' ' + users.map((s) => '"' + s.name + '"').join(', ') + '. Remove it from there first, or hide the product instead.', 409);
    const gone = c.products[i]; c.products.splice(i, 1);
    c.products.forEach((p) => { p.related = (p.related || []).filter((r) => r !== b.id); });
    for (const im of gone.images || []) dropped.push(im);
    return done();
  }

  // ---------- systems (bundles that REFERENCE products) ----------
  const cleanComps = (a) => {
    const seen = new Set(), out = [];
    for (const k of (Array.isArray(a) ? a : []).slice(0, 30)) {
      const id = String(k && k.productId || ''); const q = Math.max(1, Math.min(99, Math.round(Number(k && k.qty) || 1)));
      if (!c.products.some((p) => p.id === id) || seen.has(id)) continue; seen.add(id); out.push({ productId: id, qty: q });
    }
    return out;
  };
  if (act === 'saveSystem') {
    const x = isObj(b.system) ? b.system : {}; const i = x.id ? c.systems.findIndex((s) => s.id === x.id) : -1;
    if (x.id && i < 0) return fail('System not found.', 404);
    if (i < 0 && c.systems.length >= MAX_SYSTEMS) return fail('That is the maximum number of systems.');
    const r = common({ ...x, prevPrice: null }, i >= 0 ? c.systems[i] : null, 'system'); if (r.error) return fail(r.error);
    const components = cleanComps(x.components); if (!components.length) return fail('Add at least one product to the system.');
    const taken = new Set(c.systems.filter((_, j) => j !== i).map((s) => s.slug));
    const rec = { ...r.rec, components, kind: KINDS.includes(x.kind) ? x.kind : 'bundle' }; delete rec.prevPrice;
    if (i >= 0) {
      const old = c.systems[i]; c.systems[i] = { ...old, ...rec, slug: old.slug, updatedAt: now };
      for (const im of old.images || []) if (!c.systems[i].images.includes(im)) dropped.push(im);
    }
    else c.systems.push({ id: newId(), slug: uniqueSlug(slugify(rec.name), taken), createdAt: now, updatedAt: now, ...rec });
    return done();
  }
  if (act === 'patchSystem') {
    const i = c.systems.findIndex((s) => s.id === b.id); if (i < 0) return fail('System not found.', 404);
    const q = isObj(b.patch) ? b.patch : {}, next = { ...c.systems[i] };
    if ('published' in q) next.published = !!q.published;
    if ('featured' in q) next.featured = !!q.featured;
    if ('onOffer' in q) { next.onOffer = !!q.onOffer; const e = checkOffer(next, next.price); if (e) return fail(e); }
    c.systems[i] = { ...next, updatedAt: now }; return done();
  }
  if (act === 'deleteSystem') {
    const i = c.systems.findIndex((s) => s.id === b.id); if (i < 0) return fail('System not found.', 404);
    const gone = c.systems[i]; c.systems.splice(i, 1);
    for (const im of gone.images || []) dropped.push(im);
    return done();
  }

  // ---------- pictures ----------
  if (act === 'uploadImage') {
    const dataUrl = String(b.dataUrl || '');
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) return fail('That picture is too large. Use one under 900 KB.', 413);
    const img = decodeImageDataUrl(dataUrl);
    if (!img) return fail('Use a JPEG, PNG or WebP picture.');
    if (img.bytes.length > MAX_IMAGE_BYTES) return fail('That picture is too large. Use one under 900 KB.', 413);
    const id = newId() + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    await mediaPut(env, mediaKey('site', 'c', id), img.bytes, img.type, { at: now });
    return json({ ok: true, id, url: '/api/catalog?img=' + id });
  }
  if (act === 'deleteImage') {
    if (!MEDIA_ID_RE.test(String(b.id || ''))) return fail('Give the picture id.');
    if (c.products.some((p) => (p.images || []).includes(b.id)) || c.systems.some((s) => (s.images || []).includes(b.id))) return fail('That picture is still used by an item. Remove it from the item first.');
    await mediaDelete(env, mediaKey('site', 'c', b.id)).catch(() => {});
    return json({ ok: true });
  }

  // ---------- starter import ----------
  if (act === 'import') {
    const cats = (Array.isArray(b.categories) ? b.categories : []).filter(isObj), items = (Array.isArray(b.products) ? b.products : []).filter(isObj);
    const idByKey = new Map();
    for (const k of cats.slice(0, 40)) {
      const name = txt(k.label || k.name, 60); if (!name) continue;
      let ex = c.categories.find((z) => z.scope === 'product' && z.name.toLowerCase() === name.toLowerCase());
      if (!ex && c.categories.length < MAX_CATEGORIES) { ex = { id: newId(), name, scope: 'product', slug: uniqueSlug(slugify(name), new Set(c.categories.map((z) => z.slug))) }; c.categories.push(ex); }
      if (ex) idByKey.set(k.key, ex.id);
    }
    let added = 0; const names = new Set(c.products.map((p) => p.name.toLowerCase()));
    for (const x of items.slice(0, 200)) {
      const name = txt(x.name, 120); if (!name || names.has(name.toLowerCase()) || c.products.length >= MAX_PRODUCTS) continue;
      names.add(name.toLowerCase());
      const specs = (Array.isArray(x.points) ? x.points : []).slice(0, 10).map((v) => ({ k: 'Includes', v: txt(v, 200) })).filter((r) => r.v);
      c.products.push({ id: newId(), slug: uniqueSlug(slugify(name), new Set(c.products.map((p) => p.slug))), createdAt: now, updatedAt: now, name, price: money(x.price), prevPrice: null,
        onOffer: false, offerPrice: null, offerStart: 0, offerEnd: 0, categoryId: idByKey.get(x.cat) || '', sku: '', kind: KINDS.includes(x.kind) ? x.kind : 'accessory', stock: 'in',
        blurb: txt(x.blurb, 200), description: para(x.blurb, 4000), specs, images: [], featured: !!x.badge, published: true, related: [] });
      added++;
    }
    await store(env, c);
    return json({ ...view(), added });
  }

  return fail('Unknown action.');
}
