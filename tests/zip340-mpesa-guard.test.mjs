// zip 340: server rules for the M-PESA Agent ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mpesaEntryProblem, sanitizeMpesaPush } from '../functions/api/_perm-guard.js';

const ok = { id: 'mpa-1', type: 'deposit', amount: 500, cash: 500, float: -500, ts: 1 };
test('balanced entries pass', () => {
  assert.equal(mpesaEntryProblem(ok), '');
  assert.equal(mpesaEntryProblem({ ...ok, type: 'withdrawal', cash: -500, float: 500 }), '');
  assert.equal(mpesaEntryProblem({ ...ok, type: 'buy_float', cash: 0, float: 500 }), '');
});
test('wrong sign, decimals and missing reasons are refused', () => {
  assert.ok(mpesaEntryProblem({ ...ok, cash: -500 }));
  assert.ok(mpesaEntryProblem({ ...ok, amount: 500.5, cash: 500.5, float: -500.5 }));
  assert.ok(mpesaEntryProblem({ id: 'a', type: 'adjustment', amount: 5, cash: 5, float: 0 }));
  assert.ok(mpesaEntryProblem({ id: 'r', type: 'reversal', amount: 5, cash: -5, float: 5 }));
});
test('sanitize drops bad entries and keeps good ones', () => {
  const r = sanitizeMpesaPush({ mpesaAgentTx: [ok, { ...ok, id: 'mpa-2', cash: 1 }] });
  assert.equal(r.body.mpesaAgentTx.length, 1);
  assert.equal(r.body.mpesaAgentTx[0].id, 'mpa-1');
});
