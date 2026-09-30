import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, APPS } from './helpers.mjs';

// zip 161: "Open" next to a staff member's Copy Link is a REAL link (<a target=_blank rel=noopener>) on both staff screens, and openStaffLoginLink()
// opens the same link by clicking such an anchor (window.open with features is refused by installed apps and returns null, so it could not report failure).
for (const app of APPS.filter((a) => a !== 'owner/index.html')) {
  test(`${app}: staff login links can be opened as well as copied`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 300 });
    const clicked = [];
    w.HTMLAnchorElement.prototype.click = function () { clicked.push({ href: this.href, target: this.target, rel: this.rel }); };
    w.eval("openStaffLoginLink('abc123')");
    assert.equal(clicked.length, 1);
    assert.match(clicked[0].href, /\?staff=abc123$/, 'the same link Copy Link copies');
    assert.equal(clicked[0].target, '_blank');
    assert.match(clicked[0].rel, /noopener/);
    // both staff screens render ONE real "Open" link per person (no second, script-driven "Open" button next to it)
    w.eval("staff.push({ id: 'st-z9', name: 'Zed', pinHash: 'x', roles: [], updatedAt: 1 }); renderStaffList(); renderStaffPanel();");
    for (const box of ['staff-list', 'staff-roster-list']) {
      const el = d.getElementById(box);
      const anchors = [...el.querySelectorAll('a[href*="?staff=st-z9"]')];
      assert.equal(anchors.length, 1, `${box}: one Open link`);
      assert.equal(anchors[0].getAttribute('target'), '_blank');
      assert.match(anchors[0].getAttribute('rel'), /noopener/);
      assert.equal(el.querySelectorAll('button[onclick^="openStaffLoginLink"]').length, 0, `${box}: no duplicate Open button`);
      assert.ok(el.querySelector('button[onclick^="copyStaffLoginLink"]'), `${box}: Copy Link is still there`);
    }
    assert.deepEqual(errors, []);
    close();
  });
}
