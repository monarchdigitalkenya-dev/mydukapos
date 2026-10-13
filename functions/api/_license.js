import { MODE_PREFIX, forgetShopMode } from './_state-store.js';
import { withRetry } from './_retry.js';
import { subscriptionState, readSettings as readBillingSettings, enforcementOn } from './_billing-core.js';   // zip 267: leaf module (no imports), so no cycle
import { mirrorClient, mirrorRemove } from './_owner-db.js';   // zip 187: best-effort OWNER_DB read model; KV below stays the source of truth
// functions/api/_license.js — shared helper, NOT a route.
//
// Every client link this master POS generates (demo or permanent) is backed
// by one record in KV, keyed by a short random token — that token is either
// resolved from the shop's own subdomain (georgehardware.mydukapos.store) or,
// for legacy links / the Owner Console / preview deployments, from the `c`
// query param, e.g. https://yoursite.pages.dev/?c=ab12cd34ef. See
// resolveClientId() below for exactly how that decision is made.
//
// STRICT, CLOCK-TAMPER-PROOF EXPIRY:
// expiresAt is a fixed millisecond timestamp computed with Date.now() on
// Cloudflare's edge server the moment the demo link is created — never from
// anything the browser sends. Every check of "is this still valid" (here,
// and in every other function that touches business data) re-reads Date.now()
// on the server and compares against that stored timestamp. A customer's PC
// clock, browser, or DevTools console has no way to influence this — the
// only two things that matter are what's stored in KV and the server's own
// clock.
//
// SCALING NOTE (see README-MASTER.md "Scaling past a few thousand clients"):
// listClients() used to fetch every single client's full record from KV on
// every load of the Licenses tab (one KV read per client). That's fine at
// dozens of clients but falls over well before 10,000 — Cloudflare Workers/
// Pages Functions cap how many subrequests one invocation can make, so a
// 10,000-client Promise.all(...) would simply fail. Instead, the index
// itself now stores a small SUMMARY object per client (id, slug, type,
// product, label, timestamps, locked/paymentClaimed flags) — everything the
// Licenses tab needs to render its list and evaluate each license's status
// — so listing clients is two KV reads total (the index, once), never N.
// Full per-client records are only fetched when something acts on ONE
// specific client (owner-lock, owner-confirm, license-claim-payment).

const LICENSE_PREFIX = 'license:';
const GONE_PREFIX = 'license-gone:';           // zip 245: tombstone of a permanently deleted link, by id
const GONE_SLUG_PREFIX = 'license-gone-slug:'; // ... and by subdomain label
const SLUG_PREFIX = 'slug:'; // slug:<slug> -> clientId, for O(1) subdomain resolution
const INDEX_KEY = 'license-index:v1'; // array of SUMMARY objects, not just ids — see note above

// ---------- HOT-PATH CACHE (zip 159) ----------
// Every request to every shop endpoint starts with "which shop is this, and is its licence valid": the slug lookup (subdomain -> id) and the licence record,
// read from KV — and, until zip 159, the licence record TWICE (once to check the slug's record exists, once again to evaluate it). A device polls every
// 7 s and re-checks its licence every 30 s, so that was 3-4 KV reads per request before any real work. Both lookups are kept for a few seconds in the
// memory of the Worker instance that made them (per instance, per KV binding; nothing shared, nothing persisted):
//   * the record is kept as its JSON text and parsed on every use, so a caller that changes the object it gets can never change the cache;
//   * every write this instance makes (saveLicense, createClient, claimSlug, permanent delete) updates or drops the entry at once, so an owner who
//     locks a link in the Owner Console sees it take effect on the very next request served by the same instance; another instance follows within
//     LICENSE_CACHE_MS (default 10 s) — inside the ~60 s that KV itself takes to spread a change to other locations, so nothing new is introduced;
//   * NOT-FOUND answers are never kept (a link created a moment ago must not read "not found" for 10 s);
//   * if KV briefly fails, the last known record (at most 10 minutes old) answers instead of an error: a storage hiccup must not lock a shop out.
// Writers that read a record in order to change it (owner-lock, owner-confirm ...) keep using getLicense(), which is never cached.
// LICENSE_CACHE_MS = 0 (environment variable) switches the cache off.
const LICENSE_CACHE_MS = 10000;
const LICENSE_STALE_OK_MS = 10 * 60000;
const LICENSE_CACHE_MAX = 2000;
const cacheHolders = new WeakMap();                                   // KV binding -> { lic: Map(id -> {at, text}), slug: Map(slug -> {at, id}) }
function cacheHolder(env) {
  const kv = env && env.mydukapos_kv;
  if (!kv || typeof kv !== 'object') return null;
  let h = cacheHolders.get(kv);
  if (!h) { h = { lic: new Map(), slug: new Map() }; cacheHolders.set(kv, h); }
  return h;
}
function cacheMs(env) {
  const n = env && env.LICENSE_CACHE_MS != null && env.LICENSE_CACHE_MS !== '' ? Number(env.LICENSE_CACHE_MS) : LICENSE_CACHE_MS;
  return Number.isFinite(n) && n >= 0 ? n : LICENSE_CACHE_MS;
}
function remember(map, key, val) { map.delete(key); map.set(key, val); if (map.size > LICENSE_CACHE_MAX) map.delete(map.keys().next().value); }
function rememberLicense(env, record) { const h = cacheHolder(env); if (h && record && record.id) remember(h.lic, record.id, { at: Date.now(), text: JSON.stringify(record) }); }
function rememberSlug(env, slug, id) { const h = cacheHolder(env); if (h && slug && id) remember(h.slug, String(slug).toLowerCase(), { at: Date.now(), id }); }
function forgetLicense(env, id, slug) { const h = cacheHolder(env); if (!h) return; if (id) h.lic.delete(id); if (slug) h.slug.delete(String(slug).toLowerCase()); }
// for tests and tools
export function clearLicenseCache(env) { const h = cacheHolder(env); if (h) { h.lic.clear(); h.slug.clear(); } }

