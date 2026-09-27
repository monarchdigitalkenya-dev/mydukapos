import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, APPS } from './helpers.mjs';

// Zip 143: every tab — the Sales Counter included — is a role. A staff member sees and reaches only the tabs ticked for them.
// Before: isTabLocked('sales-tab') was always false for everyone, so a staff member NOT given the Sales Counter still landed on it
// (its button hidden, its contents showing), a barcode scanned on any tab opened it, and a Secondary Admin never saw Settings.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function loginAs(w, d, roles, extra = '') {
  w.eval("showToast = function (m) { (window.__toasts = window.__toasts || []).push(m); };");
  w.eval(`staff.length = 0; staff.push({ id: 's1', name: 'Jane', pinHash: '${sha('1234')}', roles: ${JSON.stringify(roles)}, salesTabMigrated: true ${extra} });`);
  d.getElementById('login-screen').style.display = 'flex';
  w.eval('currentServer = null; applyServerVisibility();');
  w.eval("pendingLoginStaffId = 's1';");
  d.getElementById('login-staffpin-input').value = '1234';
  await w.eval('submitLoginStaffPin()');
}

const visibleTabs = (d) => Array.from(d.querySelectorAll('.tabs .tab-link[data-tab]')).filter((b) => b.style.display !== 'none').map((b) => b.dataset.tab);

for (const app of APPS) {
  test(`${app}: a staff member without the Sales Counter never sees or reaches it`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    // Pick a second tab this app really has (so the test works in every module).
    const other = ['inventory-list-tab', 'daily-sales-tab', 'bills-tab'].find((id) => d.getElementById(id));
    assert.ok(other, 'the app has a second tab to give');
    await loginAs(w, d, [other]);
    assert.deepEqual(visibleTabs(d), [other], 'only the given tab is in the tab bar');
    assert.equal(w.eval("isTabLocked('sales-tab')"), true, 'the Sales Counter is locked for this person');
    assert.equal(d.getElementById('sales-tab').classList.contains('active'), false, 'the till is not showing');
    assert.equal(d.getElementById(other).classList.contains('active'), true, 'they land on their own tab');
    assert.equal(w.eval('openSalesCounterIfAllowed()'), false, 'a shortcut to the till is refused');
    assert.equal(d.getElementById('sales-tab').classList.contains('active'), false);
    if (app.startsWith('water/')) await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a staff member given the Sales Counter (and nothing else) sees exactly that`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    await loginAs(w, d, ['sales-tab']);
    assert.deepEqual(visibleTabs(d), ['sales-tab']);
    assert.equal(w.eval("isTabLocked('sales-tab')"), false);
    assert.equal(d.getElementById('sales-tab').classList.contains('active'), true);
    assert.equal(w.eval("isTabLocked('settings-tab')"), true, 'no Settings without Secondary Admin sections');
    if (app.startsWith('water/')) await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a staff member with no tabs at all sees an explanation, not a tab's contents`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    await loginAs(w, d, []);
    assert.deepEqual(visibleTabs(d), []);
    assert.equal(d.querySelectorAll('.tab-content.active').length, 0, 'no tab contents showing');
    const notice = d.getElementById('no-tabs-assigned-notice');
    assert.ok(notice && notice.style.display === 'block', 'the "no tabs yet" notice shows');
    if (app.startsWith('water/')) await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(errors, []);
    close();
  });

  test(`${app}: a Secondary Admin sees the Settings button (their sections only); the owner is unchanged`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 1200 });
    const section = d.querySelector('.settings-subtab-btn[data-section]').dataset.section;
    await loginAs(w, d, ['sales-tab'], `, adminPermissions: ['${section}']`);
    assert.notEqual(d.getElementById('settings-tab-btn').style.display, 'none', 'Settings button shows for a Secondary Admin');
    assert.equal(d.getElementById('staff-tab-btn') ? d.getElementById('staff-tab-btn').style.display : 'none', 'none', 'never the Staff panel');
    // Back to the owner: every tab is there again and the till is never locked for them.
    w.eval('currentServer = null; applyServerVisibility();');
    assert.equal(w.eval("isTabLocked('sales-tab')"), false);
    assert.notEqual(d.getElementById('sales-tab-btn').style.display, 'none');
    if (app.startsWith('water/')) await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(errors, []);
    close();
  });
}

test('owner/index.html: 🔗 Generate Link is a role for console staff (existing staff keep it once)', async () => {
  const pin = sha('1234');
  const storage = { pos_staff: JSON.stringify([{ id: 'old', name: 'Old', pinHash: pin, roles: [] }, { id: 'new', name: 'New', pinHash: pin, roles: ['daily-sales-tab'], salesTabMigrated: true }]) };
  const { w, d, errors, close } = await boot('owner/index.html', { storage, wait: 1200 });
  w.eval("showToast = function () {};");
  assert.deepEqual(w.eval("JSON.stringify(staff.find(s => s.id === 'old').roles)"), '["sales-tab"]', 'existing staff kept Generate Link once');
  w.eval("currentServer = { id: 'new', name: 'New' }; applyServerVisibility();");
  assert.equal(w.eval("isTabLocked('sales-tab')"), true, 'not given → locked');
  assert.equal(d.getElementById('sales-tab-btn').style.display, 'none', 'not given → hidden');
  w.eval("currentServer = null; applyServerVisibility();");
  assert.equal(w.eval("isTabLocked('sales-tab')"), false, 'the owner always has it');
  assert.deepEqual(errors, []);
  close();
});
