// Builds the Windows installers of one or all MyDukaPOS apps:   node build.mjs [appKey ...]      (default: all 7)
// Output: dist/<appKey>/<Name>-<version>-Setup.exe (NSIS) and <Name>-<version>.msi — x64. Needs Windows (or CI's windows runner).
// Code signing (optional — Windows SmartScreen warns about unsigned installers): set CSC_LINK (the .pfx, path or base64) and
// CSC_KEY_PASSWORD; electron-builder then signs. Nothing is signed with an invented certificate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';

// an EMPTY signing variable (CI without the secret) means "not signed" — electron-builder would read it as a certificate path
for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) if (!process.env[k]) delete process.env[k];
const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps.json'), 'utf8'));
const want = process.argv.slice(2);
const apps = cfg.apps.filter((a) => !want.length || want.includes(a.key));
if (!apps.length) { console.error('Unknown app. Choose from:', cfg.apps.map((a) => a.key).join(', ')); process.exit(2); }

for (const a of apps) {
  const slug = a.name.replace(/\s+/g, '-');
  console.log(`\n=== ${a.name} ${cfg.version.name} (${a.key}) ===`);
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget(['nsis', 'msi'], builder.Arch.x64),
    config: {
      appId: `com.mydukapos.${a.key}.desktop`,
      productName: a.name,
      copyright: 'MyDukaPOS',
      directories: { output: `dist/${a.key}`, buildResources: 'build' },
      files: ['main.js', 'preload.js', 'package.json', `build/${a.key}.png`],
      extraResources: [{ from: '../launcher', to: 'launcher' }],
      extraMetadata: { version: cfg.version.name, mydukaApp: { key: a.key, name: a.name, product: a.product, path: a.path, rootDomain: cfg.rootDomain } },
      win: { icon: `build/${a.key}.png`, target: ['nsis', 'msi'], artifactName: `${slug}-${cfg.version.name}-Setup.\${ext}` },
      nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: a.name, artifactName: `${slug}-${cfg.version.name}-Setup.\${ext}` },
      msi: { oneClick: false, perMachine: false, createDesktopShortcut: true, shortcutName: a.name, artifactName: `${slug}-${cfg.version.name}.\${ext}` },
      publish: null,
    },
  });
}
