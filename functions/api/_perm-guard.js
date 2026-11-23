// functions/api/_perm-guard.js - shared helper, NOT a route (zip 292). Server-side permission checks for the cash and serial-unit lists.
//
// Until now these checks lived only in the app. The sync server holds the shop's data as one synced state, so a changed record cannot be
// attributed from the record alone; the staff session that signed the push (X-Staff-Token, see _staff-auth.js) can. This module compares
// what a push CHANGES against what the server already stores, and a change that needs a manager is kept out of the stored state when the
// signed-in staff member is not one.
//
// SWITCH: it acts only when the shop has turned "staff sessions required" on (readMode === 'enforce', the same opt-in switch as every other
// staff action on the server). With it off nothing changes. The rest of the push is never refused: only the record that needs more
// authority is replaced by the stored one (a held record is reported back as `held` and logged as a security event). A push from a
// manager, the Admin, or a shop that has not switched enforcement on goes through untouched.
//
// Pure functions: no KV, no Durable Object, no network. `getStored(col, record)` returns the stored copy of a record (or null).

const MANAGER_ONLY_LISTS = new Set(['cashConfig', 'cashPoints']);            // cash settings, cashier points and the devices on them
const UNIT_MANAGER_STATES = new Set(['damaged', 'under_repair', 'written_off', 'returned_to_supplier', 'transferred']);   // write-off / damage / repair / supplier return / transfer

export const isManagerClaims = (c) => !!c && !c.expired && (c.mgr === true || (Array.isArray(c.perms) && c.perms.includes('*') && c.mgr === true));

const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } };
const strip = (r) => { if (!r || typeof r !== 'object') return r; const o = { ...r }; delete o.updatedAt; delete o._srv; delete o._auth; delete o._cells; return o; };

