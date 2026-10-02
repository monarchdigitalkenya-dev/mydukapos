import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// zip 185: unlinking the recovery email asks for the account password and shows a server refusal instead of "Email unlinked."
const src = fs.readFileSync(new URL('../src/shared/functions.js', import.meta.url), 'utf8');
const i = src.indexOf('//@fn unlinkRecoveryEmail\n'); const j = src.indexOf('\n//@fn ', i + 5);
const fn = src.slice(i, j);
function run({ prompt, status, body }) {
  const calls = []; const msg = { className: '', textContent: '' };
  const sb = { window: { prompt: () => prompt }, confirm: () => true, document: { getElementById: () => msg }, apiUrl: (u) => u, loadRecoveryStatus: () => { calls.push('reload'); },
    netErrText: (t) => t, JSON,
    fetch: async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: status < 400, status, json: async () => body }; } };
  vm.createContext(sb); vm.runInContext(fn, sb);
  return vm.runInContext('unlinkRecoveryEmail()', sb).then(() => ({ calls, msg }));
}
test('sends the typed password; success reloads', async () => {
  const r = await run({ prompt: 'secret1', status: 200, body: { ok: true } });
  assert.deepEqual(r.calls[0], { action: 'unlink', currentPassword: 'secret1' });
  assert.equal(r.msg.textContent, 'Email unlinked.'); assert.ok(r.calls.includes('reload'));
});
test('cancelling the prompt sends nothing', async () => {
  const r = await run({ prompt: null, status: 200, body: {} });
  assert.equal(r.calls.length, 0);
});
test('a wrong password is shown as an error, not "Email unlinked."', async () => {
  const r = await run({ prompt: 'bad', status: 401, body: { error: 'Current password is incorrect.' } });
  assert.equal(r.msg.textContent, 'Current password is incorrect.'); assert.equal(r.msg.className, 'settings-msg error');
  assert.ok(!r.calls.includes('reload'));
});