// The licence record for the hot path (cached, see above). Same result as getLicense() otherwise.
export async function getLicenseCached(env, clientId) {
  if (!clientId) return null;
  const h = cacheHolder(env), ttl = cacheMs(env), now = Date.now();
  const hit = h && ttl > 0 ? h.lic.get(clientId) : null;
  if (hit && now - hit.at < ttl) return JSON.parse(hit.text);
  let raw;
  try { raw = await withRetry(() => env.mydukapos_kv.get(LICENSE_PREFIX + clientId), { tries: 2, baseMs: 30, env }); }
  catch (e) { if (hit && now - hit.at < LICENSE_STALE_OK_MS) return JSON.parse(hit.text); throw e; }
  if (h) { if (raw && ttl > 0) remember(h.lic, clientId, { at: now, text: raw }); else h.lic.delete(clientId); }
  return raw ? JSON.parse(raw) : null;
}
async function slugToIdCached(env, slug) {
  const key = String(slug || '').toLowerCase();
  if (!key) return null;
  const h = cacheHolder(env), ttl = cacheMs(env), now = Date.now();
  const hit = h && ttl > 0 ? h.slug.get(key) : null;
  if (hit && now - hit.at < ttl) return hit.id;
  let id;
  try { id = await withRetry(() => env.mydukapos_kv.get(SLUG_PREFIX + key), { tries: 2, baseMs: 30, env }); }
  catch (e) { if (hit && now - hit.at < LICENSE_STALE_OK_MS) return hit.id; throw e; }
  if (h) { if (id && ttl > 0) remember(h.slug, key, { at: now, id }); else h.slug.delete(key); }
  return id || null;
}

// ---------- DEMO DURATION (owner-configurable, one value shared everywhere) ----------
// Used to be a fixed 72h constant. Now a single owner-editable setting,
// stored in KV, that EVERY demo-duration mention in the whole system reads
// from — the Owner Console's "Generate Link" button/toast, the default
// "extend" bump (owner-lock.js), the public website's marketing copy
// (index.html/app.html, via website-content.js's public 'get' action), and
// the actual duration granted to a self-service account demo
// (demo-account.js). Changing it in Owner Console → 🌐 Public Website
// updates every one of those the moment it's saved — nothing here is
// cached beyond the single KV read each caller already does.
const DEMO_DURATION_CONFIG_KEY = 'config:demo-duration-hours';
const DEFAULT_DEMO_DURATION_HOURS = 72;
const MIN_DEMO_DURATION_HOURS = 1;
const MAX_DEMO_DURATION_HOURS = 24 * 90; // 90 days ceiling — a sane upper bound, not a hard business rule

export async function getDemoDurationHours(env) {
  const raw = await env.mydukapos_kv.get(DEMO_DURATION_CONFIG_KEY);
  const hours = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_DEMO_DURATION_HOURS;
  return hours;
}

export async function getDemoDurationMs(env) {
  return (await getDemoDurationHours(env)) * 60 * 60 * 1000;
}

export async function setDemoDurationHours(env, hours) {
  const n = parseFloat(hours);
  if (!Number.isFinite(n) || n < MIN_DEMO_DURATION_HOURS || n > MAX_DEMO_DURATION_HOURS) {
    throw new Error(`Enter a demo duration between ${MIN_DEMO_DURATION_HOURS} and ${MAX_DEMO_DURATION_HOURS} hours.`);
  }
  await env.mydukapos_kv.put(DEMO_DURATION_CONFIG_KEY, String(n));
  return n;
}

// Human-friendly rendering shared by every caller that shows this value as
// text (owner console button/toast, public site copy) — "72 hours" below a
// day, "3 days" for a whole number of days above that, "1.5 days" style
// fallback otherwise, so an odd value like 40 or 100 still reads sensibly
// instead of forcing every caller to invent its own formatting.
export function formatDemoDuration(hours) {
  const n = Number(hours) || 0;
  if (n < 24) return `${n % 1 === 0 ? n : n.toFixed(1)} hour${n === 1 ? '' : 's'}`;
  const days = n / 24;
  const daysRounded = Math.round(days * 10) / 10;
  return `${daysRounded % 1 === 0 ? daysRounded : daysRounded.toFixed(1)} day${daysRounded === 1 ? '' : 's'}`;
}

// The base domain clients' subdomains live under, e.g. "mydukapos.store" so
// a client's link is "https://<slug>.mydukapos.store/". Override per-
// environment by setting a ROOT_DOMAIN Cloudflare Pages env var (handy for
// staging domains) — this default is just a fallback.
const DEFAULT_ROOT_DOMAIN = 'mydukapos.store';

export function getRootDomain(env) {
  return ((env && env.ROOT_DOMAIN) || DEFAULT_ROOT_DOMAIN).toLowerCase().replace(/^\.+/, '');
}

// Registry of POS products this master deployment can issue links for. Each
// entry's `path` is where that product's front-end lives (a static folder
// alongside index.html — e.g. /hotel/index.html for the "hotel" product) —
// this is the ONLY place a new product needs to be registered for the
// Master dashboard to know it exists and build correct links for it. The
// product itself still needs its own front-end folder deployed; adding it
// here just makes the master admin dashboard and link-building aware of it.
export const PRODUCTS = {
  shop: { label: 'Shop POS', path: '/' },
  hotel: { label: 'Hotel/Restaurant/Bar POS', path: '/hotel/' },
  hospital: { label: 'Hospital Management', path: '/hospital/' },
  production: { label: 'Production POS', path: '/production/' },
  pharmacy: { label: 'Pharmacy POS', path: '/pharmacy/' },
  services: { label: 'Services POS (Bookings)', path: '/services/' },
  water: { label: 'Water Refill Station POS (AquaPOS)', path: '/water/' },
  chama: { label: 'Chama (savings group manager)', path: '/chama/' },
};
const DEFAULT_PRODUCT = 'shop';

