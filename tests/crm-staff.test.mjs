import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';

test('admin adds staff: an invite link (never a password), single use, 7 days, only its hash is stored; accepting activates the account', async () => {
  const c = await makeCrm();
  const r = await c.api('POST', '/staff', { body: { name: 'Amina Wanjiru', email: 'Amina@Myduka.test', phone: '0722 111 222', role: 'sales', department: 'Nairobi' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.status, 'invited'); assert.equal(r.body.user.email, 'amina@myduka.test', 'e-mail is lower-cased');
  assert.equal(r.body.user.phone, '+254722111222', 'phone is normalised');
  assert.equal(r.body.user.password_hash, undefined, 'no secrets in the response'); assert.equal(JSON.stringify(r.body).includes('password_hash'), false);
  const token = new URL(r.body.inviteLink).searchParams.get('invite');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(r.body.expiresAt - Date.now() > 6.9 * 86400000 && r.body.expiresAt - Date.now() <= 7 * 86400000, true, 'valid for 7 days');
  const stored = c.q(`select * from crm_invitations`)[0];
  assert.notEqual(stored.token_hash, token); assert.equal(stored.token_hash.length, 64);
  for (const t of ['crm_users', 'crm_invitations', 'crm_audit']) assert.equal(JSON.stringify(c.q(`select * from ${t}`)).includes(token), false, 'the raw token is stored nowhere: ' + t);
  // cannot sign in before accepting
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: 'amina@myduka.test', password: 'whatever12' } })).status, 401);
  const info = await c.ok('GET', '/auth/invite?token=' + token, { token: null });
  assert.deepEqual([info.name, info.email, info.role], ['Amina Wanjiru', 'amina@myduka.test', 'sales']);
  assert.equal((await c.api('POST', '/auth/invite/accept', { token: null, body: { token, password: 'short' } })).body.code, 'weak_password');
  const acc = await c.ok('POST', '/auth/invite/accept', { token: null, body: { token, password: 'Correct-horse-9', phone: '0733000111' } });
  assert.match(acc.token, /^c1\./); assert.equal(acc.user.status, 'active'); assert.equal(acc.user.phone, '+254733000111');
  assert.ok(acc.user.perms.includes('leads.claim') && !acc.user.perms.includes('staff.view'));
  const row = c.q(`select * from crm_users where email = 'amina@myduka.test'`)[0];
  assert.equal(row.password_iters, 100000); assert.equal(row.password_salt.length, 32); assert.equal(row.password_hash.length, 64);
  assert.equal(JSON.stringify(row).includes('Correct-horse-9'), false);
  // single use
  const again = await c.api('POST', '/auth/invite/accept', { token: null, body: { token, password: 'Another-pass-1' } });
  assert.equal(again.status, 400); assert.equal(again.body.code, 'token_used');
  // login works, wrong password does not; unknown email answers the same as a wrong password
  const login = await c.ok('POST', '/auth/login', { token: null, body: { email: 'AMINA@myduka.test', password: 'Correct-horse-9' } });
  assert.equal(login.user.name, 'Amina Wanjiru');
  const bad = await c.api('POST', '/auth/login', { token: null, body: { email: 'amina@myduka.test', password: 'nope-nope-nope' } });
  const ghost = await c.api('POST', '/auth/login', { token: null, body: { email: 'ghost@myduka.test', password: 'nope-nope-nope' } });
  assert.deepEqual([bad.status, bad.body.code, bad.body.error], [ghost.status, ghost.body.code, ghost.body.error]);
  // duplicate e-mail, bad role, bad phone
  assert.equal((await c.api('POST', '/staff', { body: { name: 'Dup', email: 'amina@myduka.test', role: 'sales' } })).body.code, 'email_taken');
  const inv = await c.api('POST', '/staff', { body: { name: 'X', email: 'x@myduka.test', phone: '123', role: 'god' } });
  assert.equal(inv.status, 400); assert.ok(inv.body.fields.phone && inv.body.fields.role);
  // audit
  assert.ok(c.q(`select * from crm_audit where action = 'staff_create'`).length === 1);
  assert.ok(c.q(`select * from crm_audit where action = 'invite_accept'`).length === 1);
});

