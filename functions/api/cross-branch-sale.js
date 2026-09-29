// functions/api/cross-branch-sale.js — Cloudflare Pages Function
//
// Lets a branch sell an item that physically lives in ANOTHER branch's own
// inventory — e.g. Branch A's customer wants something only Branch B has in
// stock. The sale is recorded entirely in Branch B's own sales log and stock
// (Branch B is who actually loses the stock and earns the revenue), tagged
// with which branch and which staff member actually rang it up, so both
// Branch B's records and that staff member's own activity reflect it.
//
// zip 156: it does not go through pos-sync.js's request handling (it is not a device), but what it writes is merged EXACTLY like a device's
// push: the sale goes into the target branch's sales log and each item's stock comes off through a STOCK MOVEMENT (id xb-<saleId>:<code>)
// that the server's stock ledger applies once — never by changing the stock number in place, which the ledger ignores (shop database) or
// which the branch's own till then logged and applied a second time (single record). A shop in its database is pushed to as a device
// would; a single-record shop goes through kvMergeUpdate (read, merge, re-check that no other save landed, write, confirm).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, getBranchGroupMembers, randomToken } from './_license.js';
import { readState, shopMode, shopCall, kvMergeUpdate } from './_state-store.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { recordPush } from './_ledger.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

async function getState(env, clientId) {
  return await readState(env, stateKey(clientId), null);
}

// The unit a sale of this item comes off (see getAvailableQty): loose pieces for a piece sale of a dual-unit item, otherwise the item's own quantity.
function stockUnitOf(item, saleMode) {
  return saleMode === 'piece' && item.dualUnit ? 'pieceQty' : 'qty';
}