// Services POS business types (SERVICES_ARCHITECTURE.md 5.1): the question asked at sign-up / when an owner generates a Services link. Keys are the
// engine's SVC_TYPE_ORDER; 'other' is also what anything unknown becomes. Keep in sync with SVC_TYPES in src/shared/blocks/svc-templates.html.
export const SVC_BUSINESS_TYPES = ['phone_repair', 'car_wash', 'garage', 'salon', 'barber', 'laundry', 'cleaning', 'electronics_repair', 'tailoring', 'other'];
// '' = not chosen (the app then asks the owner itself); a recognised key stays; any other non-empty text means 'other'.
export function normalizeSvcType(v) {
  if (typeof v !== 'string' || !v.trim()) return '';
  const k = v.trim().toLowerCase();
  return SVC_BUSINESS_TYPES.includes(k) ? k : 'other';
}

export function listProducts() {
  return Object.keys(PRODUCTS).map((key) => ({ id: key, ...PRODUCTS[key] }));
}

export function productPath(product) {
  return (PRODUCTS[product] || PRODUCTS[DEFAULT_PRODUCT]).path;
}

// Builds the public link for a client record: a subdomain when it has a
// slug, falling back to the old ?c= query-param form (used for the Owner
// Console's own record and anything created before slugs existed).
//
// A slugged link also carries ?c=<id> even though normal subdomain
// resolution never reads it — it's the belt-and-braces input
// resolveClientId() checks during the few seconds right after creation
// when the slug->id KV write may not have reached every edge location yet
// (see the comment there). Once the slug is resolving normally (almost
// always well under a minute), the param is simply unused dead weight in
// the URL — harmless either way, and never a way to reach a different
// client's subdomain since resolveClientId() checks it belongs to THIS slug.
export function clientLink(env, record, origin) {
  const path = productPath(record.product);
  if (record.slug) {
    return `https://${record.slug}.${getRootDomain(env)}${path}?c=${record.id}`;
  }
  return `${origin}${path}?c=${record.id}`;
}

export function randomToken(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous 0/O/1/l/i
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// Turns a free-text label ("George's Hardware!") into a DNS-safe subdomain
// piece ("georges-hardware"). Falls back to a short random slug if the label
// has no usable characters at all (e.g. it was empty, or pure emoji).
function slugify(label) {
  const base = String(label || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `shop-${randomToken(6)}`;
}

async function slugTaken(env, slug) {
  const existing = await env.mydukapos_kv.get(SLUG_PREFIX + slug);
  return !!existing;
}

// Finds a free, unique subdomain slug based on the label, appending -2, -3,
// etc. on collision. Reserves nothing by itself — call claimSlug() once the
// client record is actually being created.
// zip 185: names that would make a customer's shop look like the company's own site, mail host or sign-in page (www.<root>, owner.<root>, login.<root> ...).
// A new business asking for one gets the usual "-2" style suffix instead; existing slugs are never touched (this runs only when a link is created).
export const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'apps', 'admin', 'administrator', 'owner', 'crm', 'mail', 'webmail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'ftp', 'ns', 'ns1', 'ns2', 'mx',
  'login', 'signin', 'signup', 'register', 'account', 'accounts', 'dashboard', 'console', 'billing', 'pay', 'payments', 'secure', 'security', 'support', 'help', 'status', 'blog', 'docs', 'cdn',
  'static', 'assets', 'img', 'media', 'staging', 'stage', 'dev', 'beta', 'root', 'autodiscover', 'mydukapos', 'myduka', 'official', 'wildcard', 'router']);
// zip 263: a buyer types the web address they want. { ok:false, error } when it cannot be used at all; else { ok:true, slug, taken } where slug is the name itself
// when it is free, and otherwise name-1 (name-2 ... if that is taken too), which is what they are told before they pay.
export async function chooseSlug(env, wanted) {
  let base = String(wanted || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[./]/)[0]
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  if (base.length < 3) return { ok: false, error: 'Use at least 3 letters or numbers for your address.' };
  if (base === 'demo' || base.startsWith('demo-')) return { ok: false, error: 'An address cannot start with "demo-". Pick another.' };
  let slug = base, n = 1;
  while (RESERVED_SLUGS.has(slug) || await slugTaken(env, slug)) { slug = `${base}-${n}`; n += 1; }
  return { ok: true, slug, taken: slug !== base };
}
async function pickUniqueSlug(env, label) {
  const wanted = slugify(label);
  let candidate = wanted;
  let n = 2;
  while (RESERVED_SLUGS.has(candidate) || await slugTaken(env, candidate)) {
    candidate = `${wanted}-${n}`;
    n += 1;
  }
  return candidate;
}

