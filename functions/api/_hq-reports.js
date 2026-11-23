// functions/api/_hq-reports.js - shared helper, NOT a route (zip 310, Phase 3 of the multi-branch brief). Business HQ: the dashboard, consolidated
// and per-branch reports (with CSV export), and role templates / custom roles applied to a person at a branch. Called by org.js AFTER it has
// authenticated the HQ user, so every rule here runs on the server. Reads only - except the roles, which write the person's branch staff record
// (the same record the branch's Staff tab edits; its PIN never leaves the server).
//
// Where the numbers come from: sales = the transaction database (ledger_sales, COMPLETED sales by business date, the same figures the branch's own
// reports reconcile against); shop-floor stock = each branch's own database; location stock and transfers = the HQ tables (_stock.js). An
// administrator only ever sees the branches in their list, consolidated totals included.
import * as S from './_stock.js';
import { audit, branchStaff, pushToBranch, adminRows, parseAdmin, listAudit } from './_org.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayAdd = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// RFC 4180 CSV; a cell starting with = + - @ is prefixed with ' so a spreadsheet never runs it as a formula
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (head, rows) => [head.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';

// the item's low-stock level, as the till itself decides it (zip 221): its own minimum / reorder level, else the shop-wide level, else 3
export function lowLevel(item, shopLevel) {
  const own = [item.reorderLevel, item.minStock].map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (own.length) return Math.max(...own);
  return Number.isFinite(Number(shopLevel)) && Number(shopLevel) >= 0 ? Number(shopLevel) : 3;
}
async function floorOf(env, clientId) {
  const { readState } = await import('./_state-store.js');
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  const items = (Array.isArray(st.inventory) ? st.inventory : []).filter((i) => i && !i._deleted && !i.removed && !i.archived && i.code != null && i.type !== 'service');
  return { items, level: st.lowStockThreshold, staff: Array.isArray(st.staff) ? st.staff : [] };
}
async function salesBy(db, ids, from, to) {
  if (!ids.length) return [];
  try {
    return (await db.prepare(`SELECT client_id, business_date AS day, COUNT(*) AS n, ROUND(SUM(total), 2) AS total, ROUND(SUM(cost), 2) AS cost,
        ROUND(SUM(cash_amount), 2) AS cash, ROUND(SUM(mpesa_amount), 2) AS mpesa, ROUND(SUM(card_amount), 2) AS card, ROUND(SUM(credit_amount), 2) AS credit
      FROM ledger_sales WHERE client_id IN (${ids.map(() => '?').join(',')}) AND business_date BETWEEN ? AND ? AND status = 'COMPLETED'
      GROUP BY client_id, business_date ORDER BY business_date, client_id`).bind(...ids, from, to).all()).results || [];
  } catch (e) { return []; }   // no sales recorded in the transaction database yet
}

/* ---------------- built-in role templates (filled with the tabs this app actually has, on the device) ---------------- */
export const TEMPLATES = [
  { key: 'branch_manager', name: 'Branch manager', isManager: true, match: '.*', not: '^(staff-tab)$', about: 'Everything at the branch except staff and settings; approves branch actions.' },
  { key: 'supervisor', name: 'Supervisor', isManager: false, match: '^(sales|pos|returns|customers|daily-sales|dashboard|stock-report|attendance|bills|debts|orders|kitchen|rooms|tables)', about: 'Till, returns, daily sales, attendance.' },
  { key: 'cashier', name: 'Cashier', isManager: false, match: '^(sales|pos|customers|bills)', about: 'Sells at the till and serves customers.' },
  { key: 'store_keeper', name: 'Store keeper', isManager: false, match: '^(inventory|add-item|store|restock|stock|deliveries|barcode|orders|purchase|suppliers)', about: 'Stock, store, restocks, counts and deliveries.' },
  { key: 'accountant', name: 'Accountant', isManager: false, match: '^(reports|profits|daily-sales|debts|trade-credits|trends|dashboard|expenses|audit|bills)', about: 'Reports, profits, debts and expenses.' },
  { key: 'auditor', name: 'Auditor (view)', isManager: false, match: '^(audit|reports|stock-report|daily-sales|trends)', about: 'Read-only reports and the audit trail.' },
];
const ROLE_SQL = [
  `CREATE TABLE IF NOT EXISTS org_role (group_id TEXT NOT NULL, role_id TEXT NOT NULL, name TEXT NOT NULL, about TEXT, tabs TEXT NOT NULL DEFAULT '[]', is_manager INTEGER NOT NULL DEFAULT 0,
     template TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, role_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_org_role_name ON org_role (group_id, lower(name))`,
];
export const ROLE_SQL_TEXT = ROLE_SQL.map((s) => s.replace(/\s+/g, ' ').trim() + ';').join('\n');
const roleReady = new WeakMap();
async function ensureRoles(db) { if (!roleReady.get(db)) { for (const q of ROLE_SQL) await db.prepare(q).run(); roleReady.set(db, true); } }
const roleOut = (r) => ({ roleId: r.role_id, name: r.name, about: r.about || '', tabs: JSON.parse(r.tabs || '[]'), isManager: !!r.is_manager, template: r.template || null, status: r.status, updatedAt: r.updated_at });
const cleanTabs = (t) => [...new Set((Array.isArray(t) ? t : []).map(String).filter((x) => /^[a-z0-9-]{2,40}$/.test(x) && x !== 'staff-tab'))].slice(0, 60);

export async function handle(ctx, a, body) {
  const { env, db, groupId, who, can, inScope, memberIds, reply, deny, branches } = ctx;
  const ids = memberIds.filter(inScope);

  /* ---------------- dashboard ---------------- */
  if (a === 'hq.dashboard') {
    await S.ensureStockSchema(db);
    const bl = (await branches()).filter((b) => inScope(b.clientId));
    const t = today(), wk = dayAdd(t, -6);
    const money = can('reports.view');      // sales and stock values: only for people allowed to see reports
    const sales = money ? await salesBy(db, ids, wk, t) : [];
    const per = await Promise.all(ids.map(async (cid) => {
      try {
        const f = await floorOf(env, cid);
        const low = f.items.filter((i) => num(i.qty) <= lowLevel(i, f.level));
        return { clientId: cid, staff: f.staff.filter((s) => s && !s.removed).length, items: f.items.length, low: low.length, out: low.filter((i) => num(i.qty) <= 0).length,
          lowItems: low.slice(0, 8).map((i) => ({ code: String(i.code), name: i.name || String(i.code), qty: num(i.qty), level: lowLevel(i, f.level) })),
          stockValue: r2(f.items.reduce((s, i) => s + Math.max(0, num(i.qty)) * num(i.wholesalePrice), 0)) };
      } catch (e) { return { clientId: cid, error: 'did not answer' }; }
    }));
    const xs = await S.listXfers(db, groupId, { clientIds: ids, limit: 1000 });
    const count = (st) => xs.filter((x) => x.status === st).length;
    const sum = (rows, k) => r2(rows.reduce((s, r) => s + num(r[k]), 0));
    const admins = (await adminRows(db, groupId)).map(parseAdmin).filter((x) => x.status === 'active');
    const byBranch = bl.map((b) => {
      const p = per.find((x) => x.clientId === b.clientId) || {};
      const s = sales.filter((r) => r.client_id === b.clientId);
      return { clientId: b.clientId, name: b.name, code: b.code, status: b.status, isMain: !!b.isMain, ...p, todaySales: sum(s.filter((r) => r.day === t), 'total'), todayCount: s.filter((r) => r.day === t).reduce((n, r) => n + num(r.n), 0), weekSales: sum(s, 'total') };
    });
    const out = {
      day: t,
      branches: { total: bl.length, active: bl.filter((b) => b.status !== 'suspended').length, suspended: bl.filter((b) => b.status === 'suspended').length },
      staff: byBranch.reduce((n, b) => n + num(b.staff), 0), admins: admins.length,
      transfers: { pending: count('pending'), awaitingDispatch: count('approved'), inTransit: count('in_transit'), partial: count('partial'), discrepancy: count('discrepancy') },
      sales: money ? { today: sum(sales.filter((r) => r.day === t), 'total'), week: sum(sales, 'total') } : null,
      lowStock: byBranch.reduce((n, b) => n + num(b.low), 0),
      byBranch: money ? byBranch : byBranch.map((b) => ({ ...b, todaySales: null, todayCount: null, weekSales: null, stockValue: null })),
      openTransfers: xs.filter((x) => ['pending', 'approved', 'in_transit', 'partial', 'discrepancy'].includes(x.status)).slice(0, 12),
      recentMovements: (await S.movements(db, groupId, { limit: 60 })).filter((m) => inScope(m.client_id)).slice(0, 12),
      recentAudit: can('audit.view') ? (await listAudit(db, groupId, {})).slice(0, 12) : [],
    };
    return reply({ ok: true, dashboard: out });
  }

  /* ---------------- reports (consolidated = all branches in scope; or one branch) ---------------- */
  if (a.startsWith('report.')) {
    if (!can('reports.view')) return deny();
    const one = body.clientId && body.clientId !== 'all' ? String(body.clientId) : null;
    if (one && !inScope(one)) return deny('That branch is not one you manage.');
    const scope = one ? [one] : ids;
    const bl = await branches(), nameOf = (cid) => { const b = bl.find((x) => x.clientId === cid); return b ? (b.code ? b.name + ' (' + b.code + ')' : b.name) : cid; };
    const to = isDay(body.to) ? body.to : today(), from = isDay(body.from) ? body.from : dayAdd(to, -29);
    if (from > to) return reply({ error: 'The start date is after the end date.' }, 400);
    let head, rows, totals = null;
    if (a === 'report.sales') {
      const s = await salesBy(db, scope, from, to);
      if (body.group === 'day' || !one) {
        // consolidated by day and branch
        head = ['Date', 'Branch', 'Sales', 'Total', 'Cost', 'Gross profit', 'Cash', 'M-Pesa', 'Card', 'On account'];
        rows = s.map((r) => [r.day, nameOf(r.client_id), r.n, r2(r.total), r2(r.cost), r2(r.total - r.cost), r2(r.cash), r2(r.mpesa), r2(r.card), r2(r.credit)]);
      } else {
        head = ['Date', 'Sales', 'Total', 'Cost', 'Gross profit', 'Cash', 'M-Pesa', 'Card', 'On account'];
        rows = s.map((r) => [r.day, r.n, r2(r.total), r2(r.cost), r2(r.total - r.cost), r2(r.cash), r2(r.mpesa), r2(r.card), r2(r.credit)]);
      }
      const per = scope.map((cid) => { const x = s.filter((r) => r.client_id === cid); return { clientId: cid, branch: nameOf(cid), n: x.reduce((t, r) => t + num(r.n), 0), total: r2(x.reduce((t, r) => t + num(r.total), 0)), cost: r2(x.reduce((t, r) => t + num(r.cost), 0)) }; });
      totals = { n: per.reduce((t, p) => t + p.n, 0), total: r2(per.reduce((t, p) => t + p.total, 0)), cost: r2(per.reduce((t, p) => t + p.cost, 0)), perBranch: per };
    } else if (a === 'report.stock') {
      await S.ensureStockSchema(db);
      const locs = await S.locations(db, groupId, scope);
      head = ['Branch', 'Location', 'Code', 'Item', 'Unit', 'Quantity', 'Unit cost', 'Value at cost', 'Low-stock level', 'Status'];
      rows = [];
      for (const cid of scope) {
        let f = { items: [], level: null };
        try { f = await floorOf(env, cid); } catch (e) { rows.push([nameOf(cid), 'Shop floor', '', '(branch did not answer)', '', '', '', '', '', '']); }
        for (const i of f.items) { const lv = lowLevel(i, f.level), q = num(i.qty); rows.push([nameOf(cid), 'Shop floor', String(i.code), i.name || '', i.unit || 'pcs', q, r2(i.wholesalePrice), r2(Math.max(0, q) * num(i.wholesalePrice)), lv, q <= 0 ? 'out' : q <= lv ? 'low' : 'ok']); }
        for (const l of locs.filter((x) => x.client_id === cid)) for (const r of await S.locStock(db, groupId, l.location_id)) rows.push([nameOf(cid), l.name, r.code, r.name, r.unit, num(r.qty), r2(r.unit_cost), r2(num(r.qty) * num(r.unit_cost)), '', num(r.qty) <= 0 ? 'out' : 'ok']);
      }
      // stock on the road belongs to no branch until it is received: listed on its own
      for (const x of (await S.listXfers(db, groupId, { clientIds: scope, limit: 1000 })).filter((x) => ['in_transit', 'partial'].includes(x.status)))
        for (const l of await S.xferLines(db, groupId, x.xfer_id)) { const q = S.inTransitOf(l); if (q > 0) rows.push([nameOf(x.to_client), 'In transit (' + x.ref + ')', l.code, l.name, l.unit, q, r2(l.unit_cost), r2(q * l.unit_cost), '', 'in transit']); }
      totals = { lines: rows.length, value: r2(rows.reduce((t, r) => t + num(r[7]), 0)), low: rows.filter((r) => r[9] === 'low').length, out: rows.filter((r) => r[9] === 'out').length };
    } else if (a === 'report.transfers') {
      await S.ensureStockSchema(db);
      const t0 = Date.parse(from + 'T00:00:00+03:00'), t1 = Date.parse(to + 'T23:59:59+03:00');
      const xs = (await S.listXfers(db, groupId, { clientIds: scope, limit: 5000 })).filter((x) => x.requested_at >= t0 && x.requested_at <= t1);
      head = ['Reference', 'Type', 'Status', 'From', 'To', 'Requested', 'Requested by', 'Approved by', 'Dispatched', 'Received', 'Item', 'Requested qty', 'Dispatched', 'Received', 'Damaged', 'Missing', 'Resolution', 'Value at cost'];
      rows = [];
      const locName = new Map((await S.locations(db, groupId, memberIds)).map((l) => [l.location_id, l.name]));
      const place = (c, l) => nameOf(c) + ' / ' + (l === 'floor' ? 'Shop floor' : (locName.get(l) || l));
      const d = (ms) => (ms ? new Date(ms + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
      for (const x of xs) for (const l of await S.xferLines(db, groupId, x.xfer_id))
        rows.push([x.ref, x.internal ? 'Move' : 'Transfer', x.status, place(x.from_client, x.from_loc), place(x.to_client, x.to_loc), d(x.requested_at), x.requested_by || '', x.approved_by || '', d(x.dispatched_at), d(x.received_at), l.name, l.qty_req, l.qty_disp, l.qty_recv, l.qty_damaged, l.qty_missing, l.resolution || '', r2(l.qty_disp * l.unit_cost)]);
      totals = { transfers: xs.length, discrepancies: xs.filter((x) => x.status === 'discrepancy').length };
    } else if (a === 'report.staff') {
      head = ['Branch', 'Name', 'Employee no.', 'Phone', 'Manager', 'Screens'];
      rows = [];
      for (const cid of scope) for (const s of (await branchStaff(env, cid)).filter((x) => x && !x.removed)) rows.push([nameOf(cid), s.name || '', s.employeeNo || '', s.phone || '', s.isManager ? 'yes' : '', (Array.isArray(s.roles) ? s.roles : []).join(' ')]);
      totals = { people: rows.length };
    } else return null;
    const out = { ok: true, from, to, scope: one ? nameOf(one) : 'All branches' + (who.branches.includes('*') ? '' : ' you manage'), head, rows: rows.slice(0, 5000), totals };
    if (body.format === 'csv') out.csv = toCsv(head, rows);
    await audit(db, groupId, who.actor, 'report.view', one ? 'branch:' + one : 'business', null, { report: a.slice(7), from, to, csv: body.format === 'csv' }, null);
    return reply(out);
  }

  /* ---------------- roles: templates + custom roles, applied to a person at a branch ---------------- */
  if (a === 'role.list') {
    await ensureRoles(db);
    const rows = (await db.prepare("SELECT * FROM org_role WHERE group_id = ? AND status = 'active' ORDER BY name").bind(groupId).all()).results || [];
    return reply({ ok: true, roles: rows.map(roleOut), templates: TEMPLATES });
  }
  if (a === 'role.save' || a === 'role.archive') {
    if (!can('staff.manage')) return deny();
    await ensureRoles(db);
    const now = Date.now();
    if (a === 'role.archive') {
      const r = await db.prepare("UPDATE org_role SET status = 'archived', updated_at = ? WHERE group_id = ? AND role_id = ? AND status = 'active'").bind(now, groupId, String(body.roleId || '')).run();
      if (!(r.meta && r.meta.changes)) return reply({ error: 'Role not found.' }, 404);
      await audit(db, groupId, who.actor, 'role.archive', 'role:' + body.roleId, null, null, body.reason || null);
      return reply({ ok: true });
    }
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return reply({ error: 'Give the role a name.' }, 400);
    const tabs = cleanTabs(body.tabs);
    if (!tabs.length) return reply({ error: 'Choose at least one screen for this role.' }, 400);
    // an administrator cannot create a role with more than a branch manager has: managers are made by the owner or someone with staff.manage over
    // all branches
    const isManager = body.isManager === true;
    if (isManager && who.kind !== 'owner' && !who.branches.includes('*')) return deny('Only the owner (or an administrator over all branches) can create a manager role.');
    const id = body.roleId ? String(body.roleId) : 'R' + now.toString(36) + Math.random().toString(36).slice(2, 5);
    const before = body.roleId ? await db.prepare('SELECT * FROM org_role WHERE group_id = ? AND role_id = ?').bind(groupId, id).first() : null;
    if (body.roleId && !before) return reply({ error: 'Role not found.' }, 404);
    try {
      await db.prepare(`INSERT INTO org_role (group_id, role_id, name, about, tabs, is_manager, template, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'active', ?, ?)
        ON CONFLICT (group_id, role_id) DO UPDATE SET name = excluded.name, about = excluded.about, tabs = excluded.tabs, is_manager = excluded.is_manager, status = 'active', updated_at = excluded.updated_at`)
        .bind(groupId, id, name, String(body.about || '').slice(0, 160), JSON.stringify(tabs), isManager ? 1 : 0, body.template ? String(body.template).slice(0, 30) : null, now, now).run();
    } catch (e) { if (/UNIQUE/i.test(String(e && e.message))) return reply({ error: 'A role with that name exists already.' }, 400); throw e; }
    await audit(db, groupId, who.actor, body.roleId ? 'role.edit' : 'role.create', 'role:' + id, before ? roleOut(before) : null, { name, tabs, isManager }, body.reason || null);
    return reply({ ok: true, role: roleOut(await db.prepare('SELECT * FROM org_role WHERE group_id = ? AND role_id = ?').bind(groupId, id).first()) });
  }
  if (a === 'staff.role') {
    // give a person a role AT ONE BRANCH (their screens + manager flag there); other branches keep their own role for the same person
    if (!can('staff.manage')) return deny();
    await ensureRoles(db);
    const pid = String(body.personId || ''), cid = String(body.clientId || '');
    if (!inScope(cid)) return deny('That branch is not one you manage.');
    if (who.kind === 'admin' && who.personId === pid) return deny('You cannot change your own role.');
    const role = await db.prepare("SELECT * FROM org_role WHERE group_id = ? AND role_id = ? AND status = 'active'").bind(groupId, String(body.roleId || '')).first();
    if (!role) return reply({ error: 'Choose a role.' }, 400);
    const r = roleOut(role);
    if (r.isManager && who.kind !== 'owner' && !who.branches.includes('*')) return deny('Only the owner can make someone a branch manager.');
    const rec = (await branchStaff(env, cid)).find((x) => x && String(x.id) === pid && !x.removed);
    if (!rec) return reply({ error: 'That person does not work at that branch.' }, 404);
    const next = { ...rec, roles: r.tabs, isManager: r.isManager, hqRoleId: r.roleId, hqRole: r.name, updatedAt: Date.now() };
    await pushToBranch(env, cid, { staff: [next] });
    await audit(db, groupId, who.actor, 'staff.role', 'person:' + pid, { branch: cid, roles: rec.roles || [], isManager: !!rec.isManager, role: rec.hqRole || null }, { branch: cid, roles: r.tabs, isManager: r.isManager, role: r.name }, body.reason || null);
    return reply({ ok: true });
  }
  return null;
}
