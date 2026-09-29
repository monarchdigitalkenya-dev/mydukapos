import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// zip 156: the phone / PC apps must never end on a blank page. Every way the shop's page can fail to load has a handler that shows the
// app's own "Can't reach your shop" screen (native/launcher/offline.html), which retries by itself; a crashed page process reloads.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const java = read('native/android/app/src/main/java/com/mydukapos/app/MainActivity.java');
const win = read('native/windows/main.js');

test('Android: no network / DNS, server 5xx, certificate problem and a crashed page process are all handled', () => {
  assert.match(java, /onReceivedError[\s\S]{0,200}isForMainFrame\(\)[\s\S]{0,120}showOffline/);
  assert.match(java, /onReceivedHttpError[\s\S]{0,300}getStatusCode\(\) >= 500[\s\S]{0,80}showOffline/);
  assert.match(java, /onReceivedSslError[\s\S]{0,200}handler\.cancel\(\)[\s\S]{0,200}showOffline/);
  assert.match(java, /onRenderProcessGone[\s\S]{0,300}recreate\(\)[\s\S]{0,60}return true/);
  assert.match(java, /onPause\(\)[\s\S]{0,200}CookieManager\.getInstance\(\)\.flush\(\)/);
  const manifest = read('native/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /ACCESS_NETWORK_STATE/);
  assert.match(manifest, /usesCleartextTraffic="false"/);
});

test('Windows: failed load, server 5xx and a crashed renderer are all handled', () => {
  assert.match(win, /did-fail-load[\s\S]{0,300}offlinePath\(\)/);
  assert.match(win, /did-navigate[\s\S]{0,200}httpResponseCode >= 500[\s\S]{0,120}offlinePath\(\)/);
  assert.match(win, /render-process-gone[\s\S]{0,300}win\.reload\(\)/);
});

test('the offline screen exists, is bundled by both apps, and reopens the shop once it answers', () => {
  const off = read('native/launcher/offline.html');
  assert.match(off, /api\/health/);
  assert.match(off, /location\.replace/);
  assert.match(off, /addEventListener\('online'/);
  const gradle = read('native/android/app/build.gradle');
  assert.match(gradle, /launcher/, 'the launcher folder (with offline.html) is bundled as Android assets');
  assert.match(read('native/windows/build.mjs'), /extraResources[\s\S]{0,60}launcher/);
});

test('the Windows workflow builds the 8 apps in parallel and one job collects and checks all 16 installers', () => {
  const y = read('.github/workflows/windows.yml');
  assert.match(y, /matrix:[\s\S]{0,200}app: \[ shop, hotel, hmis, production, pharmacy, services, aquapos, owner \]/);
  assert.match(y, /needs: build/);
  assert.match(y, /got \$\(\$rows\.Count\)/);
});
