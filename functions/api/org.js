// functions/api/org.js - Cloudflare Pages Function (zip 309). THE BUSINESS HQ API: branches, staff across branches, HQ administrators, audit.
// Data model and rules: see _org.js. Every action except 'login' needs an HQ session (X-HQ-Token), checked HERE on every request - never only
// in the app - and DENIED by default:
//   * the OWNER: signs in with the MAIN branch's management (Admin) password (SHA-256 proof, as the staff sign-in sends it). Can do everything.
//   * an HQ ADMINISTRATOR: a person the owner made one, signing in with their own PIN at their home branch. Can do only what their permissions
//     say, only for the branches they were given, never manage administrators, never touch the owner. Re-read on every request, so a change
//     or a suspension applies to the very next request; a changed PIN / password ends the session (credential fingerprint).
// The session token is signed with the MAIN branch's server key in a context of its own ('hq|'), so no staff or device token can pass as one.
//
// POST { action, ... }:
//   login {auto:true} (Admin on the main branch, no password) | {proof} | {personId, proof}          -> { token, who }
//   whoami                                     -> { who, business }
//   overview                                   -> { business, branches[], counts }
//   branch.save {clientId, code, name, phone, email, location, managerPersonId, notes, reason}
//   branch.status {clientId, status: 'active'|'suspended', reason}       (the main branch cannot be suspended; nothing is deleted)
//   branch.create {name, code, reason}
//   staff.list                                 -> { people[] }  (no PIN hashes, ever)
//   staff.assign {personId, fromClientId, toClientId, kind: 'additional'|'permanent'|'temporary', endsAt?, roles?, isManager?, reason}
//   staff.end {personId, clientId, reason}     staff.deactivate {personId, reason}     staff.edit {personId, name?, employeeNo?, phone?, reason}
//   admin.list | admin.save {personId, homeClientId, perms[], branches[]|['*'], status} | admin.remove {adminId}      (owner only, except list)
//   audit.list {target?}
// zip 310 (see _xfer-actions.js and _hq-reports.js):
//   inv.settings {save?} | inv.locations | inv.location.create {clientId, name, kind} | inv.stock {clientId, locId|'floor'}
//   inv.receive / inv.adjust {clientId, locId, key, reason, lines[{code, qty}]} | inv.movements {clientId?, locId?} | inv.move {clientId, fromLoc, toLoc, lines}
//   xfer.create {fromClient, fromLoc, toClient, toLoc, lines[{code, qty, batch?, expiry?}], notes} | xfer.list {status?} | xfer.get {xferId}
//   xfer.approve | xfer.reject {reason} | xfer.cancel {reason} | xfer.dispatch {lines?[{lineId, qty}]} | xfer.receive {receiptId, lines[{lineId, received, damaged, missing}]}
//   xfer.resolve {lines[{lineId, resolution: write_off|return_to_source|found_at_destination, note}]} | xfer.reverse {xferId}
//   hq.dashboard | report.sales / report.stock / report.transfers / report.staff {clientId|'all', from, to, format?: 'csv'}
//   role.list | role.save {roleId?, name, tabs[], isManager, about, template} | role.archive {roleId} | staff.role {personId, clientId, roleId}
import { requireValidLicense, getLicense, saveLicense, getBranchGroupMembers, getGroupMainRecord, listClientSummaries } from './_license.js';
import { shopMode, shopCall, readState } from './_state-store.js';
import { proofMatches } from './_device-auth.js';
import { shopKey, hmacHex, readMode, verifyToken, staffTokenOf } from './_staff-auth.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { corsHeadersFor } from './_cors.js';
import { createBranchFor, branchCreateCap } from './branches.js';
import * as O from './_org.js';
import { handle as stockActions } from './_xfer-actions.js';
import { handle as hqReports } from './_hq-reports.js';

const CORS_OPTS = { methods: 'POST, OPTIONS', headers: 'Content-Type, X-HQ-Token' };
const HQ_MS = 8 * 3600 * 1000;
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));
const eq = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

