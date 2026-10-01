// functions/api/_merge.js — shared helper, NOT a route.
//
// The merge rules for a shop's synced state, extracted unchanged from pos-sync.js so that BOTH storage backends use exactly
// the same logic: the single-blob KV backend (pos-sync.js) and the per-shop SQLite Durable Object (wildcard-router/shop-store.js).
// Pure functions only — no KV, no Durable Object, no network.

// Merges an incoming array of records against whatever's already stored,
// matched by a stable per-record key (id, falling back to code — inventory
// items across the app suite are keyed by `code`, not `id`), keeping
// whichever side of each conflicting record has the newer updatedAt. This
// is what turns "last full push wins" into real per-record conflict
// resolution: if Device A edits an item's price/name (or adds a staff
// member) and pushes, then Device B — still holding an older in-memory
// copy that never had that change, e.g. because B was offline at the time
// — pushes moments later, this merge means B's stale copy of THAT record
// can't silently erase A's newer one, even though B's push still carries
// its own (older) version of everything it didn't touch. A record only
// ever loses to a NEWER one, not to "whichever happened to be posted
// last." This is the fix for: edit a price/name on one device, and it
// reverts after another device (that missed the edit) syncs.
//
// Requires each record to carry an `updatedAt` (ms epoch) set by the
// front-end whenever that specific record is created or changed. Records
// missing it are treated as updatedAt: 0 — oldest possible — so a legacy
// record without one always loses to any record that does carry a real
// timestamp, and only wins against another equally timestamp-less record
// by whichever happens to be seen last (no worse than the pre-merge
// behavior for data that predates this).
//
// Deletion is a tombstone, not an absence: the front-end marks a removed
// staff member with `removed: true` rather than dropping it from the
// array, precisely so this merge has a real record — with its own
// updatedAt — to compare instead of just seeing the id vanish. A key
// present in the existing array but missing from the incoming one is left
// exactly as it was (covers a device sending a shorter, older array from
// before that record even existed — never treated as a deletion).
export function recordKey(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.id != null) return `id:${r.id}`;
  if (r.code != null) return `code:${r.code}`;
  // pendingInvites records have no `id` — they're identified by `token`
  // everywhere else in the front-end (pos_pending_invites lookups, accept/
  // revoke flows all match on i.token). Without this, every invite record
  // falls back to "keyless" and this merge can't protect a freshly-created
  // invite on one device from being lost if another, staler device pushes
  // before that device has pulled it.
  if (r.token != null) return `token:${r.token}`;
  return null;
}

// Lists whose records are given a fresh unique id when they are created and are never re-created under the same id. For these a tombstone
// is FINAL: once a bill / debt / supplier ... has been deleted (a bill fully settled and removed, say) no later copy of it can bring it back.
// Without this, a till that was asleep or slow to sync and still held the record only had to TOUCH it (a reminder flag, a takeaway status) to
// give it a newer `updatedAt` than the tombstone, and the settled bill reappeared on every till after its next refresh. (Lists keyed by `code`
// — inventory — are different: the same code is deliberately added again, so a newer record still replaces the tombstone there.)
export const FINAL_TOMBSTONE_FIELDS = ['bills', 'debts', 'suppliers', 'deliveryZones', 'recurringExpenses', 'contracts',
  // Services engine (SERVICES_ARCHITECTURE.md 3.4): unique ids that are never re-created, so a deleted job / appointment / catalog entry stays deleted.
  'svcJobs', 'svcAppointments', 'svcCatalog'];

