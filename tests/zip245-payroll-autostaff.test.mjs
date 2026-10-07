import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// Zip 245. Payroll: staff already in Staff Accounts are in the register by themselves (no second typing); nobody is added twice.
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
for (const app of APPS.filter((a) => a !== 'water/index.html')) {
  test(`${app}: POS staff are added to the payroll register automatically, once, skipping those already there`, async () => {
    const saved = [];
    const fetch = async (u, o) => {
      if (!String(u).includes('/api/payroll')) return json({});
      const b = JSON.parse(o.body);
      if (b.action === 'employee.list') return json({ ok: true, employees: [{ emp_id: 'e1', name: 'Mary', pos_staff_id: 's-mary' }, { emp_id: 'e2', name: 'peter  ', pos_staff_id: '' }] });
      if (b.action === 'employee.save') { saved.push(b.employee); return json({ ok: true, employee: { emp_id: 'new' + saved.length, ...b.employee } }); }
      return json({ ok: true });
    };
    const { w, close } = await boot(app, { fetch, wait: 700 });
    if (!w.Payroll || !w.Payroll.__t) { close(); return; }                                   // an app without the Payroll tab
    w.eval(`staff = [{id:'s-mary',name:'Mary'},{id:'s-john',name:'John'},{id:'s-pete',name:'Peter'},{id:'s-gone',name:'Gone',removed:true}]`);
    const t = w.Payroll.__t; t.S.who = { admin: true, perms: [] };
    assert.equal(await t.autoSyncPos(), 1, 'only John is new: Mary is linked, Peter is already there by name, Gone is removed');
    assert.deepEqual(saved.map((x) => x.name), ['John']);
    assert.equal(await t.autoSyncPos(), 0, 'not repeated within a minute');
    t.S.autoAt = 0; saved.length = 0; t.S.who = { admin: false, perms: ['view'] };
    assert.equal(await t.autoSyncPos(), 0, 'someone who may not edit staff adds nobody');
    close();
  });
}
