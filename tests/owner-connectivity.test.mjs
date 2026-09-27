import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 143 — Owner Console.
// (1) "Could not load clients — check your connection" was shown for EVERY failure (server error, ended session, rate limit, a
//     Cloudflare error page that is not JSON) — so an owner with working internet was told to connect to the internet.
// (2) The console's own-shop sync applied every pull over the local lists, even while an edit had not reached the server yet
//     (inside the 300 ms before its push, a push on its way, or a push that failed): the edit reverted on the next poll.
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
function router(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), body: opts.body });
    for (const [re, h] of handlers) if (re.test(u)) return h(u, opts, calls);
    return json({});
  };
  fn.calls = calls;
  return fn;
}
const OWNER = { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' };

test('a server error on the client list is reported as a server error — not "check your connection"', async () => {
  const fetch = router([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\/health/, () => json({ ok: true })],
    [/\/api\/owner-clients/, () => new Response('<html>error code: 1101</html>', { status: 500, headers: { 'Content-Type': 'text/html' } })],
  ]);
  const t = await boot('owner/index.html', { storage: OWNER, fetch, wait: 1200 });
  await t.w.eval("renderGroupedClientsList('demo', true)");
  const txt = t.d.getElementById('demo-links-list').textContent;
  assert.doesNotMatch(txt, /check your connection/i);
  assert.match(txt, /server had a problem \(error 500\)/);
  assert.match(txt, /internet works/i);
  t.close();
});

test('a rate-limited request says so; a request with no answer at all is the one that mentions the connection', async () => {
  let mode = 429;
  const fetch = router([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\/health/, () => { if (mode === 'down') throw new TypeError('Failed to fetch'); return json({ ok: true }); }],
    [/\/api\/owner-clients/, () => { if (mode === 'down') throw new TypeError('Failed to fetch'); return json({ error: 'slow down' }, 429); }],
  ]);
  const t = await boot('owner/index.html', { storage: OWNER, fetch, wait: 1200 });
  await t.w.eval("renderGroupedClientsList('demo', true)");
  assert.match(t.d.getElementById('demo-links-list').textContent, /too many requests/i);
  mode = 'down';
  t.w.__posNetInternetProbe = () => Promise.resolve(false);           // and the internet itself does not answer either
  await t.w.eval("renderGroupedClientsList('demo', true)");
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('ownerFailReason()').startsWith('this device is offline'), true, 'truly offline -> offline');
  t.close();
});

test('the internet works but only the POS server is down -> "the server is not answering", never "you are offline"', async () => {
  const fetch = router([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\//, () => { throw new TypeError('Failed to fetch'); }],
  ]);
  const t = await boot('owner/index.html', { storage: OWNER, fetch, wait: 1200 });
  t.w.__posNetInternetProbe = () => Promise.resolve(true);
  await t.w.eval('PosNet.check("test")');
  assert.equal(t.w.eval('PosNet.state'), 'backend_unavailable');
  await t.w.eval("renderGroupedClientsList('demo', true)");
  const txt = t.d.getElementById('demo-links-list').textContent;
  assert.match(txt, /your internet works, but the MyDukaPOS server is not answering/i);
  assert.doesNotMatch(txt, /offline/i);
  t.close();
});

test('an edit that has not reached the server is never overwritten by a pull (no revert)', async () => {
  let pushOk = false, serverUpdatedAt = Date.now() + 60000;
  const serverInventory = [{ code: 'A1', name: 'Old name', price: 100, qty: 5 }];
  const fetch = router([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\/health/, () => json({ ok: true })],
    [/\/api\/pos-sync/, (u, o) => {
      if ((o.method || 'GET').toUpperCase() === 'POST') {
        if (!pushOk) return json({ error: 'busy' }, 503);
        const body = JSON.parse(o.body);
        serverInventory.splice(0, serverInventory.length, ...body.inventory.filter((r) => !r._deleted));
        serverUpdatedAt += 1000;
        return json({ ok: true, updatedAt: serverUpdatedAt });
      }
      return json({ updatedAt: serverUpdatedAt, inventory: serverInventory.map((r) => ({ ...r })), salesLog: [], expenses: [], bills: [], contracts: [], savedBarcodes: [] });
    }],
  ]);
  const t = await boot('owner/index.html', { storage: { ...OWNER, pos_inventory: JSON.stringify([{ code: 'A1', name: 'Old name', price: 100, qty: 5 }]) }, fetch, wait: 1500 });
  // The owner renames the item; the push fails (server busy).
  t.w.eval("inventory.find(p => p.code === 'A1').name = 'New name'; queuePush();");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(t.w.eval('ownerHasUnsentChanges()'), true, 'the change is known to be unsent');
  // The poll pulls — another device changed something (the server copy is newer) — the edit must survive.
  serverUpdatedAt += 5000;                                                   // another device saved meanwhile
  await t.w.eval('pullState()');
  assert.equal(t.w.eval("inventory.find(p => p.code === 'A1').name"), 'New name', 'not reverted by the pull');
  // The server is back: the next poll sends the change first, then the pull brings back the merged copy with it.
  pushOk = true;
  await t.w.eval('pullState()');
  assert.equal(t.w.eval('ownerHasUnsentChanges()'), false);
  assert.equal(serverInventory[0].name, 'New name', 'the server has it');
  assert.equal(t.w.eval("inventory.find(p => p.code === 'A1').name"), 'New name');
  t.close();
});
