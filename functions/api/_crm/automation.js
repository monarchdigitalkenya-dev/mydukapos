// functions/api/_crm/automation.js — the in-app Automation screen and the two simple rules behind it (NOT a route). zip 158.
// There is no scheduler on Pages, so rules run lazily: whenever the CRM API is used or a WhatsApp message arrives, at most once a minute (one conditional
// upsert decides who runs it), and every rule is idempotent (an escalation is remembered as an event, a notification has a dedupe key) so a repeat
// or a race never notifies twice. crm_events stays the append-only record: rule firings are appended to it, and the screen lists it.
//   * "A new lead nobody has taken for N minutes"  -> notify the managers (once per lead).            Setting: autoUnassignedLeadMinutes (0 = off)
//   * "A follow-up is overdue by N minutes"        -> notify its owner (managers after a day) once.   Setting: autoFollowupOverdueMinutes (0 = off)
//     (the second one is executed by sweepReminders in followups.js, which reads the setting.)
import { all, first, run, st, many, changes, now, notifySt, emitSt, jparse } from './core.js';
import { readSettings } from './config.js';
import { managers } from './notify.js';

export const RULE_EVENT = 'automation.unassigned_lead_escalated';
const WINDOW_MS = 14 * 24 * 3600000;                      // only leads created in the last two weeks are escalated (no flood when the rule is first switched on)

// `seen` = the value of crm_meta 'auto' that THIS request already read in its first round trip (auth.js). When it is younger than a minute somebody ran the rules
// already and there is nothing to ask the database (zip 161: that write used to be a round trip on every request). No `seen` = decide with the conditional upsert alone.
export async function runAutomation(db, seen) {
  const t = now();
  if (seen && Number.isFinite(seen.auto) && seen.auto >= t - 60000) return { ran: false, escalated: 0 };
  const r = await run(db, `INSERT INTO crm_meta (k, v) VALUES ('auto', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(crm_meta.v AS INTEGER) < ?`, String(t), t - 60000);
  if (changes(r) !== 1) return { ran: false, escalated: 0 };
  const s = await readSettings(db);
  let escalated = 0;
  const n = Number(s.autoUnassignedLeadMinutes) || 0;
  if (n > 0) {
    const leads = await all(db, `SELECT l.id, l.name, l.created_at FROM crm_leads l
      WHERE l.deleted_at IS NULL AND l.owner_id IS NULL AND l.created_at <= ? AND l.created_at >= ?
        AND l.status_key NOT IN (SELECT key FROM crm_statuses WHERE is_won = 1 OR is_lost = 1)
        AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.name = ? AND e.lead_id = l.id)
      ORDER BY l.created_at LIMIT 50`, t - n * 60000, t - WINDOW_MS, RULE_EVENT);
    if (leads.length) {
      const mg = await managers(db, null);
      for (const l of leads) {
        const mins = Math.round((t - l.created_at) / 60000);
        await db.batch([
          emitSt(db, null, RULE_EVENT, { entity: 'lead', entityId: l.id, leadId: l.id, data: { waitedMinutes: mins, thresholdMinutes: n, notified: mg.length } }, t),
          ...mg.map((u) => notifySt(db, u.id, 'lead_unassigned_late', `Nobody has taken this lead: ${l.name}`, `Waiting ${mins} min (rule: ${n} min)`, { leadId: l.id, entity: 'lead', entityId: l.id, dedupe: `auto-unassigned:${l.id}:${u.id}`, at: t })),
        ]);
        escalated++;
      }
    }
  }
  return { ran: true, escalated };
}

// GET /automation — the screen: the rules with their current values, and the recent events (newest first) with what happened to them
export async function automationOverview(ctx) {
  const { db, actor } = ctx;
  if (!actor.has('settings.manage') && !actor.has('settings.integrations')) actor.require('settings.manage');
  const s = await readSettings(db);
  const [rows, [pc]] = await many(db, [st(db, `SELECT * FROM crm_events ORDER BY id DESC LIMIT 60`), st(db, `SELECT COUNT(*) n FROM crm_events WHERE processed_at IS NULL`)]);   // zip 161: one trip
  const pending = pc.n;
  return {
    rules: [
      { key: 'autoUnassignedLeadMinutes', label: 'A new lead nobody has taken', action: 'Notify the managers', unit: 'minutes', value: s.autoUnassignedLeadMinutes, off: s.autoUnassignedLeadMinutes === 0 },
      { key: 'autoFollowupOverdueMinutes', label: 'A follow-up is overdue', action: 'Notify its owner (the managers too after a day)', unit: 'minutes', value: s.autoFollowupOverdueMinutes, off: s.autoFollowupOverdueMinutes === 0 },
    ],
    canEdit: actor.has('settings.manage'),
    events: rows.map((e) => ({ id: e.id, name: e.name, entity: e.entity, entityId: e.entity_id, leadId: e.lead_id, actorName: e.actor_name, data: jparse(e.data), at: e.at, processedAt: e.processed_at })),
    pendingEvents: pending,
  };
}