test('an expired or invalid invite is refused; a new link replaces the old one', async () => {
  const c = await makeCrm();
  const r = await c.ok('POST', '/staff', { body: { name: 'Ken', email: 'ken@myduka.test', role: 'sales' } });
  const t1 = new URL(r.inviteLink).searchParams.get('invite');
  const l2 = await c.ok('POST', `/staff/${r.user.id}/reset-link`);
  assert.equal(l2.kind, 'invite', 'a person who never accepted gets a fresh invite');
  const t2 = new URL(l2.link).searchParams.get('invite');
  assert.equal((await c.api('POST', '/auth/invite/accept', { token: null, body: { token: t1, password: 'Password-123' } })).body.code, 'token_used', 'the old link died');
  c.db._db.exec(`update crm_invitations set expires_at = ${Date.now() - 1000} where used_at is null`);
  assert.equal((await c.api('POST', '/auth/invite/accept', { token: null, body: { token: t2, password: 'Password-123' } })).body.code, 'token_expired');
  assert.equal((await c.api('GET', '/auth/invite?token=zzz', { token: null })).body.code, 'invalid_token');
  assert.equal((await c.api('GET', '/auth/invite?token=' + '0'.repeat(64), { token: null })).body.code, 'invalid_token');
});

test('roles, editing, suspend / restore / deactivate: status is read from the DB on every request, so it is immediate', async () => {
  const c = await makeCrm();
  const bob = await c.staff('Bob Otieno');
  assert.equal((await c.api('GET', '/me', { token: bob.token })).status, 200);
  // edit
  const ed = await c.ok('PATCH', `/staff/${bob.id}`, { body: { name: 'Robert Otieno', department: 'Mombasa', phone: '0700 123 456' } });
  assert.deepEqual([ed.user.name, ed.user.department, ed.user.phone], ['Robert Otieno', 'Mombasa', '+254700123456']);
  const a = c.q(`select * from crm_audit where action = 'staff_update'`)[0];
  assert.equal(JSON.parse(a.prev).name, 'Bob Otieno'); assert.equal(JSON.parse(a.next).name, 'Robert Otieno');
  // role change takes effect on the very next request
  assert.equal((await c.api('GET', '/staff', { token: bob.token })).status, 403);
  await c.ok('POST', `/staff/${bob.id}/role`, { body: { role: 'manager' } });
  assert.equal((await c.api('GET', '/staff', { token: bob.token })).status, 200);
  assert.equal((await c.api('POST', `/staff/${bob.id}/role`, { body: { role: 'owner' } })).status, 400, 'nobody can be made owner');
  await c.ok('POST', `/staff/${bob.id}/role`, { body: { role: 'sales' } });
  assert.equal((await c.api('GET', '/staff', { token: bob.token })).status, 403);
  // suspend: the SAME token stops working at once
  const s = await c.ok('POST', `/staff/${bob.id}/status`, { body: { status: 'suspended' } });
  assert.equal(s.user.status, 'suspended');
  const r = await c.api('GET', '/me', { token: bob.token });
  assert.equal(r.status, 401);
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: bob.email, password: bob.password } })).status, 401);
  // restore: signing in works again, but the old token stays dead (session epoch)
  await c.ok('POST', `/staff/${bob.id}/status`, { body: { status: 'active' } });
  assert.equal((await c.api('GET', '/me', { token: bob.token })).status, 401, 'tokens issued before the suspension are revoked for good');
  const back = await c.ok('POST', '/auth/login', { token: null, body: { email: bob.email, password: bob.password } });
  assert.equal((await c.api('GET', '/me', { token: back.token })).status, 200);
  // deactivate + reactivate
  await c.ok('POST', `/staff/${bob.id}/status`, { body: { status: 'inactive' } });
  assert.equal((await c.api('GET', '/me', { token: back.token })).status, 401);
  await c.ok('POST', `/staff/${bob.id}/status`, { body: { status: 'active' } });
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: bob.email, password: bob.password } })).status, 200);
  assert.deepEqual(c.q(`select action from crm_audit where entity = 'user' and entity_id = ? and action like 'staff_%' order by id`, bob.id).map((x) => x.action), ['staff_create', 'staff_update', 'staff_role', 'staff_role', 'staff_suspend', 'staff_restore', 'staff_deactivate', 'staff_restore']);
  // guard rails: the owner account is untouchable, you cannot suspend yourself
  assert.equal((await c.api('POST', `/staff/${c.ownerId}/status`, { body: { status: 'suspended' } })).status, 403);
  const again = await c.ok('POST', '/auth/login', { token: null, body: { email: bob.email, password: bob.password } });
  assert.equal((await c.api('POST', `/staff/${bob.id}/status`, { token: again.token, body: { status: 'suspended' } })).status, 403, 'a sales person cannot suspend anyone');
  const boss = await c.staff('Boss', 'manager', { perms: { grant: ['staff.roles', 'staff.deactivate'] } });
  assert.equal((await c.api('POST', `/staff/${boss.id}/status`, { token: boss.token, body: { status: 'inactive' } })).body.code, 'self_protected');
});

