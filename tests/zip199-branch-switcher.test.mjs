import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 199: the owner's global branch switcher (header pill). Pure client UI: branch isolation stays tenant-level (each branch = its own shop).
const SUMMARY = { isBranchGroup: true, branches: [
  { id: 'c1', label: 'Nairobi CBD', slug: 'cbd', isMainBranch: true, isSelf: true, staff: [] },
  { id: 'c2', label: 'Westlands', slug: 'westlands', isMainBranch: false, isSelf: false, staff: [] },
  { id: 'c3', label: 'Thika', slug: 'thika', isMainBranch: false, isSelf: false, staff: [] },
] };
const setup = async (app = 'index.html') => {
  const t = await boot(app, { wait: 600 });
  t.w.eval(`myBranchGroupId = 'g1'; currentServer = null; branchesSummaryCache = ${JSON.stringify(SUMMARY)}; window.branchSwitcherRefresh()`);
  return t;
};
const pill = (t) => t.d.getElementById('branch-pill');

for (const app of ['index.html', 'hotel/index.html', 'water/index.html', 'pharmacy/index.html']) {
  test(`${app}: the owner sees one branch pill with the current branch's name, and no error`, async () => {
    const t = await setup(app);
    assert.ok(await until(() => pill(t) && pill(t).classList.contains('on')), 'pill shown');
    assert.match(pill(t).textContent, /Nairobi CBD/);
    assert.deepEqual(t.errors, []);
    t.close();
  });
}

test('hidden when the shop is not in a branch group, and hidden for a staff member', async () => {
  const t = await boot('index.html', { wait: 600 });
  t.w.eval(`myBranchGroupId = null; branchesSummaryCache = ${JSON.stringify({ isBranchGroup: false })}; window.branchSwitcherRefresh()`);
  assert.ok(!pill(t) || !pill(t).classList.contains('on'), 'a lone shop has no switcher');
  t.w.eval(`myBranchGroupId = 'g1'; branchesSummaryCache = ${JSON.stringify(SUMMARY)}; currentServer = { id: 's1', name: 'Mary' }; window.branchSwitcherRefresh()`);
  assert.ok(!pill(t) || !pill(t).classList.contains('on'), 'staff never see it');
  t.close();
});

test('the menu lists every branch and All branches; choosing another branch asks first, naming it, and nothing changes until confirmed', async () => {
  const t = await setup();
  assert.ok(await until(() => pill(t) && pill(t).classList.contains('on')));
  pill(t).click();
  const menu = t.d.getElementById('branch-menu');
  assert.ok(menu.classList.contains('open'));
  const txt = menu.textContent;
  for (const n of ['Nairobi CBD', 'Westlands', 'Thika', 'All branches']) assert.ok(txt.includes(n), n);
  menu.querySelector('[data-bid="c2"]').click();
  const c = t.d.getElementById('branch-confirm');
  assert.ok(c.classList.contains('open'), 'confirmation shown');
  assert.match(c.textContent, /Westlands/);
  assert.match(c.textContent, /Nairobi CBD/, 'also names the branch being left');
  c.querySelector('.bc-cancel').click();
  assert.ok(!c.classList.contains('open'), 'cancel closes it');
  t.close();
});

test('All branches is the read-only combined view and the pill says so; Back returns to this branch', async () => {
  const t = await setup();
  assert.ok(await until(() => pill(t) && pill(t).classList.contains('on')));
  pill(t).click();
  t.d.getElementById('branch-menu').querySelector('[data-bid="__all"]').click();
  assert.ok(await until(() => t.w.eval('viewedBranchId') === 'all'));
  assert.ok(await until(() => /view only/.test(pill(t).textContent)), 'pill shows view only');
  pill(t).click();
  t.d.getElementById('branch-menu').querySelector('[data-bid="__back"]').click();
  assert.ok(await until(() => t.w.eval('viewedBranchId') === 'self'));
  assert.ok(await until(() => !/view only/.test(pill(t).textContent)));
  t.close();
});

test('the other branch opens on the same page and screen, at its own address; an address with no branch name is refused, never guessed', async () => {
  const t = await boot('index.html', { wait: 500 });
  const u = (host, path, hash) => t.w.eval(`branchSwitcherUrl({ slug: 'westlands' }, { hostname: '${host}', protocol: 'https:', port: '', pathname: '${path}', hash: '${hash}' })`);
  assert.equal(u('cbd.mydukapos.store', '/hotel/', '#sales'), 'https://westlands.mydukapos.store/hotel/#sales');
  assert.equal(u('cbd.mydukapos.store', '/', ''), 'https://westlands.mydukapos.store/');
  assert.equal(u('mydukapos.store', '/', ''), '', 'apex: no branch address');
  assert.equal(u('mydukapos.pages.dev', '/', ''), '', 'test address');
  assert.equal(u('localhost', '/', ''), '');
  assert.equal(t.w.eval("branchSwitcherUrl({ slug: '' }, { hostname: 'cbd.mydukapos.store', protocol: 'https:', port: '', pathname: '/', hash: '' })"), '');
  t.close();
});
