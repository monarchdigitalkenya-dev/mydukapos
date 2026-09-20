import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, APPS } from './helpers.mjs';

const SAMPLES = ['', '1234', 'correct horse battery staple', 'Pässwörd-Ünïcode-🔐', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)];
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

for (const app of [...APPS, 'owner/index.html']) {
  test(`${app}: password hashing is real SHA-256 with or without Web Crypto (no more weak fallback)`, async () => {
    const { w, errors, close } = await boot(app, { wait: 700 });
    for (const s of SAMPLES) {
      assert.equal(w.eval(`sha256HexFallback(${JSON.stringify(s)})`), sha(s), 'JS implementation matches the standard for ' + JSON.stringify(s).slice(0, 20));
    }
    // Simulate an insecure context: no crypto.subtle
    Object.defineProperty(w.crypto, 'subtle', { value: undefined, configurable: true });
    const noSubtle = await w.eval(`hashPassword('1234')`);
    assert.equal(noSubtle, sha('1234'), 'same hash as everywhere else');
    assert.doesNotMatch(noSubtle, /^fb_/);
    close();
  });
}