// A bill only ever moves FORWARD: voided, then closed (settled), then more money paid, then more payments recorded. A till that was slow to
// sync still holds the bill as it was (open, unpaid); when it pushes it with a newer time it must not put the bill back to that state — that
// re-opened settled bills and made a payment "disappear" from the bill it was taken on. So for bills the more advanced record wins whatever
// the times say; only two equally advanced records fall back to last-write-wins.
export function billProgress(r) {
  const paid = Number(r && r.amountPaid) || 0;
  return [r && r.voided ? 1 : 0, r && r.closed ? 1 : 0, Math.round(paid * 100), Array.isArray(r && r.paymentHistory) ? r.paymentHistory.length : 0];
}
export function compareBillProgress(a, b) {
  const x = billProgress(a), y = billProgress(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// PAYMENTS ARE NEVER LOST (zip 156). Two tills each taking a payment on the SAME bill (or debt) at the same moment: the "more advanced" bill (or the
// newer debt) replaced the other WHOLE, so one of the two payments — real money handed over — was gone, and the amount paid was short. Now the
// payments of both copies are UNIONED: by the payment's id (every payment gets a unique one), and by its content when a legacy payment has none.
// A payment is never removed (there is no "delete a payment"), so a union cannot bring anything back that was deliberately taken away.
const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export function paymentKey(p) {
  if (p && typeof p === 'object') return p.id != null ? 'id:' + p.id : 'sig:' + [p.timestamp || p.at || '', money2(p.amount), p.method || '', p.reference || ''].join('|');
  return 'raw:' + JSON.stringify(p);
}
export function unionPayments(base, other) {
  const a = Array.isArray(base) ? base : [], b = Array.isArray(other) ? other : [];
  if (!b.length) return { list: a, added: false };
  const seen = new Set(a.map(paymentKey));
  const extra = [];
  for (const p of b) { const k = paymentKey(p); if (!seen.has(k)) { seen.add(k); extra.push(p); } }
  if (!extra.length) return { list: a, added: false };
  let list = a.concat(extra);
  const times = list.map((p) => Date.parse(p && (p.timestamp || p.at)));
  if (times.every(Number.isFinite)) list = list.map((p, i) => ({ p, i, t: times[i] })).sort((x, y) => (x.t - y.t) || (x.i - y.i)).map((x) => x.p);   // oldest first, as recorded
  return { list, added: true };
}
// Bill lines: a line on one copy and not on the other is kept (lines are only ever added, never edited in place). Lines have no id, so the
// same line on both copies is recognised by its content, and repeats of one line (two identical lines) are counted.
const lineSig = (l) => (l && typeof l === 'object' ? [l.code, l.name, Number(l.price) || 0, Number(l.qty) || 0, l.unit || '', l.saleMode || ''].join('|') : 'raw:' + JSON.stringify(l));
export function unionLines(base, other) {
  if (!Array.isArray(base) || !Array.isArray(other) || !other.length) return { list: base, added: false };
  const have = new Map();
  base.forEach((l) => { const k = lineSig(l); have.set(k, (have.get(k) || 0) + 1); });
  const seen = new Map(), extra = [];
  other.forEach((l) => { const k = lineSig(l); seen.set(k, (seen.get(k) || 0) + 1); if (seen.get(k) > (have.get(k) || 0)) extra.push(l); });
  return extra.length ? { list: base.concat(extra), added: true } : { list: base, added: false };
}
const paymentsTotal = (h) => money2((Array.isArray(h) ? h : []).reduce((n, p) => n + (Number(p && p.amount) || 0), 0));

// Two copies of one bill -> the bill. The winner of the rest of the record is decided exactly as before (more advanced wins whatever the times
// say; two equally advanced: newest wins). On top of that: payments and lines of both are kept, the amount paid is recomputed from them (never
// less than either copy said), and the bill is closed when that pays it off — a closed bill stays closed, a voided bill stays voided.
export function mergeBillRecords(stored, incoming) {
  const c = compareBillProgress(stored, incoming);
  const exTs = Number(stored.updatedAt) || 0, inTs = Number(incoming.updatedAt) || 0;
  const base = c > 0 ? stored : c < 0 ? incoming : (inTs >= exTs ? incoming : stored);
  const other = base === stored ? incoming : stored;
  const pay = unionPayments(base.paymentHistory, other.paymentHistory);
  const lines = unionLines(base.items, other.items);
  if (!pay.added && !lines.added) return base;
  const out = { ...base, updatedAt: Math.max(exTs, inTs) };
  if (pay.added) out.paymentHistory = pay.list;
  if (lines.added) out.items = lines.list;
  // paid = the payments of both copies + any paid amount that has no payment record behind it (legacy bills), never less than either copy
  const untracked = (r) => Math.max(0, money2((Number(r.amountPaid) || 0) - paymentsTotal(r.paymentHistory)));
  out.amountPaid = money2(Math.max(paymentsTotal(out.paymentHistory) + Math.max(untracked(base), untracked(other)), Number(base.amountPaid) || 0, Number(other.amountPaid) || 0));
  if (!out.voided) {
    const total = money2((Array.isArray(out.items) ? out.items : []).reduce((n, l) => n + (Number(l && l.price) || 0) * (Number(l && l.qty) || 0), 0));
    const outstanding = money2(Math.max(0, total - out.amountPaid));
    const paidOff = outstanding <= 0.005 && total > 0;
    const pendingPickup = out.fulfillmentType === 'held_in_shop' && !out.inventoryDeducted;
    out.closed = !!(base.closed || other.closed || (paidOff && !pendingPickup));      // a settled bill never re-opens
    out.status = out.closed || paidOff ? 'fully_paid' : (out.amountPaid > 0 ? 'partially_paid' : 'unpaid');
    if (out.closed && !out.closedAt) out.closedAt = base.closedAt || other.closedAt || new Date(out.updatedAt).toISOString();
  }
  return out;
}
// Two copies of one debt -> the debt: newest wins the rest of the record, the payments of both are kept.
export function mergeDebtRecords(stored, incoming) {
  const exTs = Number(stored.updatedAt) || 0, inTs = Number(incoming.updatedAt) || 0;
  const base = inTs >= exTs ? incoming : stored;
  const other = base === stored ? incoming : stored;
  const pay = unionPayments(base.payments, other.payments);
  if (!pay.added) return base;
  return { ...base, payments: pay.list, updatedAt: Math.max(exTs, inTs) };
}

// Aqua POS products are ONE shared catalogue whose stock is held per site inside the record
// (`stock` = { siteId: qty }, `bottleStockBySite` for bottle-tracked bales). Merging the whole record
// last-write-wins let a stale push from one site (a Shop till selling one bottle) wipe out what another
// site (Production) had just produced. So the record-level winner still decides every ordinary field, but
// each SITE's stock is taken from whichever side changed THAT site most recently (`siteTimes[siteId]`, stamped
// by the app whenever it changes a site's stock). A site with no stamp on either side (older data) simply
// follows the record winner, exactly as before.
export function mergeProductRecords(stored, incoming) {
  const st = Number(stored && stored.updatedAt) || 0, it = Number(incoming && incoming.updatedAt) || 0;
  const incWins = it >= st;
  const winner = incWins ? incoming : stored;
  if (!stored || !incoming || stored._deleted === true || incoming._deleted === true) return winner;
  const MAPS = ['stock', 'bottleStockBySite'];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!MAPS.some((m) => isObj(stored[m]) || isObj(incoming[m]))) return winner;
  const tS = isObj(stored.siteTimes) ? stored.siteTimes : {}, tI = isObj(incoming.siteTimes) ? incoming.siteTimes : {};
  const sites = new Set([...Object.keys(tS), ...Object.keys(tI)]);
  MAPS.forEach((m) => { [stored[m], incoming[m]].forEach((o) => { if (isObj(o)) Object.keys(o).forEach((k) => sites.add(k)); }); });
  const out = { ...winner };
  MAPS.forEach((m) => { out[m] = { ...(isObj(winner[m]) ? winner[m] : {}) }; });
  const times = { ...(isObj(winner.siteTimes) ? winner.siteTimes : {}) };
  sites.forEach((k) => {
    const a = typeof tS[k] === 'number' ? tS[k] : 0, b = typeof tI[k] === 'number' ? tI[k] : 0;
    if (!a && !b) return;                                  // neither side ever stamped this site: the record winner decides
    const src = b >= a ? incoming : stored;                // tie: the incoming push
    MAPS.forEach((m) => { if (isObj(src[m]) && typeof src[m][k] === 'number') out[m][k] = src[m][k]; });
    times[k] = Math.max(a, b);
  });
  if (Object.keys(times).length) out.siteTimes = times;
  return out;
}

// RECORDS THAT GROW BY APPENDING (zip 119). A hotel tab collects orders from several tills; a cashier shift collects manager
// adjustments. Newest-whole-record-wins lost one till's order (or one manager's adjustment) whenever two landed in the same sync
// window, and a stale copy could re-open a closed tab/shift or put an approval back to "pending". Now: the listed arrays are
// unioned by id (nothing in them is ever removed), the status only moves forward, and a decided approval is never undone.
export const NESTED_MERGE = {
  // MOVED: everything moved to another order (zip 134). lineStatus: the kitchen / bar display's status per line — merged per line, the
  // newest wins, so a kitchen tablet marking "ready" and a waiter adding a round at the same moment never undo each other (zip 135).
  // zip 142: a keg container. usedBy[device] = { ml, at } is what ONE device served from it (only that device writes its key), so
  // two bartenders on two tills always add up and a re-sent push changes nothing; wastage / measurements / status changes are
  // events joined by id; the status only moves forward (Full → Active → Empty → Closed / Spoiled).
  kegs: { arrays: ['events'], status: { FULL: 0, ACTIVE: 1, DISCONNECTED: 1, EMPTY: 2, CLOSED: 3, SPOILED: 3 }, maps: { usedBy: 'at' } },
  tabs: { arrays: ['orders', 'partPayments'], status: { OPEN: 0, CLOSED: 1, MOVED: 1, VOID: 2 }, maps: { lineStatus: 'at', lineNotes: null } },
  cashShifts: { arrays: ['adjustments'], status: { open: 0, closed: 1 } },
  // zip 132: two devices adding images to the same imaging order keep both. No status ranking (a corrected report legitimately
  // goes from "verified" back to "reported"): the newest record decides the rest. For the same image, what is further along
  // wins: removed > uploaded > still uploading.
  radiologyOrders: { arrays: ['images'], status: {}, better: (a, b) => {
    const rank = (x) => (x && x.removedAt ? 2 : x && x.status === 'uploaded' ? 1 : 0);
    return rank(b) > rank(a) ? b : a;
  } },
  // Services engine (SERVICES_ARCHITECTURE.md 3.4). A job's hot-path arrays are append-only and unioned by element id, so two tills adding a
  // charge / material / payment / status entry to the same job at the same moment both survive; an element edited in place (voided, reversed)
  // carries a higher per-element `rev` and wins. `rankBy:'phase'`: a job already closed (phase 3/4) is never put back to open by a stale copy.
  svcJobs: { arrays: ['statusHistory', 'charges', 'materials', 'payments', 'audit', 'notify', 'jobStaff', 'valuables', 'photos', 'quoteVersions', 'quoteLog'],
    status: {}, rankBy: 'phase',
    better: (a, b) => (((b && b.rev) || 0) > ((a && a.rev) || 0) ? b : (b && b.voidedAt && !(a && a.voidedAt) ? b : a)) },
  // An asset keeps its visit history after the jobs are archived; the rings of two tills are unioned by id (history entries use the job id).
  svcAssets: { arrays: ['history', 'ownerHistory'], status: {}, better: (a, b) => (((b && b.at) || 0) > ((a && a.at) || 0) ? b : a) },
};
export function mergeNestedRecord(field, stored, incoming) {
  const spec = NESTED_MERGE[field];
  const st = Number(stored && stored.updatedAt) || 0, it = Number(incoming && incoming.updatedAt) || 0;
  let base = it >= st ? incoming : stored;
  const other = base === incoming ? stored : incoming;
  // rankBy: rank from a numeric field of the record (svcJobs: `phase`) instead of a status map
  const rank = spec.rankBy
    ? (r) => (r && r[spec.rankBy] != null && Number.isFinite(Number(r[spec.rankBy])) ? Number(r[spec.rankBy]) : -1)
    : (r) => (r && spec.status[r.status] !== undefined ? spec.status[r.status] : -1);
  if (rank(other) > rank(base)) base = other;                                   // the further-along record decides the rest
  const out = { ...base };
  spec.arrays.forEach((f) => {
    const a = Array.isArray(base[f]) ? base[f] : [], b = Array.isArray(base === stored ? incoming[f] : stored[f]) ? (base === stored ? incoming[f] : stored[f]) : [];
    const seen = new Set(a.map((x) => (x && x.id != null ? String(x.id) : null)).filter(Boolean));
    const extra = b.filter((x) => x && x.id != null && !seen.has(String(x.id)));
    let merged = a;
    if (spec.better) {
      const byId = new Map(b.filter((x) => x && x.id != null).map((x) => [String(x.id), x]));
      merged = a.map((x) => (x && x.id != null && byId.has(String(x.id)) ? spec.better(x, byId.get(String(x.id))) : x));
    }
    if (extra.length || Array.isArray(base[f])) out[f] = merged.concat(extra);
  });
  Object.entries(spec.maps || {}).forEach(([f, timeKey]) => {
    const a = base[f] && typeof base[f] === 'object' ? base[f] : {}, b = other[f] && typeof other[f] === 'object' ? other[f] : {};
    if (!Object.keys(b).length) return;
    const m = { ...a };
    Object.entries(b).forEach(([k, v]) => {
      if (!(k in m)) { m[k] = v; return; }
      if (timeKey && v && m[k] && (Number(v[timeKey]) || 0) > (Number(m[k][timeKey]) || 0)) m[k] = v;
    });
    out[f] = m;
  });
  if (field === 'cashShifts') {
    const decided = (r) => r && r.approval && (r.approval.status === 'approved' || r.approval.status === 'rejected');
    if (!decided(out) && decided(other)) out.approval = other.approval;
  }
  return out;
}

// INVENTORY RECORD MERGE (zip 152). Whole-record newest-wins lost data that lives ON the record but was not what the newer
// edit was about: a till that only changed stock (or was a stale copy loaded before the photo / pour setup was added) carries
// `image: null` and no pour fields, and its newer updatedAt then erased the photo and the shot/tot setup saved on another
// device. The newest record still decides everything it actually states; but a field it leaves EMPTY (absent, null, '')
// keeps the older record's value. There is no "remove photo" action on an item, so an empty photo is never a deliberate clear.
export const INVENTORY_STICKY_FIELDS = ['image', 'imageUrl', 'imageKey', 'pourOf', 'bottleMl', 'shotMl', 'totMl', 'shotPrice', 'totPrice', 'pours', 'pourSizes', 'servings', 'keg'];
const emptyVal = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
export function mergeInventoryRecord(existing, incoming) {
  const st = Number(existing.updatedAt) || 0, it = Number(incoming.updatedAt) || 0;
  const win = it >= st ? incoming : existing, lose = win === incoming ? existing : incoming;
  let out = win;
  for (const f of INVENTORY_STICKY_FIELDS) {
    if (emptyVal(win[f]) && !emptyVal(lose[f])) { if (out === win) out = { ...win }; out[f] = lose[f]; }
  }
  return out;
}

// zip 158: records that only ever move FORWARD: a trade credit goes open -> settled, a shift goes clocked in -> clocked out. Neither list stamps
// `updatedAt` on edit, so the ordinary "newer wins, a tie goes to the incoming copy" rule let a device that had not pulled yet (its first push of a
// session sends its whole list) put its OLD "open" copy on top of a settlement made on another till: the debt came back to life. The more advanced
// copy now wins whatever the order they arrive in; equally advanced copies fall back to the ordinary rule.
export const PROGRESS_FIELDS = ['tradeCredits', 'attendanceLog'];
function progressOf(field, r) {
  if (!r || typeof r !== 'object') return 0;
  if (field === 'tradeCredits') return r.status === 'settled' || r.settledAt ? 1 : 0;
  if (field === 'attendanceLog') return r.clockOut != null && r.clockOut !== '' ? 1 : 0;
  return 0;
}
export function mergeProgressRecord(field, existing, incoming) {
  const pe = progressOf(field, existing), pi = progressOf(field, incoming);
  if (pe !== pi) return pi > pe ? incoming : existing;
  return (incoming.updatedAt || 0) >= (existing.updatedAt || 0) ? incoming : existing;
}

// ---- Loyalty tokens (zip 158) ------------------------------------------------------------------------------------------------
// `customer.tokens` was a plain number, so it was last-write-wins like every other field of the customer: two tills each awarding tokens to the same
// customer (5 -> 6 on one, 5 -> 6 on the other) ended at 6, and a stale copy of the customer could put the balance back. A till now records what
// IT awarded in `tokenLedger` = { <deviceId>: <tokens awarded by that device> } (a device only ever raises its own entry) on top of `tokenBase` (the
// balance before the ledger began, fixed once); `tokens` stays the total (base + every device's entry) so nothing that reads it changes.
// Merging two copies takes each device's larger entry and the larger base, so awards from any number of tills add up whatever order they arrive
// in, and arriving twice changes nothing. A copy from a till that has no ledger yet (an older release) can only say "the balance is N": if N is
// more than the ledger accounts for, the difference is what that till awarded and is added to the base; if it is less, it is simply older.
// Keep identical to mergeLoyaltyFields in src/shared/functions.js.
export function mergeLoyaltyFields(a, b) {
  const la = a && a.tokenLedger && typeof a.tokenLedger === 'object' ? a.tokenLedger : null;
  const lb = b && b.tokenLedger && typeof b.tokenLedger === 'object' ? b.tokenLedger : null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (!la && !lb) {
    if ((!a || a.tokens === undefined) && (!b || b.tokens === undefined)) return null;
    return { tokens: Math.max(num(a && a.tokens), num(b && b.tokens)) };      // no ledger anywhere: the larger balance (a stale copy never lowers it)
  }
  const ledger = {};
  for (const l of [la, lb]) if (l) for (const [dev, v] of Object.entries(l)) ledger[dev] = Math.max(num(ledger[dev]), num(v));
  const sum = Object.values(ledger).reduce((n, v) => n + v, 0);
  let base = Math.max(la ? num(a.tokenBase) : 0, lb ? num(b.tokenBase) : 0);
  for (const [side, l] of [[a, la], [b, lb]]) {       // a copy without a ledger: an older release that still adds to `tokens` itself
    if (!l && side && side.tokens !== undefined) base += Math.max(0, num(side.tokens) - (base + sum));
  }
  return { tokens: base + sum, tokenBase: base, tokenLedger: ledger };
}

// TANK REFILL LOG (zip 159). Two tills logging a refill on the same tank in the same sync window used to lose one entry (the tank record
// is newest-wins). The log is now unioned by entry id, oldest first, newest 500 kept. A legacy entry without an id gets a deterministic
// one from its fields. Same rule, line for line, as refillEntryId / mergeRefillLogs in src/shared/functions.js.
export function refillEntryId(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.id != null && e.id !== '') return String(e.id);
  const raw = [e.timestamp, e.litersAdded, e.cost, e.supplier, e.servedBy].map((v) => (v == null ? '' : String(v))).join('|');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = (((h << 5) + h) ^ raw.charCodeAt(i)) >>> 0;
  return 'rf-legacy-' + h.toString(36) + '-' + raw.length;
}
export function mergeRefillLogs(a, b, cap, info) {
  const la = a && Array.isArray(a.refillLog) ? a.refillLog : null;
  const lb = b && Array.isArray(b.refillLog) ? b.refillLog : null;
  if (!la && !lb) return null;
  const seen = new Map();
  [la || [], lb || []].forEach((list) => list.forEach((e) => {
    const id = refillEntryId(e);
    if (id == null || seen.has(id)) return;
    seen.set(id, e.id != null && e.id !== '' ? e : { ...e, id });
  }));
  const t = (e) => { const v = Date.parse(e && e.timestamp); return Number.isFinite(v) ? v : 0; };
  const out = [...seen.values()].map((e, i) => [e, i]).sort((x, y) => (t(x[0]) - t(y[0])) || (x[1] - y[1])).map((x) => x[0]);
  const max = cap > 0 ? cap : 500;
  if (info && out.length > max) info.dropped = out.length - max;      // zip 160: how many of the oldest entries this merge let go (see refillLogTruncated)
  return out.length > max ? out.slice(out.length - max) : out;
}

