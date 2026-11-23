// functions/api/_org.js - shared helper, NOT a route (zip 309). THE BUSINESS HQ: branches, people, branch assignments, HQ administrators, audit.
//
// What a "business" is did not change: a branch group (licence.branchGroupId) whose members are separate shops (each its own link, licence and
// database). A shop that has no branches yet is a business of one (group id = 'solo:<its id>'). The HQ records that belong to the BUSINESS (not to
// one branch) live here, in the shared transaction database (LEDGER_DB), keyed by group_id:
//
//   org_branch      one row per branch: code (unique in the business), name, status active | suspended, manager, contacts, location.
//   org_person      one row per PERSON (the staff record's id, the same id in every branch the person works at): name, employee number, status.
//   org_assignment  effective-dated assignments person -> branch: kind permanent | additional | temporary, starts_at, ends_at (temporary), ended_at.
//   org_admin       HQ administrators: a person given explicit HQ permissions (never everything by default), over all or listed branches.
//   org_audit       append-only (no update, no delete): who did what to which branch / person, before and after, and why.
//
// The branch's own staff list (in its synced state) stays what devices sign in with, offline as before. HQ writes into it through the branch's
// own database exactly as a device push would (pushToBranch), so every device of that branch receives it by sync; ending an assignment marks the
// record removed (never deleted), which also ends that person's server sessions there (the credential fingerprint changes).
import { shopMode, shopCall, readState, kvMergeUpdate } from './_state-store.js';

