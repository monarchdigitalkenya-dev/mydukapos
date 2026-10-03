// Shared helpers for the tools in this folder.
//
// WHY THESE TOOLS EXIST
// Each app (root/Shop, water, hotel, hospital, production, services,
// pharmacy) is one big index.html, and most of their logic was copy-pasted
// between them. A fix made in one copy silently never reached the others. The
// tools here keep the apps as the single-file PWAs they are (deploy is
// unchanged: `npx wrangler pages deploy .`) but let ONE canonical copy of the
// shared code live in src/shared/ and be written into every app by a script.
//
//   npm run sync     -> rewrite every app's shared regions from src/shared/
//   npm run check    -> fail if any app's shared region was hand-edited/stale
//   npm run drift    -> report what is still duplicated or has diverged
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every app that carries POS logic. (owner/ is an admin console with its own code.)
export const MODULES = [
  'index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html',
  'production/index.html', 'services/index.html', 'pharmacy/index.html',
];

// Files that also receive the shared HTML/script blocks (the owner console has no shared functions region).
export const BLOCK_TARGETS = [...MODULES, 'owner/index.html'];

export const FN_FILE = path.join(ROOT, 'src/shared/functions.js');
export const BLOCK_DIR = path.join(ROOT, 'src/shared/blocks');

export function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
export function write(rel, text) { fs.writeFileSync(path.join(ROOT, rel), text); }

// Inline <script> blocks that are big enough to be app code (skips tiny snippets).
export function scriptBlocks(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const js = m[1];
    if (js.length < 2000) continue;
    out.push({ start: m.index + m[0].indexOf('>') + 1, js });
  }
  return out;
}

export function parse(js) { return acorn.parse(js, { ecmaVersion: 'latest' }); }

// name -> [{ block, node, src }]  for every top-level function declaration.
export function topLevelFunctions(html) {
  const blocks = scriptBlocks(html);
  const decls = {};
  blocks.forEach((b, bi) => {
    const ast = parse(b.js);
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration' && n.id) {
        (decls[n.id.name] ||= []).push({ block: bi, node: n, src: b.js.slice(n.start, n.end) });
      }
    }
  });
  return { blocks, decls };
}

// The canonical function library: "//@fn name" then the source, repeated.
export function loadFunctionLibrary() {
  const text = fs.readFileSync(FN_FILE, 'utf8');
  const map = new Map();
  const parts = text.split(/^\/\/@fn (\S+)\n/m);
  // parts[0] is the header; then name, body, name, body ...
  for (let i = 1; i < parts.length; i += 2) {
    map.set(parts[i], parts[i + 1].replace(/\n+$/, ''));
  }
  return map;
}

export const REGION_RE = /\/\* @shared:begin names=(.*?) \*\/[\s\S]*?\/\* @shared:end \*\//;

export function regionText(names, lib) {
  const body = names.map((n) => '        ' + lib.get(n)).join('\n\n');
  return `/* @shared:begin names=${names.join(',')} */\n` +
    `        /* GENERATED from src/shared/functions.js by tools/sync-shared.mjs - do not edit here; edit the library and run \`npm run sync\`. */\n` +
    `${body}\n        /* @shared:end */`;
}

