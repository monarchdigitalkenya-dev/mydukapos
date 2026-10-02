// functions/api/offers.js — timed offers (zip 177). All time decisions use the SERVER clock, never the visitor's.
//   GET  /api/offers                      public -> { now, offers:[active offers] }   (cached for 15 s)
//   POST { action:'list' }                owner  -> { now, offers:[all, with computed status], audit:[...] }
//   POST { action:'save', offer }         owner  -> create (no id) or edit
//   POST { action:'state', id, state }    owner  -> state: draft | published | paused | archived
// Stored state is draft|published|paused|archived. The status shown is computed against the server clock:
//   published + before start = scheduled, between = active, after end = expired. Times are epoch ms; the Owner Console enters them as Nairobi time (UTC+3).
import { requireOwnerAuth } from './_owner-auth.js';

const KEY = 'offers:v1', AUDIT = 'offers-audit:v1';
const STATES = ['draft', 'published', 'paused', 'archived'];
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (b, s = 200, extra = {}) => new Response(JSON.stringify(b), { status: s, headers: { ...H, ...extra } });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export function statusOf(o, now) {
  if (o.state !== 'published') return o.state;
  if (o.startsAt && now < o.startsAt) return 'scheduled';
  if (o.endsAt && now >= o.endsAt) return 'expired';
  return 'active';
}
async function read(env, key) { try { const r = await env.mydukapos_kv.get(key); return r ? JSON.parse(r) : []; } catch (e) { return []; } }
const safeUrl = (u) => { u = String(u || '').trim(); return /^(\/[^\/\\]|https:\/\/)/.test(u) || u === '/' ? u.slice(0, 300) : '/'; };

export async function onRequestGet({ env }) {
  const now = Date.now();
  const offers = (await read(env, KEY)).filter((o) => statusOf(o, now) === 'active')
    .map((o) => ({ id: o.id, title: o.title, description: o.description, terms: o.terms, startsAt: o.startsAt, endsAt: o.endsAt, ctaLabel: o.ctaLabel, ctaUrl: o.ctaUrl }));
  return json({ now, offers }, 200, { 'Cache-Control': 'public, max-age=15' });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Sign in as the owner.' }, 401);
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  const now = Date.now();
  let offers = await read(env, KEY);
  const log = async (what, o) => { const a = await read(env, AUDIT); a.unshift({ at: now, what, id: o.id, title: o.title }); await env.mydukapos_kv.put(AUDIT, JSON.stringify(a.slice(0, 200))); };
  const view = () => offers.map((o) => ({ ...o, status: statusOf(o, now) }));

  if (b.action === 'list') return json({ now, offers: view(), audit: (await read(env, AUDIT)).slice(0, 50) });

  if (b.action === 'save') {
    const x = b.offer || {};
    const title = txt(x.title, 120);
    if (!title) return json({ error: 'An offer needs a title.' }, 400);
    const startsAt = Number(x.startsAt) || 0, endsAt = Number(x.endsAt) || 0;
    if (endsAt && startsAt && endsAt <= startsAt) return json({ error: 'The end time must be after the start time.' }, 400);
    const rec = { title, description: txt(x.description, 600), terms: txt(x.terms, 600), startsAt, endsAt, ctaLabel: txt(x.ctaLabel, 40) || 'Get started', ctaUrl: safeUrl(x.ctaUrl) };
    const i = x.id ? offers.findIndex((o) => o.id === x.id) : -1;
    if (i >= 0) { offers[i] = { ...offers[i], ...rec, updatedAt: now }; await log('edited', offers[i]); }
    else { offers.push({ id: crypto.randomUUID(), state: 'draft', createdAt: now, ...rec }); await log('created', offers[offers.length - 1]); }
    if (offers.length > 200) offers = offers.slice(-200);
    await env.mydukapos_kv.put(KEY, JSON.stringify(offers));
    return json({ ok: true, offers: view() });
  }

  if (b.action === 'state') {
    const i = offers.findIndex((o) => o.id === b.id);
    if (i < 0) return json({ error: 'Offer not found.' }, 404);
    if (!STATES.includes(b.state)) return json({ error: 'Unknown state.' }, 400);
    if (b.state === 'published' && !offers[i].endsAt) return json({ error: 'Set an end time before publishing, so the offer cannot run forever.' }, 400);
    offers[i].state = b.state; offers[i].updatedAt = now;
    await env.mydukapos_kv.put(KEY, JSON.stringify(offers));
    await log('state → ' + b.state, offers[i]);
    return json({ ok: true, offers: view() });
  }
  return json({ error: 'Unknown action.' }, 400);
}