export function mergeRecordsById(existingArr, incomingArr, finalTombstones = false, field = '') {
  if (!Array.isArray(incomingArr)) return existingArr;
  if (!Array.isArray(existingArr) || existingArr.length === 0) return incomingArr;

  // Keyed records (the normal case) are merged per-record below. A record
  // with no id/code at all can't be matched against anything on the other
  // side, so — same as before this generalization existed — it just falls
  // back to "incoming wins": existing's keyless records are dropped and
  // incoming's are kept as-is. Collecting BOTH sides' keyless records here
  // (instead of only incoming's) would double them on every single push,
  // since there'd be no way to ever recognize one as "the same" as another
  // and dedupe it back down.
  const merged = new Map();
  for (const r of existingArr) {
    const key = recordKey(r);
    if (key == null) continue;
    merged.set(key, r);
  }
  const incomingKeyless = [];
  for (const incoming of incomingArr) {
    const key = recordKey(incoming);
    if (key == null) { incomingKeyless.push(incoming); continue; }
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, incoming);
      continue;
    }
    if (finalTombstones && existing._deleted === true && incoming._deleted !== true && key.startsWith('id:')) continue;   // a deleted record stays deleted
    // A stock movement is an immutable event: once the server has it (and has stamped what it did with it, `_srv`), no later
    // copy — a retry, a refresh re-sending everything, a device that never pulled the stamp — may replace it.
    if (field === 'stockMovementLog' && existing._deleted !== true) continue;
    // Bills only move forward, and the payments / lines of both copies are kept (see mergeBillRecords); debts keep the payments of both copies.
    if (field === 'bills' && existing._deleted !== true && incoming._deleted !== true) {
      merged.set(key, mergeBillRecords(existing, incoming)); continue;
    }
    if (field === 'debts' && existing._deleted !== true && incoming._deleted !== true) { merged.set(key, mergeDebtRecords(existing, incoming)); continue; }
    if (field === 'tanks' && existing._deleted !== true && incoming._deleted !== true) {
      const win = (incoming.updatedAt || 0) >= (existing.updatedAt || 0) ? incoming : existing;
      const info = {};
      const log = mergeRefillLogs(existing, incoming, undefined, info);
      // zip 160: the cap used to drop the oldest entries silently. `refillLogTruncated` = at least this many older entries were dropped (max of the copies and this merge, never summed, so a re-merge does not inflate it)
      const lost = Math.max(Number(existing.refillLogTruncated) || 0, Number(incoming.refillLogTruncated) || 0, info.dropped || 0);
      merged.set(key, log ? { ...win, refillLog: log, ...(lost > 0 ? { refillLogTruncated: lost } : {}) } : win); continue;
    }
    if (NESTED_MERGE[field] && existing._deleted !== true && incoming._deleted !== true) { merged.set(key, mergeNestedRecord(field, existing, incoming)); continue; }
    if (PROGRESS_FIELDS.includes(field) && existing._deleted !== true && incoming._deleted !== true) { merged.set(key, mergeProgressRecord(field, existing, incoming)); continue; }
    const existingTs = existing.updatedAt || 0;
    const incomingTs = incoming.updatedAt || 0;
    if (field === 'inventory' && existing._deleted !== true && incoming._deleted !== true) { merged.set(key, mergeInventoryRecord(existing, incoming)); continue; }
    if (field === 'customers' && existing._deleted !== true && incoming._deleted !== true) {
      const win = incomingTs >= existingTs ? incoming : existing;
      const lf = mergeLoyaltyFields(existing, incoming);
      merged.set(key, lf ? { ...win, ...lf } : win); continue;
    }
    merged.set(key, field === 'products' ? mergeProductRecords(existing, incoming) : (incomingTs >= existingTs ? incoming : existing));
  }
  // Keyed records in their merged-map order (existing order, with
  // incoming-only records appended), then incoming's keyless records (if
  // any) tacked on at the end.
  return [...merged.values(), ...incomingKeyless];
}

// Fields this merge applies to, each matched by whichever stable key its
// records actually carry (`id` for most; `code` for inventory/products,
// see recordKey() above). This covers every synced list that's genuinely
// edited in place after creation — not just appended to — since those are
// exactly the lists where "whichever device's push landed last wins"
// silently reverts someone's edit: staff and pendingInvites (roles/access),
// inventory/products (price, name, qty), customers, suppliers, delivery
// zones/agents, offers, bills, debts, recurringExpenses, contracts,
// staffShifts, attendanceRoster. Also included: the append-only transaction
// logs (salesLog, stockMovementLog, returns, expenses, tradeCredits,
// crossBranchSalesFacilitated, savedBarcodes, attendanceLog,
// adminActivityLog, billNotifications, pendingExchanges) —
// even though those are rarely edited after creation, merging them by id
// is still strictly safer than a wholesale replace: it unions two devices'
// concurrent new entries instead of one push's log silently clobbering the
// other's, at no extra cost since an unedited record's id simply doesn't
// conflict. Each front-end stamps `updatedAt` on a record at the moment
// it's actually written to (see each app's collectSyncPayload()/doPush()
// and their generalized stampDirtyInventory()/stampDirtyExtraSyncedFields()
// — they run a dirty-check against the last-known-synced snapshot right
// before serializing, so ANY change to a record gets a fresh timestamp
// without every individual edit site needing to set it by hand).
// Deliberately NOT applied to fields that aren't arrays of id/code-bearing
// records at all — tables/rooms are plain strings ("Table 01"), not
// objects, so there's no key to merge on (they fall back to ordinary
// wholesale replace, same as always); tableStates/roomStates are single
// keyed objects, not arrays; loyaltyTiers has no per-tier id.
export const MERGE_BY_ID_FIELDS = [
  'staff', 'pendingInvites', 'inventory', 'products',
  'customers', 'suppliers', 'deliveryZones', 'deliveryAgents', 'offers',
  'bills', 'debts', 'recurringExpenses', 'contracts', 'staffShifts',
  'attendanceRoster', 'sites',
  // Hotel/HMS: Tab Management's open tabs (table/room/guest tabs — see
  // Check-In/Check-Out and the Folio). Edited in place (orders appended,
  // status OPEN -> CLOSED/VOID), and different tills opening/appending to
  // DIFFERENT tabs must both survive a merge — plain wholesale replace
  // would let one till's push silently erase every other till's open tabs.
  // Note: this still resolves two tills editing the exact SAME tab id at
  // the exact same time by last-write-wins on that whole tab record (the
  // same trade-off every other field in this list accepts) — it does not
  // give tabs the additive per-order union that qty/stockMovementLog get
  // below, so two tills appending different orders to the same already-
  // open tab within the same sync window can still have one append lost.
  'tabs',
  // Aqua POS bulk tanks (per site). Volumes/settings edited in place; removal is a `removed: true` tombstone.
  'tanks',
  // Aqua POS: Shop -> Production stock requests (edited in place: pending -> fulfilled). Merged per record so two tills' requests both survive.
  'stockRequests',
  'salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits',
  'crossBranchSalesFacilitated', 'savedBarcodes', 'attendanceLog',
  'adminActivityLog', 'billNotifications', 'pendingExchanges', 'dispatchLog', 'patientCharges',
  // Orders tab: supplier purchase orders. Edited in place (status, per-line receivedQty), so they need the
  // per-record merge. Removal is a `removed: true` tombstone, like staff.
  'purchaseOrders',
  // Hospital/HMIS clinical records. Previously replaced as whole arrays, so two devices (reception + triage + doctor) could overwrite each
  // other. Now per-record newest-updatedAt-wins; removals (patients, notes, lab requests, appointments, queue entries) are tombstones.
  'patients', 'visits', 'labResults', 'admissions', 'appointments', 'queue', 'patientNotes',
  // Hospital cashier shifts (open -> closed -> approval / adjustments). Merged per record so two tills' shifts both survive.
  'cashShifts',
  // Refund / approval requests (pending -> approved / rejected / cancelled).
  'approvalRequests',
  // Hospital insurers/institutions and their claim lines (claim lifecycle). Per-record merge instead of whole-array replace.
  'institutions', 'institutionCharges',
  // Hospital radiology / imaging orders (requested -> ... -> verified).
  'radiologyOrders',
  // Hospital theatre / procedure cases.
  'theatreCases',
  // Hospitality (zip 137): bookable resources (pools, pool tables, cabanas, conference rooms …), their timed sessions / passes, and
  // facility reservations. Edited in place (status, pauses, charges), so merged per record.
  'resources', 'resourceSessions', 'facilityBookings',
  // Hotel service requests (towels, cot, laundry, setups, maintenance: requested -> assigned -> in progress -> done). zip 138
  'serviceRequests',
  // Custom orders (cakes, special meals, catering, events): request -> quote -> approval -> deposit -> ... -> completed. zip 139
  'customOrders',
  // Draught kegs (zip 142): each keg taken into use, merged per record with NESTED_MERGE.kegs (per-device served counters + events).
  'kegs',
  // Inventory categories (zip 159, Hotel POS): one record per category (id, type, name, active, order). Removal is a `_deleted` tombstone kept in the
  // list, so a till that missed the deletion cannot bring the category back. Newest updatedAt wins per category.
  'inventoryCategories',
  // Aqua POS raw materials (caps, labels, preforms ...). Were replaced as ONE whole list, so any device's push put back every
  // other device's material edits and stock counts. Now per record (its stock is ledger-managed: see CELL_SPECS).
  'rawMaterials',
  // Services engine (SERVICES_ARCHITECTURE.md 3.1): jobs (NESTED_MERGE.svcJobs), vehicles/devices, price catalogue, appointments and per-kind
  // settings records. All merged per record by id. (The legacy serviceJobs / bookings are deliberately NOT here: they stay whole-value.)
  'svcJobs', 'svcAssets', 'svcCatalog', 'svcAppointments', 'svcConfig',
];