test('remove keeps every trace: the account is archived, leads / activity / ownership history keep their names', async () => {
  const c = await makeCrm();
  const amina = await c.staff('Amina'), joe = await c.staff('Joe');
  const l = (await c.ok('POST', '/leads', { token: amina.token, body: lead({ name: 'Shop Owner' }) })).lead;
  await c.ok('POST', `/leads/${l.id}/note`, { token: amina.token, body: { text: 'Called, wants a demo' } });
  await c.ok('POST', `/leads/${l.id}/contact`, { token: amina.token, body: { method: 'call', outcome: 'answered' } });
  const rm = await c.ok('POST', `/staff/${amina.id}/remove`, { body: {} });
  assert.equal(rm.openLeads, 1, 'the caller is told she still owns an open lead');
  const u = c.q(`select * from crm_users where id = ?`, amina.id)[0];
  assert.deepEqual([u.status, u.archived], ['inactive', 1], 'archived, not deleted');
  assert.equal((await c.api('GET', '/me', { token: amina.token })).status, 401);
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: amina.email, password: amina.password } })).status, 401);
  const d = await c.ok('GET', `/leads/${l.id}`);
  assert.equal(d.lead.ownerName, 'Amina');
  assert.ok(d.timeline.some((x) => x.userName === 'Amina' && x.type === 'note'), 'her activity still carries her name');
  assert.equal(d.owners[0].userName, 'Amina');
  const list = await c.ok('GET', '/staff'); assert.equal(list.items.some((x) => x.id === amina.id), false, 'hidden from the default list');
  const arch = await c.ok('GET', '/staff?archived=1'); assert.ok(arch.items.some((x) => x.id === amina.id && x.archived));
  // the database refuses a real delete
  assert.throws(() => c.db._db.exec(`delete from crm_users where id = '${amina.id}'`), /never deleted/);
  // restore brings her back with her history
  await c.ok('POST', `/staff/${amina.id}/status`, { body: { status: 'active' } });
  assert.equal(c.q(`select archived from crm_users where id = ?`, amina.id)[0].archived, 0);
  // remove + hand over in one call
  const rm2 = await c.ok('POST', `/staff/${amina.id}/remove`, { body: { toUserId: joe.id } });
  assert.equal(rm2.reassigned.moved, 1); assert.equal(rm2.openLeads, 0);
  assert.equal((await c.ok('GET', `/leads/${l.id}`)).lead.ownerId, joe.id);
});

