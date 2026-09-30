import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, newPhone } from './crm-harness.mjs';

const P = (i) => '07' + String(20000000 + i).padStart(8, '0');
async function run(c, rows, { options, mapping, source, token, fileName = 'leads.csv' } = {}) {
  const { id } = await c.ok('POST', '/imports', { token, body: { fileName, options, mapping, source } });
  for (let i = 0; i < rows.length; i += 400) await c.ok('POST', `/imports/${id}/rows`, { token, body: { rows: rows.slice(i, i + 400) } });
  return id;
}
async function commitAll(c, id, token) {
  let last, calls = 0;
  do { last = await c.ok('POST', `/imports/${id}/commit`, { token }); calls++; assert.ok(last.batch === undefined || last.batch <= 200, 'batch <= 200'); } while (!last.done && calls < 200);
  return { last, calls };
}

test('import: staged, preview counts (valid / invalid / dupes in DB / dupes in file), skip is the default, results + error CSV + history', async () => {
  const c = await makeCrm();
  await c.ok('POST', '/leads', { body: { name: 'Existing', phone: P(1) } });
  const rows = [
    { Name: 'Good One', Phone: P(2), Email: 'g1@x.co.ke', Source: 'Website', Product: 'Shop POS', Classification: 'Hot', utm_campaign: 'sep' },
    { Name: 'Dup DB', Phone: '+254 ' + P(1).slice(1) },
    { Name: 'Dup File', Phone: P(2) },
    { Name: 'No Contact' },
    { Name: 'Bad Phone', Phone: '123' },
    { Name: 'Bad Mail', Phone: P(3), Email: 'nope' },
    { Name: 'Warn', Phone: P(4), Source: 'smoke signals', Product: 'Nothing', Classification: 'lava' },
    { Name: '', Phone: P(5) },
  ];
  const id = await run(c, rows);
  const pv = await c.ok('GET', `/imports/${id}/preview`);
  assert.deepEqual([pv.counts.total, pv.counts.valid, pv.counts.invalid, pv.counts.duplicateExisting, pv.counts.duplicateInFile], [8, 2, 4, 1, 1]);
  assert.equal(pv.counts.willSkip, 2); assert.equal(pv.counts.willCreate, 2); assert.equal(pv.options.duplicates, 'skip', 'skip by default');
  assert.equal(pv.counts.warnings, 1);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1, 'preview writes nothing');
  // error CSV is available before the commit too
  const pre = await c.api('GET', `/imports/${id}/errors.csv`); assert.match(pre.text, /No Contact/);
  const { last } = await commitAll(c, id);
  assert.deepEqual([last.created, last.skipped, last.failed, last.warnings], [2, 2, 4, 1]);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 3);
  const good = c.q(`select * from crm_leads where name = 'Good One'`)[0];
  assert.equal(good.source_key, 'website'); assert.equal(good.class_key, 'hot'); assert.equal(good.first_utm_campaign, 'sep'); assert.equal(c.q('select count(*) n from crm_lead_products where lead_id = ?', good.id)[0].n, 1);
  const warn = c.q(`select source_key, class_key from crm_leads where name = 'Warn'`)[0]; assert.deepEqual([warn.source_key, warn.class_key], ['import', null]);
  const res = await c.ok('GET', `/imports/${id}?rows=error`);
  assert.equal(res.rows.length, 4); assert.ok(res.rows.every((r) => r.error));
  assert.equal((await c.ok('GET', `/imports/${id}?rows=skipped`)).rows.length, 2);
  const errs = await c.api('GET', `/imports/${id}/errors.csv`);
  assert.equal(errs.status, 200); assert.match(errs.res.headers.get('content-disposition'), /import-errors/);
  assert.equal(errs.text.trim().split('\n').length, 5, 'header + 4 failed rows'); assert.match(errs.text, /Bad Phone/); assert.doesNotMatch(errs.text, /Good One/);
  const hist = await c.ok('GET', '/imports');
  assert.equal(hist.items[0].id, id); assert.equal(hist.items[0].status, 'done'); assert.equal(hist.items[0].createdByName.length > 0, true);
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'import_create'`)[0].n, 1);
  // committing a finished import is a no-op (no doubles)
  assert.equal((await c.ok('POST', `/imports/${id}/commit`)).done, true); assert.equal(c.q('select count(*) n from crm_leads')[0].n, 3);
  // no new staging after the start
  assert.equal((await c.api('POST', `/imports/${id}/rows`, { body: { rows: [{ Name: 'x', Phone: P(9) }] } })).status, 409);
  // template
  const t = await c.api('GET', '/imports/template.csv'); assert.equal(t.status, 200); assert.match(t.text.split('\n')[0], /name/i);
});

test('import duplicate policies: update fills blanks / create adds anyway', async () => {
  const c = await makeCrm();
  const l = (await c.ok('POST', '/leads', { body: { name: 'Old Name', phone: P(11), notes: 'kept' } })).lead;
  const rows = [{ Name: 'New Name', Phone: P(11), Email: 'new@x.co.ke', Location: 'Kisumu', Notes: 'from sheet' }];
  const u = await run(c, rows, { options: { duplicates: 'update' } });
  assert.equal((await c.ok('GET', `/imports/${u}/preview`)).counts.willUpdate, 1);
  const r = (await commitAll(c, u)).last; assert.deepEqual([r.updated, r.created], [1, 0]);
  const after = c.q('select name, email, location, notes from crm_leads where id = ?', l.id)[0];
  assert.deepEqual([after.email, after.location, after.notes], ['new@x.co.ke', 'Kisumu', 'kept\nfrom sheet']);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'lead_import_update'`)[0].n, 1);
  const cr = await run(c, [{ Name: 'Twin', Phone: P(11) }], { options: { duplicates: 'create' } });
  assert.equal((await commitAll(c, cr)).last.created, 1); assert.equal(c.q('select count(*) n from crm_leads')[0].n, 2);
  assert.equal((await c.api('POST', '/imports', { body: { options: { duplicates: 'destroy' } } })).status, 400);
  assert.equal((await c.api('POST', '/imports', { body: { source: 'nope' } })).status, 400);
});