// Branch-specific slug pattern: mainslug1, mainslug2, mainslug3... — no
// separate name typed by the client at all. Starts at 1 (not pickUniqueSlug's
// -2 collision-suffix pattern, which is for ordinary clients and leaves the
// first candidate bare) since every branch, including the first, gets a
// number here. Auto-advances past any slug that's somehow already taken —
// a prior branch, a coincidental match with an unrelated client, or (rare)
// a race with a concurrent request — same "keep trying the next one" logic
// as pickUniqueSlug, just with this numbering scheme instead.
export async function pickNextBranchSlug(env, mainSlug) {
  const base = slugify(mainSlug);
  let n = 1;
  let candidate = `${base}${n}`;
  while (await slugTaken(env, candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

export async function claimSlug(env, slug, clientId) {
  await env.mydukapos_kv.put(SLUG_PREFIX + slug, clientId);
  rememberSlug(env, slug, clientId);
}

export async function getLicenseBySlug(env, slug) {
  if (!slug) return null;
  const id = await env.mydukapos_kv.get(SLUG_PREFIX + slug.toLowerCase());
  if (!id) return null;
  return getLicense(env, id);
}

/* ---------- index (client summaries, used by the Licenses tab) ---------- */

async function readIndex(env) {
  const raw = await env.mydukapos_kv.get(INDEX_KEY);
  if (!raw) return [];
  const list = JSON.parse(raw);
  // Backward-compat: older deployments stored the index as a plain array of
  // id strings. Upgrade those entries to summary shape on the fly (they'll
  // be missing fields like slug/type until the record is next touched).
  return list.map((entry) => (typeof entry === 'string' ? { id: entry } : entry));
}

function summaryFromRecord(record) {
  return {
    id: record.id,
    slug: record.slug || '',
    deleted: !!record.deleted,
    deletedAt: record.deletedAt || null,
    type: record.type,
    product: record.product,
    label: record.label || '',
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    locked: !!record.locked,
    paymentClaimed: !!record.paymentClaimed,
    paymentClaimedAt: record.paymentClaimedAt || null,
    confirmedAt: record.confirmedAt || null,
    branchGroupId: record.branchGroupId || null,
    isMainBranch: !!record.isMainBranch,
    branchAllowance: record.branchAllowance || 0,
    branchAddonClaimed: !!record.branchAddonClaimed,
    clientName: record.clientName || '',
    preferredName: record.preferredName || '',
    notes: record.notes || '',
    phone: record.phone || '',
    email: record.email || '',
    source: record.source || 'owner',
    agreedAmount: record.agreedAmount || 0,
    paidAmount: record.paidAmount || 0,
    balanceOwed: record.balanceOwed || 0,
    // The owner's own income bookkeeping for this link (see owner-lock.js 'recordRevenue') and the last payment reminder sent to its admin.
    revenue: record.revenue || null,
    notice: record.notice ? { at: record.notice.at, ackAt: record.notice.ackAt || null } : null,
    // zip 267: the small part of a shop's subscription the owner's lists need (absent = the shop predates billing = exempt). The full record stays on the licence.
    billing: record.billing && record.billing.cohort ? { cohort: record.billing.cohort, paidThrough: record.billing.paidThrough || 0, price: record.billing.price || 0, graceDays: record.billing.graceDays, comped: !!record.billing.comped, exempt: !!record.billing.exempt, suspended: !!record.billing.suspended, claim: !!record.billing.claim } : null,
  };
}

async function upsertIndexSummary(env, record) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.id === record.id);
  const summary = summaryFromRecord(record);
  if (idx === -1) list.push(summary);
  else list[idx] = summary;
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
  await mirrorClient(env, summary);     // zip 187: after the KV write; best effort, never throws, no-op without OWNER_DB
}

// Call this after saveLicense() any time a change should be reflected in the
// Licenses tab's list (lock/unlock/extend, payment claimed, confirmed,
// slug/label changes). createClient() already does this for new records.
export const refreshIndexSummary = upsertIndexSummary;

// Lighter-weight than upsertIndexSummary — updates just the businessName
// field on a client's existing index entry, without needing the full
// license record (businessName lives in the client's synced POS state, a
// separate KV entry entirely — see pos-sync.js, which calls this). This is
// what lets Owner Console's Clients tab show the real business name a
// branch's own setup was given, instead of its auto-generated slug, without
// adding a per-client read to the list endpoint itself — the name is kept
// current on the index as it changes, not looked up fresh on every list load.
export async function updateIndexBusinessName(env, clientId, businessName) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.id === clientId);
  if (idx === -1) return; // client not in the index yet (shouldn't normally happen) — nothing to update
  if (list[idx].businessName === businessName) return; // unchanged — skip the write
  list[idx] = { ...list[idx], businessName };
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
  await mirrorClient(env, list[idx]);   // zip 187
}

// NOTE ON CONCURRENT WRITES: this read-modify-write on a single JSON blob is
// fine for the volume of admin actions (creating/locking/confirming links)
// even at thousands of clients, but Workers KV has no compare-and-swap, so
// two of these landing in the same instant can still clobber one another —
// the same risk existed in the old id-only index. If you're issuing many
// links concurrently (e.g. a bulk-import script), serialize those calls, or
// migrate this index to Cloudflare D1 (a real database, with proper
// transactions) once that becomes a real workload rather than an edge case.

