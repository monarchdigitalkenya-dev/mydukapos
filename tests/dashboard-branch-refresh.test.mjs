import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// When this shop first learns it's part of a branch group (from the license
// check, which runs in parallel with startup and can finish AFTER Dashboard
// has already rendered once), Settings' Branches panel and the branch
// switchers everywhere else were told to refresh — but Dashboard itself,
// even when it was the tab already showing, was not. Fixed by re-rendering
// Dashboard too when this happens while it's the active tab.
const APPS = [
  { app: 'index.html', dashboardFn: 'renderShopDashboard' },
  { app: 'water/index.html', dashboardFn: 'renderAquaDashboard' },
  { app: 'hotel/index.html', dashboardFn: 'renderHotelDashboard' },
  { app: 'production/index.html', dashboardFn: 'renderShopDashboard' },
  { app: 'services/index.html', dashboardFn: 'renderShopDashboard' },
  { app: 'pharmacy/index.html', dashboardFn: 'renderShopDashboard' },
];

for (const { app, dashboardFn } of APPS) {
  test(`${app}: landing on Dashboard before the branch-group info arrives still shows branch details once it does, without switching tabs away and back`, async () => {
    const fetchImpl = async (url, opts = {}) => {
      if (String(url).includes('/api/license-status')) {
        return { ok: true, status: 200, json: async () => ({ branchGroupId: 'grp1', isMainBranch: true }) };
      }
      if (String(url).includes('/api/branches')) {
        return { ok: true, status: 200, json: async () => ({ isBranchGroup: true, branches: [{ id: 'c1', isSelf: true, label: 'Main', todayRevenue: 0, monthRevenue: 0, stockValue: 0, lowStockCount: 0, staffCount: 1 }] }) };
      }
      if (String(url).includes('/api/pos-sync') && (opts.method || 'GET') === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: Date.now() }) };
      }
      return Promise.reject(new Error('offline'));
    };
    const { w, d, errors, close } = await boot(app, { fetch: fetchImpl, wait: 900 });
    w.eval("showToast = function () {};");
    // Land on Dashboard and let its own initial async render fully settle
    // first — otherwise that in-flight call (not the one this test means to
    // exercise) can itself set the section visible after the reset below,
    // making the test pass or fail for the wrong reason.
    w.eval("performTabSwitch(document.getElementById('dashboard-tab-btn'), 'dashboard-tab')");
    await new Promise((r) => setTimeout(r, 300));
    // Now simulate "branch info not learned yet" — the exact state the app
    // is in for a moment during real startup, before checkLicenseStatus()
    // first resolves.
    w.eval("myBranchGroupId = null; const s = document.getElementById('dash-branches-section'); if (s) s.style.display = 'none';");
    // Now the license check completes, learning for the first time this shop is in a branch group.
    await w.eval('checkLicenseStatus()');
    await new Promise((r) => setTimeout(r, 300)); // let the async renderDashboardBranchesSection() settle
    const section = d.getElementById('dash-branches-section');
    if (section) assert.notEqual(section.style.display, 'none', "Dashboard's branch section is shown without needing a tab switch");
    assert.deepEqual(errors, []);
    close();
  });
}