test('reassign: all open leads / chosen leads / back to the pool; ownership history stays intact and audited', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), b = await c.staff('Ben');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'L' + i, phone: newPhone() }) })).lead.id);
  const other = (await c.ok('POST', '/leads', { token: b.token, body: lead({ name: 'Ben lead', phone: newPhone() }) })).lead.id;
  const rs = await c.ok('POST', `/staff/${a.id}/reassign`, { body: { toUserId: b.id, leadIds: [ids[0], other, 'nonsense'] } });
  assert.equal(rs.moved, 1); assert.equal(rs.skipped, 2, 'a lead that is not hers (or does not exist) is not touched');
  assert.equal((await c.ok('GET', `/leads/${ids[0]}`)).lead.ownerId, b.id);
  assert.equal(c.q(`select owner_id from crm_leads where id = ?`, other)[0].owner_id, b.id);
  // won leads stay put unless asked
  await c.ok('POST', `/leads/${ids[1]}/status`, { token: a.token, body: { status: 'lost', lostReason: 'price' } });
  const all = await c.ok('POST', `/staff/${a.id}/reassign`, { body: { toUserId: b.id, all: true } });
  assert.equal(all.moved, 2, 'the two open ones; the lost one stays with Ann');
  assert.equal(c.q(`select owner_id from crm_leads where id = ?`, ids[1])[0].owner_id, a.id);
  const pool = await c.ok('POST', `/staff/${b.id}/reassign`, { body: { toUserId: null, all: true } });
  assert.ok(pool.moved >= 3);
  assert.equal(c.q(`select count(*) n from crm_leads where owner_id is null`)[0].n, pool.moved);
  // history: every hand-over is a row, exactly one open row per owned lead, none for pooled ones
  const hist = c.q(`select kind, user_id, ended_at from crm_lead_owners where lead_id = ? order by started_at, rowid`, ids[0]);
  assert.deepEqual(hist.map((h) => h.kind), ['create', 'reassign', 'unassign']);
  assert.equal(hist.filter((h) => h.ended_at == null).length, 0);
  assert.equal(c.q(`select count(*) n from crm_lead_owners where ended_at is null`)[0].n, c.q(`select count(*) n from crm_leads where owner_id is not null`)[0].n, 'open ownership rows == owned leads');
  assert.ok(c.q(`select * from crm_audit where action = 'lead_reassign'`).length >= 3);
  assert.equal((await c.api('POST', `/staff/${a.id}/reassign`, { body: { toUserId: a.id, all: true } })).status, 400);
  assert.equal((await c.api('POST', `/staff/${a.id}/reassign`, { body: { toUserId: 'nobody', all: true } })).status, 404);
  // the new owner is told
  assert.ok((await c.ok('GET', '/notifications', { token: b.token })).items.some((n) => n.kind === 'reassigned' || n.kind === 'assigned'));
});

test('permission overrides (grant / deny) apply immediately; nobody can hand out what they lack; the owner cannot be limited', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  assert.equal((await c.api('GET', '/leads/export.csv', { token: a.token })).status, 403);
  const cat = await c.ok('GET', '/permissions');
  assert.ok(cat.keys.includes('leads.export') && cat.roles.owner.length === cat.keys.length && cat.roles.sales.length < cat.roles.manager.length);
  const put = await c.ok('PUT', `/staff/${a.id}/permissions`, { body: { grant: ['leads.export'], deny: ['leads.create'] } });
  assert.deepEqual(put.user.overrides, { grant: ['leads.export'], deny: ['leads.create'] });
  assert.equal((await c.api('GET', '/leads/export.csv', { token: a.token })).status, 200);
  assert.equal((await c.api('POST', '/leads', { token: a.token, body: lead() })).status, 403, 'a denied permission beats the role');
  // no-ops are dropped: granting what the role already gives changes nothing
  const noop = await c.ok('PUT', `/staff/${a.id}/permissions`, { body: { grant: ['leads.claim'], deny: ['staff.view'] } });
  assert.deepEqual(noop.user.overrides, { grant: [], deny: [] });
  assert.equal((await c.api('PUT', `/staff/${a.id}/permissions`, { body: { grant: ['made.up'] } })).body.code, 'invalid_permission');
  assert.equal((await c.api('PUT', `/staff/${a.id}/permissions`, { body: { grant: ['leads.view'], deny: ['leads.view'] } })).status, 400);
  // escalation: a manager who may edit roles still cannot grant what he does not hold
  const m = await c.staff('Mona', 'manager', { perms: { grant: ['staff.roles'] } });
  const e = await c.api('PUT', `/staff/${a.id}/permissions`, { token: m.token, body: { grant: ['revenue.company'] } });
  assert.equal(e.status, 403); assert.equal(e.body.code, 'escalation');
  assert.equal((await c.api('PUT', `/staff/${a.id}/permissions`, { token: m.token, body: { grant: ['leads.export'] } })).status, 200);
  assert.equal((await c.api('POST', `/staff/${a.id}/role`, { token: m.token, body: { role: 'manager' } })).status, 200, 'she may give a role whose permissions she holds');
  // ...and the owner is out of reach for everyone but themselves; own account cannot be re-permissioned
  assert.equal((await c.api('PUT', `/staff/${c.ownerId}/permissions`, { token: m.token, body: { deny: ['leads.view'] } })).status, 403);
  assert.equal((await c.api('PUT', `/staff/${m.id}/permissions`, { token: m.token, body: { grant: ['audit.view'] } })).status, 403);
  // a creation request cannot smuggle permissions in for someone without staff.roles
  const s = await c.staff('Sam', 'manager');
  assert.equal((await c.api('POST', '/staff', { token: s.token, body: { name: 'N', email: 'n@myduka.test', role: 'sales', perms: { grant: ['leads.export'] } } })).status, 403);
  assert.equal((await c.api('POST', '/staff', { token: s.token, body: { name: 'N', email: 'n@myduka.test', role: 'manager' } })).status, 403, 'creating a manager needs staff.roles');
});