test('import assignment: one / csv / roundrobin / equal; commits in batches of at most 200', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), b = await c.staff('Ben'), d = await c.staff('Dee');
  // give Ann a head start so "equal" (workload balanced) shows
  for (let i = 0; i < 6; i++) { const l = (await c.ok('POST', '/leads', { body: { name: 'pre' + i, phone: P(500 + i) } })).lead; await c.ok('POST', `/leads/${l.id}/assign`, { body: { userId: a.id } }); }
  const rows = (n, off) => Array.from({ length: n }, (_, i) => ({ Name: 'L' + (off + i), Phone: P(off + i) }));
  const owners = (name) => c.q(`select u.name n, count(*) k from crm_leads l join crm_users u on u.id = l.owner_id where l.name like ? group by u.name`, name + '%').reduce((m, r) => ({ ...m, [r.n]: r.k }), {});
  // none -> pool
  let id = await run(c, rows(3, 1000)); await commitAll(c, id);
  assert.equal(c.q(`select count(*) n from crm_leads where name like 'L100%' and owner_id is null`)[0].n, 3);
  // one
  id = await run(c, rows(4, 1100), { options: { assign: { mode: 'one', userIds: [b.id] } } }); await commitAll(c, id);
  assert.deepEqual(owners('L110'), { Ben: 4 });
  assert.equal((await c.ok('GET', `/imports/${id}`)).assignments[0].leads, 4);
  // roundrobin
  id = await run(c, rows(9, 1200), { options: { assign: { mode: 'roundrobin', userIds: [a.id, b.id, d.id] } } }); await commitAll(c, id);
  assert.deepEqual(owners('L12'), { Ann: 3, Ben: 3, Dee: 3 });
  // equal (workload-balanced): Ann already carries 9, Ben 7, Dee 3 -> the new 12 go to Dee first
  id = await run(c, rows(12, 1300), { options: { assign: { mode: 'equal', userIds: [a.id, b.id, d.id] } } }); await commitAll(c, id);
  const eq = owners('L13'); assert.equal(eq.Dee > eq.Ben && eq.Ben >= eq.Ann, true, JSON.stringify(eq));
  assert.equal(Object.values(eq).reduce((x, y) => x + y, 0), 12);
  // csv: by e-mail or by name; unknown -> pool with a warning
  const csvRows = [{ Name: 'C1', Phone: P(1400), 'Assigned To': a.email }, { Name: 'C2', Phone: P(1401), 'Assigned To': 'ben' + '' }, { Name: 'C3', Phone: P(1402), 'Assigned To': 'Dee' }, { Name: 'C4', Phone: P(1403), 'Assigned To': 'Ghost' }, { Name: 'C5', Phone: P(1404) }];
  id = await run(c, csvRows, { options: { assign: { mode: 'csv', userIds: [] } } });
  assert.equal((await c.ok('GET', `/imports/${id}/preview`)).assignment.unmatchedAssignees >= 1, true);
  await commitAll(c, id);
  assert.equal(c.q(`select u.name n from crm_leads l join crm_users u on u.id = l.owner_id where l.name = 'C1'`)[0].n, 'Ann');
  assert.equal(c.q(`select u.name n from crm_leads l join crm_users u on u.id = l.owner_id where l.name = 'C3'`)[0].n, 'Dee');
  assert.equal(c.q(`select count(*) n from crm_leads where name in ('C4','C5') and owner_id is null`)[0].n, 2);
  assert.equal(c.q(`select count(*) n from crm_import_rows where import_id = ? and warning is not null`, id)[0].n >= 1, true);
  // every assigned import lead has an ownership history row and an audit row
  assert.equal(c.q(`select count(*) n from crm_leads l where l.name like 'L12%' and not exists (select 1 from crm_lead_owners o where o.lead_id = l.id and o.ended_at is null)`)[0].n, 0);
  // assigned staff are notified
  assert.ok((await c.ok('GET', '/notifications', { token: d.token })).items.some((n) => /assigned/.test(n.kind)));
  // assign options need the permission; a sales user cannot hand leads to others, may not import without leads.import
  const s = await c.staff('Sam');
  assert.equal((await c.api('POST', '/imports', { token: s.token, body: {} })).status, 403);
  const m = await c.staff('Mona', 'manager');
  assert.equal((await c.api('POST', '/imports', { token: m.token, body: { options: { assign: { mode: 'one', userIds: ['ghost'] } } } })).status, 404);
  assert.equal((await c.api('POST', '/imports', { token: m.token, body: { options: { assign: { mode: 'roundrobin', userIds: [] } } } })).status, 400);
});

