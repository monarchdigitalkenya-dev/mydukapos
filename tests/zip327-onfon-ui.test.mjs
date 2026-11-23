import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 327: the Onfon Media entry in Settings > SMS - selectable, shows its own fields, sends the secrets only when typed, never shows saved secrets, test + balance go to the server.
const SEED = { pos_inventory: JSON.stringify([{ code: 'A', type: 'item', name: 'A', price: 1, qty: 1, unit: 'pcs', vatCategory: 'A' }]), pos_last_synced_at: String(Date.now() - 1000) };
test('Onfon appears, switches fields, validates, posts only what was typed, and reads status without secrets', async (t) => {
  const posts = []; let status = { configured: false, provider: 'africastalking', onfon: {} };
  const fetchMock = async (url, o = {}) => {
    const u = String(url);
    if (/\/api\/license-status/.test(u)) return new Response(JSON.stringify({ valid: true, clientId: 'C1', type: 'permanent' }), { status: 200 });
    if (/\/api\/sms-config/.test(u)) { if ((o.method || 'GET') === 'POST') { posts.push(JSON.parse(o.body)); return new Response(JSON.stringify({ success: true }), { status: 200 }); } return new Response(JSON.stringify(status), { status: 200 }); }
    if (/\/api\/sms-test/.test(u)) { posts.push({ test: u, body: o.body ? JSON.parse(o.body) : null }); return new Response(JSON.stringify(/balance/.test(u) ? { ok: true, balance: 1500, unit: 'SMS credits' } : { ok: true, messageId: 'M-9' }), { status: 200 }); }
    throw new Error('offline');
  };
  const dev = await boot('index.html', { url: 'https://shop.mydukapos.store/?c=C1', storage: SEED, fetch: fetchMock, wait: 700 });
  t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
  const { w, d } = dev;
  w.eval("showToast = function () {}; window.confirm = () => true; Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });");   // the typed-password pop-up (pay-confirm) is covered by its own tests; offline it steps aside
  assert.ok(d.getElementById('sms-provider-onfon-btn'), 'Onfon is in the provider list');
  assert.ok(d.getElementById('sms-provider-at-btn') && d.getElementById('sms-provider-talksasa-btn'), 'the others are still there');
  w.eval("setSmsProvider('onfon')");
  assert.equal(d.getElementById('sms-provider-onfon-fields').style.display, 'block');
  assert.equal(d.getElementById('sms-provider-at-fields').style.display, 'none');
  for (const id of ['sms-onfon-accesskey-input', 'sms-onfon-apikey-input', 'sms-onfon-clientid-input', 'sms-onfon-senderid-input', 'sms-onfon-enabled-input']) assert.ok(d.getElementById(id), id);
  // incomplete: refused in the browser, nothing posted
  await w.eval('saveSmsConfig()');
  assert.match(d.getElementById('sms-config-msg').textContent, /Enter the Onfon/); assert.equal(posts.length, 0);
  d.getElementById('sms-onfon-accesskey-input').value = 'AK'; d.getElementById('sms-onfon-apikey-input').value = 'APIK'; d.getElementById('sms-onfon-clientid-input').value = 'CL1'; d.getElementById('sms-onfon-senderid-input').value = 'MYDUKA';
  const p = w.eval('saveSmsConfig()');
  await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
  const saved = posts.find((x) => x.provider === 'onfon');
  assert.ok(saved, 'posted');
  assert.deepEqual({ ...saved }, { provider: 'onfon', onfonAccessKey: 'AK', onfonApiKey: 'APIK', onfonClientId: 'CL1', onfonSenderId: 'MYDUKA', onfonEnabled: true });
  assert.equal(d.getElementById('sms-onfon-accesskey-input').value, '', 'the typed secrets are cleared from the page after saving');
  // after save the server reports what is saved (no secrets): the page shows hints only and a blank secret box is accepted
  w.eval(`smsOnfonStatus(${JSON.stringify({ provider: 'onfon', onfon: { hasAccessKey: true, hasApiKey: true, clientId: 'CL1', senderId: 'MYDUKA', enabled: false } })})`);
  assert.equal(d.getElementById('sms-onfon-clientid-input').value, 'CL1');
  assert.match(d.getElementById('sms-onfon-apikey-input').placeholder, /saved/);
  assert.equal(d.getElementById('sms-onfon-apikey-input').value, '');
  assert.equal(d.getElementById('sms-onfon-balance-row').style.display, '');
  assert.equal(d.getElementById('sms-onfon-off-note').style.display, '');
  posts.length = 0;
  d.getElementById('sms-onfon-enabled-input').checked = true;
  await Promise.race([w.eval('saveSmsConfig()'), new Promise((r) => setTimeout(r, 1500))]);
  const again = posts.find((x) => x.provider === 'onfon');
  assert.ok(again && !('onfonAccessKey' in again) && !('onfonApiKey' in again), 'blank secret boxes keep the saved keys');
  // test SMS + balance go to the server's own route
  w.eval("window.__smsActiveProvider = 'onfon'; document.getElementById('sms-test-phone-input').value = '0712345678';");
  await w.eval('sendTestSms()');
  assert.ok(posts.some((x) => x.test && /sms-test/.test(x.test) && x.body.to === '0712345678'));
  assert.match(d.getElementById('sms-test-msg').textContent, /accepted.*submitted|submitted/i);
  await w.eval('smsOnfonBalance()');
  assert.match(d.getElementById('sms-balance-msg').textContent, /1,?500/);
});