// --- Quantity reconciliation (fixes the lost-update problem) ---------------
// DISABLED — kept below, renamed, but no longer called from
// mergeIncomingState() or shop-store.js. This used to make qty/pieceQty
// additive across concurrent offline sales of the same item on two tills.
// In production it turned out to be the source of a worse and far more
// common problem: qty edits doubling or reverting on ordinary refreshes —
// real, repeated, reported data corruption, not a rare edge case.
//
// The trade-off this removal accepts: the one scenario this specifically
// protected — two tills each selling the LAST unit of the same item while
// BOTH are offline at the same time — can now lose one of those two
// decrements (stock briefly reads one higher than physically true, until
// the next manual stock take corrects it). Judged the smaller risk.
//
// What still applies, unaffected by this change: every record — inventory
// included — still gets ordinary per-record "newest updatedAt wins" merging
// via mergeRecordsById()/upsert() above. A real edit, with its own fresh
// timestamp, is never reverted by an older push landing after it. Only the
// additive delta-replay on top of that whole-record merge is removed.
function reconciledQuantities_DISABLED(existingArr, mergedArr, mergedLog) {
  if (!Array.isArray(mergedArr)) return mergedArr;
  const now = Date.now();

  const byCodeUnit = new Map(); // "code|unit" -> [{ts, delta}, ...]
  if (Array.isArray(mergedLog)) {
    for (const e of mergedLog) {
      if (!e || e.code == null || typeof e.delta !== 'number' || !e.delta) continue;
      const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number(e.timestamp);
      if (!Number.isFinite(ts)) continue;
      const unit = e.unit === 'pieceQty' ? 'pieceQty' : 'qty';
      const key = `${e.code}|${unit}`;
      if (!byCodeUnit.has(key)) byCodeUnit.set(key, []);
      byCodeUnit.get(key).push({ ts, delta: e.delta });
    }
  }

  const existingByCode = new Map();
  if (Array.isArray(existingArr)) {
    for (const r of existingArr) { if (r && r.code != null) existingByCode.set(r.code, r); }
  }

  // SAME-EPOCH GUARD. A record carries the `updatedAt` of the last edit its device made. If an incoming record has EXACTLY the
  // stored record's updatedAt, it is the same edit — a retry of a push whose reply was lost, or a copy the device hasn't refreshed —
  // so any difference in quantity can only be something the server did since (another till's sales, reconciled below). The
  // ordinary merge lets a tie go to the incoming record, which would put the OLD quantity back; keep the server's instead. A real
  // stock edit always gets a new updatedAt, so it is never affected.
  if (existingByCode.size > 0) {
    mergedArr = mergedArr.map((rec) => {
      if (!rec || rec.code == null) return rec;
      const prior = existingByCode.get(rec.code);
      if (!prior || typeof rec.updatedAt !== 'number' || rec.updatedAt !== prior.updatedAt) return rec;
      let out = null;
      for (const unit of ['qty', 'pieceQty']) {
        if (typeof prior[unit] === 'number' && rec[unit] !== prior[unit]) { out = out || { ...rec }; out[unit] = prior[unit]; }
      }
      if (out && typeof prior._qtySyncedAt === 'number') out._qtySyncedAt = prior._qtySyncedAt;
      return out || rec;
    });
  }
  if (byCodeUnit.size === 0) return mergedArr;

  return mergedArr.map((rec) => {
    if (!rec || rec.code == null) return rec;
    // Batch-tracked (FEFO) items keep their nested `batches` array as
    // ordinary whole-record last-write-wins — reconciling which physical
    // batch lost how much stock isn't something a flat delta can express.
    // The aggregate `qty` below is still worth correcting even for these:
    // it's what the rest of the app reads for "how much is in stock," and
    // pharmacy/hospital's deductStockForSaleUnit logs its batch deductions
    // as a plain qty delta same as everywhere else — so the total stays
    // accurate even though, after a genuinely concurrent batch sale on two
    // offline devices, the specific batch/expiry breakdown behind that
    // total may need a manual once-over.
    const prior = existingByCode.get(rec.code);
    const cursor = (prior && typeof prior._qtySyncedAt === 'number') ? prior._qtySyncedAt : now;
    let changed = false;
    const out = { ...rec };
    for (const unit of ['qty', 'pieceQty']) {
      const deltas = byCodeUnit.get(`${rec.code}|${unit}`);
      if (!deltas || deltas.length === 0) continue;
      const base = (prior && typeof prior[unit] === 'number') ? prior[unit] : (rec[unit] || 0);
      let extra = 0;
      for (const { ts, delta } of deltas) { if (ts > cursor) extra += delta; }
      if (extra !== 0) { out[unit] = Math.max(0, base + extra); changed = true; }
    }
    if (changed || !prior || typeof prior._qtySyncedAt !== 'number') {
      out._qtySyncedAt = now;
      changed = true;
    }
    return changed ? out : rec;
  });
}

// The no-op that actually runs now: quantities are left exactly as the
// ordinary per-record merge (mergeRecordsById, above) already resolved
// them -- whichever side has the newer updatedAt for that whole record.
export function reconcileQuantities(existingArr, mergedArr, mergedLog) {
  return mergedArr;
}

// ============================================================================================================================
// STOCK LEDGER (zip 118) — the server owns every stock quantity; each stock movement is applied EXACTLY ONCE.
// ============================================================================================================================
// THE BUG THIS FIXES. Quantities used to sync as plain numbers, whole record, newest `updatedAt` wins. Every till kept its own
// copy of the number and pushed it back. So:
//   * REVERT — till A counts 120 (stock take). Till B, which has not pulled yet, sells one: its record says 99 with a NEWER
//     time, wins the merge, and the count is gone (100 - 1 = 99 instead of 120 - 1 = 119).
//   * WRONG TOTALS — two tills each selling from the same starting number: one sale is lost, stock reads too high.
//   * REPEATED ADDITION — the additive "reconciliation" that tried to paper over that (removed from this file in zip 76, but
//     still running inside any wildcard-router / per-shop database deployed before zip 76) re-added movement deltas on top of
//     numbers that already contained them.
// THE MODEL NOW.
//   * The number a device sends for an EXISTING item's `qty` / `pieceQty` (and a variant's `qty`) is IGNORED. The server keeps
//     its own, and changes it only by applying stock movements (stockMovementLog entries) it has NOT seen before — matched by
//     the movement's immutable `id`. The same movement arriving twice (retry, refresh, offline resend, second device, lost
//     reply) is already stored, so it is skipped: one logical action = one stock change.
//   * A movement is a DELTA (sale -1, restock +20 ...) — except a stock-take COUNT (`kind: 'count'`), which is ABSOLUTE:
//     "at time T there were N". A count sets the stock to N plus whatever the server already applied that happened AFTER T.
//     Any movement stamped at or before the item's latest count (an offline till's sale arriving late) is recorded for the
//     audit but does NOT move the stock again — the count already includes it. An older count arriving after a newer one is
//     recorded as superseded. So two devices counting, a stale device, or a replay can never stack a count twice.
//   * What the server did is stamped on the movement: `_srv = { applied, before, after, sv, at, reason?, stale? }` — the audit
//     truth (previous authoritative quantity -> final). `_sv` on the item is its stock version (+1 per applied change); `_sq` /
//     `_sp` echo the authoritative qty / pieceQty the device last received (devices use them to spot local changes that
//     were never logged — see reconcileLocalStockChanges in src/shared/functions.js); `_ct` = time of the latest count per unit.
//   * A brand-new item (not on the server yet) is taken as sent — its movements in the same push are already in that number.
//   * Batch-tracked items (pharmacy/hospital `batches`) have their batches brought back in line with the authoritative qty:
//     shortfalls come off the soonest-expiring batch first, surpluses become one "Stock adjustment" batch.
// Only `inventory` is ledger-managed. Aqua POS `products` (per-site stock) keep their own per-site merge above.
export const LEDGER_COLLECTION = 'inventory';
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
// A movement's time, as the ledger orders it. A device whose clock runs fast must not be able to date a stock count into the future —
// that count would then out-rank (and silently refuse) every real sale until the date came round. So a time later than the server's
// own clock (+1 minute of slack) counts as "now". (zip 121)
export const MOVE_CLOCK_SLACK_MS = 60000;
export function moveTime(m) {
  if (!m) return 0;
  const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
  if (!Number.isFinite(t)) return 0;
  const cap = Date.now() + MOVE_CLOCK_SLACK_MS;
  return t > cap ? cap : t;
}
const moveUnit = (m) => (m && m.unit === 'pieceQty' ? 'pieceQty' : 'qty');
export function isLedgerMove(m) {
  if (!m || typeof m !== 'object' || m.id == null || m.code == null || m._deleted === true) return false;
  if (m.kind === 'count') return m.counted !== null && m.counted !== '' && Number.isFinite(Number(m.counted));
  return typeof m.delta === 'number' && Number.isFinite(m.delta) && m.delta !== 0;
}
// How much a STORED movement actually changed the stock (for "what happened after this count").
export function effectiveMoveDelta(m) {
  if (!m) return 0;
  if (m._srv && typeof m._srv === 'object') {
    if (m._srv.applied === false) return 0;
    if (typeof m._srv.after === 'number' && typeof m._srv.before === 'number') return m._srv.after - m._srv.before;
  }
  if (m.kind === 'count') return 0;
  return typeof m.delta === 'number' && Number.isFinite(m.delta) ? m.delta : 0;
}
const hasVariantList = (r) => !!(r && r.hasVariants && Array.isArray(r.variants) && r.variants.length > 0);

// Authoritative stock comes from the server, never from the device's copy: puts the stored record's stock fields (qty, pieceQty,
// each variant's qty, and the ledger's own _sv/_ct) onto `rec` IN PLACE (rec.variants must already be rec's own copies). Returns the
// codes of variants that are new on the server (their figure is taken as sent). Also used by the per-shop database's upsert.
export function restoreLedgerStock(ex, rec) {
  const freshVariants = [];
  for (const u of ['qty', 'pieceQty']) { if (typeof ex[u] === 'number') rec[u] = ex[u]; }
  for (const f of ['_sv', '_ct']) { if (ex[f] !== undefined) rec[f] = ex[f]; else delete rec[f]; }
  if (Array.isArray(rec.variants)) {
    const exV = new Map((Array.isArray(ex.variants) ? ex.variants : []).filter((v) => v && v.code != null).map((v) => [String(v.code), v]));
    rec.variants.forEach((v) => {
      if (!v || v.code == null) return;
      const e = exV.get(String(v.code));
      if (!e) { freshVariants.push(String(v.code)); return; }
      if (typeof e.qty === 'number') v.qty = e.qty;
      for (const f of ['_sv', '_ct']) { if (e[f] !== undefined) v[f] = e[f]; else delete v[f]; }
    });
    if (hasVariantList(rec)) rec.qty = r3(rec.variants.reduce((s, v) => s + (Number(v && v.qty) || 0), 0));
  }
  return freshVariants;
}
// The authoritative figures echoed to devices (see _sq above).
export function stampLedgerEcho(rec) {
  if (typeof rec.qty === 'number') rec._sq = rec.qty;
  if (typeof rec.pieceQty === 'number') rec._sp = rec.pieceQty; else delete rec._sp;
  (rec.variants || []).forEach((v) => { if (v && typeof v.qty === 'number') v._sq = v.qty; });
}

// existingInv: the server's inventory BEFORE this push (at least every record the push touches; variant parents included).
// mergedInv:   the same records AFTER the ordinary per-record merge (so names/prices etc. are already resolved).
// newMoves:    movements in this push the server has never stored (callers filter by id), any order.
// laterMoves(code, unit, T): stored movements (from BEFORE this push) of that code/unit stamped after T.
// Returns { inventory, notes: Map(moveId -> _srv), changed: Set(code of every record whose stock fields were set) }.
export function applyStockLedger({ existingInv, mergedInv, newMoves, laterMoves, serverNow = Date.now() }) {
  const exByCode = new Map();
  (Array.isArray(existingInv) ? existingInv : []).forEach((r) => { if (r && r.code != null && r._deleted !== true) exByCode.set(String(r.code), r); });
  const notes = new Map();
  const changed = new Set();
  const fresh = new Set();                                    // codes (item or variant) that are new on the server in this push
  const byCode = new Map();                                   // code -> { rec, variant }
  // codes that new movements name (a variant's code counts for its parent below) — records outside it can take the fast path
  const moveCodes = new Set((Array.isArray(newMoves) ? newMoves : []).map((m) => String(m && m.code)));
  const out = (Array.isArray(mergedInv) ? mergedInv : []).map((r) => {
    if (!r || r.code == null || r._deleted === true) return r;
    const ex0 = exByCode.get(String(r.code));
    // FAST PATH (most records of most pushes): not named by any new movement, no variants/batches, and already carrying exactly the
    // server's stock figures and echo — nothing to restore or stamp, so no copy is made.
    if (ex0 && !moveCodes.has(String(r.code)) && !Array.isArray(r.variants) && !Array.isArray(r.batches)
        && r.qty === ex0.qty && r.pieceQty === ex0.pieceQty && r._sv === ex0._sv && r._ct === ex0._ct
        && r._sq === (typeof r.qty === 'number' ? r.qty : undefined) && r._sp === (typeof r.pieceQty === 'number' ? r.pieceQty : undefined)) {
      byCode.set(String(r.code), { rec: r, variant: null, shared: true });
      return r;
    }
    const rec = { ...r };
    if (Array.isArray(rec.variants)) rec.variants = rec.variants.map((v) => (v && typeof v === 'object' ? { ...v } : v));
    const ex = exByCode.get(String(rec.code));
    if (!ex) {
      fresh.add(String(rec.code));
      (rec.variants || []).forEach((v) => { if (v && v.code != null) fresh.add(String(v.code)); });
    } else {
      restoreLedgerStock(ex, rec).forEach((c) => fresh.add(c));
    }
    byCode.set(String(rec.code), { rec, variant: null });
    (rec.variants || []).forEach((v) => { if (v && v.code != null && !byCode.has(String(v.code))) byCode.set(String(v.code), { rec, variant: v }); });
    return rec;
  });

  const moves = (Array.isArray(newMoves) ? newMoves : []).filter(isLedgerMove).slice()
    .sort((a, b) => (moveTime(a) - moveTime(b)) || String(a.id).localeCompare(String(b.id)));
  const touchedParents = new Set();
  for (const m of moves) {
    const code = String(m.code);
    const tgt = byCode.get(code);
    if (!tgt) { notes.set(String(m.id), { applied: false, reason: 'no-item', at: serverNow }); continue; }
    const obj = tgt.variant || tgt.rec;
    const unit = moveUnit(m);
    if (fresh.has(code)) { notes.set(String(m.id), { applied: true, reason: 'initial', after: r3(obj[unit]), at: serverNow }); continue; }
    if (!tgt.variant && hasVariantList(tgt.rec)) {            // a variant parent's own qty is only ever the sum of its variants
      notes.set(String(m.id), { applied: false, reason: 'variant-parent', at: serverNow }); continue;
    }
    const cur = r3(obj[unit]);
    const svBefore = Number(obj._sv) || 0;
    const T = moveTime(m);
    const lastCount = (obj._ct && typeof obj._ct === 'object' && Number(obj._ct[unit])) || 0;
    const stale = m.baseSv != null && Number(m.baseSv) !== svBefore;
    if (T && lastCount && T <= lastCount) {
      notes.set(String(m.id), { applied: false, reason: m.kind === 'count' ? 'older-count' : 'before-count', before: cur, after: cur, sv: svBefore, at: serverNow, ...(stale ? { stale: true } : {}) });
      continue;
    }
    let after;
    if (m.kind === 'count') {
      const later = typeof laterMoves === 'function' ? (laterMoves(code, unit, T) || []) : [];
      after = r3(Number(m.counted) + later.reduce((s, x) => s + effectiveMoveDelta(x), 0));
      if (T) obj._ct = { ...(obj._ct && typeof obj._ct === 'object' ? obj._ct : {}), [unit]: T };
    } else {
      after = r3(cur + m.delta);
    }
    obj[unit] = after;
    obj._sv = svBefore + 1;
    notes.set(String(m.id), { applied: true, before: cur, after, sv: obj._sv, at: serverNow, ...(m.kind === 'count' ? { kind: 'count' } : {}), ...(stale ? { stale: true } : {}) });
    changed.add(String(tgt.rec.code));
    if (tgt.variant) touchedParents.add(tgt.rec);
  }
  touchedParents.forEach((p) => { p.qty = r3(p.variants.reduce((s, v) => s + (Number(v && v.qty) || 0), 0)); });

  // Echo the authoritative figures (see _sq above) and keep batch-tracked items consistent with them.
  const shared = new Set([...byCode.values()].filter((x) => x.shared).map((x) => x.rec));
  out.forEach((rec) => {
    if (!rec || rec.code == null || rec._deleted === true || shared.has(rec)) return;
    stampLedgerEcho(rec);
    if (Array.isArray(rec.batches) && rec.batches.length > 0 && !fresh.has(String(rec.code))) {
      const sum = r3(rec.batches.reduce((s, b) => s + (Number(b && b.qty) || 0), 0));
      let diff = r3((Number(rec.qty) || 0) - sum);
      if (diff !== 0) {
        let batches = rec.batches.map((b) => ({ ...b }));
        if (diff < 0) {
          batches.sort((a, b) => String(a.expiryDate || '9999').localeCompare(String(b.expiryDate || '9999')));
          for (const b of batches) { if (diff >= 0) break; const take = Math.min(Number(b.qty) || 0, -diff); b.qty = r3((Number(b.qty) || 0) - take); diff = r3(diff + take); }
          batches = batches.filter((b) => (Number(b.qty) || 0) > 0);
        } else {
          batches.push({ id: `adj-${rec.code}-${Number(rec._sv) || 0}`, batchNumber: 'Stock adjustment', expiryDate: '9999-12-31', qty: diff });
        }
        rec.batches = batches;
        if (batches.length) rec.expiryDate = batches.reduce((mn, b) => (String(b.expiryDate) < String(mn) ? b.expiryDate : mn), batches[0].expiryDate);
        changed.add(String(rec.code));
      }
    }
  });
  return { inventory: out, notes, changed };
}

// ============================================================================================================================
// AQUA POS STOCK CELLS (zip 118b) — the same ledger for Aqua's stock, which is not one `qty` per item but:
//   products[].stock[siteId]              finished goods at each site (Production, every Shop branch)
//   products[].bottleStockBySite[siteId]  loose-bottle count of a bottle-tracked bale at each site
//   tanks[].currentVolumeLiters           water in each tank (tanks belong to a site)
//   rawMaterials[].stockQty               caps, labels, preforms ... (each record belongs to a site)
// Each of those numbers is a CELL. A cell movement names it — { cell: { c: collection, k: record key, f: field, s?: site } } —
// and is either a delta or an absolute count (`kind: 'count'`), with its own immutable id, applied once, exactly like
// applyStockLedger: the numbers a device sends for cells the server already has are ignored; a count sets the cell and makes
// movements stamped before it no-ops; `_srv` records before -> after. Aqua never shows stock below zero, so cells stop at 0
// (the audit keeps the real before/after). The server echoes its figures per record in `_ss` ({ field: n | { site: n } }).
export const CELL_SPECS = {
  products: { maps: ['stock', 'bottleStockBySite'] },
  tanks: { scalars: ['currentVolumeLiters'] },
  rawMaterials: { scalars: ['stockQty'] },
};
const cellIdOf = (cell) => (cell.s != null ? `${cell.f}|${cell.s}` : String(cell.f));
export function isCellMove(m) {
  if (!m || typeof m !== 'object' || m.id == null || m._deleted === true || !m.cell || typeof m.cell !== 'object') return false;
  const spec = CELL_SPECS[m.cell.c];
  if (!spec || m.cell.k == null) return false;
  const isMap = (spec.maps || []).includes(m.cell.f), isScalar = (spec.scalars || []).includes(m.cell.f);
  if (!(isMap && m.cell.s != null) && !(isScalar && m.cell.s == null)) return false;
  if (m.kind === 'count') return m.counted !== null && m.counted !== '' && Number.isFinite(Number(m.counted));
  return typeof m.delta === 'number' && Number.isFinite(m.delta) && m.delta !== 0;
}
export function sameCell(a, b) {
  return !!(a && b && a.c === b.c && String(a.k) === String(b.k) && a.f === b.f && String(a.s ?? '') === String(b.s ?? ''));
}
export function cellLedgerPush(body) {
  return !!(body && (body._cells === 1 || (Array.isArray(body.stockMovementLog) && body.stockMovementLog.some((m) => m && m.cell))));
}
export function newCellMoves(incomingLog, isStored) {
  const seen = new Set();
  return (Array.isArray(incomingLog) ? incomingLog : []).filter((m) => {
    if (!isCellMove(m)) return false;
    const id = String(m.id);
    if (seen.has(id) || isStored(id)) return false;
    seen.add(id);
    return true;
  });
}
// col: 'products' | 'tanks' | 'rawMaterials'. existingArr / mergedArr / newMoves / laterMoves(cell, T) as in applyStockLedger.
export function applyCellLedger({ col, existingArr, mergedArr, newMoves, laterMoves, serverNow = Date.now() }) {
  const spec = CELL_SPECS[col];
  const notes = new Map();
  if (!spec || !Array.isArray(mergedArr)) return { arr: mergedArr, notes };
  const exByKey = new Map();
  (Array.isArray(existingArr) ? existingArr : []).forEach((r) => { const k = recordKey(r); if (k != null && r._deleted !== true) exByKey.set(k, r); });
  const fresh = new Set();                                             // "<record key>#<cell id>" of cells new on the server
  const byKey = new Map();
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const arr = mergedArr.map((r) => {
    const key = recordKey(r);
    if (!r || key == null || r._deleted === true) return r;
    const rec = { ...r };
    const ex = exByKey.get(key);
    (spec.maps || []).forEach((f) => {
      const inc = isObj(rec[f]) ? rec[f] : {};
      const out = { ...inc };
      const exMap = ex && isObj(ex[f]) ? ex[f] : null;
      Object.keys(inc).forEach((site) => { if (!exMap || typeof exMap[site] !== 'number') fresh.add(`${key}#${f}|${site}`); });
      if (exMap) Object.keys(exMap).forEach((site) => { if (typeof exMap[site] === 'number') out[site] = exMap[site]; });
      if (isObj(rec[f]) || exMap) rec[f] = out;
    });
    (spec.scalars || []).forEach((f) => {
      if (ex && typeof ex[f] === 'number') rec[f] = ex[f];
      else fresh.add(`${key}#${f}`);
    });
    if (ex) { for (const f of ['_sv', '_ct']) { if (ex[f] !== undefined) rec[f] = ex[f]; else delete rec[f]; } }
    byKey.set(key, rec);
    return rec;
  });
  const moves = (Array.isArray(newMoves) ? newMoves : []).filter((m) => isCellMove(m) && m.cell.c === col).slice()
    .sort((a, b) => (moveTime(a) - moveTime(b)) || String(a.id).localeCompare(String(b.id)));
  for (const m of moves) {
    const rec = byKey.get(String(m.cell.k));
    if (!rec) { notes.set(String(m.id), { applied: false, reason: 'no-item', at: serverNow }); continue; }
    const cid = cellIdOf(m.cell);
    const isMap = m.cell.s != null;
    const read = () => (isMap ? (isObj(rec[m.cell.f]) ? Number(rec[m.cell.f][m.cell.s]) || 0 : 0) : Number(rec[m.cell.f]) || 0);
    if (fresh.has(`${m.cell.k}#${cid}`)) { notes.set(String(m.id), { applied: true, reason: 'initial', after: r3(read()), at: serverNow }); continue; }
    const cur = r3(read());
    const svBefore = (isObj(rec._sv) && Number(rec._sv[cid])) || 0;
    const T = moveTime(m);
    const lastCount = (isObj(rec._ct) && Number(rec._ct[cid])) || 0;
    const stale = m.baseSv != null && Number(m.baseSv) !== svBefore;
    if (T && lastCount && T <= lastCount) {
      notes.set(String(m.id), { applied: false, reason: m.kind === 'count' ? 'older-count' : 'before-count', before: cur, after: cur, sv: svBefore, at: serverNow, ...(stale ? { stale: true } : {}) });
      continue;
    }
    let after;
    if (m.kind === 'count') {
      const later = typeof laterMoves === 'function' ? (laterMoves(m.cell, T) || []) : [];
      after = r3(Number(m.counted) + later.reduce((sum, x) => sum + effectiveMoveDelta(x), 0));
      if (T) rec._ct = { ...(isObj(rec._ct) ? rec._ct : {}), [cid]: T };
    } else {
      after = r3(cur + m.delta);
    }
    after = Math.max(0, after);                                         // Aqua never goes below zero (same rule as setStockAt)
    if (isMap) rec[m.cell.f] = { ...(isObj(rec[m.cell.f]) ? rec[m.cell.f] : {}), [m.cell.s]: after };
    else rec[m.cell.f] = after;
    rec._sv = { ...(isObj(rec._sv) ? rec._sv : {}), [cid]: svBefore + 1 };
    notes.set(String(m.id), { applied: true, before: cur, after, sv: svBefore + 1, at: serverNow, ...(m.kind === 'count' ? { kind: 'count' } : {}), ...(stale ? { stale: true } : {}) });
  }
  arr.forEach((rec) => {
    if (!rec || recordKey(rec) == null || rec._deleted === true) return;
    const ss = {};
    (spec.maps || []).forEach((f) => { if (isObj(rec[f])) ss[f] = { ...rec[f] }; });
    (spec.scalars || []).forEach((f) => { if (typeof rec[f] === 'number') ss[f] = rec[f]; });
    if (Object.keys(ss).length) rec._ss = ss; else delete rec._ss;
  });
  return { arr, notes };
}

// ---- INTEGRITY CHECK (Phase 19) ------------------------------------------------------------------------------------------
// Does the stock agree with its own history? For every item (and every Aqua cell) the movements the server APPLIED, in stock-
// version order, must chain — each one starting exactly where the previous one ended — and the last one must end at today's
// figure. No movement id may appear twice. Items with no ledger history yet (before zip 118) are skipped, and a history that only
// starts part-way (older movements archived / outside a device's recent window) is checked from where it starts.
// Returns { ok, checked, problems: [{ what, detail }] }. Pure — used by the tests and mirrored by the app's "Check" button.
export function ledgerIntegrity(state) {
  const problems = [];
  const log = Array.isArray(state && state.stockMovementLog) ? state.stockMovementLog : [];
  const seen = new Set();
  log.forEach((m) => { if (m && m.id != null) { const id = String(m.id); if (seen.has(id)) problems.push({ what: 'duplicate movement', detail: id }); seen.add(id); } });
  const chains = new Map();                                   // cell id -> applied movements
  const add = (key, m) => { if (!chains.has(key)) chains.set(key, []); chains.get(key).push(m); };
  log.forEach((m) => {
    if (!m || !m._srv || m._srv.applied !== true || typeof m._srv.before !== 'number' || typeof m._srv.sv !== 'number') return;
    if (m.cell) add(`cell:${m.cell.c}|${m.cell.k}|${m.cell.f}|${m.cell.s ?? ''}`, m);
    else if (m.code != null) add(`inv:${m.code}|${moveUnit(m)}`, m);
  });
  const current = new Map();
  (Array.isArray(state && state.inventory) ? state.inventory : []).forEach((r) => {
    if (!r || r.code == null || r._deleted) return;
    const v = hasVariantList(r) ? r.variants : [r];
    v.forEach((x) => { if (x && x.code != null) { current.set(`inv:${x.code}|qty`, Number(x.qty) || 0); if (typeof x.pieceQty === 'number') current.set(`inv:${x.code}|pieceQty`, x.pieceQty); } });
  });
  for (const [col, spec] of Object.entries(CELL_SPECS)) {
    (Array.isArray(state && state[col]) ? state[col] : []).forEach((r) => {
      const k = recordKey(r);
      if (k == null || r._deleted) return;
      (spec.maps || []).forEach((f) => { if (r[f] && typeof r[f] === 'object') Object.keys(r[f]).forEach((site) => current.set(`cell:${col}|${k}|${f}|${site}`, Number(r[f][site]) || 0)); });
      (spec.scalars || []).forEach((f) => { if (typeof r[f] === 'number') current.set(`cell:${col}|${k}|${f}|`, r[f]); });
    });
  }
  for (const [key, moves] of chains) {
    moves.sort((a, b) => a._srv.sv - b._srv.sv);
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]._srv, cur = moves[i]._srv;
      if (cur.sv === prev.sv) problems.push({ what: 'two changes with one version', detail: `${key} v${cur.sv}` });
      else if (cur.sv === prev.sv + 1 && r3(cur.before) !== r3(prev.after)) problems.push({ what: 'history does not chain', detail: `${key}: v${prev.sv} ended at ${prev.after}, v${cur.sv} started at ${cur.before}` });
    }
    const last = moves[moves.length - 1]._srv;
    if (current.has(key) && r3(current.get(key)) !== r3(last.after)) problems.push({ what: 'figure differs from its history', detail: `${key}: history ends at ${last.after}, figure is ${current.get(key)}` });
  }
  return { ok: problems.length === 0, checked: chains.size, problems };
}