export async function createClient(env, type, label, product, extra = {}) {
  // zip 267: a caller may fix the id (only a plain lower-case token). "Get my own link" derives it from the purchase, so two requests finishing the SAME payment at once write the
  // SAME record instead of two shops (KV has no compare-and-set). A record that already has that id is returned as it is, never overwritten.
  const fixedId = extra.id && /^[a-z0-9]{8,32}$/.test(String(extra.id)) ? String(extra.id) : '';
  if (fixedId) { const have = await getLicense(env, fixedId); if (have) return have; }
  const id = fixedId || randomToken(10);
  const now = Date.now();
  // zip 263: a caller may ask for an exact address (chooseSlug, used by Get my own link); it is used only if it is still free, else the usual pick
  const slug = extra.slug && !RESERVED_SLUGS.has(extra.slug) && !(await slugTaken(env, extra.slug)) ? extra.slug : await pickUniqueSlug(env, label);
  // Every caller gets the owner-configured demo window (default 72h — see
  // getDemoDurationHours above) unless it explicitly passes its own
  // extra.durationMs — nothing currently does, but the override stays
  // available for a future caller that genuinely needs a one-off duration.
  const durationMs = extra.durationMs || (await getDemoDurationMs(env));
  const record = {
    id,
    slug,
    type: type === 'permanent' ? 'permanent' : 'demo',
    product: PRODUCTS[product] ? product : DEFAULT_PRODUCT,
    // Services POS only: the business type chosen at sign-up / link generation (optional; the app pre-selects it, see license-status.js).
    svcType: product === 'services' ? normalizeSvcType(extra.svcType) : '',
    label: label || '',
    createdAt: now,
    expiresAt: type === 'permanent' ? null : now + durationMs,
    locked: false,
    paymentClaimed: false,
    paymentClaimedAt: null,
    confirmedAt: type === 'permanent' ? now : null,
    // Branch fields — see branches.js. Absent/null for an ordinary client
    // that isn't part of any branch group.
    branchGroupId: extra.branchGroupId || null,
    isMainBranch: !!extra.isMainBranch,
    // Tiered branch billing (spec: Base Tier KES 3,000 includes the shop +
    // 1 branch; each further branch is a KES 1,500 add-on). This count
    // lives on whichever record currently holds isMainBranch — see
    // getGroupMainRecord() below — and starts at 0 for a brand-new record;
    // owner-confirm.js sets it to 1 the moment the base tier is confirmed
    // permanent. A demo or not-yet-confirmed record has no allowance at
    // all, which is fine since branches.js already blocks demo accounts
    // from creating branches outright.
    branchAllowance: extra.branchAllowance || 0,
    branchAddonClaimed: false,
    branchAddonClaimedAt: null,
    // For the owner's own records — never shown to the client, never used
    // for the subdomain/slug (label still drives that). clientName is the
    // real person/business behind this link; preferredName is however they
    // actually like to be addressed, when that differs.
    clientName: extra.clientName || '',
    preferredName: extra.preferredName || '',
    // Free-text notes the owner can leave on a link — e.g. "paid via
    // M-Pesa", "prefers WhatsApp" — never shown to the client, editable
    // any time via owner-lock.js's 'edit' action.
    notes: extra.notes || '',
    // Optional — populated when a client is generated from a Lead Tracker
    // entry that had a phone number on file, or from a public-site/dashboard
    // self-signup (demo-account.js passes the account's own phone/email
    // through here). Never required; most clients created directly via
    // "Generate Link" won't have either unless the owner types them in.
    phone: extra.phone || '',
    email: extra.email || '',
    // Where this client link came from — 'signup' (account self-signup in demo-account.js), 'website' (the legacy
    // anonymous flow in public-demo.js),
    // 'lead' (closed out of the Owner Console's own Leads tracker, see
    // the old Leads tab's generateLink action), or 'owner' (typed directly into the
    // 🔗 Licenses tab's "Generate Demo Link", the default for everything
    // else). Purely informational — shown as a badge in the Demo/Permanent
    // Links lists so a website- or lead-sourced link is identifiable there.
    source: extra.source || 'owner',
    // Simple one-off billing record for what THIS client (the shop owner
    // using mydukapos, not one of their own customers) agreed to pay for
    // the service and how much of that has actually been paid — set when a
    // Leads-tab lead is closed (the old Leads tab) and editable afterwards from
    // either the Leads tab or this client's own detail view (owner-lock.js's
    // 'edit' action). balanceOwed is just agreedAmount minus paidAmount,
    // recomputed any time either changes — this IS the "bill" the owner
    // asked to track, no separate ledger needed.
    agreedAmount: extra.agreedAmount || 0,
    paidAmount: extra.paidAmount || 0,
    balanceOwed: Math.max(0, (extra.agreedAmount || 0) - (extra.paidAmount || 0)),
  };
  await env.mydukapos_kv.put(LICENSE_PREFIX + id, JSON.stringify(record));
  rememberLicense(env, record);
  await claimSlug(env, slug, id);
  await upsertIndexSummary(env, record);
  // A brand-new PERMANENT shop starts in its own database (no size ceiling, nothing archived away). Nothing is stored yet, so there is nothing to
  // import — just the flag. Skipped when the database is not set up on this project. Demo links stay single records until they are made permanent.
  // zip 147: ...and only when that database ANSWERS. The binding existing proves nothing: with the router Worker not deployed (or out of
  // date) every new permanent shop — the Owner Console's own included — was put on a database that could not be reached, and never synced.
  if (record.type === 'permanent' && env.SHOP_STORE && (await shopDbAnswers(env, record.id))) {
    try { await env.mydukapos_kv.put(MODE_PREFIX + record.id, 'do', { metadata: { at: Date.now(), records: 0, bytes: 0, auto: true } }); forgetShopMode(env, record.id); } catch (e) { /* stays a normal shop */ }
  }
  return record;
}