test('staff profile: performance and activity come from real rows (no invented figures)', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const p = await c.ok('GET', `/staff/${a.id}`);
  assert.deepEqual([p.stats.leadsOwned, p.stats.contactAttempts, p.stats.avgFirstContactMinutes, p.stats.dealsClosed], [0, 0, null, 0], 'nothing yet: nulls and zeros, not made-up numbers');
  const l1 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  const l2 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l1.id}/contact`, { token: a.token, body: { method: 'call', outcome: 'answered' } });
  await c.ok('POST', `/leads/${l1.id}/contact`, { token: a.token, body: { method: 'whatsapp' } });
  const prod = c.q(`select id from crm_products where key = 'shop'`)[0].id;
  await c.ok('POST', `/leads/${l1.id}/convert`, { token: a.token, body: { productId: prod, quantity: 2, unitPrice: 5000, discount: 500, paymentStatus: 'partial', amountPaid: 4000 } });
  await c.ok('POST', `/leads/${l2.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 3600000, type: 'call' } });
  const s = (await c.ok('GET', `/staff/${a.id}`)).stats;
  assert.equal(s.leadsOwned, 2); assert.equal(s.openLeads, 1); assert.equal(s.contactAttempts, 2);
  assert.equal(s.dealsClosed, 1); assert.equal(s.revenue, 9500); assert.equal(s.collected, 4000);
  assert.equal(s.followupsOpen, 1); assert.equal(typeof s.avgFirstContactMinutes, 'number'); assert.ok(s.avgFirstContactMinutes >= 0 && s.avgFirstContactMinutes < 1);
  const act = await c.ok('GET', `/staff/${a.id}/activity`);
  assert.ok(act.total >= 6 && act.items.every((x) => x.userName === 'Ann'));
  assert.ok(act.items.some((x) => x.type === 'sale') && act.items.some((x) => x.type === 'contact'));
  // she can see her own profile but not a colleague's
  const b = await c.staff('Ben');
  assert.equal((await c.api('GET', `/staff/${a.id}`, { token: a.token })).status, 200);
  assert.equal((await c.api('GET', `/staff/${b.id}`, { token: a.token })).status, 403);
  assert.equal((await c.api('GET', `/staff/${b.id}/activity`, { token: a.token })).status, 403);
});