test('import batches: 450 rows -> several commit calls, each <= 200 rows; concurrent commit is refused; column mapping', async () => {
  const c = await makeCrm();
  const rows = Array.from({ length: 450 }, (_, i) => ({ Contact: 'Bulk ' + i, Mobile: P(3000 + i) }));
  const id = await run(c, rows, { mapping: { name: 'Contact', phone: 'Mobile' } });
  const first = await c.ok('POST', `/imports/${id}/commit`);
  assert.deepEqual([first.done, first.batch, first.processed, first.total], [false, 200, 200, 450]);
  const [x, y] = await Promise.all([c.api('POST', `/imports/${id}/commit`), c.api('POST', `/imports/${id}/commit`)]);
  assert.equal([x.status, y.status].filter((s) => s === 200).length >= 1, true);
  const done = (await commitAll(c, id)).last;
  assert.equal(done.created, 450, 'no double creation even with concurrent commits');
  assert.equal(c.q(`select count(*) n from crm_leads where name like 'Bulk %'`)[0].n, 450);
  // limits
  const id2 = await run(c, [{ name: 'x', phone: P(1) }]);
  assert.equal((await c.api('POST', `/imports/${id2}/rows`, { body: { rows: Array(501).fill({ name: 'x' }) } })).status, 400);
  assert.equal((await c.api('POST', `/imports/${id2}/rows`, { body: { rows: ['not an object'] } })).status, 400);
  assert.equal((await c.api('POST', `/imports/nope/commit`)).status, 404);
  const empty = (await c.ok('POST', '/imports', { body: {} })).id; assert.equal((await c.api('POST', `/imports/${empty}/commit`)).status, 400);
  // a sales user cannot see someone else's import
  const s = await c.staff('Sam'); await c.ok('PUT', `/staff/${s.id}/permissions`, { body: { grant: ['leads.import'] } });
  assert.equal((await c.api('GET', `/imports/${id}`, { token: s.token })).status, 404);
  assert.equal((await c.ok('GET', '/imports', { token: s.token })).items.length, 0);
});