// Whole HTML+script blocks that are identical in every app (e.g. the Hardware icon).
// Per-block options: owner (also the owner console), skip:[modules] (not these), only:[modules] (ONLY these: the svc-* Services engine blocks), perModule.
export const SHARED_BLOCKS = {
  'hardware-quick-access': { startMarker: '<!-- HARDWARE QUICK-ACCESS' },
  'hold-sale': { startMarker: '<!-- HOLD SALE' },
  'receipt-size': { startMarker: '<!-- RECEIPT SIZE' },                    // Settings > Adjust receipt size: paper + letter size window with a live sample and a test print (zip 158)
  'receipt-extras': { startMarker: '<!-- RECEIPT EXTRAS' },                // the receipt stamp, the bills lock, the extra delivery fields and their settings sync (zip 155)
  'measure-purchase': { startMarker: '<!-- MEASURE PURCHASE', skip: ['water/index.html'] },   // zip 163: purchase packaging, weighted-average cost, measured selling, purchases report
  'stock-take': { startMarker: '<!-- STOCK TAKE TAB', skip: ['water/index.html'] },
  'reports-tab': { startMarker: '<!-- REPORTS TAB', skip: ['water/index.html'] },
  'mobile-cards': { startMarker: '<!-- MOBILE CARDS', owner: true },
  'session-keep': { startMarker: '<!-- SESSION KEEP', owner: true },
  'guide-ui': { startMarker: '<!-- GUIDE UI', owner: true },
  'guide-data': { startMarker: '<!-- GUIDE DATA', owner: true, perModule: true },      // the per-module user guide text (src/shared/blocks/guide-data/<module>.html, built by tools/build-guides.mjs)
  'storage-and-photos': { startMarker: '<!-- STORAGE & PHOTOS' },
  'device-security': { startMarker: '<!-- DEVICE SECURITY' },          // device pairing + the shop's device list (zip 120)
  'tap-rescue': { startMarker: '<!-- TAP RESCUE', owner: true },      // first-tap reliability when the screen redraws mid-tap (zip 122)
  'one-tab': { startMarker: '<!-- ONE TAB' },
  'sales-journal': { startMarker: '<!-- SALES JOURNAL' },
  'mpesa-verify': { startMarker: '<!-- MPESA VERIFY' },
  'staff-session': { startMarker: '<!-- STAFF SESSION' },               // per-staff server sessions + signed sales (zip 141)                // a typed M-Pesa code is checked against M-Pesa's own records (zip 140)              // every completed sale also kept in IndexedDB until the server has it (zip 127)                          // one working tab per app, so tabs never save over each other's sales (zip 125)
  'native-app': { startMarker: '<!-- NATIVE APPS' },                  // the Android / Windows apps: their printers, Settings ▸ Install App downloads (zip 148)
  'connectivity': { startMarker: '<!-- CONNECTIVITY', owner: true },            // ONE connectivity manager (window.PosNet): online / offline / server unavailable / auth (zip 129)
  'storage-compress': { startMarker: '<!-- STORAGE COMPRESSION', owner: true },   // must come first in <head>: everything below reads localStorage through it
  'error-reporting': { startMarker: '<!-- ERROR REPORTING', owner: true },   // also goes into the owner console
  'form-controls': { startMarker: '<!-- FORM CONTROLS', owner: true },   // zip 186: ONE bigger, modern look for every text box / select / textarea; its <style> is the last thing before </body> so it wins the cascade
  // Orders tab (purchase orders) sits next to Restock. Water's Restocking tab is a different design
  // (materials vs items), so it does not get this block.
  'orders-tab': { startMarker: '<!-- ORDERS TAB', skip: ['water/index.html'] },
  // Services engine (SERVICES_ARCHITECTURE.md 2.1): 18 blocks, written ONLY into services/index.html (`only`), in dependency order (the order below is the
  // order of the marker pairs on that page). Each file in src/shared/blocks/ starts with a header comment naming its owner and contract.
  'svc-core': { startMarker: '<!-- SVC CORE', only: ['services/index.html'] },
  'svc-templates': { startMarker: '<!-- SVC TEMPLATES', only: ['services/index.html'] },
  'svc-form': { startMarker: '<!-- SVC FORM', only: ['services/index.html'] },
  'svc-store': { startMarker: '<!-- SVC STORE', only: ['services/index.html'] },
  'svc-ui-home': { startMarker: '<!-- SVC UI HOME', only: ['services/index.html'] },
  'svc-metrics': { startMarker: '<!-- SVC METRICS', only: ['services/index.html'] },
  'svc-ui-board': { startMarker: '<!-- SVC UI BOARD', only: ['services/index.html'] },
  'svc-appts': { startMarker: '<!-- SVC APPOINTMENTS', only: ['services/index.html'] },
  'svc-reports': { startMarker: '<!-- SVC REPORTS', only: ['services/index.html'] },
  'svc-catalog': { startMarker: '<!-- SVC CATALOG', only: ['services/index.html'] },
  'svc-inventory': { startMarker: '<!-- SVC INVENTORY', only: ['services/index.html'] },
  'svc-quote': { startMarker: '<!-- SVC QUOTE', only: ['services/index.html'] },
  'svc-pay': { startMarker: '<!-- SVC PAY', only: ['services/index.html'] },
  'svc-notify': { startMarker: '<!-- SVC NOTIFY', only: ['services/index.html'] },
  'svc-perms': { startMarker: '<!-- SVC PERMS', only: ['services/index.html'] },
  'svc-config-ui': { startMarker: '<!-- SVC CONFIG UI', only: ['services/index.html'] },
  'svc-photos': { startMarker: '<!-- SVC PHOTOS', only: ['services/index.html'] },
  'svc-custom': { startMarker: '<!-- SVC CUSTOM', only: ['services/index.html'] },
};
export function blockRegex(name) {
  return new RegExp(`<!-- @shared-block:${name}:begin -->[\\s\\S]*?<!-- @shared-block:${name}:end -->`);
}
export function blockText(name, canonical) {
  return `<!-- @shared-block:${name}:begin -->\n${canonical.replace(/\n+$/, '')}\n<!-- @shared-block:${name}:end -->`;
}
