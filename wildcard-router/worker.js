// wildcard-router/worker.js — Cloudflare Worker (separate from the mydukapos
// Pages project — deployed with `wrangler deploy`, not `wrangler pages deploy`)
//
// WHY THIS EXISTS: Cloudflare Pages does not support wildcard custom domains
// (confirmed current as of 2026 — see developers.cloudflare.com/dns/manage-
// dns-records/reference/wildcard-dns-records/). So *.mydukapos.store can't be
// added directly in the Pages project's Custom Domains settings the way a
// single domain can. This Worker is the actual thing bound to the wildcard
// route (*.mydukapos.store/*, configured below and in the Cloudflare
// dashboard) — all it does is forward every request through to the Pages
// deployment.
//
// IMPORTANT: rewriting the hostname to reach the Pages origin means the
// outgoing request's own Host header no longer carries the original
// subdomain (georgehardware.mydukapos.store) — it would say mydukapos.pages.dev
// instead. Without fixing that, every client's requests would look
// identical to the backend and subdomain-based client resolution
// (_license.js's resolveClientId) would silently break for everyone. So this
// Worker sets X-Forwarded-Host to the ORIGINAL hostname before forwarding —
// _license.js reads that header first (falling back to the raw URL hostname
// for direct pages.dev/preview access, which never passes through here).

import { ledgerHealth, saveAlert } from '../functions/api/_ledger-health.js';
import { auditMaintenance } from '../functions/api/_audit-db.js';

const PAGES_ORIGIN = 'mydukapos.pages.dev'; // <-- your Pages project's own *.pages.dev domain

// Subdomains that should NOT be routed into the app — add to this if you
// ever want e.g. "www" or "status" to do something else. Everything else
// (any client's slug) falls through to the Pages deployment.
const EXCLUDED_SUBDOMAINS = [];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const label = url.hostname.split('.')[0];

    if (EXCLUDED_SUBDOMAINS.includes(label)) {
      return fetch(request);
    }

    const originalHost = url.hostname;
    url.hostname = PAGES_ORIGIN;

    const proxied = new Request(url.toString(), request);
    proxied.headers.set('X-Forwarded-Host', originalHost);
    // Proves to the Pages project that this header came from here (see hostnameFromRequest in functions/api/_license.js). Only sent
    // when ROUTER_SHARED_SECRET is set on this Worker; a client's own copy of the header is always replaced above.
    proxied.headers.delete('X-Router-Secret');
    if (env && env.ROUTER_SHARED_SECRET) proxied.headers.set('X-Router-Secret', env.ROUTER_SHARED_SECRET);

    // fetch() here tunnels a WebSocket upgrade (e.g. a device connecting to
    // /api/sync-ws) through to the Pages deployment exactly the same way it
    // tunnels any other request — Cloudflare's runtime forwards the
    // Upgrade: websocket handshake end-to-end and hands back a 101 Response
    // carrying the live socket, which just flows straight back out through
    // this `return` to the original client. No special-casing needed here.
    return fetch(proxied);
  },

  // DAILY SHOP HEALTH CHECK (zip 120, #10). Runs on the cron in wrangler.toml. Does nothing unless BOTH are set on this Worker:
  //   HEALTH_URL = "https://mydukapos.store/api/owner-health"      ROUTER_SHARED_SECRET = (the same secret as on the Pages project)
  // The Pages endpoint then checks every shop and emails the owner only when something needs attention.
  async scheduled(event, env, ctx) {
    // zip 186: LEDGER SIZE WATCHDOG (every cron firing, see wrangler.toml). Inert unless this Worker has the LEDGER_DB binding.
    ctx.waitUntil(ledgerSizeWatchdog(env));
    if (event && event.cron === WATCHDOG_ONLY_CRON) return;                  // the 6-hourly firing is for the watchdog only; the shop health check stays daily
    if (!env || !env.HEALTH_URL || !env.ROUTER_SHARED_SECRET) return;
    ctx.waitUntil(fetch(env.HEALTH_URL + (env.HEALTH_URL.includes('?') ? '&' : '?') + 'cron=1', { headers: { 'X-Router-Secret': env.ROUTER_SHARED_SECRET } }).catch(() => {}));
  },
};