// Why this changed record needs a manager, or '' when any staff member may make the change.
export function needsManager(col, incoming, stored, ctx) {
  if (!incoming || typeof incoming !== 'object') return '';
  if (MANAGER_ONLY_LISTS.has(col)) return same(strip(incoming), strip(stored)) ? '' : 'cash settings and cashier points are changed by the Admin or a manager';
  if (col === 'cashSessions') {
    const ic = incoming.closing || null, sc = (stored && stored.closing) || null;
    if (ic && ic.status === 'exempted' && !(sc && sc.status === 'exempted')) return 'exempting a cash session from counting needs a manager';
    const ia = ic && ic.approval && ic.approval.status, sa = sc && sc.approval && sc.approval.status;
    if (ia && ia !== sa && (ia === 'approved' || ia === 'rejected')) return 'approving or rejecting a cash difference needs a manager';
    if ((incoming.corrections || []).length > ((stored && stored.corrections) || []).length) return 'correcting a finished cash count needs a manager';
    return '';
  }
  if (col === 'cashMovements') {
    if (incoming.voided && !(stored && stored.voided)) return 'voiding a cash movement needs a manager';
    return '';
  }
  if (col === 'serialUnits') {
    if (stored && incoming.status !== stored.status && UNIT_MANAGER_STATES.has(incoming.status)) return 'marking a unit damaged, written off, in repair, transferred or returned to the supplier needs a manager';
    if (stored && !same(incoming.ids, stored.ids)) return 'correcting a unit identifier needs a manager';
    return '';
  }
  // zip 328: cancelling a contract issue, merging customers and changing a saved ID number are manager actions (the app checks too; this holds a modified client to it)
  if (col === 'contracts') {
    const sv = new Map(((stored && stored.visits) || []).filter((v) => v && v.id != null).map((v) => [String(v.id), v]));
    for (const v of incoming.visits || []) { if (v && v.status === 'cancelled' && v.id != null && sv.has(String(v.id)) && sv.get(String(v.id)).status !== 'cancelled') return 'cancelling a contract issue needs a manager'; }
    return '';
  }
  if (col === 'customers') {
    if (incoming.mergedInto && !(stored && stored.mergedInto)) return 'merging customers needs a manager';
    if (stored && stored.idNumber && incoming.idNumber !== stored.idNumber) return 'changing a customer\'s ID number needs a manager';
    return '';
  }
  // zip 336 (batches): the cost and the status (usable / quarantined / recalled) of a batch already on file are changed by a manager - that is a
  // cost correction or a medicine-safety decision. Selling from a batch (its qty), a new delivery (a new batch) and a returned batch are anyone's.
  if (col === 'inventory') {
    const sb = new Map(((stored && stored.batches) || []).filter((b) => b && b.id != null).map((b) => [String(b.id), b]));
    const nz = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    for (const b of (incoming.batches || [])) {
      const o = b && b.id != null ? sb.get(String(b.id)) : null;
      if (!o) continue;
      if (nz(b.cost) !== nz(o.cost)) return 'changing the cost of a batch needs a manager (use Cost & profit check)';
      if ((o.status || 'ok') !== (b.status || 'ok')) return 'quarantining, recalling or releasing a batch needs a manager';
    }
    // which batch is sold first (an override of FEFO / FIFO) is a manager decision too; the override ending by itself (its batch sold out) is not
    const of = stored && stored.lotFirst ? String(stored.lotFirst.id) : '', inf = incoming.lotFirst ? String(incoming.lotFirst.id) : '';
    if (inf && inf !== of) return 'choosing which batch is sold first needs a manager';
    return '';
  }
  // zip 340 (M-PESA Agent): the ledger is append-only. A new reversal / adjustment / override, or a change to an entry already posted, needs a
  // manager or the matching grant the manager gave this staff member (Staff & Permissions tab). Settings are manager-only.
  if (col === 'mpesaAgentCfg') return same(strip(incoming), strip(stored)) ? '' : 'M-PESA Agent settings are changed by the Admin or a manager';
  if (col === 'mpesaAgentTx') {
    const grant = (g) => !!(ctx && ctx.claims && ctx.getStored && (((ctx.getStored('mpesaAgentCfg', { id: 'cfg' }) || {}).grants || {})[String(ctx.claims.sid)] || []).includes(g));
    if (stored) {
      const core = (r) => [r.type, r.amount, r.cash, r.float, r.opId, r.ts, r.by, r.byId, r.reversalOf].join('|');
      if (core(incoming) !== core(stored)) return 'a posted M-PESA entry cannot be edited: reverse it instead';
      if (incoming.status === 'reversed' && stored.status !== 'reversed' && !grant('reverse')) return 'reversing an M-PESA entry needs a manager or the Reverse permission';
      return '';
    }
    if (incoming.type === 'reversal' && !grant('reverse')) return 'reversing an M-PESA entry needs a manager or the Reverse permission';
    if (incoming.type === 'adjustment' && !grant('adjust')) return 'an M-PESA adjustment needs a manager or the Adjust permission';
    if (incoming.override && !grant('override')) return 'posting below zero needs a manager or the Override permission';
    return '';
  }
  if (col === 'mpesaAgentClosings') {
    const grant = (g) => !!(ctx && ctx.claims && ctx.getStored && (((ctx.getStored('mpesaAgentCfg', { id: 'cfg' }) || {}).grants || {})[String(ctx.claims.sid)] || []).includes(g));
    const ia = incoming.approval && incoming.approval.status, sa = stored && stored.approval && stored.approval.status;
    if (ia && ia !== sa && !grant('close')) return 'approving or rejecting a day closing needs a manager or the Close permission';
    return '';
  }
  // zip 328 (hospital billing): a charge becomes PAID only through a completed sale, and a paid charge keeps its original amount and description.
  // `ctx.hasSale(id)` says whether that sale is in the same push or already stored. A clinician's modified client cannot simply flip a status.
  if (col === 'patientCharges') {
    const sold = (r) => r && (r.status === 'paid' || r.status === 'billed');
    if (sold(incoming) && !(stored && sold(stored) && stored.paidSaleId === incoming.paidSaleId)) {
      if (!incoming.paidSaleId) return 'a charge can only be marked paid by a completed sale';
      if (ctx && typeof ctx.hasSale === 'function' && !ctx.hasSale(incoming.paidSaleId, incoming.status === 'paid')) return 'a charge can only be marked paid by a completed sale';
    }
    if (stored && sold(stored) && (Number(incoming.price) !== Number(stored.price) || Number(incoming.qty) !== Number(stored.qty) || incoming.name !== stored.name)) return 'the amount and description of a paid charge cannot be changed';
    return '';
  }
  return '';
}

