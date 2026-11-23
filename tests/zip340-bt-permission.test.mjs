// zip 340: Bluetooth printing must not call anything that needs BLUETOOTH_SCAN (the app declares only BLUETOOTH_CONNECT and never scans).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const java = fs.readFileSync(path.join(ROOT, 'native/android/app/src/main/java/com/mydukapos/app/NativeBridge.java'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'native/android/app/src/main/AndroidManifest.xml'), 'utf8');

test('btPrint does not call cancelDiscovery (needs BLUETOOTH_SCAN on Android 12+)', () => {
  const code = java.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/cancelDiscovery\s*\(/.test(code), false);
});

test('no scan / discovery calls without the BLUETOOTH_SCAN permission being declared', () => {
  const code = java.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const usesScan = /startDiscovery\s*\(|getBluetoothLeScanner|BluetoothLeScanner/.test(code);
  if (usesScan) assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
});
