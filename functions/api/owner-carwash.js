// functions/api/owner-carwash.js — Cloudflare Pages Function (Owner Console only) — zip 361.
//
// The Owner Console's "🚗 Car Wash" application panel. The Car Wash & Cleaning app is its own product ("carwash", /carwash/), so its links
// are ordinary client links (created, locked, edited and deleted by the endpoints the console already uses). This endpoint adds what only
// this app has: how each Car Wash business is actually using it.
//
//   GET                -> { apps: [summary...], services: [summary...] }  every Car Wash link, and the Services links whose business type
//                                                                         is still car_wash (candidates to move to the Car Wash app)
//   GET ?c=<clientId>  -> { usage }  customers, vehicles, jobs (today / 30 days / open), collections in 30 days, SMS, staff, devices,
//                                    last activity, and what was imported from Services. Read-only: nothing in the shop is changed.
import { requireOwnerAuth } from './_owner-auth.js';
import { listClientSummaries, getLicense, clientLink, evaluateLicense } from './_license.js';
import { readStateRaw, shopMode, shopCall } from './_state-store.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const DAY = 86400000;
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function readShopState(env, clientId) {
  const mode = await shopMode(env, clientId);
  if (mode === 'do') {
    const res = await shopCall(env, clientId, 'export', {});
    return res.ok ? JSON.parse(await res.text()) : {};
  }
  const raw = await readStateRaw(env, 'pos-data:state:' + clientId);
  return raw ? JSON.parse(raw.text) : {};
}

// Usage figures of one Car Wash business, from its own synced records (pure: exported for the tests).
export function carwashUsage(state, now = Date.now()) {
  const live = (a) => arr(a).filter((r) => r && !r._deleted);
  const jobs = live(state.cwJobs), pays = live(state.cwPayments), sms = live(state.cwSms);
  const nairobiDay = (ms) => Math.floor((num(ms) + 3 * 3600000) / DAY);
  const today = nairobiDay(now);
  const closed = (j) => ['collected', 'delivered', 'cancelled'].includes(j.status) || (j.status === 'completed' && j.kind === 'clean');
  let last = 0;
  [jobs, pays, sms, live(state.cwAudit)].forEach((l) => l.forEach((r) => { const t = num(r.updatedAt || r.at || r.createdAt); if (t > last && t <= now + DAY) last = t; }));
  const coll30 = pays.filter((p) => !p.reversedAt && num(p.at) >= now - 30 * DAY).reduce((s, p) => s + num(p.amount), 0);
  const cfg = live(state.cwConfig).find((c) => c.id === 'cfg') || {};
  const reg = state.deviceRegistry && typeof state.deviceRegistry === 'object' ? Object.values(state.deviceRegistry) : [];
  return {
    businessName: (cfg.business && cfg.business.name) || state.businessName || '',
    customers: live(state.cwCustomers).length,
    vehicles: live(state.cwVehicles).length,
    jobsTotal: jobs.length,
    jobsToday: jobs.filter((j) => nairobiDay(j.receivedAt || j.createdAt) === today).length,
    jobs30: jobs.filter((j) => num(j.receivedAt || j.createdAt) >= now - 30 * DAY).length,
    open: jobs.filter((j) => !closed(j)).length,
    cleaning: jobs.filter((j) => j.kind === 'clean').length,
    collected30: Math.round(coll30 * 100) / 100,
    smsSent30: sms.filter((s) => s.status === 'sent' && num(s.at) >= now - 30 * DAY).length,
    smsFailed: sms.filter((s) => s.status === 'failed').length,
    staff: arr(state.staff).filter((m) => m && !m.removed && !m._deleted).length,
    devices: reg.filter((d) => d && num(d.lastSeen) > now - 7 * DAY).length,
    lastActivity: last || null,
    migration: cfg.migration || null,
    servicesCarWashJobs: arr(state.svcJobs).filter((j) => j && j.serviceType === 'car_wash' && !j._deleted).length,
  };
}

export async function onRequestGet(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const { request, env } = context;
  const url = new URL(request.url);
  const c = url.searchParams.get('c');
  if (c) {
    const record = await getLicense(env, c);
    if (!record || (record.product !== 'carwash' && !(record.product === 'services' && record.svcType === 'car_wash'))) return json({ error: 'Not a Car Wash business.' }, 404);
    let state = {};
    try { state = await readShopState(env, c); } catch (e) { return json({ error: 'Could not read this business right now.', detail: String((e && e.message) || e).slice(0, 160) }, 503); }
    return json({ usage: carwashUsage(state), product: record.product });
  }
  const all = await listClientSummaries(env, {});
  const origin = url.origin;
  const shape = (s) => { const ev = evaluateLicense(s); return { ...s, link: clientLink(env, s, origin), valid: ev.valid, liveReason: ev.reason, remainingMs: ev.remainingMs !== undefined ? ev.remainingMs : null }; };
  // Summaries written before zip 361 do not carry svcType: read those Services licences (a bounded number) to find the car wash ones.
  const svc = all.filter((s) => s.product === 'services' && !s.deleted);
  const unknown = svc.filter((s) => s.svcType === undefined).slice(0, 80);
  const typeOf = {};
  await Promise.all(unknown.map(async (s) => { try { const r = await getLicense(env, s.id); typeOf[s.id] = (r && r.svcType) || ''; } catch (e) { typeOf[s.id] = ''; } }));
  return json({
    apps: all.filter((s) => s.product === 'carwash' && !s.deleted).map(shape),
    services: svc.filter((s) => (s.svcType !== undefined ? s.svcType : typeOf[s.id]) === 'car_wash').map(shape),
    serverNow: Date.now(),
  });
}
