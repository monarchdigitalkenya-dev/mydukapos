import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

// zip 162, job 7: static facts about .github/workflows/*.yml (what can be checked without GitHub). YAML is parsed by python3 (PyYAML), the only
// parser in the build environment; if it is missing the structural tests are skipped rather than failing.
const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
const HAVE_YAML = py.status === 0;
const load = (f) => {
  const r = spawnSync('python3', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path.join(ROOT, '.github/workflows', f)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const apps = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/apps.json'), 'utf8'));
const T = { skip: HAVE_YAML ? false : 'PyYAML not installed' };

test('both workflows parse, have a name, triggers and read-only permissions', T, () => {
  for (const f of ['android.yml', 'windows.yml']) {
    const y = load(f);
    assert.ok(y.name); assert.ok(y.jobs && Object.keys(y.jobs).length);
    const on = y.on || y[true];
    assert.ok(on.push && on.workflow_dispatch !== undefined, f + ': push and manual trigger');
    assert.deepEqual(y.permissions, { contents: 'read' }, f + ': least privilege');
    for (const [id, j] of Object.entries(y.jobs)) { assert.ok(j['runs-on'], id); assert.ok(j['timeout-minutes'] > 0, id + ' has a timeout'); assert.ok(Array.isArray(j.steps) && j.steps.length, id); }
  }
});

test('the 8 apps of native/apps.json are exactly the windows matrix, and each cell makes a unique artifact', T, () => {
  const y = load('windows.yml');
  const matrix = y.jobs.build.strategy.matrix.app;
  assert.equal(apps.apps.length, 8);
  assert.deepEqual([...matrix].sort(), apps.apps.map((a) => a.key).sort());
  assert.equal(new Set(matrix).size, matrix.length);
  assert.equal(y.jobs.build.strategy['fail-fast'], false, 'one failing app must not cancel the others');
  const up = y.jobs.build.steps.find((s) => /upload-artifact/.test(s.uses || ''));
  assert.match(up.with.name, /\$\{\{ matrix\.app \}\}/, 'artifact name carries the matrix cell');
  const names = matrix.map((k) => up.with.name.replace('${{ matrix.app }}', k));
  assert.equal(new Set(names).size, 8);
  // 8 apps x (.exe + .msi) = 16 installers expected by the collector
  const collect = y.jobs.collect;
  assert.equal(collect.needs, 'build');
  const script = collect.steps.map((s) => s.run || '').join('\n');
  assert.match(script, /-lt 16/); assert.match(script, /uninstaller/, 'the NSIS uninstaller stub is not shipped as an installer');
  const dl = collect.steps.find((s) => /download-artifact/.test(s.uses || ''));
  assert.equal(dl.with.pattern, 'part-*'); assert.equal(dl.with['merge-multiple'], true);
  const buildStep = y.jobs.build.steps.map((s) => s.run || '').join('\n');
  assert.match(buildStep, /-lt 2/, 'each cell must hold its .exe and its .msi');
});

test('windows build inputs exist: build.mjs, lockfile used by the cache and npm ci, icons per app, check script, launcher resources', T, () => {
  const y = load('windows.yml');
  const setup = y.jobs.build.steps.find((s) => /setup-node/.test(s.uses || ''));
  for (const f of [setup.with['cache-dependency-path'], 'native/windows/build.mjs', 'native/windows/package.json', 'native/windows/check-installed.ps1', 'native/launcher/launcher.html', 'native/launcher/offline.html']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.equal(setup.with.cache, 'npm');
  for (const a of apps.apps) assert.ok(fs.existsSync(path.join(ROOT, 'native/windows/build', a.key + '.png')), 'icon ' + a.key);
  const run = y.jobs.build.steps.map((s) => s.run || '').join('\n');
  assert.match(run, /npm ci/); assert.match(run, /node build\.mjs \$\{\{ matrix\.app \}\}/);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/windows/package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/windows/package.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies, 'npm ci needs the lockfile to match package.json');
});

test('android workflow: build -> emulator chain, scripts and wrapper exist, secrets are the documented ones, one upload name per purpose', T, () => {
  const y = load('android.yml');
  assert.equal(y.jobs.emulator.needs, 'build');
  const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/android.yml'), 'utf8');
  const secrets = [...new Set([...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(secrets, ['MYDUKA_KEYSTORE_B64', 'MYDUKA_KEYSTORE_PASSWORD', 'MYDUKA_KEY_ALIAS', 'MYDUKA_KEY_PASSWORD']);
  for (const s of secrets) assert.ok(raw.split('\n').slice(0, 10).join('\n').includes(s), s + ' is documented in the header');
  for (const f of ['native/android/gradlew', 'native/android/gradle/wrapper/gradle-wrapper.jar', 'native/android/gradle/wrapper/gradle-wrapper.properties', 'native/android/build.gradle', 'native/android/settings.gradle', 'native/android/app/build.gradle', 'native/tools/emulator-check.sh']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  const uploads = Object.values(y.jobs).flatMap((j) => j.steps.filter((s) => /upload-artifact/.test(s.uses || '')).map((s) => s.with.name));
  assert.equal(new Set(uploads).size, uploads.length);
  const dl = y.jobs.emulator.steps.find((s) => /download-artifact/.test(s.uses || ''));
  assert.ok(uploads.includes(dl.with.name), 'the emulator job downloads an artifact the build job uploads');
  // the emulator script picks the Shop debug APK by the name the build step gives it
  const build = y.jobs.build.steps.map((s) => s.run || '').join('\n');
  assert.match(build, /debug-TEST-ONLY/); assert.match(fs.readFileSync(path.join(ROOT, 'native/tools/emulator-check.sh'), 'utf8'), /MyDukaPOS-\*-debug-TEST-ONLY\.apk/);
  // the flavours come from apps.json, so the gradle file must read it
  assert.match(fs.readFileSync(path.join(ROOT, 'native/android/app/build.gradle'), 'utf8'), /apps\.json/);
  // a 'release' build is signed only when the keystore secret exists
  assert.match(build + y.jobs.build.steps.map((s) => s.run || '').join(''), /signing: /);
});

test('nothing in the workflows needs .git history, node_modules from the repo root, or files outside native/', T, () => {
  for (const f of ['android.yml', 'windows.yml']) {
    const raw = fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
    assert.ok(!/git (log|describe|rev-list)|fetch-depth: 0/.test(raw), f + ': no git history needed');
    assert.ok(!/node_modules/.test(raw.replace(/cache-dependency-path[^\n]*/g, '')), f + ': no repo node_modules');
    const refs = [...raw.matchAll(/(?:\.\/|\s|')((?:native|release)\/[A-Za-z0-9_./-]+)/g)].map((m) => m[1]).filter((p) => p.startsWith('native/') && /\.[a-z0-9]+$/.test(p) && !/build\/outputs|dist\//.test(p));
    for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r)), f + ' references ' + r);
  }
  // the desktop build bundles ../launcher only: the web apps are loaded over the network, so web-file edits need no rebuild trigger
  const b = fs.readFileSync(path.join(ROOT, 'native/windows/build.mjs'), 'utf8');
  assert.match(b, /from: '\.\.\/launcher'/);
});
