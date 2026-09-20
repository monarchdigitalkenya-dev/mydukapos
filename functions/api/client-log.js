// functions/api/client-log.js — Cloudflare Pages Function
//
// Collects uncaught errors from every app (see src/shared/blocks/error-reporting.html)
// so problems show up in the Owner Console's 🐞 Errors tab within minutes instead of
// when a customer phones.
//
// POST (no login — the apps call it): one error report. Grouped by a fingerprint so a
//      bug hitting 500 devices is ONE line with a count, not 500 lines.
// GET  (owner only): the last 7 days, grouped, newest first.
//
// Storage: one KV key per UTC day (client-errors:YYYY-MM-DD), expires after 14 days.
//
// Deliberately cheap and hard to abuse:
//   * bodies over 8 KB are rejected, every field is truncated;
//   * at most MAX_FINGERPRINTS_PER_DAY distinct errors are kept per day;
//   * a fingerprint that has been seen 10+ times only writes to KV every 10th time,
//     so an error looping on many devices can't hammer KV's one-write-per-second-per-key
//     limit (its count is then approximate — "at least").
// A failure here must never affect the app that reported it: POST always answers 204.

import { requireOwnerAuth } from './_owner-auth.js';
import { resolveClientId } from './_license.js';

const MAX_BODY = 8 * 1024;
const MAX_FINGERPRINTS_PER_DAY = 300;
const KEEP_DAYS = 14;
const SHOW_DAYS = 7;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
const noContent = () => new Response(null, { status: 204, headers: CORS_HEADERS });

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
const dayKey = (d = new Date()) => `client-errors:${d.toISOString().slice(0, 10)}`;

// Small stable hash (FNV-1a) — grouping only, not security.
export function fingerprint(app, message, stack) {
  const topFrames = String(stack || '').split('\n').slice(0, 3).join('|').replace(/https?:\/\/[^\s)]+\//g, '');
  const text = `${app}|${message}|${topFrames}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const raw = await request.text();
    if (!raw || raw.length > MAX_BODY) return noContent();
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object') return noContent();

    const app = cut(r.app, 40) || 'unknown';
    const message = cut(r.message, 300);
    if (!message) return noContent();
    const stack = cut(r.stack, 1500);
    const fp = fingerprint(app, message, stack);
    let clientId = '';
    try { clientId = await resolveClientId(request, env); } catch (e) { /* unknown shop is fine */ }

    const key = dayKey();
    const existingRaw = await env.mydukapos_kv.get(key);
    const day = existingRaw ? JSON.parse(existingRaw) : { fps: {} };
    const entry = day.fps[fp];
    const now = Date.now();

    if (!entry) {
      if (Object.keys(day.fps).length >= MAX_FINGERPRINTS_PER_DAY) return noContent();
      day.fps[fp] = {
        app, kind: cut(r.kind, 12), message, stack, source: cut(r.source, 160), path: cut(r.path, 120),
        ua: cut(r.ua, 160), count: 1, first: now, last: now, shops: clientId ? { [clientId]: 1 } : {},
      };
    } else {
      // Very noisy errors: only ~1 in 10 reports writes, and it adds 10 (an unbiased estimate),
      // so a loop on many devices can't hammer KV. Counts above 10 are therefore approximate.
      if (entry.count >= 10) {
        if (Math.random() >= 0.1) return noContent();
        entry.count += 10;
      } else {
        entry.count++;
      }
      entry.last = now;
      if (clientId && (entry.shops[clientId] || Object.keys(entry.shops).length < 20)) entry.shops[clientId] = (entry.shops[clientId] || 0) + 1;
    }
    await env.mydukapos_kv.put(key, JSON.stringify(day), { expirationTtl: KEEP_DAYS * 24 * 60 * 60 });
  } catch (e) {
    // never let logging break anything
  }
  return noContent();
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);

  const merged = {};
  const days = [];
  for (let i = 0; i < SHOW_DAYS; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const raw = await env.mydukapos_kv.get(dayKey(d));
    if (!raw) continue;
    const day = JSON.parse(raw);
    days.push(d.toISOString().slice(0, 10));
    for (const [fp, e] of Object.entries(day.fps || {})) {
      const m = merged[fp];
      if (!m) { merged[fp] = { fp, ...e, shops: { ...e.shops } }; continue; }
      m.count += e.count;
      m.first = Math.min(m.first, e.first);
      m.last = Math.max(m.last, e.last);
      Object.entries(e.shops || {}).forEach(([id, n]) => { m.shops[id] = (m.shops[id] || 0) + n; });
    }
  }
  const errors = Object.values(merged)
    .map((e) => ({ ...e, shopCount: Object.keys(e.shops).length, shops: undefined }))
    .sort((a, b) => b.last - a.last);
  return json({ days, total: errors.reduce((n, e) => n + e.count, 0), errors });
}