test('reset link: single use, changes the password, ends every earlier session; password change does the same', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const rl = await c.ok('POST', `/staff/${a.id}/reset-link`);
  assert.equal(rl.kind, 'reset');
  const tok = new URL(rl.link).searchParams.get('reset');
  const done = await c.api('POST', '/auth/reset/accept', { token: null, body: { token: tok, password: 'Brand-new-pass-1' } });
  assert.equal(done.status, 200);
  assert.equal((await c.api('POST', '/auth/reset/accept', { token: null, body: { token: tok, password: 'Brand-new-pass-2' } })).body.code, 'token_used');
  assert.equal((await c.api('GET', '/me', { token: a.token })).status, 401, 'the old session is gone');
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: a.email, password: a.password } })).status, 401);
  const login = await c.ok('POST', '/auth/login', { token: null, body: { email: a.email, password: 'Brand-new-pass-1' } });
  // an invite link cannot be used as a reset link and vice versa
  const inv = await c.ok('POST', '/staff', { body: { name: 'Zed', email: 'zed@myduka.test', role: 'sales' } });
  assert.equal((await c.api('POST', '/auth/reset/accept', { token: null, body: { token: new URL(inv.inviteLink).searchParams.get('invite'), password: 'Brand-new-pass-3' } })).body.code, 'invalid_token');
  // change password
  assert.equal((await c.api('POST', '/auth/password/change', { token: login.token, body: { current: 'wrong', next: 'Another-pass-22' } })).status, 403);
  assert.equal((await c.api('POST', '/auth/password/change', { token: login.token, body: { current: 'Brand-new-pass-1', next: 'short' } })).body.code, 'weak_password');
  const ch = await c.ok('POST', '/auth/password/change', { token: login.token, body: { current: 'Brand-new-pass-1', next: 'Another-pass-22' } });
  assert.equal((await c.api('GET', '/me', { token: login.token })).status, 401);
  assert.equal((await c.api('GET', '/me', { token: ch.token })).status, 200, 'a fresh token comes back');
  // suspended accounts cannot get a link
  await c.ok('POST', `/staff/${a.id}/status`, { body: { status: 'suspended' } });
  assert.equal((await c.api('POST', `/staff/${a.id}/reset-link`)).body.code, 'account_disabled');
});

test('login: rate limited per e-mail + IP (only failures count); tampered tokens are refused', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), b = await c.staff('Ben');
  const from = (ip) => ({ 'CF-Connecting-IP': ip });
  for (let i = 0; i < 8; i++) assert.equal((await c.api('POST', '/auth/login', { token: null, headers: from('9.9.9.9'), body: { email: a.email, password: 'bad-password-' + i } })).status, 401);
  const blocked = await c.api('POST', '/auth/login', { token: null, headers: from('9.9.9.9'), body: { email: a.email, password: a.password } });
  assert.equal(blocked.status, 429, 'even the right password is refused for this e-mail + IP');
  assert.equal((await c.api('POST', '/auth/login', { token: null, headers: from('9.9.9.9'), body: { email: b.email, password: b.password } })).status, 200, 'another e-mail from the same IP is fine');
  assert.equal((await c.api('POST', '/auth/login', { token: null, headers: from('8.8.8.8'), body: { email: a.email, password: a.password } })).status, 200, 'and the same e-mail from another IP');
  // tokens
  const parts = a.token.split('.');
  const forged = [parts[0], parts[1], parts[2], 'f'.repeat(64)].join('.');
  assert.equal((await c.api('GET', '/me', { token: forged })).status, 401);
  const swapped = [parts[0], b.id, parts[2], parts[3]].join('.');
  assert.equal((await c.api('GET', '/me', { token: swapped })).status, 401, 'Ann\'s signature does not work for Ben\'s id');
  assert.equal((await c.api('GET', '/me', { token: 'c1.x.y.z' })).status, 401);
  assert.equal((await c.api('GET', '/me', { token: 'garbage' })).status, 401);
  assert.equal((await c.api('GET', '/me', { token: null })).status, 401);
  // a different deployment secret cannot mint valid tokens
  const c2 = await makeCrm({ CRM_SESSION_SECRET: 'another-secret' });
  assert.equal((await c2.api('GET', '/me', { token: a.token })).status, 401);
});

test('the owner token becomes the owner CRM user automatically (once); the owner sees everything', async () => {
  const c = await makeCrm();
  const me = await c.ok('GET', '/me');
  assert.equal(me.user.role, 'owner'); assert.equal(me.user.name, 'owner@myduka.test'); assert.equal(me.user.perms.length, 34);
  await c.ok('GET', '/me'); await c.ok('GET', '/leads');
  assert.equal(c.q(`select count(*) n from crm_users where owner_ref = 'owner'`)[0].n, 1);
  assert.ok(me.config.statuses.length >= 8 && me.config.products.length >= 7 && me.integrations.whatsappApi === false);
  assert.equal((await c.api('GET', '/me', { token: 'not-the-owner-token' })).status, 401);
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: 'owner@myduka.test', password: 'x' } })).status, 401, 'the owner uses the owner console token, not a CRM password');
});
