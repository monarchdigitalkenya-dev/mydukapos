import test from 'node:test';
import assert from 'node:assert/strict';
import { needsManager, guardPush } from '../functions/api/_perm-guard.js';

test('server guard: cancelling a contract issue, merging customers and changing a saved ID need a manager', () => {
  const stored = { id: 'c', visits: [{ id: 'v1', status: 'issued' }, { id: 'v2', status: 'issued' }] };
  assert.match(needsManager('contracts', { id: 'c', visits: [{ id: 'v1', status: 'cancelled' }, { id: 'v2', status: 'issued' }] }, stored), /cancelling a contract issue/);
  assert.equal(needsManager('contracts', { id: 'c', visits: [...stored.visits, { id: 'v3', status: 'issued' }] }, stored), '', 'a new issue is allowed');
  assert.equal(needsManager('contracts', { id: 'c', visits: [{ id: 'v1', status: 'issued', printCount: 2 }, stored.visits[1]] }, stored), '', 'printing is allowed');
  assert.match(needsManager('customers', { id: 'x', mergedInto: 'y' }, { id: 'x' }), /merging/);
  assert.match(needsManager('customers', { id: 'x', idNumber: '999' }, { id: 'x', idNumber: '123' }), /ID number/);
  assert.equal(needsManager('customers', { id: 'x', idNumber: '123', name: 'New name' }, { id: 'x', idNumber: '123' }), '');
  assert.equal(needsManager('customers', { id: 'x', idNumber: '123' }, { id: 'x' }), '', 'adding an ID where there was none is fine');
});

test('server guard: a staff push that cancels an issue is held and the stored copy stands; a manager\'s is not', () => {
  const stored = { id: 'c', visits: [{ id: 'v1', status: 'issued' }] };
  const body = { contracts: [{ id: 'c', visits: [{ id: 'v1', status: 'cancelled' }] }] };
  const get = () => stored;
  const staff = guardPush(body, get, { enforce: true, claims: { role: 'staff' } });
  assert.equal(staff.held.length, 1); assert.equal(staff.body.contracts[0].visits[0].status, 'issued');
  const off = guardPush(body, get, { enforce: false, claims: { role: 'staff' } });
  assert.equal(off.held.length, 0, 'not enforcing: untouched');
});