// Does this shop's database (the ShopStore Durable Object) really answer, with current code? (zip 147)
export async function shopDbAnswers(env, clientId) {
  try {
    const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(clientId));
    const res = await Promise.race([
      stub.fetch('https://shop-store/registry', { method: 'POST', body: '{}' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    return res.ok && String(res.headers.get('content-type') || '').includes('application/json');
  } catch (e) { return false; }
}

// ---------- BRANCH GROUPS ----------
// A branch group links a shop and its branches together — one flat list of
// client ids under a shared key, no hierarchy baked into the storage itself.
// "Which one is main" is just a per-client boolean flag (isMainBranch on the
// record above), reassignable at any time — the group membership list never
// needs to change when that flag moves.

const BRANCH_GROUP_PREFIX = 'branch-group:'; // branch-group:<groupId> -> array of client ids

export async function getBranchGroupMembers(env, groupId) {
  if (!groupId) return [];
  const raw = await env.mydukapos_kv.get(BRANCH_GROUP_PREFIX + groupId);
  return raw ? JSON.parse(raw) : [];
}

export async function addToBranchGroup(env, groupId, clientId) {
  const members = await getBranchGroupMembers(env, groupId);
  if (!members.includes(clientId)) {
    members.push(clientId);
    await env.mydukapos_kv.put(BRANCH_GROUP_PREFIX + groupId, JSON.stringify(members));
  }
}

// Removes one member from a branch group's flat id list — used when a
// branch is permanently deleted (see the 'delete' action in branches.js).
// Deliberately leaves the group key in place even if this empties it down
// to one remaining member; a lone member with a branchGroupId still set is
// harmless (getBranchGroupMembers/getGroupMainRecord both handle a
// single-member group fine), and it preserves branchGroupId as a stable
// "has ever branched" marker rather than needing extra cleanup logic.
export async function removeFromBranchGroup(env, groupId, clientId) {
  if (!groupId) return;
  const members = await getBranchGroupMembers(env, groupId);
  const next = members.filter((id) => id !== clientId);
  if (next.length !== members.length) {
    await env.mydukapos_kv.put(BRANCH_GROUP_PREFIX + groupId, JSON.stringify(next));
  }
}

// The record that holds tier/allowance state for a whole branch group is
// whichever member currently has isMainBranch — this is the one place that
// resolves it, given ANY member's own record. Returns the record itself
// unchanged when it isn't part of a group yet (a not-yet-branched shop is,
// in effect, its own future main branch, and branchAllowance already lives
// on it directly). Used by branches.js (create/allowance check) and
// license-claim-payment.js (branch add-on claims) so both apply an add-on
// to the same record no matter which group member's link triggered it.
export async function getGroupMainRecord(env, record) {
  if (!record || !record.branchGroupId) return record;
  if (record.isMainBranch) return record;
  const members = await getBranchGroupMembers(env, record.branchGroupId);
  for (const memberId of members) {
    const memberRecord = await getLicense(env, memberId);
    if (memberRecord && memberRecord.isMainBranch) return memberRecord;
  }
  return record; // no main flagged yet (shouldn't normally happen) — fall back to caller's own
}

// Returns the lightweight summaries directly — no per-client KV fetch, so
// this stays cheap however many clients exist. Accepts an optional case-
// insensitive text filter (matched against label/slug) for the Licenses
// tab's search box once the list gets long.
export async function listClientSummaries(env, { q, trashOnly } = {}) {
  let list = await readIndex(env);
  list = list.filter((e) => !!e.deleted === !!trashOnly);
  list.sort((a, b) => (trashOnly ? (b.deletedAt || 0) - (a.deletedAt || 0) : (b.createdAt || 0) - (a.createdAt || 0)));
  if (!q) return list;
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((e) =>
    (e.label || '').toLowerCase().includes(needle) || (e.slug || '').toLowerCase().includes(needle)
  );
}

export async function getLicense(env, clientId) {
  if (!clientId) return null;
  const raw = await env.mydukapos_kv.get(LICENSE_PREFIX + clientId);
  return raw ? JSON.parse(raw) : null;
}

export async function saveLicense(env, record) {
  await env.mydukapos_kv.put(LICENSE_PREFIX + record.id, JSON.stringify(record));
  rememberLicense(env, record);                    // zip 159: this instance sees the change at once (see the cache note at the top)
  await upsertIndexSummary(env, record);
}

async function removeIndexSummary(env, clientId) {
  const list = await readIndex(env);
  const next = list.filter((e) => e.id !== clientId);
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(next));
  await mirrorRemove(env, clientId);    // zip 187
}

// Soft delete: moves the client to Trash rather than removing anything. The slug and the client's own
// synced business data are left completely alone — restoreClient() undoes this exactly. Nothing here is
// permanent; permanentlyDeleteClient() (below) is what actually removes data, and only after 30 days
// unrestored. Deliberately does not touch pos-sync state/backups either way — see that function's own
// comment for why leaving those behind is fine.
export async function deleteClient(env, clientId) {
  const record = await getLicense(env, clientId);
  if (!record || record.deleted) return false;
  record.deleted = true;
  record.deletedAt = Date.now();
  await saveLicense(env, record);
  return true;
}

// Undoes deleteClient(). Available any time before the 30-day trash window closes it out for good.
export async function restoreClient(env, clientId) {
  const record = await getLicense(env, clientId);
  if (!record || !record.deleted) return false;
  delete record.deleted;
  delete record.deletedAt;
  await saveLicense(env, record);
  return true;
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The actual, unrecoverable removal — what deleteClient() used to do directly. Only reached once something
// has sat in Trash for the full 30 days; see purgeExpiredTrash(), which is what calls this.
// The real, unrecoverable removal — the license record, its slug reservation (so the subdomain becomes
// available again), and its entry in the Licenses tab's index. Deliberately does not touch that client's
// own pos-sync state/backups (pos-data:state:<id>, pos-data:backup:<id>:*) — those are cheap to leave
// behind and harmless since nothing can reach them without the deleted id, but could be reclaimed here
// later if that ever matters. Only reached via purgeExpiredTrash() once 30 days have passed unrestored.
async function permanentlyDeleteClient(env, clientId, record) {
  // zip 245: leave a tombstone, so a link that really was deleted can be told apart from one that was never found (no token, a mistyped
  // address, a lookup that missed for a moment). "This link no longer exists" is only ever said on the strength of a tombstone or a Trash record.
  try {
    const t = JSON.stringify({ at: Date.now(), slug: record && record.slug || '' });
    await env.mydukapos_kv.put(GONE_PREFIX + clientId, t);
    if (record && record.slug) await env.mydukapos_kv.put(GONE_SLUG_PREFIX + String(record.slug).toLowerCase(), clientId);
  } catch (e) { /* the deletion itself must still go through */ }
  await env.mydukapos_kv.delete(LICENSE_PREFIX + clientId);
  forgetLicense(env, clientId, record && record.slug);
  if (record && record.slug) {
    await env.mydukapos_kv.delete(SLUG_PREFIX + record.slug);
  }
  await removeIndexSummary(env, clientId);
}

// Sweeps Trash and permanently removes what is due: by default anything past its 30-day window; { all: true } = everything in Trash ("Empty trash");
// { only: id } = that one link ("Delete forever"). Also frees the contact details it was signed up with (see _forget.js). Cheap to call on every
// Trash-tab load (one index read, and only per-client KV work for entries actually purged, which should be rare).
export async function purgeExpiredTrash(env, opts = {}) {
  const list = await readIndex(env);
  const now = Date.now();
  const due = list.filter((e) => e.deleted && (opts.only ? e.id === opts.only : opts.all || (e.deletedAt && now - e.deletedAt > TRASH_RETENTION_MS)));
  for (const entry of due) {
    const record = await getLicense(env, entry.id);
    await permanentlyDeleteClient(env, entry.id, record);
    try {
      const { forgetClientContacts } = await import('./_forget.js');
      await forgetClientContacts(env, entry.id, record || entry);
    } catch (e) { /* best effort: a stuck contact link is recoverable by hand, unlike lost data */ }
  }
  return due.length;
}

// The single source of truth for "can this client use the app right now" —
// server clock only. Used both by license-status.js (for the on-screen
// countdown) and by every business-data endpoint (pos-sync, mpesa-*,
// gateway-config, barcode-lookup) to actually block requests once expired.
// Works identically whether given a full record or just its summary shape
// (both carry type/locked/expiresAt), which is what makes the cheap
// summary-only listing above safe to reuse for status checks too.
export function evaluateLicense(record, opts) {
  const now = Date.now();
  if (!record) return { valid: false, reason: 'not_found', now };
  if (record.deleted) return { valid: false, reason: 'deleted', record, now };
  if (record.locked) return { valid: false, reason: 'locked', record, now };
  if (record.type === 'permanent') {
    // zip 267: a subscribed shop (billing.cohort 'new') whose paid period AND grace have ended is suspended, but only where the caller asked for it (opts.subscriptions =
    // billing is live and enforcement is on). Every other caller, and every shop without a billing record, behaves exactly as before. Nothing is ever deleted by this.
    const sub = subscriptionState(record, now);
    if (opts && opts.subscriptions && sub.blocking) return { valid: false, reason: 'subscription_suspended', record, now, subscription: sub };
    return { valid: true, reason: 'permanent', record, now, subscription: sub };
  }
  if (record.sharedDemo) return { valid: true, reason: 'shared_demo', record, now, remainingMs: null };      // zip 262: the fixed public demos never expire
  const remainingMs = (record.expiresAt || 0) - now;
  if (remainingMs <= 0) return { valid: false, reason: 'expired', record, now, remainingMs: 0 };
  return { valid: true, reason: 'demo_active', record, now, remainingMs };
}

/* ---------- resolving WHICH client a request is for ---------- */

// Cloudflare Pages does not support wildcard custom domains (confirmed as of
// 2026 — see developers.cloudflare.com/dns/manage-dns-records/reference/
// wildcard-dns-records/, "wildcard custom domains are not supported"). The
// working alternative is a Cloudflare Worker on a wildcard route
// (*.mydukapos.store/*) that proxies each request to this Pages deployment —
// see the deploy guide for that Worker's exact code. A naive proxy rewrites
// the outgoing Host header to the pages.dev domain, which would make every
// request here look identical regardless of which client's subdomain it
// actually came in on — breaking subdomain resolution entirely. The Worker
// is written to set X-Forwarded-Host to the ORIGINAL hostname before
// forwarding, so that's checked first; the raw request URL is still the
// fallback for direct pages.dev / preview-deployment access (which never
// goes through that Worker, so has no such header) and for local dev.
// X-Forwarded-Host is set by the wildcard-router Worker (the real shop subdomain). OPT-IN HARDENING (zip 119): when the Pages project
// has ROUTER_SHARED_SECRET set, the header is only believed if the request also carries X-Router-Secret with that value — which only
// the router (given the same secret) sends — so a caller hitting the Pages domain directly cannot claim to be any shop's subdomain.
// Without the setting, behaviour is exactly as before.
export function hostnameFromRequest(request, env) {
  try {
    const forwarded = request.headers.get('X-Forwarded-Host');
    const secret = env && env.ROUTER_SHARED_SECRET;
    const trusted = !secret || request.headers.get('X-Router-Secret') === secret;
    if (forwarded && trusted) return forwarded.toLowerCase().split(',')[0].trim();
    return new URL(request.url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Pulls the subdomain label out of a hostname, given the configured root
// domain — e.g. ("georgehardware.mydukapos.store", "mydukapos.store") ->
// "georgehardware". Returns '' for the bare apex domain, "www", any host
// that isn't under the root domain at all (e.g. a *.pages.dev preview URL),
// or a multi-level subdomain (only one level of nesting is supported).
export function subdomainLabel(hostname, rootDomain) {
  if (!hostname || !rootDomain) return '';
  if (hostname === rootDomain || hostname === `www.${rootDomain}`) return '';
  const suffix = `.${rootDomain}`;
  if (!hostname.endsWith(suffix)) return '';
  const label = hostname.slice(0, -suffix.length);
  if (!label || label.includes('.')) return ''; // no bare-apex or nested subdomains
  return label;
}

// THE single place every route decides which client a request belongs to.
// Priority: 1) this request's own subdomain (georgehardware.mydukapos.store),
// 2) the legacy/manual ?c=<token> query param — still supported for the
// Owner Console (served from /owner/ on the apex domain — see the deploy
// guide; it must NOT live at the shop product's own path, or every
// generated "General Shop" client link would open the console instead of
// an actual point of sale), Cloudflare Pages preview deployments
// (*.pages.dev, which never match the root domain), and any link generated
// before subdomains existed.
// -> { clientId, record } — `record` is the licence record when the lookup already had to read it (a subdomain link), else undefined. (zip 159: cached, and
// the record is read ONCE — resolveClientId used to read it just to prove it exists and requireValidLicense then read it again.)
async function resolveIdAndRecord(request, env) {
  const url = new URL(request.url);
  const hostname = hostnameFromRequest(request, env);
  const rootDomain = getRootDomain(env);
  const label = subdomainLabel(hostname, rootDomain);

  if (label) {
    // zip 245: a lookup that comes back empty is looked at again (twice, a moment apart) before it is believed: KV is eventually consistent and
    // a read can miss for an instant. A shop that is really there must never be told it is not.
    let id = null, record = null;
    for (let attempt = 0; attempt < 3 && !record; attempt++) {
      if (attempt) { clearLicenseCache(env); await new Promise((r) => setTimeout(r, 120 * attempt)); }
      id = await slugToIdCached(env, label);
      record = id ? await getLicenseCached(env, id) : null;
    }
    if (record) return { clientId: record.id, record };

    // zip 245: the slug entry itself can be missing (lost, or never written for an older link) while the shop is alive and listed in the
    // Licenses index with this very slug. The index is the second source of truth: find it there and write the slug entry back (self-healing).
    try {
      const hit = (await readIndex(env)).find((e) => e && e.slug && String(e.slug).toLowerCase() === label.toLowerCase());
      if (hit && hit.id) {
        const rec = await getLicenseCached(env, hit.id);
        if (rec && rec.slug && String(rec.slug).toLowerCase() === label.toLowerCase()) {
          try { await claimSlug(env, String(rec.slug).toLowerCase(), rec.id); } catch (e) { /* healing is best effort */ }
          return { clientId: rec.id, record: rec };
        }
      }
    } catch (e) { /* index unreadable: fall through to the c fallback */ }

    // Subdomain lookup came up empty. Workers KV writes are only eventually consistent (up to ~60s), and older links may have no slug entry at
    // all, so the ?c= the link carries is used when it points at a real licence record AND the subdomain is not another shop's: either the
    // record claims this very slug, or nobody has claimed this subdomain (no slug entry exists for it - the same trust as opening ?c= on the
    // apex). A subdomain that DOES belong to another shop never accepts someone else's c.
    const fallbackId = url.searchParams.get('c') || '';
    if (fallbackId) {
      const fallbackRecord = await getLicenseCached(env, fallbackId);
      if (fallbackRecord) {
        const sameSlug = fallbackRecord.slug && fallbackRecord.slug.toLowerCase() === label.toLowerCase();
        const labelUnclaimed = !id;
        if (sameSlug || labelUnclaimed) return { clientId: fallbackRecord.id, record: fallbackRecord };
      }
    }
    return { clientId: '', record: null };
  }

  return { clientId: url.searchParams.get('c') || '', record: undefined };
}

export async function resolveClientId(request, env) {
  return (await resolveIdAndRecord(request, env)).clientId;
}

// Which shop, and its licence record — for the endpoints that need both (license-status). Cached (see the cache note at the top).
export async function resolveLicense(request, env) {
  const r = await resolveIdAndRecord(request, env);
  const record = r.record !== undefined ? r.record : await getLicenseCached(env, r.clientId);
  return { clientId: r.clientId, record };
}

// zip 262: the shared public demos are READ-ONLY on the server. Anything that would change a shop's stored state (every method except GET/HEAD/OPTIONS)
// is refused here for a demo, centrally, unless the endpoint is one that is safe or simulated for demos (a sale push is acknowledged without being
// stored; an M-Pesa prompt is simulated; client logs / hit counters / lookups carry no shop state).
const DEMO_WRITE_OK = new Set(['/api/pos-sync', '/api/mpesa-stkpush', '/api/client-log', '/api/hit', '/api/barcode-lookup', '/api/image-proxy', '/api/image-search', '/api/health']);
export async function requireValidLicense(request, env) {
  const { clientId, record } = await resolveLicense(request, env);
  const settings = record && record.type === 'permanent' && record.billing ? await readBillingSettings(env) : null;      // zip 267: one cached read (30 s), only for a shop that has a subscription record
  const result = evaluateLicense(record, { subscriptions: enforcementOn(settings) });
  if (result.valid && record && record.sharedDemo) {
    const m = String(request.method || 'GET').toUpperCase();
    let path = ''; try { path = new URL(request.url).pathname; } catch (e) { /* none */ }
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !DEMO_WRITE_OK.has(path)) return { valid: false, reason: 'demo_readonly', demo: true, record, clientId, now: result.now };
  }
  return { ...result, clientId };
}

// zip 262: create (or refresh) one FIXED shared demo shop. Idempotent: the id and the web address never change, the record is only written when it is
// missing or its details changed, and nothing is ever created per visitor. `spec` = { id, product, slug, label, seedVersion }.
export async function ensureSharedDemoRecord(env, spec) {
  const id = String(spec.id);
  const raw = await env.mydukapos_kv.get(LICENSE_PREFIX + id);
  let record = raw ? JSON.parse(raw) : null;
  if (record && record.sharedDemo && record.product === spec.product && record.slug === spec.slug && record.label === spec.label) return { record, created: false };
  const owner = await env.mydukapos_kv.get(SLUG_PREFIX + spec.slug);
  if (owner && owner !== id) throw new Error('The address ' + spec.slug + ' already belongs to another shop - rename that shop before the shared demo can use it.');
  const now = Date.now();
  record = {
    ...(record || {}),
    id, slug: spec.slug, type: 'demo', sharedDemo: true, product: PRODUCTS[spec.product] ? spec.product : DEFAULT_PRODUCT,
    svcType: spec.product === 'services' ? normalizeSvcType(spec.svcType) : '', label: spec.label,
    createdAt: (record && record.createdAt) || now, expiresAt: null, locked: false, paymentClaimed: false, paymentClaimedAt: null, confirmedAt: null,
    branchGroupId: null, isMainBranch: false, branchAllowance: 0, branchAddonClaimed: false, branchAddonClaimedAt: null,
    clientName: 'Shared public demo', preferredName: '', notes: 'Shared demo - read-only on the server; visitors\' edits stay on their own device.',
    phone: '', email: '', source: 'shared-demo', agreedAmount: 0, paidAmount: 0, balanceOwed: 0,
  };
  await env.mydukapos_kv.put(LICENSE_PREFIX + id, JSON.stringify(record));
  rememberLicense(env, record);
  await claimSlug(env, spec.slug, id);
  await upsertIndexSummary(env, record);
  return { record, created: true };
}


// zip 245: was this id / subdomain label PERMANENTLY deleted (a tombstone exists)? Only that, or a Trash record, proves a link was removed.
export async function wasPermanentlyDeleted(env, clientId, slugLabel) {
  try {
    if (clientId && await env.mydukapos_kv.get(GONE_PREFIX + clientId)) return true;
    if (slugLabel && await env.mydukapos_kv.get(GONE_SLUG_PREFIX + String(slugLabel).toLowerCase())) return true;
  } catch (e) { /* cannot tell: not proof */ }
  return false;
}