export const PERMS = ['branches.manage', 'staff.manage', 'staff.assign', 'admins.view', 'audit.view', 'reports.view', 'inventory.manage', 'transfers.approve'];
export const PERM_LABELS = {
  'branches.manage': 'Create and edit branches, suspend and activate them',
  'staff.manage': 'Edit, suspend and deactivate staff',
  'staff.assign': 'Assign and move staff between branches',
  'admins.view': 'See the list of HQ administrators',
  'audit.view': 'See the HQ audit trail',
  'reports.view': 'See consolidated reports',
  'inventory.manage': 'Manage stock locations and stock moves',
  'transfers.approve': 'Approve stock transfers between branches',
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS org_branch (group_id TEXT NOT NULL, client_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), manager_person_id TEXT, phone TEXT, email TEXT, location TEXT, notes TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, client_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_org_branch_code ON org_branch (group_id, lower(code))`,
  `CREATE TABLE IF NOT EXISTS org_person (group_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, employee_no TEXT, phone TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deactivated')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, person_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_org_person_empno ON org_person (group_id, lower(employee_no)) WHERE employee_no IS NOT NULL AND employee_no <> ''`,
  `CREATE TABLE IF NOT EXISTS org_assignment (group_id TEXT NOT NULL, assignment_id TEXT NOT NULL, person_id TEXT NOT NULL, client_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('permanent','additional','temporary')), starts_at INTEGER NOT NULL, ends_at INTEGER, ended_at INTEGER, end_reason TEXT,
     created_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (group_id, assignment_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_org_assignment_person ON org_assignment (group_id, person_id)`,
  `CREATE INDEX IF NOT EXISTS ix_org_assignment_open ON org_assignment (group_id, ended_at, ends_at)`,
  `CREATE TABLE IF NOT EXISTS org_admin (group_id TEXT NOT NULL, admin_id TEXT NOT NULL, person_id TEXT NOT NULL, home_client_id TEXT NOT NULL,
     perms TEXT NOT NULL DEFAULT '[]', branches TEXT NOT NULL DEFAULT '["*"]', status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
     created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, admin_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_org_admin_person ON org_admin (group_id, person_id)`,
  `CREATE TABLE IF NOT EXISTS org_audit (group_id TEXT NOT NULL, audit_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
     target TEXT, before_json TEXT, after_json TEXT, reason TEXT, PRIMARY KEY (group_id, audit_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_org_audit_at ON org_audit (group_id, at)`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_org_audit BEFORE DELETE ON org_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_update_org_audit BEFORE UPDATE ON org_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_org_assignment BEFORE DELETE ON org_assignment BEGIN SELECT RAISE(ABORT, 'assignment history is never deleted'); END`,
];
export const ORG_SQL = SCHEMA.map((s) => s.replace(/\s+/g, ' ').trim() + ';').join('\n');

const ready = new WeakMap();
export async function ensureOrgSchema(env) {
  const db = env && env.LEDGER_DB;
  if (!db) { const e = new Error('The business database is not set up on this deployment.'); e.code = 'no_db'; throw e; }
  if (ready.get(db)) return db;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready.set(db, true);
  return db;
}

export const groupIdOf = (record) => (record && record.branchGroupId) ? String(record.branchGroupId) : 'solo:' + String(record && record.id);
export const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const j = (v) => (v === undefined ? null : JSON.stringify(v));
const all = async (db, sql, ...b) => ((await db.prepare(sql).bind(...b).all()).results || []);
const one = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).first()) || null;

export async function audit(db, groupId, actor, action, target, before, after, reason) {
  await db.prepare('INSERT INTO org_audit (group_id, audit_id, at, actor, action, target, before_json, after_json, reason) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(groupId, rid('A'), Date.now(), String(actor || 'unknown').slice(0, 80), action, target == null ? null : String(target).slice(0, 120), j(before), j(after), reason ? String(reason).slice(0, 300) : null).run();
}
export const listAudit = (db, groupId, { limit = 200, target } = {}) => (target
  ? all(db, 'SELECT * FROM org_audit WHERE group_id = ? AND target = ? ORDER BY at DESC LIMIT ?', groupId, String(target), Math.min(500, limit))
  : all(db, 'SELECT * FROM org_audit WHERE group_id = ? ORDER BY at DESC LIMIT ?', groupId, Math.min(500, limit)));

/* ---------- branches ---------- */
export const branchRows = (db, groupId) => all(db, 'SELECT * FROM org_branch WHERE group_id = ?', groupId);
export const branchRow = (db, groupId, clientId) => one(db, 'SELECT * FROM org_branch WHERE group_id = ? AND client_id = ?', groupId, clientId);
export function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12); }
export async function saveBranch(db, groupId, clientId, f, actor, reason) {
  const before = await branchRow(db, groupId, clientId), now = Date.now();
  const code = cleanCode(f.code != null ? f.code : before && before.code), name = String(f.name != null ? f.name : (before && before.name) || '').trim().slice(0, 80);
  if (!code) return { ok: false, error: 'Give the branch a short code (letters and numbers, for example NRB1).' };
  if (!name) return { ok: false, error: 'Give the branch a name.' };
  const clash = await one(db, 'SELECT client_id, name FROM org_branch WHERE group_id = ? AND lower(code) = lower(?) AND client_id <> ?', groupId, code, clientId);
  if (clash) return { ok: false, error: `The code ${code} is already used by ${clash.name}.` };
  const pick = (k) => (f[k] !== undefined ? (f[k] == null ? null : String(f[k]).trim().slice(0, 160) || null) : (before ? before[k] : null));
  const row = { code, name, manager_person_id: pick('manager_person_id'), phone: pick('phone'), email: pick('email'), location: pick('location'), notes: pick('notes') };
  if (before) await db.prepare('UPDATE org_branch SET code=?, name=?, manager_person_id=?, phone=?, email=?, location=?, notes=?, updated_at=? WHERE group_id=? AND client_id=?')
    .bind(row.code, row.name, row.manager_person_id, row.phone, row.email, row.location, row.notes, now, groupId, clientId).run();
  else await db.prepare('INSERT INTO org_branch (group_id, client_id, code, name, status, manager_person_id, phone, email, location, notes, created_at, updated_at) VALUES (?,?,?,?,\'active\',?,?,?,?,?,?,?)')
    .bind(groupId, clientId, row.code, row.name, row.manager_person_id, row.phone, row.email, row.location, row.notes, now, now).run();
  const after = await branchRow(db, groupId, clientId);
  await audit(db, groupId, actor, before ? 'branch.edit' : 'branch.profile', 'branch:' + clientId, before, after, reason);
  return { ok: true, branch: after };
}
export async function setBranchStatus(db, groupId, clientId, status, actor, reason) {
  const before = await branchRow(db, groupId, clientId);
  if (!before) return { ok: false, error: 'Save the branch profile first.' };
  await db.prepare('UPDATE org_branch SET status = ?, updated_at = ? WHERE group_id = ? AND client_id = ?').bind(status, Date.now(), groupId, clientId).run();
  await audit(db, groupId, actor, status === 'suspended' ? 'branch.suspend' : 'branch.activate', 'branch:' + clientId, { status: before.status }, { status }, reason);
  return { ok: true };
}

/* ---------- people and assignments ---------- */
export const personRow = (db, groupId, personId) => one(db, 'SELECT * FROM org_person WHERE group_id = ? AND person_id = ?', groupId, personId);
export const personRows = (db, groupId) => all(db, 'SELECT * FROM org_person WHERE group_id = ?', groupId);
export async function upsertPerson(db, groupId, personId, f, actor) {
  const before = await personRow(db, groupId, personId), now = Date.now();
  const name = String((f.name != null ? f.name : before && before.name) || '').trim().slice(0, 80) || 'Staff member';
  const emp = f.employee_no !== undefined ? (String(f.employee_no || '').trim().slice(0, 30) || null) : (before ? before.employee_no : null);
  const phone = f.phone !== undefined ? (String(f.phone || '').trim().slice(0, 20) || null) : (before ? before.phone : null);
  const status = f.status || (before ? before.status : 'active');
  if (emp) { const dup = await one(db, 'SELECT person_id, name FROM org_person WHERE group_id = ? AND lower(employee_no) = lower(?) AND person_id <> ?', groupId, emp, personId); if (dup) return { ok: false, error: `Employee number ${emp} is already ${dup.name}'s.` }; }
  if (before) await db.prepare('UPDATE org_person SET name=?, employee_no=?, phone=?, status=?, updated_at=? WHERE group_id=? AND person_id=?').bind(name, emp, phone, status, now, groupId, personId).run();
  else await db.prepare('INSERT INTO org_person (group_id, person_id, name, employee_no, phone, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(groupId, personId, name, emp, phone, status, now, now).run();
  const after = await personRow(db, groupId, personId);
  if (actor && (!before || JSON.stringify({ ...before, updated_at: 0 }) !== JSON.stringify({ ...after, updated_at: 0 }))) await audit(db, groupId, actor, before ? 'person.edit' : 'person.add', 'person:' + personId, before, after, f.reason);
  return { ok: true, person: after };
}
export const assignmentsOf = (db, groupId, personId) => all(db, 'SELECT * FROM org_assignment WHERE group_id = ? AND person_id = ? ORDER BY starts_at', groupId, personId);
export const openAssignments = (db, groupId) => all(db, 'SELECT * FROM org_assignment WHERE group_id = ? AND ended_at IS NULL', groupId);
export async function addAssignment(db, groupId, a, actor) {
  const id = rid('AS'), now = Date.now();
  await db.prepare('INSERT INTO org_assignment (group_id, assignment_id, person_id, client_id, kind, starts_at, ends_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(groupId, id, a.person_id, a.client_id, a.kind, a.starts_at || now, a.ends_at || null, String(actor || ''), now).run();
  return id;
}
export async function endAssignments(db, groupId, personId, clientId, reason) {
  await db.prepare('UPDATE org_assignment SET ended_at = ?, end_reason = ? WHERE group_id = ? AND person_id = ? AND client_id = ? AND ended_at IS NULL')
    .bind(Date.now(), reason ? String(reason).slice(0, 120) : null, groupId, personId, clientId).run();
}
// temporary assignments whose end date has passed (to be closed by the caller, which also removes the person from that branch)
export const dueTemporary = (db, groupId, now = Date.now()) => all(db, "SELECT * FROM org_assignment WHERE group_id = ? AND kind = 'temporary' AND ended_at IS NULL AND ends_at IS NOT NULL AND ends_at <= ?", groupId, now);

/* ---------- HQ administrators ---------- */
export const adminRows = (db, groupId) => all(db, 'SELECT * FROM org_admin WHERE group_id = ?', groupId);
export const adminByPerson = (db, groupId, personId) => one(db, 'SELECT * FROM org_admin WHERE group_id = ? AND person_id = ?', groupId, personId);
export const adminById = (db, groupId, adminId) => one(db, 'SELECT * FROM org_admin WHERE group_id = ? AND admin_id = ?', groupId, adminId);
export function parseAdmin(row) {
  if (!row) return null;
  let perms = [], branches = ['*'];
  try { perms = JSON.parse(row.perms || '[]').filter((p) => PERMS.includes(p)); } catch (e) { perms = []; }
  try { branches = JSON.parse(row.branches || '["*"]'); if (!Array.isArray(branches) || !branches.length) branches = ['*']; } catch (e) { branches = ['*']; }
  return { ...row, perms, branches };
}

/* ---------- writing into a branch's own staff list (as a device push would) ---------- */
// rec: the full staff record as the branch's devices keep it. The server-side copy of the branch's state is the authority for what is there.
export async function branchStaff(env, clientId) {
  const st = await readState(env, 'pos-data:state:' + clientId, null);
  return Array.isArray(st && st.staff) ? st.staff : [];
}
export async function pushToBranch(env, clientId, body) {
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'push', { body, serverNow: Date.now() });
    if (!res || !res.ok) { const e = new Error('That branch’s database did not answer. Nothing was changed there; try again.'); e.code = 'busy'; throw e; }
    try { await res.json(); } catch (e) { /* the write is done */ }
  } else {
    await kvMergeUpdate(env, 'pos-data:state:' + clientId, async () => ({ body }), { verifyFields: [] });
  }
  try {      // the branch's other devices pull at once (a bare poke, like every other save)
    if (env.SYNC_ROOM) { const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(clientId)); Promise.resolve(room.fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true }) })).catch(() => {}); }
  } catch (e) { /* their next check finds it */ }
}
// What HQ may show about a staff record: never the PIN hash or any secret.
export function publicStaff(s) {
  if (!s) return null;
  return { id: String(s.id), name: s.name || '', roles: Array.isArray(s.roles) ? s.roles : [], isManager: !!s.isManager, removed: !!s.removed, phone: s.phone || '', employeeNo: s.employeeNo || '', updatedAt: Number(s.updatedAt) || 0 };
}