// Picks this push's movements the server has not stored yet (deduplicated by id), for applyStockLedger.
export function newLedgerMoves(incomingLog, isStored) {
  const seen = new Set();
  return (Array.isArray(incomingLog) ? incomingLog : []).filter((m) => {
    if (!isLedgerMove(m)) return false;
    const id = String(m.id);
    if (seen.has(id) || isStored(id)) return false;
    seen.add(id);
    return true;
  });
}

// Scalar settings that a push must never BLANK. A brand-new device (or one
// with cleared browser storage) pushes before its first pull — see
// flushThenPull() in the apps — carrying its empty local defaults, and
// scalars are last-write-wins, so without this guard that first push wiped
// the shop's saved password hashes and business name for every device.
// An empty/absent incoming value keeps what's stored; a REAL value (a
// password change, a rename) still wins as before. Enforced here, not just
// in the apps, so devices still running an older cached build are covered.
export const NEVER_BLANK_FIELDS = ['pwHash', 'adminPwHash', 'businessName'];

// Whole-value settings that only a stamped change may replace (see mergeIncomingState). The list is the receipt / branding / payment
// details of a shop - the things a new device starts empty on and that a person notices missing at once.
export const SETTINGS_NEED_STAMP_FIELDS = [
  'receiptLogo', 'receiptQr', 'receiptQrCaption', 'receiptShowLogo', 'receiptShowQr', 'receiptItemAlign', 'receiptEmail', 'receiptContact',
  'receiptExtraInfo', 'receiptFooterNotes', 'receiptWidth', 'receiptCustomWidth', 'receiptLengthMode', 'receiptFixedLength', 'receiptFontPt',
  'receiptShowRefNumber', 'receiptShowBarcode', 'receiptFooterNotesHire', 'receiptLogoData', 'receiptQrData', 'paymentDetails', 'receiptStampSrc', 'receiptStampAngle', 'receiptStampSize', 'receiptShowStamp', 'billsLocked',
  'receiptAlign', 'lockedTabs', 'vatRateA', 'vatRateB', 'requireCartRemovePw', 'requireCartPricePw', 'lowStockThreshold', 'expiryWarningDays', 'qtyDisplayFormat',
];

export function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

// TILL NUMBERS (zip 119). Every device that syncs is given a small till number (1-99), once, by the server — the only place
// that can hand them out without two devices getting the same one. Receipt references are built from it (see generateReceiptRef
// in src/shared/functions.js), so two tills can never print the same reference. Devices send `_till` (their device id) and read
// their number back from `tillNumbers`; they can never write that map.
export function allocateTill(map, deviceId) {
  const out = { ...(map && typeof map === 'object' && !Array.isArray(map) ? map : {}) };
  const dev = typeof deviceId === 'string' ? deviceId.slice(0, 80) : '';
  if (!dev || out[dev]) return { map: out, till: dev ? out[dev] || 0 : 0 };
  const used = new Set(Object.values(out).map(Number));
  let n = 1;
  while (used.has(n) && n <= 99) n++;
  if (n <= 99) out[dev] = n;
  return { map: out, till: out[dev] || 0 };
}

// DEVICE REGISTRY (zip 120): which devices sync this shop, their till number, the app release they run and when they were last
// seen — server-managed like tillNumbers (a device can never write it), shown in Settings and the Owner Console. Rides on the push
// that is written anyway, so it costs no extra storage write.
export function noteDevice(reg, deviceId, dev, till) {
  const out = { ...(reg && typeof reg === 'object' && !Array.isArray(reg) ? reg : {}) };
  const id = typeof deviceId === 'string' ? deviceId.slice(0, 80) : '';
  if (!id) return Object.keys(out).length ? out : undefined;
  const d = dev && typeof dev === 'object' ? dev : {};
  out[id] = { ...(out[id] || {}), lastSeen: Date.now(), ...(till ? { till } : {}), ...(d.v ? { v: String(d.v).slice(0, 40) } : {}), ...(d.app ? { app: String(d.app).slice(0, 20) } : {}) };
  const ids = Object.keys(out);
  if (ids.length > 200) ids.sort((a, b) => (out[a].lastSeen || 0) - (out[b].lastSeen || 0)).slice(0, ids.length - 200).forEach((x) => { delete out[x]; });
  return out;
}

export function mergeIncomingState(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const tills = allocateTill(existing.tillNumbers, incoming._till);
  merged.tillNumbers = tills.map;
  if (!Object.keys(tills.map).length) delete merged.tillNumbers;
  merged.deviceRegistry = noteDevice(existing.deviceRegistry, incoming._till, incoming._dev, tills.till);
  if (!merged.deviceRegistry) delete merged.deviceRegistry;
  delete merged._till; delete merged._dev;
  // zip 158: the receipt "scale" setting no longer exists. An older app that still sends it is accepted and the value is simply not kept (and one stored earlier is dropped).
  delete merged.receiptScale;
  for (const field of NEVER_BLANK_FIELDS) {
    if (isBlank(incoming[field]) && !isBlank(existing[field])) {
      merged[field] = existing[field];
    }
  }
  // RECEIPT / BRANDING SETTINGS NEVER COME FROM A DEVICE THAT DID NOT CHANGE THEM (zip 155). A device that has just been installed (the
  // Android / Windows app, a new phone, a cleared browser) starts with EMPTY defaults - no logo, no footer, "print logo" off. If its very
  // first push lands before (or without) its first successful pull - a bad connection on the first open is enough - those defaults were
  // saved over the shop's real settings, and the logo / receipt settings vanished on EVERY device. A whole-value setting of this list is
  // now only replaced by a value that carries a change stamp (`_fieldTimes`: the person changed it on that device). An unstamped copy is
  // a default or an old copy and never replaces a value the shop already has. When the shop has no value yet, the incoming one is taken.
  const sentStamps = (incoming && incoming._fieldTimes) || {};
  for (const field of SETTINGS_NEED_STAMP_FIELDS) {
    if (!(field in incoming) || !(field in existing) || isBlank(existing[field]) || (Array.isArray(existing[field]) && existing[field].length === 0)) continue;
    if (typeof sentStamps[field] === 'number') continue;                    // a real change made on that device
    // only a BLANK unstamped value is treated as a fresh-device default. A filled-in value without a stamp is a real edit from a device that had no
    // baseline yet (it never applied a pull); dropping it would silently undo the person's change.
    const inc = incoming[field];
    if (!(inc === '' || inc == null || (Array.isArray(inc) && inc.length === 0))) continue;
    merged[field] = existing[field];
  }
  // PER-FIELD TIMESTAMPS for the settings-type fields that are one whole value (receipt text, VAT rates, tab locks, loyalty tiers,
  // tables/rooms ...). Until now the LAST PUSH to arrive won: a till that had simply not refreshed yet pushed its old copy of
  // every setting at its next sale and silently put back what somebody else had just changed. Now a device stamps the fields IT
  // changed (`_fieldTimes`, see slimPayloadForPush in the apps). A stored field that carries a stamp is only replaced by an
  // incoming value with an equal or newer stamp; an unstamped incoming value (an unchanged copy, or an older app) is ignored for it.
  // Fields nobody ever stamped behave exactly as before.
  const storedTimes = (existing && existing._fieldTimes) || {};
  const sentTimes = (incoming && incoming._fieldTimes) || {};
  const times = { ...storedTimes };
  for (const k of Object.keys(incoming)) {
    if (k === 'updatedAt' || k === '_fieldTimes' || k === '_cells' || k === '_till' || k === 'tillNumbers' || k === '_dev' || k === 'deviceRegistry' || MERGE_BY_ID_FIELDS.includes(k)) continue;
    const stored = storedTimes[k], sent = sentTimes[k];
    if (typeof stored === 'number' && !(typeof sent === 'number' && sent >= stored)) {
      if (k in existing) merged[k] = existing[k];
    } else if (typeof sent === 'number') {
      times[k] = sent;
    }
  }
  delete times.receiptScale;
  if (Object.keys(times).length) merged._fieldTimes = times;
  for (const field of MERGE_BY_ID_FIELDS) {
    if (Array.isArray(incoming[field])) {
      merged[field] = mergeRecordsById(existing[field], incoming[field], FINAL_TOMBSTONE_FIELDS.includes(field), field);
    } else if (field in incoming && Array.isArray(existing[field])) {
      merged[field] = existing[field];       // zip 156: a null / {} / '' where a list belongs never replaces the stored list
    }
  }
  // Quantity reconciliation runs AFTER the ordinary per-record merge above
  // (so name/price/other fields still resolve the normal last-write-wins
  // way) and needs the fully-merged stockMovementLog so it can see every
  // device's deltas, including ones this particular push didn't carry.
  for (const field of ['inventory', 'products']) {
    if (Array.isArray(merged[field])) {
      merged[field] = reconcileQuantities(existing[field], merged[field], merged.stockMovementLog);
    }
  }
  // STOCK LEDGER: the server's quantities + every NEW movement, applied once (see applyStockLedger / applyCellLedger).
  const storedLog = Array.isArray(existing.stockMovementLog) ? existing.stockMovementLog : [];
  let storedIds = null;
  const incomingIds = (Array.isArray(incoming.stockMovementLog) ? incoming.stockMovementLog : []).filter((m) => m && m.id != null).map((m) => String(m.id));
  const stored = () => {
    if (storedIds) return storedIds;
    storedIds = new Set();
    if (incomingIds.length <= 32) {                              // a typical push carries a movement or two: look just those up
      const want = new Set(incomingIds);
      for (const m of storedLog) { if (m && m.id != null && want.has(String(m.id))) storedIds.add(String(m.id)); }
    } else storedLog.forEach((m) => { if (m && m.id != null) storedIds.add(String(m.id)); });
    return storedIds;
  };
  const allNotes = new Map();
  // Aqua cells are ledgered only for pushes from an app that sends cell movements (it says so with `_cells`). A till still on an
  // older cached app sends plain numbers and no movements — ignoring them would lose its sales until it updates, so its push keeps
  // the previous merge rules (see cellLedgerPush).
  const cellPush = cellLedgerPush(incoming);
  delete merged._cells;
  for (const col of Object.keys(CELL_SPECS)) {
    if (!cellPush) break;
    if (!Array.isArray(merged[col]) || !(Array.isArray(incoming[col]) || Array.isArray(incoming.stockMovementLog))) continue;
    const res = applyCellLedger({
      col, existingArr: existing[col], mergedArr: merged[col],
      newMoves: newCellMoves(incoming.stockMovementLog, (id) => stored().has(id)).filter((m) => m.cell.c === col),
      laterMoves: (cell, T) => storedLog.filter((m) => m && m.cell && sameCell(m.cell, cell) && moveTime(m) > T && m._deleted !== true),
    });
    merged[col] = res.arr;
    res.notes.forEach((v, k) => allNotes.set(k, v));
  }
  if (Array.isArray(merged[LEDGER_COLLECTION]) && (Array.isArray(incoming[LEDGER_COLLECTION]) || Array.isArray(incoming.stockMovementLog))) {
    const storedIds = stored();
    const newMoves = newLedgerMoves(incoming.stockMovementLog, (id) => storedIds.has(id));
    const res = applyStockLedger({
      existingInv: existing[LEDGER_COLLECTION],
      mergedInv: merged[LEDGER_COLLECTION],
      newMoves,
      laterMoves: (code, unit, T) => storedLog.filter((m) => m && String(m.code) === code && moveUnit(m) === unit && moveTime(m) > T && m._deleted !== true),
    });
    merged[LEDGER_COLLECTION] = res.inventory;
    res.notes.forEach((v, k) => allNotes.set(k, v));
  }
  if (allNotes.size && Array.isArray(merged.stockMovementLog)) {
    const ids = stored();
    merged.stockMovementLog = merged.stockMovementLog.map((m) => (m && m.id != null && allNotes.has(String(m.id)) && !ids.has(String(m.id)) ? { ...m, _srv: allNotes.get(String(m.id)) } : m));
  }
  return merged;
}

// --- Clock-drift correction -------------------------------------------------
// The per-record merge above decides a winner by comparing each record's
// own `updatedAt`, stamped by the DEVICE's clock at edit time — not the
// server's. Two devices with clocks even a few minutes apart can make the
// "wrong" side win an edit that has nothing to do with which one actually
// happened later, and it also throws off the quantity reconciliation above
// (which compares delta timestamps against a server-stamped cursor). Every
// push already carries the device's own clock reading — the top-level
// `updatedAt` collectSyncPayload() stamps right before sending — so this
// compares that against the server's own clock at receipt and shifts every
// timestamp in the push by the difference, expressing all of it in
// server-clock terms before any comparison happens. A device that's off by
// ten minutes no longer has any advantage (or disadvantage) in a merge.
export const CLOCK_DRIFT_MIN_MS = 120000;
export function correctClockDrift(body, serverNow) {
  const clientClaimedNow = Number(body.updatedAt);
  if (!Number.isFinite(clientClaimedNow) || clientClaimedNow <= 0) return body;
  const offset = serverNow - clientClaimedNow;
  // zip 156: ignore anything under CLOCK_DRIFT_MIN_MS. A gap of a few seconds to a minute or two is not a wrong clock — it is the push having been
  // built a moment before it arrived (a slow line, a retry after a lost answer, a queue). "Correcting" it shifted every record's time FORWARD by
  // that delay, so an edit made 30 s earlier on a slow line looked NEWER than one made 0.5 s ago on the other till, and a stock count could jump
  // over a sale made after it. A clock that is really minutes or hours off is still corrected.
  if (Math.abs(offset) < CLOCK_DRIFT_MIN_MS) return body;

  const shifted = { ...body };
  if (shifted._fieldTimes && typeof shifted._fieldTimes === 'object') {
    shifted._fieldTimes = Object.fromEntries(Object.entries(shifted._fieldTimes).map(([k, v]) => [k, typeof v === 'number' ? v + offset : v]));
  }
  for (const field of MERGE_BY_ID_FIELDS) {
    if (Array.isArray(shifted[field])) {
      shifted[field] = shifted[field].map((r) => (
        r && typeof r === 'object' && typeof r.updatedAt === 'number'
          ? { ...r, updatedAt: r.updatedAt + offset }
          : r
      ));
    }
  }
  // stockMovementLog timestamps are ISO strings, not epoch ms — shift those
  // too so the quantity reconciliation above compares apples-to-apples
  // against the (now-corrected) record updatedAt / cursor values.
  if (Array.isArray(shifted.stockMovementLog)) {
    shifted.stockMovementLog = shifted.stockMovementLog.map((e) => {
      if (!e || typeof e.timestamp !== 'string') return e;
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t)) return e;
      return { ...e, timestamp: new Date(t + offset).toISOString() };
    });
  }
  return shifted;
}



// ---- Deletions ------------------------------------------------------------------------------------------------------------------
// The merge above is a UNION by id: a record that is simply missing from a push is left as it was ("never treated as a deletion"). That is
// safe for stale devices, but it meant a record a person DELETED on one device (a bill settled and removed from the open list, a supplier,
// an item, a debt...) was still on the server and came back the next time any device applied the server's copy. A device now says so
// explicitly by sending a tombstone — { id | code | token, _deleted: true, updatedAt } — which wins over any OLDER copy of that record
// (so a stale device can't bring it back) and loses to a NEWER one (the same code deliberately re-added later). The server keeps the
// tombstone but never hands it to a device: stripTombstones() removes them from every payload the apps receive.
export function stripTombstones(state) {
  if (!state || typeof state !== 'object') return state;
  let out = state;
  for (const f of MERGE_BY_ID_FIELDS) {
    const arr = state[f];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((r) => !(r && r._deleted === true));
    if (kept.length !== arr.length) { if (out === state) out = { ...state }; out[f] = kept; }
  }
  return out;
}

// The BUSINESS version of a log record (zip 129): the same string the apps' sales journal computes (window.salesJournalSig in
// src/shared/blocks/sales-journal.html — keep the two identical). Two copies with the same value are the same sale / movement /
// expense as far as the shop is concerned, whatever bookkeeping fields (updatedAt shifted for clock drift, ctx, _srv) differ.
// Used by /api/sync-have: "which of these records do you already have, in this version?"
// zip 158: the version used to cover only a handful of fields (time, void, paid, amount paid, item count and total, qty, amount ...). A record edited in
// any OTHER field (a customer's name, the payment method, a note, which item a line is, a delivery status) kept the same version, so /api/sync-have
// answered "already have it" for a copy that was NOT the same, and the edit was never sent. The version now ends with a hash of the whole record,
// less the fields that are only bookkeeping (SIG_IGNORED_FIELDS: stamped or re-stamped on the way to the server, so they differ between two copies
// of the same business record). Keep this identical to sigOf in src/shared/blocks/sales-journal.html.
export const SIG_IGNORED_FIELDS = ['updatedAt', 'tries', 'dev', 'till', 'stn', 'ctx', '_srv'];
function stableJson(v) {
  if (v === null || typeof v !== 'object') { const j = JSON.stringify(v); return j === undefined ? 'null' : j; }
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}
export function contentHash(r) {
  const j = stableJson(Object.fromEntries(Object.entries(r).filter(([k]) => !SIG_IGNORED_FIELDS.includes(k))));
  let h = 0x811c9dc5;
  for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + '.' + j.length.toString(36);
}
export function businessSig(r) {
  if (!r || typeof r !== 'object') return '';
  const items = r.items;
  let n = 0, sum = 0;
  if (items && items.length) { n = items.length; for (let i = 0; i < n; i++) { const it = items[i]; if (it) sum += (+it.price || 0) * (+it.qty || 0); } }
  return (r.timestamp || r.date || '') + '|' + (r.voided ? 1 : 0) + '|' + (r.voidedAt || '') + '|' + (r.unvoidedAt || '') + '|' + (r.paid === false ? 0 : 1)
    + '|' + (r.amountPaid == null ? '' : r.amountPaid) + '|' + n + '|' + Math.round(sum * 100) + '|' + (r.qty == null ? '' : r.qty)
    + '|' + (r.amount == null ? '' : r.amount) + '|' + (r.removed ? 1 : 0) + '|' + (r._deleted ? 1 : 0)
    // zip 141: signed later by a staff session / M-Pesa-checked later = a new version (same as salesJournalSig on the device)
    + (r.staffAuth && r.staffAuth.m ? '|a' + r.staffAuth.m : '') + (r.mpesaCheck && r.mpesaCheck.status ? '|m' + r.mpesaCheck.status : '')
    + '|c' + contentHash(r);
}


// ---- Reservations: one resource cannot be booked twice for overlapping times (zip 137) ------------------------------------------
export const BOOKING_ACTIVE = ['BOOKED', 'CHECKED_IN'];
// -> the existing booking that overlaps `b` on the same resource, or null. Times are ms; a booking ending exactly when another
// starts is not a clash.
export function bookingConflict(existing, b) {
  if (!b || !b.resourceId || !(Number(b.end) > Number(b.start)) || !BOOKING_ACTIVE.includes(b.status || 'BOOKED')) return null;
  return (Array.isArray(existing) ? existing : []).find((x) => x && x.id !== b.id && x._deleted !== true && x.resourceId === b.resourceId
    && BOOKING_ACTIVE.includes(x.status) && Number(x.start) < Number(b.end) && Number(b.start) < Number(x.end)) || null;
}