export const GUARDED_LISTS = ['cashConfig', 'cashPoints', 'cashSessions', 'cashMovements', 'serialUnits', 'contracts', 'customers', 'patientCharges', 'inventory', 'mpesaAgentCfg', 'mpesaAgentTx', 'mpesaAgentClosings'];

// -> { body, held: [{ col, id, reason }] }. `auth` = { enforce: boolean, claims }. Returns the body untouched (same object) unless something is held.
export function guardPush(body, getStored, auth) {
  if (!body || typeof body !== 'object' || !auth || !auth.enforce) return { body, held: [] };
  if (isManagerClaims(auth.claims)) return { body, held: [] };
  const held = [];
  let out = body;
  const ctx = { claims: auth.claims, getStored, hasSale: (id, needPaid) => { const k = String(id), ok = (x) => !!x && String(x.id) === k && (!needPaid || x.paid !== false); return (Array.isArray(body.salesLog) && body.salesLog.some(ok)) || ok(getStored('salesLog', { id: k })); } };
  for (const col of GUARDED_LISTS) {
    const list = body[col];
    if (!Array.isArray(list) || !list.length) continue;
    let next = null;
    list.forEach((rec, i) => {
      const stored = getStored(col, rec) || null;
      const reason = needsManager(col, rec, stored, ctx);
      if (!reason) return;
      held.push({ col, id: String((rec && (rec.id != null ? rec.id : rec.code)) || '').slice(0, 60), reason });
      next = next || list.slice();
      next[i] = stored;                    // the stored copy stands (or, for a new forbidden record, nothing)
    });
    if (next) { if (out === body) out = { ...body }; out[col] = next.filter((r) => r != null); }
  }
  return { body: out, held };
}


// zip 340 (M-PESA Agent): a pushed ledger entry must be internally consistent whoever sends it (the Admin included): whole shillings, a known type, and
// deltas that match the type. Anything else is dropped and reported, so a modified client cannot invent money. Pure; no storage access.
export const MPESA_TYPES = ['deposit', 'withdrawal', 'buy_float', 'sell_float', 'cash_in', 'cash_out', 'adjustment', 'reversal'];
const MPESA_MAX = 100000000;
export function mpesaEntryProblem(r) {
  if (!r || typeof r !== 'object') return 'not a record';
  if (r.id == null || String(r.id) === '' || String(r.id).length > 80) return 'missing id';
  if (r._deleted === true || r.removed === true) return '';
  if (!MPESA_TYPES.includes(r.type)) return 'unknown type';
  const ints = [r.cash, r.float, r.amount];
  if (!ints.every((n) => Number.isInteger(n) && Math.abs(n) <= MPESA_MAX)) return 'amounts must be whole shillings';
  const { cash, float: fl, amount: a, type: t } = r;
  if (t === 'adjustment') { if (cash === 0 && fl === 0) return 'an adjustment must change something'; if (!String(r.reason || '').trim()) return 'an adjustment needs a reason'; return ''; }
  if (t === 'reversal') { if (!r.reversalOf) return 'a reversal must name the entry it reverses'; return ''; }
  if (!(a > 0)) return 'the amount must be more than zero';
  if (t === 'deposit') return cash === a && fl === -a ? '' : 'deposit does not balance';
  if (t === 'withdrawal') return cash === -a && fl === a ? '' : 'withdrawal does not balance';
  if (t === 'buy_float') return fl === a && (cash === 0 || cash === -a) ? '' : 'buy float does not balance';
  if (t === 'sell_float') return fl === -a && (cash === 0 || cash === a) ? '' : 'sell float does not balance';
  if (t === 'cash_in') return cash === a && fl === 0 ? '' : 'cash in does not balance';
  if (t === 'cash_out') return cash === -a && fl === 0 ? '' : 'cash out does not balance';
  return '';
}
export function sanitizeMpesaPush(body) {
  const list = body && body.mpesaAgentTx;
  if (!Array.isArray(list) || !list.length) return { body, dropped: [] };
  const dropped = [], ok = [];
  list.forEach((r) => { const p = mpesaEntryProblem(r); if (p) dropped.push({ id: String((r && r.id) || '').slice(0, 60), reason: p }); else ok.push(r); });
  return dropped.length ? { body: { ...body, mpesaAgentTx: ok }, dropped } : { body, dropped };
}
