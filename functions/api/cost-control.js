// functions/api/cost-control.js — Cloudflare Pages Function (zip 336). COST CORRECTIONS, PROFIT ADJUSTMENTS AND THE STOCK AUDIT TRAIL.
//
// Wrong cost prices typed by staff made profits negative or misleading. This is where a MANAGER puts that right - never by editing sales:
//   * a cost correction is its own record (item or one batch, old -> new, from / to, why, who, the effect shown before saving). Reports lay it OVER
//     the sales when they add up cost ("restate"), or it only applies from now on ("forward"). The sales themselves are never changed.
//   * a profit adjustment (e.g. bring a period's reported profit to zero) is its own documented entry: period, amount, the figure before and after,
//     why, who. It is undone only by a reversal entry - never edited or deleted.
//   * once the books are closed through a date, nothing may restate or adjust that period any more.
// Every write needs the Admin password or a manager PIN, checked HERE on the server (X-Pay-Proof, the same proof as payment settings: _pay-guard.js),
// so a modified app or a direct call cannot skip it. Every write is idempotent on its own id: a retry or a second device sending it again is a no-op.
// The tables are append-only (D1 triggers refuse UPDATE / DELETE).
//
//   POST /api/cost-control?c=<link>
//     { action: 'list' }                                   -> { corrections, adjustments, settings, audit }
//     { action: 'correct', corrId, code, name, lotId?, mode: 'forward'|'restate', oldCost, newCost, from?, to?, reason, ...effects } (proof)
//     { action: 'adjust', adjId, kind: 'zero'|'amount', from, to, amount, reportedBefore, reason } (proof)
//     { action: 'reverse', adjId, reverseOf, reason } (proof)
//     { action: 'setClosed', through: 'YYYY-MM-DD' | '', reason } (proof)
//     { action: 'event', evId, kind, code?, name?, detail?, reason } (proof)      a stock action for the audit trail
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';
import { ledgerDb } from './_ledger.js';
import { ensureIntegritySchema } from './_stock-integrity-schema.js';
import { requirePayProof } from './_pay-guard.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_.:-]{6,80}$/;
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const cost6 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null; };
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const EVENT_KINDS = new Set(['lot_status', 'lot_opening', 'lot_override', 'packaging', 'lot_policy', 'transfer_resolve', 'store_merge', 'lot_remove', 'profit_edit']);

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, { headers: 'Content-Type, X-Pay-Proof, X-Staff-Token' }) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, { headers: 'Content-Type, X-Pay-Proof, X-Staff-Token' });
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const clientId = license.clientId;
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const action = String((body && body.action) || '');
  const sg = await staffGuard(request, env, clientId, action === 'list' ? 'reports' : null, cors);
  if (sg.denied) return sg.denied;
  const db = ledgerDb(env);
  if (!db) return reply({ error: 'The transaction database (D1) is not connected to this deployment yet.', code: 'no_d1' }, 503);
  try {
    await ensureIntegritySchema(db);
    const closedThrough = async () => { const r = await db.prepare(`SELECT v FROM cc_settings WHERE client_id = ? AND k = 'closed_through'`).bind(clientId).first(); return r && DAY.test(r.v) ? r.v : null; };

    if (action === 'list') {
      const corrections = (await db.prepare(`SELECT * FROM cost_corrections WHERE client_id = ? ORDER BY at`).bind(clientId).all()).results || [];
      const adjustments = (await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? ORDER BY at`).bind(clientId).all()).results || [];
      const audit = (await db.prepare(`SELECT * FROM stock_audit WHERE client_id = ? ORDER BY at DESC LIMIT 300`).bind(clientId).all()).results || [];
      return reply({ ok: true, corrections, adjustments, audit, settings: { closedThrough: await closedThrough() } });
    }
    if (!['correct', 'adjust', 'reverse', 'setClosed', 'event'].includes(action)) return reply({ error: 'Unknown action.' }, 400);

    // ---- every action below changes something: the Admin password or a manager PIN, checked here ----
    const proof = await requirePayProof(request, env, clientId, cors);
    if (proof.denied) return proof.denied;
    const actor = txt(body.servedBy, 60) || proof.who.name;
    const actorKind = proof.who.kind;
    const reason = txt(body.reason, 300);
    const now = Date.now();
    if (reason.length < 5) return reply({ error: 'Write the reason (at least a few words) - it is kept with the record.' }, 400);

    if (action === 'correct') {
      const id = txt(body.corrId, 80);
      if (!ID.test(id)) return reply({ error: 'Missing request id.' }, 400);
      const prev = await db.prepare(`SELECT * FROM cost_corrections WHERE client_id = ? AND corr_id = ?`).bind(clientId, id).first();
      if (prev) return reply({ ok: true, replay: true, correction: prev });
      const code = txt(body.code, 80), mode = body.mode === 'restate' ? 'restate' : 'forward';
      const newCost = cost6(body.newCost), oldCost = body.oldCost === null || body.oldCost === undefined || body.oldCost === '' ? null : cost6(body.oldCost);
      if (!code) return reply({ error: 'Which item?' }, 400);
      if (newCost === null || newCost < 0) return reply({ error: 'Type the correct cost (0 or more).' }, 400);
      if (oldCost !== null && Math.abs(oldCost - newCost) < 0.000001) return reply({ error: 'The new cost is the same as the old one - nothing to correct.' }, 400);
      const from = DAY.test(body.from) ? body.from : null, to = DAY.test(body.to) ? body.to : null;
      if (mode === 'restate') {
        if (!from) return reply({ error: 'From which date should past sales be counted at the corrected cost?' }, 400);
        if (to && to < from) return reply({ error: 'The end date is before the start date.' }, 400);
        const ct = await closedThrough();
        if (ct && from <= ct) return reply({ error: `The books are closed through ${ct}. Sales up to that date cannot be restated - correct from ${nextDay(ct)} on, or record a profit adjustment in an open period.`, code: 'closed' }, 409);
      }
      await db.prepare(`INSERT OR IGNORE INTO cost_corrections (client_id, corr_id, code, name, lot_id, mode, old_cost, new_cost, date_from, date_to, qty_on_hand, value_effect, cogs_effect, lines_affected, reason, actor, actor_kind, at, detail)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(clientId, id, code, txt(body.name, 160) || null, txt(body.lotId, 60) || null, mode, oldCost, newCost, mode === 'restate' ? from : null, mode === 'restate' ? to : null,
          cost6(body.qtyOnHand), money(body.valueEffect), mode === 'restate' ? money(body.cogsEffect) : 0, Math.max(0, Math.round(Number(body.linesAffected) || 0)), reason, actor, actorKind, now, txt(body.detail, 1000) || null).run();
      const correction = await db.prepare(`SELECT * FROM cost_corrections WHERE client_id = ? AND corr_id = ?`).bind(clientId, id).first();
      return reply({ ok: true, correction, who: proof.who });
    }

    if (action === 'adjust') {
      const id = txt(body.adjId, 80);
      if (!ID.test(id)) return reply({ error: 'Missing request id.' }, 400);
      const prev = await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? AND adj_id = ?`).bind(clientId, id).first();
      if (prev) return reply({ ok: true, replay: true, adjustment: prev });
      const from = DAY.test(body.from) ? body.from : null, to = DAY.test(body.to) ? body.to : null;
      if (!from || !to || to < from) return reply({ error: 'Choose the period (from / to) this adjustment is for.' }, 400);
      const amount = money(body.amount), before = money(body.reportedBefore);
      if (amount === null || amount === 0) return reply({ error: 'The adjustment amount must be a number other than 0.' }, 400);
      if (Math.abs(amount) > 1e10) return reply({ error: 'That amount is not realistic.' }, 400);
      const ct = await closedThrough();
      if (ct && from <= ct) return reply({ error: `The books are closed through ${ct} - that period cannot be adjusted any more.`, code: 'closed' }, 409);
      const kind = body.kind === 'zero' ? 'zero' : 'amount';
      await db.prepare(`INSERT OR IGNORE INTO profit_adjustments (client_id, adj_id, kind, date_from, date_to, amount, reported_before, reported_after, reason, reverses, actor, actor_kind, at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)`)
        .bind(clientId, id, kind, from, to, amount, before, before === null ? null : money(before + amount), reason, actor, actorKind, now).run();
      return reply({ ok: true, adjustment: await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? AND adj_id = ?`).bind(clientId, id).first(), who: proof.who });
    }

    if (action === 'reverse') {
      const id = txt(body.adjId, 80), of = txt(body.reverseOf, 80);
      if (!ID.test(id) || !of) return reply({ error: 'Missing request id.' }, 400);
      const orig = await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? AND adj_id = ?`).bind(clientId, of).first();
      if (!orig) return reply({ error: 'That adjustment was not found.' }, 404);
      if (orig.kind === 'reversal') return reply({ error: 'A reversal cannot itself be reversed - record a new adjustment instead.' }, 400);
      const ct = await closedThrough();
      if (ct && orig.date_from <= ct) return reply({ error: `The books are closed through ${ct} - that adjustment stays.`, code: 'closed' }, 409);
      try {
        await db.prepare(`INSERT INTO profit_adjustments (client_id, adj_id, kind, date_from, date_to, amount, reported_before, reported_after, reason, reverses, actor, actor_kind, at) VALUES (?,?,'reversal',?,?,?,NULL,NULL,?,?,?,?,?)`)
          .bind(clientId, id, orig.date_from, orig.date_to, money(-orig.amount), reason, of, actor, actorKind, now).run();
      } catch (e) {
        const again = await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? AND reverses = ?`).bind(clientId, of).first();
        if (again) return reply({ ok: true, replay: true, adjustment: again });
        throw e;
      }
      return reply({ ok: true, adjustment: await db.prepare(`SELECT * FROM profit_adjustments WHERE client_id = ? AND adj_id = ?`).bind(clientId, id).first() });
    }

    if (action === 'setClosed') {
      const through = String(body.through || '');
      if (through && !DAY.test(through)) return reply({ error: 'Give a date (YYYY-MM-DD) or nothing to reopen.' }, 400);
      const ct = await closedThrough();
      if (ct && through && through < ct && actorKind === 'manager') return reply({ error: 'Only the Admin can move the closing date back.' }, 403);
      await db.batch([
        db.prepare(`INSERT INTO cc_settings (client_id, k, v, actor, updated_at) VALUES (?, 'closed_through', ?, ?, ?) ON CONFLICT (client_id, k) DO UPDATE SET v = excluded.v, actor = excluded.actor, updated_at = excluded.updated_at`).bind(clientId, through, actor, now),
        db.prepare(`INSERT INTO stock_audit (client_id, ev_id, at, kind, code, name, detail, reason, actor, actor_kind) VALUES (?,?,?,?,NULL,NULL,?,?,?,?)`).bind(clientId, 'close-' + now.toString(36) + Math.random().toString(36).slice(2, 6), now, 'books_closed', through ? `Books closed through ${through}${ct ? ' (was ' + ct + ')' : ''}` : `Books reopened (were closed through ${ct || '-'})`, reason, actor, actorKind),
      ]);
      return reply({ ok: true, settings: { closedThrough: through || null } });
    }

    // action === 'event'
    const evId = txt(body.evId, 80), kind = txt(body.kind, 40);
    if (!ID.test(evId)) return reply({ error: 'Missing request id.' }, 400);
    if (!EVENT_KINDS.has(kind)) return reply({ error: 'Unknown kind of stock action.' }, 400);
    await db.prepare(`INSERT OR IGNORE INTO stock_audit (client_id, ev_id, at, kind, code, name, detail, reason, actor, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(clientId, evId, now, kind, txt(body.code, 80) || null, txt(body.name, 160) || null, txt(body.detail, 1000) || null, reason, actor, actorKind).run();
    return reply({ ok: true, who: proof.who });
  } catch (e) {
    return reply({ error: 'The database did not answer - nothing was changed. Try again.', code: 'busy', detail: String((e && e.message) || e).slice(0, 160) }, 503);
  }
}

function nextDay(d) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }
