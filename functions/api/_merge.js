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

export function mergeRecordsById(existingArr, incomingArr) {
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
    const existingTs = existing.updatedAt || 0;
    const incomingTs = incoming.updatedAt || 0;
    merged.set(key, incomingTs >= existingTs ? incoming : existing);
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
];

// --- Quantity reconciliation (fixes the lost-update problem) ---------------
// mergeRecordsById above is last-write-wins for the WHOLE record, which is
// exactly wrong for a running stock count: if two devices are offline and
// each sell one unit of the same item from the same starting count, only
// one device's decrement can "win" a whole-record merge — the other is
// silently dropped, and the item ends up overcounted by however many
// decrements lost. This makes qty/pieceQty additive instead: every quantity
// change is ALSO logged as a signed delta in stockMovementLog (see
// logStockMovement() in each app's index.html — sales, box-opening, voids,
// restocks and manual adjustments all go through it), and stockMovementLog
// itself already merges losslessly (it's in MERGE_BY_ID_FIELDS, unioned by
// id) — so no delta a device recorded is ever dropped, no matter how many
// devices were offline or for how long.
//
// `_qtySyncedAt` is a cursor stamped onto each record here, never read or
// written by the front-end. It marks "every delta up to this timestamp is
// already folded into this record's qty," so the same delta is never
// applied twice across repeated merges. The base a record's new deltas are
// added ON TOP OF is always taken from `existing` — the server's last-known
// canonical count — never from the merge winner picked above, since that
// winner may just be one device's necessarily partial view. A record with
// no logged deltas for its code, or one that tracks quantity a different
// way (batch-tracked items — see `batches`), is left exactly as the
// ordinary per-record merge produced it.
//
// On the very first push after this feature goes live, a record has no
// `_qtySyncedAt` yet — rather than replaying its entire delta history
// (which the OLD last-write-wins qty may already reflect, and would double
// count), the cursor is initialized to "now" and reconciliation starts
// fresh from the next push onward. This avoids a one-time corruption of
// existing stock counts on rollout.
export function reconcileQuantities(existingArr, mergedArr, mergedLog) {
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

// Scalar settings that a push must never BLANK. A brand-new device (or one
// with cleared browser storage) pushes before its first pull — see
// flushThenPull() in the apps — carrying its empty local defaults, and
// scalars are last-write-wins, so without this guard that first push wiped
// the shop's saved password hashes and business name for every device.
// An empty/absent incoming value keeps what's stored; a REAL value (a
// password change, a rename) still wins as before. Enforced here, not just
// in the apps, so devices still running an older cached build are covered.
export const NEVER_BLANK_FIELDS = ['pwHash', 'adminPwHash', 'businessName'];

export function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

export function mergeIncomingState(existing, incoming) {
  const merged = { ...existing, ...incoming };
  for (const field of NEVER_BLANK_FIELDS) {
    if (isBlank(incoming[field]) && !isBlank(existing[field])) {
      merged[field] = existing[field];
    }
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
    if (k === 'updatedAt' || k === '_fieldTimes' || MERGE_BY_ID_FIELDS.includes(k)) continue;
    const stored = storedTimes[k], sent = sentTimes[k];
    if (typeof stored === 'number' && !(typeof sent === 'number' && sent >= stored)) {
      if (k in existing) merged[k] = existing[k];
    } else if (typeof sent === 'number') {
      times[k] = sent;
    }
  }
  if (Object.keys(times).length) merged._fieldTimes = times;
  for (const field of MERGE_BY_ID_FIELDS) {
    if (Array.isArray(incoming[field])) {
      merged[field] = mergeRecordsById(existing[field], incoming[field]);
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
export function correctClockDrift(body, serverNow) {
  const clientClaimedNow = Number(body.updatedAt);
  if (!Number.isFinite(clientClaimedNow) || clientClaimedNow <= 0) return body;
  const offset = serverNow - clientClaimedNow;
  // Ignore trivial drift — anything under 2s is well within normal network
  // latency and not worth rewriting every array in the payload for.
  if (Math.abs(offset) < 2000) return body;

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
