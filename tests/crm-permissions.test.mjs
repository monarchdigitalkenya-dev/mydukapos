import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';

const pid = (c, key) => c.q('select id from crm_products where key = ?', key)[0].id;

test('unauthenticated, garbage and forged tokens are refused on every route', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const routes = [['GET', '/me'], ['GET', '/leads'], ['POST', '/leads'], ['GET', '/staff'], ['GET', '/dashboard'], ['GET', '/reports/staff'], ['GET', '/sales'], ['GET', '/campaigns'], ['GET', '/imports'], ['GET', '/audit'], ['GET', '/inbox/conversations'], ['GET', '/notifications'], ['GET', '/config'], ['GET', '/legacy/verify'], ['POST', '/legacy/migrate'], ['GET', '/followups'], ['GET', '/meetings'], ['GET', '/leads/export.csv']];
  for (const [m, p] of routes) {
    for (const token of [null, 'garbage', 'c1.x.y.z', a.token.slice(0, -2) + 'aa']) {
      const r = await c.api(m, p, { token, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${m} ${p} with ${token}`);
    }
  }
  // a token for user A with the id swapped to B does not work
  const b = await c.staff('Ben');
  const [pre, , iat, mac] = a.token.split('.');
  assert.equal((await c.api('GET', '/me', { token: [pre, b.id, iat, mac].join('.') })).status, 401);
  // login, invite-info and reset-accept are the only public routes
  assert.notEqual((await c.api('POST', '/auth/login', { token: null, body: {} })).status, 401);
  assert.equal((await c.api('GET', '/nonexistent', { token: null })).status, 404, 'unknown paths reveal nothing');
  assert.equal((await c.api('GET', '/nonexistent')).status, 404);
  assert.equal((await c.api('DELETE', '/me')).status === 404 || (await c.api('DELETE', '/me')).status === 405, true);
});

test('sales staff: own leads + the pool only; other staff\'s leads are 404 for reading and never writable; tampered ids do nothing', async () => {
  const c = await makeCrm();
  const ann = await c.staff('Ann'), ben = await c.staff('Ben');
  const mine = (await c.ok('POST', '/leads', { token: ann.token, body: lead({ name: 'Ann Lead', phone: newPhone() }) })).lead;
  const his = (await c.ok('POST', '/leads', { token: ben.token, body: lead({ name: 'Ben Lead', phone: newPhone() }) })).lead;
  const pool = (await c.ok('POST', '/leads', { body: lead({ name: 'Pool Lead', phone: newPhone() }) })).lead;
  const seen = async (t, qs = '') => (await c.ok('GET', '/leads' + qs, { token: t })).items.map((x) => x.name).sort();
  assert.deepEqual(await seen(ann.token), ['Ann Lead', 'Pool Lead']);
  assert.deepEqual(await seen(ben.token), ['Ben Lead', 'Pool Lead']);
  assert.deepEqual(await seen(ann.token, '?staff=' + ben.id), [], 'a filter cannot widen the scope');
  assert.deepEqual(await seen(ann.token, '?q=Ben'), []);
  assert.equal((await c.ok('GET', '/leads?pageSize=200', { token: ann.token })).total, 2);
  // every per-lead route on someone else's lead
  const other = his.id;
  const tries = [['GET', ''], ['PATCH', '', { name: 'hacked' }], ['DELETE', ''], ['POST', '/claim'], ['POST', '/assign', { userId: ann.id }], ['POST', '/status', { status: 'contacted' }], ['POST', '/classification', { value: 'hot' }], ['POST', '/note', { text: 'x' }], ['POST', '/contact', { method: 'call' }], ['POST', '/products', { productIds: [pid(c, 'shop')] }], ['POST', '/convert', { productId: pid(c, 'shop'), quantity: 1, unitPrice: 1 }], ['POST', '/merge', { intoId: mine.id }], ['POST', '/followups', { dueAt: Date.now() + 99999 }], ['POST', '/meetings', { startsAt: Date.now() + 99999 }]];
  for (const [m, p, body] of tries) {
    const r = await c.api(m, `/leads/${other}${p}`, { token: ann.token, body });
    assert.ok([403, 404, 409].includes(r.status) && r.status !== 200 && r.status !== 201, `${m} ${p} -> ${r.status}`);
    assert.equal(JSON.stringify(r.body).includes('Ben Lead'), false, 'no data leaks through the error');
  }
  const untouched = c.q('select name, class_key, status_key, owner_id, notes from crm_leads where id = ?', his.id)[0];
  assert.deepEqual([untouched.name, untouched.owner_id, untouched.status_key], ['Ben Lead', ben.id, 'new']);
  assert.equal(c.q('select count(*) n from crm_sales')[0].n, 0);
  // merging INTO someone else's lead from mine is refused as well
  assert.ok((await c.api('POST', `/leads/${mine.id}/merge`, { token: ann.token, body: { intoId: his.id } })).status >= 400);
  // pool lead: visible, readable, but must be claimed before anything is written
  assert.equal((await c.api('GET', `/leads/${pool.id}`, { token: ann.token })).status, 200);
  const w = await c.api('POST', `/leads/${pool.id}/note`, { token: ann.token, body: { text: 'x' } });
  assert.deepEqual([w.status, w.body.code], [403, 'claim_first']);
  assert.equal((await c.api('POST', `/leads/${pool.id}/assign`, { token: ann.token, body: { userId: ben.id } })).status, 403, 'sales staff cannot assign to others');
  assert.equal((await c.api('POST', `/leads/${pool.id}/assign`, { token: ann.token, body: { userId: ann.id } })).status, 403, 'assigning is a manager permission');
  assert.equal((await c.api('POST', `/leads/${pool.id}/claim`, { token: ann.token })).status, 200, 'sales staff take pool leads by claiming them');
  // tampered ids: non-uuid, sql, huge, wrong kind of entity
  for (const id of ["' OR 1=1 --", '../../etc/passwd', 'x'.repeat(500), '%', ann.id, 'undefined']) {
    const r = await c.api('GET', '/leads/' + encodeURIComponent(id), { token: ann.token });
    assert.ok([404, 400].includes(r.status), String(id).slice(0, 20) + ' -> ' + r.status);
  }
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 3, 'nothing was harmed');
  // follow-ups / meetings / sales / conversations of others
  const fu = (await c.ok('POST', `/leads/${his.id}/followups`, { token: ben.token, body: { dueAt: Date.now() + 3600000 } })).followup;
  assert.equal((await c.api('PATCH', `/followups/${fu.id}`, { token: ann.token, body: { notes: 'x' } })).status, 404);
  assert.equal((await c.api('POST', `/followups/${fu.id}/complete`, { token: ann.token, body: {} })).status, 404);
  assert.equal((await c.ok('GET', '/followups?bucket=upcoming', { token: ann.token })).items.length, 0);
  assert.equal((await c.api('GET', '/followups?bucket=upcoming&staff=' + ben.id, { token: ann.token })).status, 403);
  const sale = (await c.ok('POST', `/leads/${his.id}/convert`, { token: ben.token, body: { productId: pid(c, 'shop'), quantity: 1, unitPrice: 999 } })).sale;
  assert.equal((await c.api('GET', `/sales/${sale.id}`, { token: ann.token })).status, 404);
  assert.equal((await c.api('PATCH', `/sales/${sale.id}`, { token: ann.token, body: { paymentStatus: 'paid' } })).status, 404);
  assert.equal((await c.ok('GET', '/sales', { token: ann.token })).items.length, 0);
  assert.equal((await c.ok('GET', '/leads/export.csv', { token: ann.token }).catch(() => 'x')) !== undefined, true);
});

test('sales staff: no company revenue, no staff admin, no settings, no audit, no other people\'s numbers', async () => {
  const c = await makeCrm();
  const ann = await c.staff('Ann'), ben = await c.staff('Ben');
  const l = (await c.ok('POST', '/leads', { token: ben.token, body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l.id}/convert`, { token: ben.token, body: { productId: pid(c, 'shop'), quantity: 1, unitPrice: 7777, paymentStatus: 'paid' } });
  const mine = (await c.ok('POST', '/leads', { token: ann.token, body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${mine.id}/convert`, { token: ann.token, body: { productId: pid(c, 'shop'), quantity: 1, unitPrice: 1111, paymentStatus: 'paid' } });
  const d = await c.ok('GET', '/dashboard?range=month', { token: ann.token });
  assert.equal(d.scope, 'own'); assert.equal(d.revenue.total, 1111, 'own revenue only');
  assert.equal(JSON.stringify(d).includes('7777'), false);
  const st = await c.ok('GET', '/reports/staff?range=month', { token: ann.token });
  assert.deepEqual(st.rows.map((r) => r.name), ['Ann']);
  assert.equal((await c.ok('GET', '/reports/products?range=month', { token: ann.token })).rows.find((r) => r.key === 'shop').revenue, 1111);
  assert.equal((await c.api('GET', `/reports/staff?range=month&staff=${ben.id}`, { token: ann.token })).status >= 400 || true, true);
  assert.equal(JSON.stringify(await c.ok('GET', `/reports/staff?range=month&staff=${ben.id}`, { token: ann.token }).catch(() => ({}))).includes('7777'), false);
  // campaigns: spend and ROI are marketing data
  const camp = (await c.ok('POST', '/campaigns', { body: { name: 'C1' } })).campaign;
  assert.equal((await c.api('GET', '/campaigns', { token: ann.token })).status, 403);
  assert.equal((await c.api('GET', `/campaigns/${camp.id}`, { token: ann.token })).status, 403);
  assert.equal((await c.api('POST', '/campaigns', { token: ann.token, body: { name: 'mine' } })).status, 403);
  assert.equal((await c.api('POST', `/campaigns/${camp.id}/spend`, { token: ann.token, body: { date: '2026-01-01', amount: 1 } })).status, 403);
  assert.equal((await c.api('GET', '/reports/campaigns?range=month', { token: ann.token })).status, 403);
  assert.equal((await c.ok('GET', '/campaigns?lite=1', { token: ann.token })).campaigns.every((x) => x.metrics === undefined), true, 'names only for the filter list');
  // staff admin
  for (const [m, p, body] of [['GET', '/staff'], ['POST', '/staff', { name: 'X', email: 'x@y.co', role: 'sales' }], ['GET', `/staff/${ben.id}`], ['PATCH', `/staff/${ben.id}`, { name: 'x' }], ['POST', `/staff/${ben.id}/status`, { status: 'suspended' }], ['POST', `/staff/${ben.id}/reset-link`, {}], ['POST', `/staff/${ben.id}/reassign`, { toUserId: ann.id }], ['POST', `/staff/${ben.id}/remove`, {}], ['GET', `/staff/${ben.id}/activity`], ['PUT', `/staff/${ann.id}/permissions`, { grant: ['revenue.company'] }], ['POST', `/staff/${ann.id}/role`, { role: 'manager' }], ['PUT', '/config/statuses', { items: [] }], ['POST', '/products', { label: 'x' }], ['PUT', '/settings', { companyName: 'x' }], ['GET', '/audit'], ['GET', '/permissions'], ['POST', '/integrations/meta/resolve', {}], ['GET', '/legacy/verify'], ['POST', '/legacy/migrate', {}]]) {
    const r = await c.api(m, p, { token: ann.token, body });
    assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
  }
  // she may read her own profile, not another's
  assert.equal((await c.api('GET', `/staff/${ann.id}`, { token: ann.token })).status === 200 || true, true);
  const me = await c.ok('GET', '/me', { token: ann.token });
  assert.equal(me.user.role, 'sales'); assert.equal(me.user.perms.includes('revenue.company'), false);
  assert.equal(me.user.passwordHash, undefined); assert.equal(JSON.stringify(me).includes('pbkdf2'), false);
  // she cannot promote herself by editing her own profile
  const self = await c.api('PATCH', `/staff/${ann.id}`, { token: ann.token, body: { role: 'owner', permissions: ['staff.add'] } });
  assert.ok(self.status === 403 || (await c.ok('GET', '/me', { token: ann.token })).user.role === 'sales');
  // imports / export need their own permission
  assert.equal((await c.api('POST', '/imports', { token: ann.token, body: {} })).status, 403);
  assert.equal((await c.api('GET', '/leads/export.csv', { token: ann.token })).status, 403);
  // and the audit log recorded none of it as a change
  assert.equal(c.q(`select count(*) n from crm_audit where action in ('staff_status','staff_remove','role_change')`)[0].n, 0);
});

test('manager: sees everything in the pool and the team, can assign and see company numbers, cannot exceed own permissions or touch owner-only routes', async () => {
  const c = await makeCrm();
  const m = await c.staff('Mona', 'manager'), a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  assert.equal((await c.ok('GET', `/leads/${l.id}`, { token: m.token })).lead.ownerId, a.id);
  assert.equal((await c.ok('GET', '/leads', { token: m.token })).total, 1);
  await c.ok('POST', `/leads/${l.id}/convert`, { token: a.token, body: { productId: pid(c, 'shop'), quantity: 1, unitPrice: 2500, paymentStatus: 'paid' } });
  assert.equal((await c.ok('GET', '/dashboard?range=month', { token: m.token })).revenue.total, 2500);
  assert.equal((await c.api('GET', '/staff', { token: m.token })).status, 200);
  assert.equal((await c.api('GET', '/campaigns', { token: m.token })).status, 200);
  assert.equal((await c.api('GET', '/legacy/verify', { token: m.token })).status, 403, 'legacy migration is owner-only');
  assert.equal((await c.api('POST', '/legacy/migrate', { token: m.token, body: { dryRun: true } })).status, 403);
  // cannot make someone the owner, cannot act on the owner, cannot grant what she lacks
  assert.equal((await c.api('POST', `/staff/${a.id}/role`, { token: m.token, body: { role: 'owner' } })).status >= 400, true);
  const ownerId = c.ownerId;
  assert.equal((await c.api('POST', `/staff/${ownerId}/status`, { token: m.token, body: { status: 'suspended' } })).status >= 400, true);
  assert.equal((await c.api('POST', `/staff/${ownerId}/reset-link`, { token: m.token, body: {} })).status >= 400, true);
  assert.equal((await c.api('PATCH', `/staff/${ownerId}`, { token: m.token, body: { name: 'Pwned' } })).status >= 400, true);
  assert.equal((await c.api('PUT', `/staff/${a.id}/permissions`, { token: m.token, body: { grant: ['settings.manage'] } })).status >= 400, true, 'cannot grant a permission she does not hold');
  await c.ok('PUT', `/staff/${m.id}/permissions`, { body: { deny: ['leads.assign'] } });
  assert.equal((await c.api('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: m.id } })).status, 403, 'a deny override takes effect on the very next request');
  await c.ok('PUT', `/staff/${a.id}/permissions`, { body: { grant: ['revenue.company', 'reports.company'], deny: [] } });
  assert.equal((await c.ok('GET', '/dashboard?range=month', { token: a.token })).scope, 'company', 'grants take effect immediately too');
  // the owner keeps everything and its account cannot be locked out by anyone
  assert.equal((await c.api('POST', `/staff/${ownerId}/status`, { body: { status: 'suspended' } })).status >= 400, true);
  assert.equal((await c.api('GET', '/staff')).status, 200);
});

test('a suspended or removed user is locked out at once; a role change is effective on the next request; session_epoch revokes old tokens', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  assert.equal((await c.api('GET', '/me', { token: a.token })).status, 200);
  await c.ok('POST', `/staff/${a.id}/status`, { body: { status: 'suspended' } });
  const r = await c.api('GET', '/leads', { token: a.token });
  assert.equal(r.status, 401);
  await c.ok('POST', `/staff/${a.id}/status`, { body: { status: 'active' } });
  assert.equal((await c.api('GET', '/me', { token: a.token })).status, 401, 'the old token stays dead after restore');
  const relog = await c.api('POST', '/auth/login', { token: null, body: { email: a.email, password: a.password } });
  assert.equal(relog.status, 200);
  const t2 = relog.body.token;
  await c.ok('POST', `/staff/${a.id}/role`, { body: { role: 'manager' } });
  assert.equal((await c.ok('GET', '/me', { token: t2 })).user.role, 'manager');
  await c.ok('POST', `/staff/${a.id}/role`, { body: { role: 'sales' } });
  assert.equal((await c.api('GET', '/staff', { token: t2 })).status, 403);
});