async function secretsOf(env, clientId) {
  if ((await shopMode(env, clientId)) === 'do') { const r = await shopCall(env, clientId, 'secrets', {}); return r.ok ? r.json() : {}; }
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  return { pwHash: st.pwHash || '', adminPwHash: st.adminPwHash || '' };
}
async function pf(env, mainId, src) { return (await hmacHex(await shopKey(env, mainId), 'hqpf|' + src)).slice(0, 16); }
async function issue(env, mainId, claims) {
  const now = Date.now(), body = b64u(JSON.stringify({ v: 1, m: mainId, iat: now, exp: now + HQ_MS, ...claims }));
  return 'h1.' + body + '.' + (await hmacHex(await shopKey(env, mainId), 'hq|' + body));
}
async function readToken(env, mainId, token) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || p[0] !== 'h1' || p[1].length > 2000) return null;
  if (!eq(await hmacHex(await shopKey(env, mainId), 'hq|' + p[1]), p[2])) return null;
  let c; try { c = JSON.parse(unb64u(p[1])); } catch (e) { return null; }
  if (!c || c.m !== mainId || !(Date.now() <= c.exp)) return null;
  return c;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  let body = {}; try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  const lic = await requireValidLicense(request, env);
  if (!lic.valid) return reply({ error: 'This link is not active.', reason: lic.reason }, 403);
  const here = lic.record || (await getLicense(env, lic.clientId));
  if (!here || here.type !== 'permanent') return reply({ error: 'Business HQ needs a permanent link.', code: 'not_permanent' }, 403);
  let db;
  try { db = await O.ensureOrgSchema(env); } catch (e) { return reply({ error: e.message, code: 'no_db' }, 503); }
  const main = here.branchGroupId ? await getGroupMainRecord(env, here) : here;
  const mainId = main.id, groupId = O.groupIdOf(here);
  const memberIds = here.branchGroupId ? await getBranchGroupMembers(env, here.branchGroupId) : [here.id];

  /* ---------------- sign in ---------------- */
  if (body.action === 'login') {
    // zip 325: NO password. The owner is whoever is signed in as the ADMIN on the MAIN branch's till. A sub-branch's admin is not the owner of the
    // business, so it is refused here (it needs an HQ administrator PIN). When the shop requires staff sessions (enforce), the request must also
    // carry a live Admin session (X-Staff-Token with every permission), checked here - not only hidden in the app.
    if (body.auto === true && !body.personId) {
      if (here.id !== mainId) return reply({ error: 'Open Business HQ from the main branch (the owner\'s branch).', code: 'not_main' }, 403);
      if ((await readMode(env, here.id)) === 'enforce') {
        const sc = await verifyToken(env, here.id, staffTokenOf(request));
        if (!sc || sc.expired || !(Array.isArray(sc.perms) && sc.perms.includes('*'))) return reply({ error: 'Sign in as the Admin on this till to open Business HQ.', code: 'admin_required' }, 403);
      }
      const so = await secretsOf(env, mainId);
      const tokenA = await issue(env, mainId, { k: 'owner', g: groupId, f: await pf(env, mainId, (so.adminPwHash || '') + '|' + (so.pwHash || '')) });
      await O.audit(db, groupId, 'owner', 'hq.signin', null, null, null, null);
      return reply({ ok: true, token: tokenA, who: { kind: 'owner', name: 'Owner', perms: O.PERMS, branches: ['*'] } });
    }
    const proof = String(body.proof || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(proof)) return reply({ error: 'Enter the password.' }, 400);
    const rl = await checkRateLimit(env, 'staffPin', 'hq:' + groupId + ':' + String(body.personId || 'owner'));
    if (!rl.ok) return rateLimitResponse('sign-in attempts', rl, cors);
    if (!body.personId) {
      const s = await secretsOf(env, mainId);
      if (!((s.adminPwHash && await proofMatches(proof, s.adminPwHash)) || (!s.adminPwHash && s.pwHash && await proofMatches(proof, s.pwHash)))) return reply({ error: 'Incorrect password. Use the management (Admin) password of the main branch.', code: 'wrong_password' }, 401);
      const token = await issue(env, mainId, { k: 'owner', g: groupId, f: await pf(env, mainId, (s.adminPwHash || '') + '|' + (s.pwHash || '')) });
      await O.audit(db, groupId, 'owner', 'hq.signin', null, null, null, null);
      return reply({ ok: true, token, who: { kind: 'owner', name: 'Owner', perms: O.PERMS, branches: ['*'] } });
    }
    const a = O.parseAdmin(await O.adminByPerson(db, groupId, String(body.personId)));
    const person = a && await O.personRow(db, groupId, a.person_id);
    if (!a || a.status !== 'active' || !person || person.status !== 'active') return reply({ error: 'This person is not an active HQ administrator.', code: 'not_admin' }, 403);
    const rec = (await O.branchStaff(env, a.home_client_id)).find((x) => x && String(x.id) === String(a.person_id) && !x.removed);
    if (!rec || !rec.pinHash || !(await proofMatches(proof, rec.pinHash))) return reply({ error: 'Incorrect PIN.', code: 'wrong_pin' }, 401);
    const token = await issue(env, mainId, { k: 'admin', g: groupId, aid: a.admin_id, pid: a.person_id, f: await pf(env, mainId, rec.pinHash) });
    await O.audit(db, groupId, 'admin:' + person.name, 'hq.signin', 'person:' + a.person_id, null, null, null);
    return reply({ ok: true, token, who: { kind: 'admin', name: person.name, perms: a.perms, branches: a.branches } });
  }

  /* ---------------- every other action: a valid HQ session, re-checked now ---------------- */
  const c = await readToken(env, mainId, request.headers.get('X-HQ-Token'));
  if (!c || c.g !== groupId) return reply({ error: 'Sign in to Business HQ.', code: 'hq_signin' }, 401);
  let who;
  if (c.k === 'owner') {
    const s = await secretsOf(env, mainId);
    if (c.f !== await pf(env, mainId, (s.adminPwHash || '') + '|' + (s.pwHash || ''))) return reply({ error: 'The password changed. Sign in again.', code: 'hq_signin' }, 401);
    who = { kind: 'owner', name: 'Owner', actor: 'owner', perms: O.PERMS, branches: ['*'] };
  } else if (c.k === 'admin') {
    const a = O.parseAdmin(await O.adminById(db, groupId, c.aid));
    const person = a && await O.personRow(db, groupId, a.person_id);
    if (!a || a.status !== 'active' || !person || person.status !== 'active') return reply({ error: 'Your HQ access was removed.', code: 'hq_revoked' }, 403);
    const rec = (await O.branchStaff(env, a.home_client_id)).find((x) => x && String(x.id) === String(a.person_id) && !x.removed);
    if (!rec || c.f !== await pf(env, mainId, rec.pinHash || '')) return reply({ error: 'Your PIN changed or you were removed from your branch. Sign in again.', code: 'hq_signin' }, 401);
    who = { kind: 'admin', name: person.name, actor: 'admin:' + person.name, personId: a.person_id, perms: a.perms, branches: a.branches };
  } else return reply({ error: 'Sign in to Business HQ.', code: 'hq_signin' }, 401);
  const can = (perm) => who.kind === 'owner' || who.perms.includes(perm);
  const inScope = (cid) => memberIds.includes(cid) && (who.branches.includes('*') || who.branches.includes(cid));
  const deny = (msg) => reply({ error: msg || 'You do not have permission for this.', code: 'forbidden' }, 403);

  // temporary assignments that have run out end now (the person is removed from that branch; history stays)
  try { await expireTemporary(env, db, groupId); } catch (e) { /* tried again on the next request */ }

  const a = String(body.action || '');
  if (a === 'whoami') return reply({ who: publicWho(who), groupId, mainId });

  if (a === 'overview') {
    const branches = await branchList(env, db, groupId, memberIds, mainId);
    return reply({ who: publicWho(who), branches: branches.filter((b) => inScope(b.clientId)), perms: O.PERM_LABELS });
  }

  /* ---------------- branches ---------------- */
  if (a === 'branch.save') {
    if (!can('branches.manage')) return deny();
    const cid = String(body.clientId || ''); if (!inScope(cid)) return deny('That branch is not one you manage.');
    const r = await O.saveBranch(db, groupId, cid, { code: body.code, name: body.name, phone: body.phone, email: body.email, location: body.location, notes: body.notes, manager_person_id: body.managerPersonId }, who.actor, body.reason);
    return reply(r, r.ok ? 200 : 400);
  }
  if (a === 'branch.status') {
    if (!can('branches.manage')) return deny();
    const cid = String(body.clientId || ''), status = body.status === 'suspended' ? 'suspended' : 'active';
    if (!inScope(cid)) return deny('That branch is not one you manage.');
    if (cid === mainId && status === 'suspended') return reply({ error: 'The main branch cannot be suspended. Make another branch the main one first.' }, 400);
    if (status === 'suspended' && !String(body.reason || '').trim()) return reply({ error: 'Give a reason for suspending the branch.' }, 400);
    if (!(await O.branchRow(db, groupId, cid))) { const r0 = await O.saveBranch(db, groupId, cid, await defaultProfile(env, cid), who.actor, 'profile created'); if (!r0.ok) return reply(r0, 400); }
    const rec = await getLicense(env, cid); if (!rec) return reply({ error: 'Branch not found.' }, 404);
    rec.branchSuspended = status === 'suspended'; await saveLicense(env, rec);
    return reply(await O.setBranchStatus(db, groupId, cid, status, who.actor, body.reason));
  }
  if (a === 'branch.create') {
    if (!can('branches.manage')) return deny();
    if (who.kind !== 'owner' && !who.branches.includes('*')) return deny('Only the owner, or an administrator over all branches, can add a branch.');
    const name = String(body.name || '').trim().slice(0, 80), code = O.cleanCode(body.code);
    if (!name || !code) return reply({ error: 'Give the new branch a name and a short code.' }, 400);
    const taken = (await O.branchRows(db, groupId)).find((b) => b.code.toLowerCase() === code.toLowerCase() || b.name.toLowerCase() === name.toLowerCase());
    if (taken) return reply({ error: taken.code.toLowerCase() === code.toLowerCase() ? `The code ${code} is already used by ${taken.name}.` : `There is already a branch called ${taken.name}.` }, 400);
    const mainRec = await getLicense(env, mainId);
    const capErr = await branchCreateCap(env, mainRec); if (capErr) return capErr;
    const made = await createBranchFor(env, mainRec, name);
    const newGroup = O.groupIdOf(await getLicense(env, mainId));
    if (newGroup !== groupId) await migrateSolo(db, groupId, newGroup);      // the first branch turns a business of one into a group
    const r = await O.saveBranch(db, newGroup, made.branch.id, { code, name }, who.actor, body.reason || 'branch created');
    if (!(await O.branchRow(db, newGroup, mainId))) await O.saveBranch(db, newGroup, mainId, await defaultProfile(env, mainId, 'MAIN'), who.actor, 'profile created');
    return reply({ ok: r.ok, branch: { clientId: made.branch.id, name, code, link: made.branch.link || null }, error: r.error, groupChanged: newGroup !== groupId });
  }

  /* ---------------- staff ---------------- */
  if (a === 'staff.list') {
    if (!can('staff.manage') && !can('staff.assign')) return deny();
    return reply({ people: await peopleList(env, db, groupId, memberIds.filter(inScope)) });
  }
  if (a === 'staff.assign') {
    if (!can('staff.assign')) return deny();
    const pid = String(body.personId || ''), from = String(body.fromClientId || ''), to = String(body.toClientId || '');
    const kind = ['additional', 'permanent', 'temporary'].includes(body.kind) ? body.kind : '';
    if (!pid || !kind) return reply({ error: 'Choose the person and how they are moving.' }, 400);
    if (!inScope(from) || !inScope(to)) return deny('Both branches must be ones you manage.');
    if (from === to) return reply({ error: 'Choose a different branch.' }, 400);
    if (who.personId && who.personId === pid) return deny('You cannot change your own assignment.');
    const endsAt = kind === 'temporary' ? Number(body.endsAt) || 0 : 0;
    if (kind === 'temporary' && !(endsAt > Date.now() + 3600000)) return reply({ error: 'A temporary assignment needs an end date at least an hour from now.' }, 400);
    const toRow = await O.branchRow(db, groupId, to); if (toRow && toRow.status === 'suspended') return reply({ error: `${toRow.name} is suspended.` }, 400);
    const src = (await O.branchStaff(env, from)).find((x) => x && String(x.id) === pid && !x.removed);
    if (!src) return reply({ error: 'That person does not work at the branch you moved them from.' }, 404);
    const person = await O.personRow(db, groupId, pid);
    if (person && person.status === 'deactivated') return reply({ error: 'This person is deactivated. Reactivate them first.' }, 400);
    const there = (await O.branchStaff(env, to)).find((x) => x && String(x.id) === pid);
    if (there && !there.removed) return reply({ error: 'This person already works at that branch.' }, 400);
    const now = Date.now();
    const roles = Array.isArray(body.roles) ? body.roles.map(String).slice(0, 60) : src.roles;
    const rec = { ...src, roles, isManager: body.isManager === undefined ? !!src.isManager : !!body.isManager, removed: false, updatedAt: now, hqAssigned: { kind, at: now, from } };
    await O.upsertPerson(db, groupId, pid, { name: src.name }, null);
    try { await O.pushToBranch(env, to, { staff: [rec] }); } catch (e) { return reply({ error: e.message, code: 'busy' }, 503); }
    await O.addAssignment(db, groupId, { person_id: pid, client_id: to, kind, ends_at: endsAt || null }, who.actor);
    let movedOut = false;
    if (kind === 'permanent') {
      try { await O.pushToBranch(env, from, { staff: [{ ...src, removed: true, updatedAt: now + 1 }] }); movedOut = true; } catch (e) { /* reported below */ }
      if (movedOut) await O.endAssignments(db, groupId, pid, from, 'moved permanently');
    }
    await O.audit(db, groupId, who.actor, 'staff.assign.' + kind, 'person:' + pid, { branch: from }, { branch: to, roles, endsAt: endsAt || null, removedFromSource: movedOut }, body.reason);
    return reply({ ok: true, partial: kind === 'permanent' && !movedOut ? 'Added to the new branch, but the old branch did not answer: remove them there with "End assignment".' : null });
  }
  if (a === 'staff.end') {
    if (!can('staff.assign')) return deny();
    const pid = String(body.personId || ''), cid = String(body.clientId || '');
    if (!inScope(cid)) return deny('That branch is not one you manage.');
    if (who.personId && who.personId === pid) return deny('You cannot change your own assignment.');
    const rec = (await O.branchStaff(env, cid)).find((x) => x && String(x.id) === pid && !x.removed);
    if (!rec) return reply({ error: 'This person does not work at that branch.' }, 404);
    try { await O.pushToBranch(env, cid, { staff: [{ ...rec, removed: true, updatedAt: Date.now() }] }); } catch (e) { return reply({ error: e.message, code: 'busy' }, 503); }
    await O.endAssignments(db, groupId, pid, cid, String(body.reason || 'ended').slice(0, 120));
    await O.audit(db, groupId, who.actor, 'staff.end', 'person:' + pid, { branch: cid }, null, body.reason);
    return reply({ ok: true });
  }
  if (a === 'staff.deactivate' || a === 'staff.reactivate') {
    if (!can('staff.manage')) return deny();
    const pid = String(body.personId || '');
    if (who.personId && who.personId === pid) return deny('You cannot change your own account.');
    if (a === 'staff.deactivate' && !String(body.reason || '').trim()) return reply({ error: 'Give a reason.' }, 400);
    const places = [];
    for (const cid of memberIds) { const rec = (await O.branchStaff(env, cid)).find((x) => x && String(x.id) === pid); if (rec) places.push({ cid, rec }); }
    if (!places.length) return reply({ error: 'Person not found.' }, 404);
    if (places.some((p) => !inScope(p.cid))) return deny('This person also works at a branch you do not manage.');
    await O.upsertPerson(db, groupId, pid, { name: places[0].rec.name, status: a === 'staff.deactivate' ? 'deactivated' : 'active' }, null);
    const failed = [];
    if (a === 'staff.deactivate') {
      for (const p of places) {
        if (p.rec.removed) continue;
        try { await O.pushToBranch(env, p.cid, { staff: [{ ...p.rec, removed: true, updatedAt: Date.now() }] }); await O.endAssignments(db, groupId, pid, p.cid, 'deactivated'); } catch (e) { failed.push(p.cid); }
      }
      const adm = await O.adminByPerson(db, groupId, pid);
      if (adm) await db.prepare("UPDATE org_admin SET status = 'suspended', updated_at = ? WHERE group_id = ? AND admin_id = ?").bind(Date.now(), groupId, adm.admin_id).run();
    }
    await O.audit(db, groupId, who.actor, a, 'person:' + pid, null, { branches: places.map((p) => p.cid), failed }, body.reason);
    return reply({ ok: !failed.length, failed, note: a === 'staff.reactivate' ? 'Reactivated. Assign them to a branch to give them access again.' : null });
  }
  if (a === 'staff.edit') {
    if (!can('staff.manage')) return deny();
    const pid = String(body.personId || '');
    const r = await O.upsertPerson(db, groupId, pid, { name: body.name, employee_no: body.employeeNo, phone: body.phone, reason: body.reason }, who.actor);
    return reply(r, r.ok ? 200 : 400);
  }

  /* ---------------- HQ administrators (owner manages; delegation never exceeds the owner's choice) ---------------- */
  if (a === 'admin.list') {
    if (!can('admins.view')) return deny();
    const rows = (await O.adminRows(db, groupId)).map(O.parseAdmin);
    const people = new Map((await O.personRows(db, groupId)).map((p) => [p.person_id, p]));
    return reply({ admins: rows.map((r) => ({ adminId: r.admin_id, personId: r.person_id, name: (people.get(r.person_id) || {}).name || r.person_id, homeClientId: r.home_client_id, perms: r.perms, branches: r.branches, status: r.status })) });
  }
  if (a === 'admin.save' || a === 'admin.remove') {
    if (who.kind !== 'owner') return deny('Only the owner can manage HQ administrators.');
    if (a === 'admin.remove') {
      const row = await O.adminById(db, groupId, String(body.adminId || '')); if (!row) return reply({ error: 'Not found.' }, 404);
      await db.prepare("UPDATE org_admin SET status = 'suspended', updated_at = ? WHERE group_id = ? AND admin_id = ?").bind(Date.now(), groupId, row.admin_id).run();
      await O.audit(db, groupId, who.actor, 'admin.remove', 'person:' + row.person_id, O.parseAdmin(row), { status: 'suspended' }, body.reason);
      return reply({ ok: true });
    }
    const pid = String(body.personId || ''), home = String(body.homeClientId || '');
    if (!memberIds.includes(home)) return reply({ error: 'Choose the branch this person works at.' }, 400);
    const rec = (await O.branchStaff(env, home)).find((x) => x && String(x.id) === pid && !x.removed);
    if (!rec) return reply({ error: 'That person does not work at that branch.' }, 404);
    if (!rec.pinHash) return reply({ error: 'This person has no PIN yet. Set one in their branch first.' }, 400);
    const perms = (Array.isArray(body.perms) ? body.perms : []).filter((p) => O.PERMS.includes(p));
    if (!perms.length) return reply({ error: 'Choose at least one permission.' }, 400);
    const branches = Array.isArray(body.branches) && body.branches.length && !body.branches.includes('*') ? body.branches.filter((x) => memberIds.includes(x)) : ['*'];
    const status = body.status === 'suspended' ? 'suspended' : 'active', now = Date.now();
    await O.upsertPerson(db, groupId, pid, { name: rec.name }, null);
    const before = await O.adminByPerson(db, groupId, pid);
    if (before) await db.prepare('UPDATE org_admin SET home_client_id=?, perms=?, branches=?, status=?, updated_at=? WHERE group_id=? AND admin_id=?').bind(home, JSON.stringify(perms), JSON.stringify(branches), status, now, groupId, before.admin_id).run();
    else await db.prepare('INSERT INTO org_admin (group_id, admin_id, person_id, home_client_id, perms, branches, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(groupId, O.rid('AD'), pid, home, JSON.stringify(perms), JSON.stringify(branches), status, who.actor, now, now).run();
    await O.audit(db, groupId, who.actor, before ? 'admin.edit' : 'admin.add', 'person:' + pid, before ? O.parseAdmin(before) : null, { perms, branches, status }, body.reason);
    return reply({ ok: true });
  }

  if (a === 'audit.list') {
    if (!can('audit.view')) return deny();
    return reply({ audit: (await O.listAudit(db, groupId, { target: body.target || undefined, limit: Number(body.limit) || 200 })).map((r) => ({ at: r.at, actor: r.actor, action: r.action, target: r.target, before: safeJson(r.before_json), after: safeJson(r.after_json), reason: r.reason })) });
  }

  // zip 310: stock locations, moves and transfers (same authenticated context: every rule is checked there, on the server)
  if (/^(inv|xfer)\./.test(a)) {
    const res = await stockActions({ env, db, groupId, who, can, inScope, memberIds, mainId, reply, deny }, a, body);
    if (res) return res;
  }
  // zip 310: dashboard, reports (CSV), role templates / custom roles
  if (/^(hq|report|role)\./.test(a) || a === 'staff.role') {
    const res = await hqReports({ env, db, groupId, who, can, inScope, memberIds, mainId, reply, deny, branches: () => branchList(env, db, groupId, memberIds, mainId) }, a, body);
    if (res) return res;
  }
  return reply({ error: 'Unknown action.' }, 400);
}

