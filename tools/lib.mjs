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
  'carwash/index.html',   // zip 361: the standalone Car Wash & Cleaning app (forked from services/, without the svc-* engine and with the cw-* blocks)
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
  'dual-grid': { startMarker: '<!-- DUAL GRID', only: ['index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },
  'hardware-quick-access': { startMarker: '<!-- HARDWARE QUICK-ACCESS' },
  'hold-sale': { startMarker: '<!-- HOLD SALE' },
  'cash-drawer': { startMarker: '<!-- CASH DRAWER', only: ['index.html'] },   // Shop: cash float & reconciliation screens + checkout hooks (pure logic: cash* in functions.js)
  'inventory-pro': { startMarker: '<!-- INVENTORY WORKSPACE', only: ['index.html'] },   // Shop: inventory workspace, serial units, variants, import wizard, checkout unit picker (zip 292; engine: serial*/variant*/import* in functions.js)
  'receipt-size': { startMarker: '<!-- RECEIPT SIZE' },                    // Settings > Adjust receipt size: paper + letter size window with a live sample and a test print (zip 158)
  'receipt-extras': { startMarker: '<!-- RECEIPT EXTRAS' },                // the receipt stamp, the bills lock, the extra delivery fields and their settings sync (zip 155)
  'measure-purchase': { startMarker: '<!-- MEASURE PURCHASE', skip: ['water/index.html'] },
  'cash-prefill': { startMarker: '<!-- CASH PREFILL', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 319: Settings > Prefill Cash Tendered (on by default)
  'suppliers': { startMarker: '<!-- SUPPLIERS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // zip 321 (from zip 319's credit restock): Suppliers tab, supplier ledger on tradeCredits + expenses, paid / part / credit restocks, payments, returns, reports
  'stock-take': { startMarker: '<!-- STOCK TAKE TAB', skip: ['water/index.html'] },
  'reports-tab': { startMarker: '<!-- REPORTS TAB', skip: ['water/index.html'] },
  'mobile-cards': { startMarker: '<!-- MOBILE CARDS', owner: true },
  'session-keep': { startMarker: '<!-- SESSION KEEP', owner: true },
  'guide-ui': { startMarker: '<!-- GUIDE UI', owner: true },
  'guide-data': { startMarker: '<!-- GUIDE DATA', owner: true, perModule: true },      // the per-module user guide text (src/shared/blocks/guide-data/<module>.html, built by tools/build-guides.mjs)
  'storage-and-photos': { startMarker: '<!-- STORAGE & PHOTOS' },
  'device-security': { startMarker: '<!-- DEVICE SECURITY' },          // device pairing + the shop's device list (zip 120)
  'pack-cost': { startMarker: '<!-- ADD ITEM: COMPACT IMAGE + PACK COST' },   // zip 253: slim picture row + box/pack price -> cost per piece on Add Item
  'image-remove': { startMarker: '<!-- ITEM IMAGE: REMOVE', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // Remove an item's picture (zip 209)
  'measure-by-price': { startMarker: '<!-- MEASURE BY PRICE', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // cart: measure by price for kg / litre items (zip 209)
  'balance-sheet': { startMarker: '<!-- BALANCE SHEET', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // Reports: Balance Sheet (zip 209)
  'gateway-more': { startMarker: '<!-- PAYMENT GATEWAYS: PESAPAL', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // Pesapal + Co-op Bank (zip 210)
  'dark-fix': { startMarker: '<!-- DARK MODE FIX', owner: true, only: ['owner/index.html', 'index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 247: dark mode - pale boxes / dim captions readable
  'pay-confirm': { startMarker: '<!-- PAY CONFIRM', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 247: typed Admin password / manager PIN before payment or SMS keys change; shows the held-change card
  'install-link': { startMarker: '<!-- INSTALL LINK GUARD', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 245: the installed app's manifest carries the shop token; a missing token is not shown as "link removed"
  'dup-item': { startMarker: '<!-- DUPLICATE ITEM', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 244: Add Item / Bulk Add find an existing item and offer: update it, add a variant (or version), or cancel
  'round-up': { startMarker: '<!-- ROUND UP', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 232: every sale rounds up to a whole shilling (a visible Rounding line), Settings > View switch
  'past-sales': { startMarker: '<!-- PAST SALES MULTI', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 232: Record a Past Sale takes many items, decimals, whole-shilling totals and a photo Capture List
  'extra-sales': { startMarker: '<!-- EXTRA SALES', owner: true, only: ['owner/index.html', 'index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 357: Daily Sales > Unrecorded / Extra Sales (one total, profit by margin %, daily summary)
  'stock-rules': { startMarker: '<!-- STOCK RULES', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 221: per-item stock alerts, Active/Inactive, Adjust stock with reasons, valuation by category
  'view-settings': { startMarker: '<!-- VIEW SETTINGS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 219: ONE Settings > View tab holding every hide switch
  'accounts': { startMarker: '<!-- ACCOUNTS (zip 227)', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 227: double-entry books built from the till's records (ledger, trial balance, P&L, balance sheet, cash flow, ageing, bank rec, fixed assets)
  'print-panels': { startMarker: '<!-- PRINT ANY LEDGER', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 224: Print button on every ledger/list panel that had none
  'hide-adhoc': { startMarker: '<!-- HIDE UNLISTED', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // Settings > General: hide the Sell Unlisted Item button (zip 208)
  'hide-counter-btns': { startMarker: '<!-- HIDE COUNTER BUTTONS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // zip 217: Settings > General: hide the Bills / Sales buttons on the Sales Counter
  'lpg-retail': { startMarker: '<!-- LPG RETAIL', only: ['index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // zip 216: the gas chooser at the Sales Counter, bundles, damaged, stock take, history, reports (server: _lpg.js)
  'first-run-customers': { startMarker: '<!-- FIRST RUN & CUSTOMERS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 258: empty-inventory / empty-counter cards, one customer search-or-add field at checkout, tabbed customer profile with a derived loyalty ledger, normalised-phone token award
  'demo-reset': { startMarker: '<!-- DEMO HOURLY RESET', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 320: the public sample shops go back to their sample data every hour (demo sub-domain + server-confirmed only); in <head> right after storage-compress
  'demo-guard': { startMarker: '<!-- DEMO GUARD', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 327: pre-filled public demos only - one new product, original names locked, imports off
  'shared-demo': { startMarker: '<!-- SHARED DEMO MODE', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 262: the shared public demos - local-only edits, DEMO banner, Reset demo
  'input-guard': { startMarker: '<!-- INPUT GUARD', owner: true, only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html', 'owner/index.html'] },   // zip 269: a redraw of a screen never takes the text box someone is typing in
  'boot-splash': { startMarker: '<!-- BOOT SPLASH', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 279: one short loading screen from the first bytes until the picker is on
  'legal-links': { startMarker: '<!-- LEGAL LINKS', owner: true, only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html', 'owner/index.html'] },   // zip 273: Terms / Privacy always open the canonical main-domain pages; added to the lock + sign-in screens
  'my-plan': { startMarker: '<!-- MY PLAN', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 267: a shop's own subscription screen (renew, add-ons, referral, overdue banner, paused page)
  'store-sales': { startMarker: '<!-- STORE SALES + STORE HISTORY', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 293: Store history is its own tab; Sell from Store at the Sales Counter (logSale in functions/api/store.js + _store-d1.js)
  'ux-polish': { startMarker: '<!-- UX POLISH', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 298: tap targets, date-of-birth picker look, label rows
  'counter-pro': { startMarker: '<!-- COUNTER PRO', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 298: compact Sales Counter - dense grid, one search box, category bar, Hold | Drawer | Complete row, scan-ready light
  'split-popup': { startMarker: '<!-- SPLIT POPUP', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 300: Split payment opens as a popup (Cash / M-Pesa / Card / tendered / M-Pesa details), a one-line summary stays in the cart
  'edit-more': { startMarker: '<!-- EDIT MORE', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 300: Item setup panel in the Edit Item popup - category, box & piece, serial numbers, variants
  'tax-returns': { startMarker: '<!-- TAX & RETURNS', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 304
  'stock-engine': { startMarker: '<!-- STOCK ENGINE', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 336: identity match for transfers, packaging levels, batch (FIFO/FEFO) lots, cost-fix overlay - pure calculations
  'stock-pro': { startMarker: '<!-- STOCK PRO', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 336: Store transfers without duplicates, packaging screens, batch screens, cost corrections and profit adjustments
  'pack-import': { startMarker: '<!-- PACK IMPORT', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 346: import a stock list (Excel / CSV) with box > packet > piece levels; reads a supplier-style list or the template
  'take-levels': { startMarker: '<!-- STOCK TAKE BY LEVEL', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 346: stock take counts each package level (boxes, packets, loose pieces) and adds them up
  'login-fix': { startMarker: '<!-- LOGIN FIX', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 347: password check also tries the typed password without stray spaces and the server's own copy (reset from the Owner Console)
  'layout-fit': { startMarker: '<!-- LAYOUT FIT', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 336: roomier, tidier tabs (restock rows, forms, tables, dialogs)
  'hmis-counter': { startMarker: '<!-- HMIS COUNTER', only: ['hospital/index.html'] },   // zip 336: HMIS Sales Counter layout
  'hmis-ui': { startMarker: '<!-- HMIS UI', only: ['hospital/index.html'] },   // zip 338: HMIS professional design layer (tokens, cashier payment summary, sectioned reception form)
  'hmis-reg': { startMarker: '<!-- HMIS REG', only: ['hospital/index.html'] },   // zip 345: county / sub-county / ward combo boxes (Kenya data built in), the just-registered patient shown at Reception, Edit looks like Register
  'hotel-mobile': { startMarker: '<!-- HOTEL MOBILE', only: ['hotel/index.html'] },   // zip 339: hotel phone layout (top bar, one-column forms, tiles)
  'hmis-cashier': { startMarker: '<!-- HMIS CASHIER', only: ['hospital/index.html'] },   // zip 328: Send to Cashier / Add Charge, the cashier's request queue, cancel with a reason, doctor-side payment status
  'hmis-catalog': { startMarker: '<!-- HMIS CATALOG', only: ['hospital/index.html'] },   // zip 351: Kenya starter catalogue (medicines + services with average prices, stock 0)
  'hmis-referral': { startMarker: '<!-- HMIS REFERRAL', only: ['hospital/index.html'] },   // zip 358: referral-hospital pick list
  'hmis-combo': { startMarker: '<!-- HMIS COMBO', only: ['hospital/index.html'] },   // zip 359: typing dropdowns
  'hmis-rx': { startMarker: '<!-- HMIS RX', only: ['hospital/index.html'] },   // zip 359: medicine suggestions + safety checker
  'hmis-slip': { startMarker: '<!-- HMIS SLIP', only: ['hospital/index.html'] },   // zip 363: 80 mm visit summary slip + sick-off, cashier loads patients who owe nothing
  'hmis-edit': { startMarker: '<!-- HMIS EDIT', only: ['hospital/index.html'] },   // zip 363: edit / remove everything preloaded (medicines, services, referral hospitals)
  'hmis-ai': { startMarker: '<!-- HMIS AI', only: ['hospital/index.html'] },   // zip 364: AI insights under the Dashboard Insights card and Reports > Business insights
  'hmis-chat': { startMarker: '<!-- HMIS CHAT', only: ['hospital/index.html'] },   // zip 359: staff chat
  'hmis-icd': { startMarker: '<!-- HMIS ICD', only: ['hospital/index.html'] },   // zip 358: more ICD-10 categories
  'hmis-adjust': { startMarker: '<!-- HMIS ADJUST', only: ['hospital/index.html'] },   // zip 371: POS adjustments list - lab results view-only for the doctor, past-visit edit, 2nd diagnosis, draft to cashier, approved lab-result delete
  'hmis-inpatient': { startMarker: '<!-- HMIS INPATIENT', only: ['hospital/index.html'] },   // zip 367: POS adjustment (in-patient) - patient file, Lab/Radiology/Cardex tabs, send to cashier, rename wards
  'hmis-records': { startMarker: '<!-- HMIS RECORDS', only: ['hospital/index.html'] },   // zip 351: Bills pop-up, Patient Database + history, clinical forms (Kardex...), registration fee, waivers
  'customer-pro': { startMarker: '<!-- CUSTOMER PRO' },   // zip 328: one customer = one profile; checkout name/ID fields + saved-customer picker, ask-don't-guess dialog, customers screen, profile, duplicate review and merge
  'profit-cash-diff': { startMarker: '<!-- PROFIT CASH DIFFERENCES' },   // zip 376: cash surplus added / shortage subtracted under profit, then Final profit
  'print-isolate': { startMarker: '<!-- PRINT ISOLATE' },   // zip 375: Print prints the receipt from its own hidden document, never the page on screen (Chrome on Android re-draws its preview from the live page)
  'delivery-guard': { startMarker: '<!-- DELIVERY GUARD' },   // zip 374: watchdog so orders/bills never silently stop arriving (stale detection, forced catch-up, reconnect, keep-awake, red banner)
  'invoicing': { startMarker: '<!-- INVOICING', owner: true },   // zip 373: Invoicing tab in every app - multi-currency (KES default), tax on/off, print/PDF/share, client statements, reconciliation
  'price-list': { startMarker: '<!-- PRICE LIST', only: ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // zip 381: Shop Price List - prices, stock, monthly targets and achievement; services tracked by the material they use
  'staff-commission': { startMarker: '<!-- STAFF COMMISSION', only: ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'] },   // zip 394: admin sets each worker's commission (% or KSh per sale), earnings report, taken off profit
  'kcb-sandbox': { startMarker: '<!-- KCB SANDBOX PAYLOAD', only: ['index.html', 'hotel/index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html'] },   // zip 389: after a KCB sandbox prompt, the exact request sent to KCB in a popup with Copy
  'cust-manage': { startMarker: '<!-- CUSTOMER MANAGE' },   // zip 362: edit / delete a customer from either profile in every app (Aqua POS had no delete)
  'settings-pro': { startMarker: '<!-- SETTINGS PRO', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 304
  'dash-status': { startMarker: '<!-- DASH STATUS', only: ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 304
  'staff-rename': { startMarker: '<!-- STAFF RENAME', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'water/index.html'] },   // zip 300: Settings -> Staff: Rename button (same id, login link and PIN)
  'mpesa-agent': { startMarker: '<!-- M-PESA AGENT', only: ['index.html'] },   // zip 340: M-PESA Agent cash + e-float ledger (Money group)
  'public-order': { startMarker: '<!-- PUBLIC ORDER', only: ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'] },   // zip 368: ONE public order-from-home barcode + the "Online Orders" tab for every app (the hotel has its own, older one)
  'hotel-reception': { startMarker: '<!-- HOTEL RECEPTION', only: ['hotel/index.html'] },   // zip 369: the front desk in one simple Reception tab (arrivals, in the house, check in, reserve) on the hotel's own tested functions
  'shop-loans': { startMarker: '<!-- BORROW & LEND', only: ['index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html', 'hotel/index.html'] },   // zip 369: borrow / lend ITEMS between shops (kind 'goods' inside tradeCredits); apps that have the Trade Credits tab
  'money-tabs': { startMarker: '<!-- MONEY TABS', only: ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html', 'hotel/index.html'] },   // zip 369: simple Expenses tab + direct Purchases tab on top of the app's own Add Expense / Complete Restock
  'aqua-inventory-io': { startMarker: '<!-- AQUA INVENTORY EXPORT', only: ['water/index.html'] },   // zip 369: Aqua Inventory tab gets Export list / Import list (preview first) / Template
  'stock-refresh': { startMarker: '<!-- STOCK REFRESH', only: ['index.html', 'water/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'] },   // zip 368: a phone with unsent work no longer keeps stale stock numbers: it asks the server for the quantities on login change / counter open / every minute while stuck / a Refresh button
  'stock-value-tab': { startMarker: '<!-- STOCK VALUE TAB', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 300: Stock Valuation (+ Inventory workspace in the Shop) in its own tab after Inventory
  'store-pro': { startMarker: '<!-- STORE PRO', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 301: the Store as complete as Inventory (category, variants, prices, reorder, valuation), editable in place + one Add/Edit popup
  'global-search': { startMarker: '<!-- GLOBAL SEARCH', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 301: one search box (header 🔎 / Ctrl+K) for items, dishes, services, customers, staff, sales and screens
  'delivery-popup': { startMarker: '<!-- DELIVERY POPUP', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 293: the delivery form opens as a wide popup
  'till-payments': { startMarker: '<!-- TILL PAYMENTS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html'] },   // zip 259: Sales Counter -> Till Payments (newest first, link a payment once to a bill or sale)
  'hmis-clinical': { startMarker: '<!-- HMIS CLINICAL', only: ['hospital/index.html'] },   // zip 259: consolidated prescription (NA), lab catalogue + structured results, inpatient account / meals / MAR / bed transfer
  'tengeneza-payroll': { startMarker: '<!-- TENGENEZA PAYROLL' },   // zip 216: staff register, documents, pay runs, payslips (server: functions/api/payroll.js)
  'tap-rescue': { startMarker: '<!-- TAP RESCUE', owner: true },      // first-tap reliability when the screen redraws mid-tap (zip 122)
  'one-tab': { startMarker: '<!-- ONE TAB' },
  'sales-journal': { startMarker: '<!-- SALES JOURNAL' },
  'aqua-materials': { startMarker: '<!-- AQUA MATERIALS', only: ['water/index.html'] },   // zip 333: raw-material varieties, eligible-recipe production, audited restock
  'aqua-flow': { startMarker: '<!-- AQUA FLOW', only: ['water/index.html'] },   // zip 348: simple material form + CSV, 9-step production with water tank, client bottles, price list + invoices
  'aqua-bottles': { startMarker: '<!-- AQUA BOTTLES', only: ['water/index.html'] },   // zip 365: finished water stock per bottle (Grip, Aqua clear...), client bottles off the counter, paste stock balances
  'sales-payments': { startMarker: '<!-- SALES PAYMENTS', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 333: Cash / M-Pesa / Card / Other totals on the Daily Sales screen
  'mpesa-verify': { startMarker: '<!-- MPESA VERIFY' },
  'staff-session': { startMarker: '<!-- STAFF SESSION' },               // per-staff server sessions + signed sales (zip 141)                // a typed M-Pesa code is checked against M-Pesa's own records (zip 140)              // every completed sale also kept in IndexedDB until the server has it (zip 127)                          // one working tab per app, so tabs never save over each other's sales (zip 125)
  'native-app': { startMarker: '<!-- NATIVE APPS' },                  // the Android / Windows apps: their printers, Settings ▸ Install App downloads (zip 148)
  'connectivity': { startMarker: '<!-- CONNECTIVITY', owner: true },            // ONE connectivity manager (window.PosNet): online / offline / server unavailable / auth (zip 129)
  'storage-compress': { startMarker: '<!-- STORAGE COMPRESSION', owner: true },   // must come first in <head>: everything below reads localStorage through it
  'error-reporting': { startMarker: '<!-- ERROR REPORTING', owner: true },   // also goes into the owner console
  'form-controls': { startMarker: '<!-- FORM CONTROLS', owner: true },   // zip 186: ONE bigger, modern look for every text box / select / textarea; its <style> is the last thing before </body> so it wins the cascade
  'print-white': { startMarker: '<!-- PRINT WHITE' },   // zip 192: receipts and tickets print black on white in every theme (the Windows app prints backgrounds)
  'phone-till': { startMarker: '<!-- PHONE TILL' },
  'branch-switcher': { startMarker: '<!-- BRANCH SWITCHER' },
  'business-hq': { startMarker: '<!-- BUSINESS HQ', only: ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'carwash/index.html', 'hospital/index.html', 'water/index.html'] },   // zip 309: Business HQ (branches, staff across branches, HQ administrators, audit; server: functions/api/org.js)   // zip 199: the owner's global branch switcher in the header (opens the other branch on the same screen; All branches = read-only)
  'phone-pay-steps': { startMarker: '<!-- PHONE PAY STEPS' },   // zip 200: phone only - Collect, then the shop's payment methods, then that method's boxes, then Confirm
  'sidebar-nav': { startMarker: '<!-- SIDEBAR NAV', owner: true },   // zip 202: grouped collapsible left sidebar built from the permitted tab buttons (drawer on phones/tablets)
  'launcher-view': { startMarker: '<!-- LAUNCHER VIEW', only: ['index.html'] },   // zip 364: the tile menu (Settings > Screen View) - shop app only
  'category-tiles': { startMarker: '<!-- CATEGORY TILES' },
  'stock-report-edit': { startMarker: '<!-- STOCK REPORT EDIT' },
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
  'svc-demo': { startMarker: '<!-- SVC DEMO', only: ['services/index.html'] },     // zip 352: sample businesses for the public Services demos
  'svc-inventory': { startMarker: '<!-- SVC INVENTORY', only: ['services/index.html'] },
  'svc-quote': { startMarker: '<!-- SVC QUOTE', only: ['services/index.html'] },
  'svc-pay': { startMarker: '<!-- SVC PAY', only: ['services/index.html'] },
  'svc-notify': { startMarker: '<!-- SVC NOTIFY', only: ['services/index.html'] },
  'svc-perms': { startMarker: '<!-- SVC PERMS', only: ['services/index.html'] },
  'svc-config-ui': { startMarker: '<!-- SVC CONFIG UI', only: ['services/index.html'] },
  'svc-photos': { startMarker: '<!-- SVC PHOTOS', only: ['services/index.html'] },
  'svc-custom': { startMarker: '<!-- SVC CUSTOM', only: ['services/index.html'] },
  'svc-carwash-moved': { startMarker: '<!-- SVC CARWASH MOVED', only: ['services/index.html'] },   // zip 361: Car Wash left Services for its own app; a car wash shop sees where it went
  // zip 361: the standalone Car Wash & Cleaning app (carwash/index.html only), in dependency order: pure rules, state, shell + operations, the other screens
  'cw-core': { startMarker: '<!-- CW CORE', only: ['carwash/index.html'] },
  'cw-store': { startMarker: '<!-- CW STORE', only: ['carwash/index.html'] },
  'cw-ui': { startMarker: '<!-- CW UI ---', only: ['carwash/index.html'] },
  'cw-ui2': { startMarker: '<!-- CW UI 2', only: ['carwash/index.html'] },
  'cw-books': { startMarker: '<!-- CW BOOKS', only: ['carwash/index.html'] },   // zip 394: Car Wash expenses, daily cash-up, supplies stock, commission (split per job), Profit & Loss
  'cw-owner': { startMarker: '<!-- CW OWNER', owner: true, only: ['owner/index.html'] },   // zip 361: Owner Console > Car Wash app (status, usage, generate / copy / revoke the app link)
};
export function blockRegex(name) {
  return new RegExp(`<!-- @shared-block:${name}:begin -->[\\s\\S]*?<!-- @shared-block:${name}:end -->`);
}
export function blockText(name, canonical) {
  return `<!-- @shared-block:${name}:begin -->\n${canonical.replace(/\n+$/, '')}\n<!-- @shared-block:${name}:end -->`;
}