function getAvailableQty(item, saleMode) {
  if (saleMode === 'piece' && item.dualUnit) return item.pieceQty || 0;
  return item.qty || 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, license.clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const callerRecord = await getLicense(env, license.clientId);
  if (!callerRecord) return jsonResponse({ error: 'Client not found.' }, 404);
  if (!callerRecord.branchGroupId) {
    return jsonResponse({ error: 'This shop is not part of a branch group.' }, 400);
  }

  // Every action below only ever touches clients confirmed to be in the
  // caller's own branch group — never an arbitrary client ID handed in by
  // the request, however this endpoint is called.
  const memberIds = await getBranchGroupMembers(env, callerRecord.branchGroupId);

  if (body.action === 'searchOtherBranches') {
    const query = String(body.query || '').trim().toLowerCase();
    if (!query) return jsonResponse({ results: [] });

    // Every other branch is fetched in parallel rather than one at a time —
    // a sequential loop here meant a group with several branches took
    // noticeably longer to search than a group with just two, which is
    // exactly the "some branches are slow" symptom this was rewritten to fix.
    const otherMemberIds = memberIds.filter((id) => id !== license.clientId);
    const perBranch = await Promise.all(otherMemberIds.map(async (memberId) => {
      const [memberRecord, state] = await Promise.all([getLicense(env, memberId), getState(env, memberId)]);
      if (!memberRecord) return [];
      const items = Array.isArray(state && state.inventory) ? state.inventory : [];
      const matches = [];
      items.forEach((item) => {
        if (item.type === 'service' || item.type === 'ingredient') return; // never sold directly
        const haystack = `${item.name} ${item.code}`.toLowerCase();
        if (!haystack.includes(query)) return;
        const available = getAvailableQty(item, undefined);
        if (available <= 0 && !(item.dualUnit && getAvailableQty(item, 'piece') > 0)) return;
        matches.push({
          branchClientId: memberId,
          branchLabel: memberRecord.label,
          code: item.code,
          name: item.name,
          price: item.price,
          unit: item.unit || 'pcs',
          qty: item.qty || 0,
          dualUnit: !!item.dualUnit,
          piecePrice: item.piecePrice || 0,
          pieceQty: item.pieceQty || 0,
        });
      });
      return matches;
    }));
    const results = perBranch.flat();
    return jsonResponse({ results: results.slice(0, 30) });
  }

  if (body.action === 'sellBatch') {
    const targetClientId = String(body.targetClientId || '');
    if (!memberIds.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this shop\u2019s branch group.' }, 400);
    }
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    if (requestedItems.length === 0) {
      return jsonResponse({ error: 'No items provided.' }, 400);
    }

    // zip 153: a retry (network drop after the server answered, a double tap) must not sell — and deduct stock — twice: the till sends one
    // `saleId` per attempt; a sale already recorded under it is returned as it is.
    const askedId = /^[A-Za-z0-9_-]{8,96}$/.test(String(body.saleId || '')) ? 'xb-' + String(body.saleId) : null;
    const saleId = askedId || randomToken(12);
    const stamp = new Date().toISOString();                     // one time for this sale, however many times the write is retried

    // Checks the request against the target branch's shop as it is NOW and builds what to record: { abort } (an answer to send instead),
    // { repeated } (already recorded), or { sale, moves }. Every item is resolved and checked BEFORE anything is written, so a shortfall
    // partway through a multi-item cart never leaves stock half-deducted for that branch.
    const plan = (targetState) => {
      if (!targetState || !Array.isArray(targetState.inventory)) return { abort: jsonResponse({ error: 'That branch has no inventory recorded yet.' }, 400) };
      if (askedId) {
        const prior = (Array.isArray(targetState.salesLog) ? targetState.salesLog : []).find((x) => x && x.id === askedId);
        if (prior) return { repeated: prior };
      }
      const resolved = [];
      const wanted = new Map();                                   // code|unit -> { item, unit, qty }: what the whole cart takes of each stock figure
      for (const reqItem of requestedItems) {
        const itemCode = String(reqItem.itemCode || '');
        const qty = parseFloat(reqItem.qty);
        const saleMode = reqItem.saleMode === 'piece' ? 'piece' : undefined;
        if (!itemCode || isNaN(qty) || qty <= 0) return { abort: jsonResponse({ error: 'Invalid item or quantity.' }, 400) };
        const item = targetState.inventory.find((p) => p.code === itemCode && p._deleted !== true);
        if (!item) return { abort: jsonResponse({ error: `"${itemCode}" no longer exists in that branch\u2019s inventory.` }, 404) };
        const available = getAvailableQty(item, saleMode);
        const unit = stockUnitOf(item, saleMode);
        const key = itemCode + '|' + unit;
        const w = wanted.get(key) || { item, unit, qty: 0 };
        w.qty += qty; wanted.set(key, w);
        // each line must fit, and so must the cart's total of that item (two lines of one item)
        if (qty > available || w.qty > available) {
          return { abort: jsonResponse({ error: `Only ${available} of "${item.name}" available at that branch now \u2014 someone else may have just bought it.` }, 409) };
        }
        resolved.push({ item, qty, saleMode });
      }

      const total = resolved.reduce((sum, r) => {
        const unitPrice = r.saleMode === 'piece' ? (r.item.piecePrice || 0) : (r.item.price || 0);
        return sum + unitPrice * r.qty;
      }, 0);

      const cashAmount = typeof body.cashAmount === 'number' ? body.cashAmount : (body.paymentMethod === 'mpesa' ? 0 : total);
      const mpesaAmount = typeof body.mpesaAmount === 'number' ? body.mpesaAmount : (body.paymentMethod === 'mpesa' ? total : 0);

      const saleRecord = {
        id: saleId,
        timestamp: stamp,
        paymentMethod: body.paymentMethod || 'cash',
        paid: true,
        cashAmount,
        mpesaAmount,
        amountTendered: total,
        change: 0,
        servedBy: body.servedBy || '?',
        customerName: body.customerName || null,
        receivingAccount: body.receivingAccount || null,
        // What makes this a cross-branch sale rather than an ordinary one —
        // both this branch's own sales log and the selling branch's own staff
        // records can key off these two fields. The customer's own printed
        // receipt is built separately, client-side, combining this with
        // whatever they also bought locally — this record here is purely the
        // owning branch's own accounting, so it stays scoped to just the
        // items that were actually theirs.
        soldViaBranch: callerRecord.label,
        soldViaBranchId: license.clientId,
        items: resolved.map((r) => {
          const unitPrice = r.saleMode === 'piece' ? (r.item.piecePrice || 0) : (r.item.price || 0);
          return {
            code: r.item.code, name: r.item.name, qty: r.qty, price: unitPrice,
            wholesalePrice: r.saleMode === 'piece' ? (r.item.pieceWholesalePrice || 0) : (r.item.wholesalePrice || 0),
            unit: r.item.unit || 'pcs', isService: false, vatCategory: r.item.vatCategory || 'A',
            saleMode: r.saleMode || null,
          };
        }),
      };
      // ONE stock movement per stock figure the sale takes from, with an id made from the sale's, so the ledger applies it once and a repeat is a no-op.
      const idBase = saleId.startsWith('xb-') ? saleId : 'xb-' + saleId;
      const moves = [...wanted.values()].map((w) => ({
        id: `${idBase}:${w.item.code}${w.unit === 'pieceQty' ? ':p' : ''}`, lg: 1, timestamp: stamp, code: w.item.code, name: w.item.name,
        delta: -Math.round(w.qty * 1000) / 1000, type: 'removed', reason: `Cross-branch sale (${callerRecord.label})`, unit: w.unit, by: body.servedBy || '?',
      }));
      return { sale: saleRecord, moves };
    };

    // zip 153: the sale belongs to the TARGET branch's books — written to its D1 ledger first (idempotent on the sale id), and the request fails
    // (nothing acknowledged) if D1 does not take it.
    const toLedger = async (p) => {
      const led = await recordPush(env, targetClientId, { salesLog: [p.sale], stockMovementLog: p.moves }, { source: 'cross-branch-sale' });
      return led.ok ? null : jsonResponse({ error: 'The transaction database did not answer \u2014 nothing was sold. Try again in a moment.', code: 'busy' }, 503);
    };
    const pushBody = (p) => ({ salesLog: [p.sale], stockMovementLog: p.moves });

    if ((await shopMode(env, targetClientId)) === 'do') {
      // the branch keeps its shop in its own database: push to it like a device would (the database applies the movements once)
      const targetState = await getState(env, targetClientId);
      const p = plan(targetState);
      if (p.abort) return p.abort;
      if (p.repeated) return jsonResponse({ sale: p.repeated, repeated: true });
      const busy = await toLedger(p);
      if (busy) return busy;
      let res;
      try { res = await shopCall(env, targetClientId, 'push', { body: pushBody(p), serverNow: Date.now() }); } catch (e) { res = null; }
      if (!res || !res.ok) return jsonResponse({ error: 'That branch\u2019s shop database did not answer \u2014 nothing was sold. Try again in a moment.', code: 'busy' }, 503);
      return jsonResponse({ sale: p.sale });
    }

    // a single-record shop: same merge as a device's push, re-checked against other saves landing at the same moment (see kvMergeUpdate)
    let planned = null, ledgerDone = false, refusal = null;
    const written = await kvMergeUpdate(env, stateKey(targetClientId), async (existing) => {
      const p = plan(existing);
      if (p.abort) return { abort: p.abort };
      if (p.repeated) return { abort: jsonResponse({ sale: p.repeated, repeated: true }) };
      if (!ledgerDone) { refusal = await toLedger(p); ledgerDone = !refusal; }
      if (refusal) return { abort: refusal };
      planned = p;
      return { body: pushBody(p) };
    });
    if (written.aborted !== undefined) return written.aborted;
    return jsonResponse({ sale: planned.sale });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