const safeJson = (t) => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
const publicWho = (w) => ({ kind: w.kind, name: w.name, perms: w.perms, branches: w.branches });

async function defaultProfile(env, clientId, fallbackCode) {
  const rec = await getLicense(env, clientId);
  const name = (rec && (rec.businessName || rec.label)) || (rec && rec.slug) || clientId;
  return { name: String(name).slice(0, 80), code: O.cleanCode(fallbackCode || (rec && rec.slug) || clientId).slice(0, 12) || 'BR' };
}

async function branchList(env, db, groupId, memberIds, mainId) {
  const rows = new Map((await O.branchRows(db, groupId)).map((r) => [r.client_id, r]));
  let names = new Map();
  try { names = new Map((await listClientSummaries(env)).filter((s) => memberIds.includes(s.id)).map((s) => [s.id, s.businessName || s.label || s.slug])); } catch (e) { /* names from the licences below */ }
  const out = [];
  for (const cid of memberIds) {
    const r = rows.get(cid), rec = await getLicense(env, cid);
    const staff = await O.branchStaff(env, cid);
    out.push({ clientId: cid, isMain: cid === mainId, code: r ? r.code : null, name: (r && r.name) || names.get(cid) || (rec && (rec.label || rec.slug)) || cid, status: r ? r.status : (rec && rec.branchSuspended ? 'suspended' : 'active'),
      slug: rec && rec.slug, phone: r && r.phone, email: r && r.email, location: r && r.location, notes: r && r.notes, managerPersonId: r && r.manager_person_id,
      staffCount: staff.filter((s) => s && !s.removed).length, hasProfile: !!r });
  }
  return out;
}