// zip 186 (INCIDENT: ledger_audit filled the 10 GB D1 database). Reads the same bounded figures as GET /api/ledger-health (functions/api/_ledger-health.js: MAX(id),
// one probe row, the newest 5000 ids - never a COUNT(*)) and keeps the result as ledger_meta 'size_alert' (the health endpoint / owner console show it), plus the KV
// key 'ledger:size-alert' when this Worker also has the KV binding. Warns at 60%, critical at 80% of the cap, or on runaway growth. Never throws, never writes
// anything but that one row, and does nothing without a LEDGER_DB (or DB) binding.
export const WATCHDOG_ONLY_CRON = '20 */6 * * *';
export async function ledgerSizeWatchdog(env) {
  // zip 187/188: retention for the separate audit database (rows older than AUDIT_RETAIN_DAYS, default 90). With the R2 binding AUDIT_ARCHIVE: archived to R2 monthly, then pruned; without it: plain bounded trim. Inert without LEDGER_AUDIT_DB.
  try { const t = await auditMaintenance(env); if (t.deleted || t.archived || t.error) console.log('audit retention:', JSON.stringify(t)); } catch (e) { /* never blocks the watchdog */ }
  const db = env && (env.LEDGER_DB || env.DB);
  if (!db) return { skipped: 'no_db' };
  try {
    const h = await ledgerHealth(db, { auditDb: (env && env.LEDGER_AUDIT_DB) || null });
    try { console.log('ledger watchdog:', JSON.stringify({ level: h.level, pct: h.pctOfCap, rows: h.auditRows, perMin: h.ratePerMin, notes: h.notes })); } catch (e) { /* log only */ }
    try { await saveAlert(db, h); } catch (e) { /* a full database cannot take even this row: the KV flag / the log still carry it */ }
    if (env.mydukapos_kv && typeof env.mydukapos_kv.put === 'function') {
      try { await env.mydukapos_kv.put('ledger:size-alert', JSON.stringify({ at: h.at, level: h.level, notes: h.notes, pctOfCap: h.pctOfCap, auditRows: h.auditRows }), { expirationTtl: 3 * 86400 }); } catch (e) { /* optional */ }
    }
    return { level: h.level };
  } catch (e) {
    try { console.error('ledger watchdog failed:', e && e.message); } catch (x) { /* log only */ }
    return { error: true };
  }
}

// ---------- SyncRoom Durable Object ----------
//
// WHY THIS LIVES HERE: Cloudflare Pages Functions (the mydukapos Pages
// project's /functions directory) can BIND to a Durable Object class, but
// cannot DEFINE one — the class itself must be exported from an actual
// Worker script that's deployed with `wrangler deploy`. This file is the
// only plain Worker in the whole project, so it's the natural (and only
// currently viable) home for it. The Pages project's own wrangler.toml
// binds to this class cross-script via `script_name = "mydukapos-wildcard-
// router"` — see the durable_objects.bindings block added there, and the
// migration below that actually registers the class with this Worker.
//
// WHAT IT DOES: one instance per client link (keyed by the same clientId
// pos-sync.js already uses for KV), holding every device's live WebSocket
// connection for that one business. pos-sync.js's POST handler calls this
// instance's /broadcast endpoint right after it writes a fresh record to
// KV, and every connected socket gets that record pushed to it immediately
// — see functions/api/sync-ws.js (the WebSocket entry point devices
// connect to) and functions/api/pos-sync.js (the broadcast trigger).
//
// Uses the Hibernatable WebSockets API (ctx.acceptWebSocket / getWebSockets)
// so an idle room with connections open costs nothing while hibernated —
// the instance only wakes to handle an actual message or broadcast.
//
// Deliberately holds NO business data of its own — KV via pos-sync.js
// remains the single source of truth. This object is purely a connection
// registry + broadcaster; if it's ever unreachable, missing, or not yet
// deployed, every device's own 7-second poll (see each app's
// startPolling()/pullState()) is what keeps things eventually correct.
export class SyncRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.text();
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(body);
          delivered += 1;
        } catch (e) {
          // A dead/closing socket that hasn't been cleaned up yet — ignore
          // it, webSocketClose below (or the next connect) tidies it up.
        }
      }
      return new Response(JSON.stringify({ delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Devices never send anything meaningful over this socket today — it's
  // server-to-client push only. Still required by the hibernation API, and
  // left ready for a future heartbeat/ping without needing a protocol
  // change.
  async webSocketMessage() {}

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (e) {}
  }
}

// The per-shop database (see shop-store.js). Bound from the Pages project as SHOP_STORE.
export { ShopStore } from './shop-store.js';
