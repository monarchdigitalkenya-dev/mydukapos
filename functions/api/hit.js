// functions/api/hit.js — first-party, cookieless page-view counts for the PUBLIC pages (zip 177). No cookies, no IP or user-agent stored, no
// visitor id: only a per-day counter per page path (and per referrer host). Honours Do-Not-Track on the client. KV counters are approximate.
//   POST { path, ref }              -> 204
//   POST { action:'report' } owner  -> { days: { 'YYYY-MM-DD': { '/': n, ... } } }
import { requireOwnerAuth } from './_owner-auth.js';
const OK = new Set(['/', '/offers', '/faq', '/contact', '/terms', '/privacy', '/cookies', '/acceptable-use', '/dashboard.html', '/app.html']);
const day = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);   // Nairobi day
export async function onRequestPost(context) {
  const { request, env } = context;
  let b = {}; try { b = await request.json(); } catch (e) { return new Response(null, { status: 204 }); }
  if (b.action === 'report') {
    if (!(await requireOwnerAuth(context))) return new Response(JSON.stringify({ error: 'Sign in as the owner.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const days = {};
    const l = await env.mydukapos_kv.list({ prefix: 'an:', limit: 1000 });
    for (const k of l.keys) { const [, d, p] = k.name.split(/:(.*?):(.*)/s).filter((x) => x !== ''); (days[d] = days[d] || {})[p] = Number(await env.mydukapos_kv.get(k.name)) || 0; }
    return new Response(JSON.stringify({ days }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  let p = String(b.path || '/').split('?')[0].split('#')[0];
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  // zip 185: only the real product pages are counted - any /products/<text> used to create a new KV key per distinct text (unbounded writes from anyone)
  if (/^\/products\/(shop|hotel|hospital|production|pharmacy|services|water)$/.test(p)) { /* counted */ }
  else if (!OK.has(p)) return new Response(null, { status: 204 });
  const key = `an:${day()}:${p}`;
  try { await env.mydukapos_kv.put(key, String((Number(await env.mydukapos_kv.get(key)) || 0) + 1), { expirationTtl: 400 * 86400 }); } catch (e) { /* best effort */ }
  return new Response(null, { status: 204 });
}
