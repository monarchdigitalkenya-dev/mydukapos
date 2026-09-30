import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';

test('claim race: 20 concurrent claims -> exactly one winner, one owner row, one audit row', async () => {
  const c = await makeCrm();
  const users = []; for (let i = 0; i < 20; i++) users.push(await c.staff('Racer' + i));
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  assert.equal(l.ownerId, null);
  const rs = await Promise.all(users.map((u) => c.api('POST', `/leads/${l.id}/claim`, { token: u.token })));
  const wins = rs.filter((r) => r.status === 200), lost = rs.filter((r) => r.status === 409);
  assert.equal(wins.length, 1); assert.equal(lost.length, 19);
  assert.ok(lost.every((r) => r.body.code === 'already_claimed'));
  const winner = users.find((u) => u.id === wins[0].body.lead.ownerId);
  assert.ok(winner);
  assert.equal(c.q('select owner_id from crm_leads where id = ?', l.id)[0].owner_id, winner.id);
  assert.equal(c.q('select count(*) n from crm_lead_owners where lead_id = ? and ended_at is null', l.id)[0].n, 1);
  assert.equal(c.q('select count(*) n from crm_lead_owners where lead_id = ?', l.id)[0].n, 1);
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'lead_claim' and entity_id = ?`, l.id)[0].n, 1, 'losers leave no trace');
  assert.equal(c.q(`select count(*) n from crm_activities where type = 'claim' and lead_id = ?`, l.id)[0].n, 1);
  assert.deepEqual(rs.filter((r) => r.status !== 200 && r.status !== 409), []);
  // a claim by the same person again is refused too
  assert.equal((await c.api('POST', `/leads/${l.id}/claim`, { token: winner.token })).body.code, 'already_claimed');
  // response times captured
  const row = c.q('select assigned_at, claimed_at, created_at from crm_leads where id = ?', l.id)[0];
  assert.ok(row.claimed_at >= row.created_at && row.assigned_at);
});

test('ownership history: assign, reassign, return to pool; old owner loses access; history intact; notifications', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), b = await c.staff('Ben'), m = await c.staff('Mona', 'manager');
  const l = (await c.ok('POST', '/leads', { token: m.token, body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: a.id } });
  assert.equal((await c.ok('GET', '/notifications', { token: a.token })).items.filter((n) => n.kind === 'assigned').length, 1);
  await c.ok('POST', `/leads/${l.id}/note`, { token: a.token, body: { text: 'Ann was here' } });
  const un = await c.ok('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: a.id } });
  assert.equal(un.unchanged, true, 're-assigning to the same person changes nothing');
  await c.ok('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: b.id, reason: 'Ann is on leave' } });
  assert.equal((await c.api('GET', `/leads/${l.id}`, { token: a.token })).status, 404, 'Ann can no longer see it');
  assert.equal((await c.ok('GET', `/leads/${l.id}`, { token: b.token })).timeline.some((t) => t.summary === 'Ann was here'), true, 'Ben sees the history');
  const ns = (await c.ok('GET', '/notifications', { token: a.token })).items.map((n) => n.kind);
  assert.ok(ns.includes('reassigned'), 'Ann is told it moved');
  assert.ok((await c.ok('GET', '/notifications', { token: b.token })).items.some((n) => n.kind === 'reassigned'));
  await c.ok('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: null } });
  assert.equal((await c.ok('GET', `/leads/${l.id}`, { token: b.token })).lead.ownerId, null, 'pool leads stay visible');
  const hist = c.q('select user_id, kind, ended_at from crm_lead_owners where lead_id = ? order by started_at, rowid', l.id);
  assert.deepEqual(hist.map((h) => h.kind), ['assign', 'reassign', 'unassign']);
  assert.ok(hist.slice(0, 2).every((h) => h.ended_at), 'earlier owners ended');
  assert.equal(c.q(`select count(*) n from crm_audit where entity_id = ? and action in ('lead_assign','lead_reassign','lead_unassign')`, l.id)[0].n, 3);
  const d = await c.ok('GET', `/leads/${l.id}`, { token: m.token });
  assert.equal(d.owners.length, 3); assert.equal(d.owners[0].userName, 'Ann');
  // errors
  assert.equal((await c.api('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: 'nobody' } })).status, 404);
  assert.equal((await c.api('POST', `/leads/${l.id}/assign`, { token: m.token, body: {} })).status, 400);
  await c.ok('POST', `/staff/${b.id}/status`, { body: { status: 'suspended' } });
  assert.equal((await c.api('POST', `/leads/${l.id}/assign`, { token: m.token, body: { userId: b.id } })).status >= 400, true, 'cannot assign to a suspended user');
});

test('bulk actions: assign / status / classification / claim, per-lead results, limits', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), m = await c.staff('Mona', 'manager');
  const ids = []; for (let i = 0; i < 5; i++) ids.push((await c.ok('POST', '/leads', { token: m.token, body: lead({ phone: newPhone() }) })).lead.id);
  const r = await c.ok('POST', '/leads/bulk', { token: m.token, body: { ids: [...ids, 'ghost'], action: 'assign', value: a.id } });
  assert.equal(r.ok, 5); assert.equal(r.failed, 1); assert.equal(r.results.find((x) => !x.ok).id, 'ghost');
  assert.equal(c.q('select count(*) n from crm_leads where owner_id = ?', a.id)[0].n, 5);
  const s = await c.ok('POST', '/leads/bulk', { token: m.token, body: { ids, action: 'classification', value: 'warm' } });
  assert.equal(s.ok, 5);
  assert.equal((await c.api('POST', '/leads/bulk', { token: a.token, body: { ids, action: 'assign', value: a.id } })).status, 403);
  assert.equal((await c.api('POST', '/leads/bulk', { token: m.token, body: { ids, action: 'explode' } })).status, 400);
  assert.equal((await c.api('POST', '/leads/bulk', { token: m.token, body: { ids: Array(201).fill('x'), action: 'assign', value: a.id } })).status, 400);
});

test('response-time fields: created, assigned, claimed, first contact, first response, converted', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l.id}/claim`, { token: a.token });
  await c.ok('POST', `/leads/${l.id}/contact`, { token: a.token, body: { method: 'call', outcome: 'reached' } });
  await c.ok('POST', `/leads/${l.id}/convert`, { token: a.token, body: { productId: c.q(`select id from crm_products limit 1`)[0].id, quantity: 1, unitPrice: 10, paymentStatus: 'paid' } });
  const r = c.q('select created_at, assigned_at, claimed_at, first_contact_at, first_response_at, converted_at from crm_leads where id = ?', l.id)[0];
  for (const k of Object.keys(r)) assert.ok(r[k] > 0, k);
  assert.ok(r.created_at <= r.claimed_at && r.claimed_at <= r.first_contact_at && r.first_contact_at <= r.converted_at);
  const rep = await c.ok('GET', '/reports/response?range=month');
  assert.ok(JSON.stringify(rep).length > 10);
});
