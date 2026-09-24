import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The exact source of a name showing twice on "Who's logging in?": clicking
// "Generate Invite Link" again for a name that already has a pending invite
// (or an active account) created a second, separate person with no warning
// — dedupeStaff() only merges identical name+PIN pairs, which two separately
// completed invites have no reason to share.
test("Owner Console: generating a second invite for a name that's already pending or active warns first, and a decline does not create a duplicate", async () => {
  const { w, d, errors, close } = await boot('owner/index.html', { url: 'https://mydukapos.store/owner/', wait: 900 });
  w.eval("showToast = function () {}; clientToken = 'C1'; pushNow = async () => true;");

  // First invite for Cynthia: goes through with no prompt.
  let confirmCalls = 0;
  w.eval("window.confirm = function () { window.__confirmCalls = (window.__confirmCalls||0)+1; return true; };");
  d.getElementById('new-staff-name-input').value = 'Cynthia';
  await w.eval('generateInviteLink()');
  assert.equal(w.eval('window.__confirmCalls || 0'), 0, 'no prompt for the first invite');
  assert.equal(w.eval('pendingInvites.filter(i => i.name === "Cynthia").length'), 1);

  // Second invite for the same name, declined: no duplicate created.
  w.eval("window.__confirmCalls = 0; window.confirm = function () { window.__confirmCalls++; return false; };");
  d.getElementById('new-staff-name-input').value = 'Cynthia';
  await w.eval('generateInviteLink()');
  assert.equal(w.eval('window.__confirmCalls'), 1, 'the owner is warned about the existing pending invite');
  assert.equal(w.eval('pendingInvites.filter(i => i.name === "Cynthia").length'), 1, 'declining does not create a second invite');

  // Confirmed: a genuinely separate second "Cynthia" is allowed.
  w.eval("window.__confirmCalls = 0; window.confirm = function () { window.__confirmCalls++; return true; };");
  d.getElementById('new-staff-name-input').value = 'Cynthia';
  await w.eval('generateInviteLink()');
  assert.equal(w.eval('pendingInvites.filter(i => i.name === "Cynthia").length'), 2, 'confirming allows a genuine second person with the same name');

  // An already-active staff member with the same name is also warned about.
  w.eval(`staff.push({ id: 'sX', name: 'Tally', pinHash: 'x', roles: [] });`);
  w.eval("window.__confirmCalls = 0; window.confirm = function () { window.__confirmCalls++; return false; };");
  d.getElementById('new-staff-name-input').value = 'Tally';
  await w.eval('generateInviteLink()');
  assert.equal(w.eval('window.__confirmCalls'), 1, 'warned about the existing active staff member too');
  assert.equal(w.eval('pendingInvites.filter(i => i.name === "Tally").length'), 0, 'declining creates no invite at all');

  assert.deepEqual(errors, []);
  close();
});
