// functions/api/health.js — Cloudflare Pages Function. The POS's connectivity check (zip 129).
//
//   GET|HEAD /api/health            -> 200 { ok: true, t: <server ms>, service: "mydukapos" }   (answered by the edge, no storage)
//   GET      /api/health?deep=1     -> also reads one tiny KV key: 200 { ok, kv: true, kvMs } or 503 when storage is failing
//
// Why it exists: the apps used to decide "Offline" by timing the heaviest request they make (/api/pos-sync: licence lookup, device
// check, shop data) with a 4-6 second limit — a slow answer or a busy shop read as "no internet". This endpoint needs no licence,
// touches no shop data, writes nothing, creates nothing, and is never cached (by Cloudflare, the browser or the service worker,
// which leaves every /api/ path alone) — so it answers "can this device reach the POS right now?" in milliseconds.
export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Robots-Tag': 'noindex',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  const out = { ok: true, t: Date.now(), service: 'mydukapos' };
  const deep = new URL(request.url).searchParams.get('deep') === '1';
  if (deep) {
    const t0 = Date.now();
    try {
      if (!env || !env.mydukapos_kv) throw new Error('no storage binding');
      await env.mydukapos_kv.get('health:probe');           // a key that normally does not exist: one cheap read
      out.kv = true;
    } catch (e) {
      out.ok = false; out.kv = false; out.error = 'storage unavailable';
    }
    out.kvMs = Date.now() - t0;
    // zip 153: the transaction database (D1). Not bound = the till still trades, but money is NOT yet in the authoritative ledger: say so.
    const db = env && (env.LEDGER_DB || env.DB);
    out.d1 = false;
    if (db) { try { await db.prepare('SELECT 1 AS ok').first(); out.d1 = true; } catch (e) { out.d1 = false; out.d1Error = 'transaction database not answering'; } }
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(out), { status: out.ok ? 200 : 503, headers });
}