async function peopleList(env, db, groupId, branchIds) {
  const persons = new Map((await O.personRows(db, groupId)).map((p) => [p.person_id, p]));
  const open = await O.openAssignments(db, groupId);
  const admins = new Map((await O.adminRows(db, groupId)).map((r) => [r.person_id, O.parseAdmin(r)]));
  const people = new Map();
  for (const cid of branchIds) {
    for (const s of await O.branchStaff(env, cid)) {
      if (!s || s.id == null) continue;
      const pid = String(s.id);
      if (!people.has(pid)) people.set(pid, { personId: pid, name: s.name || '', branches: [] });
      const asg = open.filter((x) => x.person_id === pid && x.client_id === cid).sort((x, y) => y.starts_at - x.starts_at)[0];
      people.get(pid).branches.push({ clientId: cid, active: !s.removed, roles: Array.isArray(s.roles) ? s.roles : [], isManager: !!s.isManager, kind: asg ? asg.kind : (s.removed ? null : 'home'), endsAt: asg && asg.ends_at ? asg.ends_at : null });
    }
  }
  return [...people.values()].map((p) => {
    const row = persons.get(p.personId), adm = admins.get(p.personId);
    return { ...p, name: (row && row.name) || p.name, employeeNo: row ? row.employee_no : null, phone: row ? row.phone : null, status: row ? row.status : (p.branches.some((b) => b.active) ? 'active' : 'inactive'),
      hqAdmin: adm && adm.status === 'active' ? { perms: adm.perms, branches: adm.branches } : null };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

async function expireTemporary(env, db, groupId) {
  for (const asg of await O.dueTemporary(db, groupId)) {
    const rec = (await O.branchStaff(env, asg.client_id)).find((x) => x && String(x.id) === asg.person_id && !x.removed);
    if (rec) await O.pushToBranch(env, asg.client_id, { staff: [{ ...rec, removed: true, updatedAt: Date.now() }] });
    await db.prepare('UPDATE org_assignment SET ended_at = ?, end_reason = ? WHERE group_id = ? AND assignment_id = ?').bind(Date.now(), 'temporary assignment ended', groupId, asg.assignment_id).run();
    await O.audit(db, groupId, 'system', 'staff.temporary.expired', 'person:' + asg.person_id, { branch: asg.client_id, endsAt: asg.ends_at }, null, null);
  }
}

// a business of one gets a branch group when its first branch is added: its HQ rows follow it
async function migrateSolo(db, fromGroup, toGroup) {
  for (const t of ['org_branch', 'org_person', 'org_admin']) await db.prepare(`UPDATE ${t} SET group_id = ? WHERE group_id = ?`).bind(toGroup, fromGroup).run();
  // assignments and the audit are history: copied, never moved or changed
  await db.prepare('INSERT INTO org_assignment (group_id, assignment_id, person_id, client_id, kind, starts_at, ends_at, ended_at, end_reason, created_by, created_at) SELECT ?, assignment_id, person_id, client_id, kind, starts_at, ends_at, ended_at, end_reason, created_by, created_at FROM org_assignment WHERE group_id = ?').bind(toGroup, fromGroup).run();
  await db.prepare('INSERT INTO org_audit (group_id, audit_id, at, actor, action, target, before_json, after_json, reason) SELECT ?, audit_id, at, actor, action, target, before_json, after_json, reason FROM org_audit WHERE group_id = ?').bind(toGroup, fromGroup).run();
}
