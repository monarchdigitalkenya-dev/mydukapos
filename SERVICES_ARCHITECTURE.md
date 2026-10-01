# SERVICES_ARCHITECTURE.md — Multi-Industry Services & Job Management Engine

Status: design for implementation by parallel agents. Author: architect (read-only pass over the code base).
Scope: `services/index.html` (the "general POS" variant that carries the 🔧 Services Counter). Source of truth for requirements: `SERVICES_MASTER_PROMPT.txt` (cited below as **MP §n**).
Line numbers are approximate (another agent is editing `services/index.html`); **anchor by function / id name, never by line number.**

---------------------------------------------------------------------------------------------------

## 0. Ten decisions that shape everything (read first)

| # | Decision | Why (one line) |
|---|---|---|
| D1 | The engine is **inline `<script>` blocks in `services/index.html`, authored as shared-block files `src/shared/blocks/svc-*.html`, registered in `tools/lib.mjs` `SHARED_BLOCKS` for the Services app only** (new `only:` option in `tools/sync-shared.mjs`). No new `.js` file, no `//@fn svc*` in `functions.js`. | `tests/helpers.mjs boot()` creates `new JSDOM(html, {runScripts:'dangerously'})` with **no `resources:'usable'`** → an external `engine.js` would never run in any test; a separate file also needs SW precache + version-mix handling. Blocks give each parallel agent its own file; `functions.js` (17.7k lines, shared by 7 apps) would be a merge-conflict magnet. |
| D2 | Pure logic (registry, validation, money, status machine, metrics, report math) lives in **DOM-free blocks** that node tests load through `vm` (`tests/svc-helpers.mjs`), DOM code lives in separate `svc-ui-*` blocks. Code style = ES2018 max (enforced by an acorn test) — the app has 0 uses of `?.`, `??`, `replaceAll`, `Object.fromEntries`, `structuredClone`. | Old Android WebViews; testability. |
| D3 | **Five new synced lists, all merged per record by id** (not whole-value): `svcJobs`, `svcAssets`, `svcCatalog`, `svcAppointments`, `svcConfig`. Hot-path arrays inside a job (`statusHistory`, `charges`, `materials`, `payments`, `audit`, `notify`, `jobStaff`, `valuables`, `photos`, `quoteVersions`, `quoteLog`) are **append-only arrays unioned by element id** (new `NESTED_MERGE.svcJobs`). Derived values (status, quote state, totals, paid, balance) are **recomputed, never trusted**. | The legacy `serviceJobs`/`bookings` are NOT in `MERGE_BY_ID_FIELDS` and NOT in `registerSyncedField` → they sync as whole values (`_fieldTimes` last-writer-wins): two tills adding a job at once lose one. We must not inherit that. |
| D4 | **Legacy `serviceJobs` and `bookings` are never migrated, rewritten or deleted.** They are read through a pure adapter (`svcLegacyToJob`, `svcLegacyBookingToAppt`) into the engine views; old screens/functions keep working on them. An explicit, optional "Upgrade to full job" *promotion* (B3) copies one legacy job into `svcJobs` under a deterministic id `sj-lg-<legacyId>`. | Zero data loss, mixed-release tills (old build keeps pushing `serviceJobs`), trivially reversible. |
| D5 | `serviceType` + `templateVersion` are **immutable on a job**. Changing the shop's business type only changes what *new* jobs use and what views default to. Every list has an **"All types"** history mode. | MP §41, §48. |
| D6 | **ONE renderer/validator** driven by a declarative field schema (`svcRenderForm`, `svcValidate`). Templates contain only the fields of their industry; `visibleWhen` fields are *unmounted* (not `display:none`). Custom fields are injected into the resolved template. | MP §2, §30. "Irrelevant fields never in the DOM" is directly assertable in tests (`querySelector('[data-fid="veh_plate"]') === null`). |
| D7 | **Existing shops see NO change until the owner opts in.** `svcConfig.business.chosen !== true` ⇒ the 🔧 tab renders the classic counter exactly as today + a dismissible "choose your business type" banner. New sign-ups choose at sign-up → engine UI immediately. Effective type for unchosen shops = `phone_repair` if `serviceJobs.length>0`, else `other`. | MP §1 ("do not break"), §6. |
| D8 | **Inventory deduction reuses `deductStockForSaleUnit` / `restoreStockForSaleUnit`** and re-tags the movements it appended (`reason:'Job <no>'`, `jobId`, `staffId`). Note: today's `completeServiceJob` mutates `product.qty` directly *without* `logStockMovement` (the stock-ledger safety net `reconcileLocalStockChanges` logs an anonymous "Stock correction (change not itemised)"). The engine must not copy that. | MP §22 traceability; stock ledger (`stockLedgerOn`). |
| D9 | **Payments reuse the Bills machinery** (`bills[]`, `paymentHistory`, `salesLog` payment lines, `recomputeBillStatus`, `mergeBillRecords` union of payments/lines on the server). Additional charges become *appended bill lines* (server `unionLines` keeps lines added on either copy). Every sale/bill/payment created for a job carries `svcJobId`/`svcJobNo`. | MP §23/§24, money correctness already proven by `tests/bill-settle-stays-settled`, `past-sale-payments`, etc. |
| D10 | **Photos never enter synced state.** Compress on device (`compressImageToTarget`, ≤300 KB), keep pending bytes in a local IndexedDB store `svc_photos`, upload to `/api/media` with existing private kind **`ref`** (id `svc-<sha20>`, already idempotent, no server change), record only `{id, kind, at, by, bytes}` on the job. | State limits (SCALE_PLAN.md: server "Large" 4 MB / refused 12 MB; localStorage ~5 MB). |

---------------------------------------------------------------------------------------------------

## 1. What exists today (inventory) and what must be preserved

### 1.1 Screens / functions (all in `services/index.html`)

| Area | Where | What it does today |
|---|---|---|
| Tab 🔧 **Services Counter** | `#services-counter-tab` (nav `#services-counter-tab-btn`); render `renderServicesCounter()`, hooked in `performTabSwitch` | Inline intake (`services-counter-client-name/phone/item-details/left-at/promised-pickup/quote/status/intake-notes`), "Primary Service" select (from `inventory` items with `type==='service'`), labour fee, parts search `searchServiceComponents()` → `serviceCounterDraft.components[]`, totals (`renderServiceCounterComponents`), override price, payment (cash / M-Pesa STK via `servicesCounterMpesaFlow` / split), amount-paid (deposit), **`completeServiceJob()`** (sale or Bill + deposit line), "Print Intake Tag" (`printIntakeTag` → `openIntakeTagWindow` → `printHTMLDirect`). Modal `#services-counter-leftitem-modal` ("Full Intake Form", `saveServicesCounterLeftItem`, `saveServicesCounterInlineIntake`, `loadJobIntoServicesCounter`). |
| Tab 🗂️ **Client Registry** | `#client-registry-tab`, `renderClientRegistry()`, `#client-job-modal` (`openClientRegistryModal`, `saveClientRegistryJob`), profile modal (`openClientJobProfile`), `setJobStatusQuick`, `deleteClientRegistryJob` (hard `filter`, no tombstone), `sendJobToServicesCounter`, `resolveJobBillStatuses()` (flips a job to `collected` when its bill disappears from `bills`). |
| Client comms | `JOB_MESSAGE_TEMPLATES` (5 statuses), `buildJobStatusMessage`, `openClientNotifyModal`, `sendJobNotifySms` (`sms:<phone>?body=`), `sendJobNotifyWhatsapp` (`wa.me/<normalizeKenyanPhone>`), `sendJobNotifyCall` (`tel:`). Manual only — no auto-send. |
| Due reminders | `getDueServiceJobs()`, `checkServiceJobsDue()` (60 s timer, bell list `#service-jobs-due-notif-list`, persisted `pos_notified_due_jobs`). |
| Tab 📅 **Bookings** | `#bookings-tab`, `renderBookingsList`, `saveBooking`, `findBookingClashes` (same staff + same date overlap, cancelled ignored), `completeBooking` (pushes service into the Sales Counter cart), `markBookingNoShow`, `cancelBooking`, `deleteBooking`, `checkUpcomingBookingsForCurrentStaff` (10-min warning). Service durations come from `inventory[].durationMinutes` (default 30). |
| Customers | `customers[]` `{id,name,phone,tokens,createdAt}` (exact-string phone match in `registerOrUpdateCustomer`), `renderCustomersList()` groups `customers + bookings + salesLog` by raw phone. `normalizeKenyanPhone()` only *normalises* (no validation). |
| Staff / permissions | `staff[]` `{id,name,pinHash,roles[],adminPermissions[],isManager,…}`; `ROLE_TABS` = `sales-tab` + `LOCKABLE_TABS` minus `staff-tab` (**a role is a tab id**; special roles `expenses-add-only`); `isTabLocked(tabId)`; staff UI = `renderStaffPanel()` (module-local, builds `roleCheckboxes` → `updateStaffRole(id, tabId, checked)` which works for **any** string); `ADMIN_GRANTABLE_SETTINGS_SECTIONS` (Secondary Admin section ids); `logAdminActivity`. |
| Settings | `#settings-subnav` buttons `data-section="settings-section-…"` → `showSettingsSection(id, btn)`; `openSettingsSection(id)` (shared fn). Sections are `<div class="settings-section-content" id="settings-section-…">`. |
| Payments | `bills[]` (`items[]`, `amountPaid`, `paymentHistory[{id,timestamp,amount,method,reference,balanceAfter}]`, `status`, `closed`, `billId` back-links), `confirmBillSettleImpl()` (sale branch appends payment + posts a `salesLog` "Bill Payment — This Installment" line with `billId`), `recomputeBillStatus`, `createMpesaStkFlow()` (+ `/api/mpesa-stkpush`), `generateReceiptRef()`, `genSaleId()`, `renderReceipt()`. |
| Inventory | `inventory[]` (`type:'service'` items carry `recipe[{code,qtyPerUnit}]`, `comboItems`, `durationMinutes`), `deductStockForSaleUnit(product, qty, saleMode)`, `restoreStockForSaleUnit`, `logStockMovement(code,name,delta,reason,unit)` (pushes `{id,lg:1,timestamp,code,name,delta,type,reason,unit,by}`), `getAvailableStock`, stock ledger (`stockLedgerOn`, `reconcileLocalStockChanges`). |
| Reports | Shared `reportsGenerate(kind)` builds from a **fixed `builders` map** (`sales, insights, staff, stock, bills, expenses` + guarded `xreport/zreport`); each builder returns `{title, html, csv}` using `reportCards`/`reportTable`. **There are no phone-repair-specific reports today**; service jobs appear only (a) as sale lines of `completeServiceJob`, (b) in the due-jobs bell list. |
| Audit | `buildAuditEvents()` (module-local) merges adminActivityLog, X/Z log, stockMovementLog, salesLog …; module filter `<select id="audit-module-select">`. |
| Dashboard | `#dashboard-tab` stat cards (`dashboard-stat-card`), no job metrics. |
| Guide | `tools/build-guides.mjs` → `src/shared/blocks/guide-data/services.html` (chapter `jobs`, `bookings`; `TAB` one-liners; `tests/guides.test.mjs` asserts every tab is described). |
| Business type | The in-app `const businessType = 'general'` (hard-locked; also in `collectSyncPayload` as `businessType`) is an old shop-vs-hotel switch. **Do not reuse the name** — engine field is `svcConfig.business.businessType`. |
| Sign-up | `#auth-signup-box` (`signup-full-name/biz-name/phone/email/password`), `submitDirectSignup()` → `POST /api/demo-account {action:'register'}` → `/api/account-recovery link` → `finishDirectAuth(name,password)` (sets `pos_biz_name`, hashes, `pushNowOrWarn('Setup')`). Shop links are created by the owner console (`functions/api/owner-clients.js` POST → `_license.js createClient(env,type,label,product,extra)`) or public-site demo (`demo-account.js` `product`). `license-status.js` returns the licence record fields the app reads. |

### 1.2 Data shapes (legacy, **frozen**)

```
serviceJobs[]  key pos_service_jobs   (NO updatedAt, NO status history, NO tombstone; delete = array filter)
{ id:'JOB-<base36time>-<rnd3>', createdAt:ISO, clientName, clientPhone, idNumber,
  itemDetails: free text ("iPhone 11, IMEI 3567…, cracked screen"),       // device/IMEI/serial are NOT separate fields today
  servicesRequired:[{code,name}], serviceNotes, quoteAmount, promisedPickup:ISO|local|'' ,
  status:'pending'|'in_progress'|'ready'|'completed'|'collected',
  components:[{code,name,qty,price,unit}], laborFee, finalAmount|null,
  saleId|null, billId|null, paymentMethod, completedAt }
bookings[]     key pos_bookings       { id:'BK-<genSaleId>', customerName, customerPhone, serviceCode, staffId, date:'YYYY-MM-DD',
                                        startTime:'HH:MM', endTime, status:'confirmed'|'cancelled'|'no-show'|'completed', notes, createdAt:ms }
```
There is no technician, diagnosis, serial/IMEI field, quote lifecycle, charges list, per-job audit or status history today. "Phone repair" as MP §6 describes it is *partly aspirational*: the preserved reality is the list above + its screens. The engine's phone-repair template must be a **superset** that can display these records without loss.

### 1.3 What must be preserved (acceptance checklist)

1. Every legacy screen/function above keeps working, byte-for-byte behaviour, for shops that never opt in (**classic mode**), and for legacy rows after opt-in (**rows are still editable through the old functions**).
2. `serviceJobs` and `bookings` storage keys, sync payload fields and shapes are never changed by the new code (new code may *read* them; it only *writes* them via the existing functions).
3. Sale/bill shape produced by `completeServiceJob` (items `Service: …`, components, `SERVICE-ADJUSTMENT`, deposit line `Deposit — Service (<name>)`, `bills.push`) is the reference the engine's checkout must equal (plus `svcJobId`).
4. `getDueServiceJobs()` keeps listing legacy jobs; engine jobs are added to the same bell list (B2 seam: `svcDueJobs()`).
5. Intake tag print and the 5 status messages keep working for legacy rows; engine jobs reuse `openIntakeTagWindow`-style printing with their own template (B3).

### 1.4 Old-record compatibility rules (hard rules — each has a test in §8)

| Rule | Mechanism |
|---|---|
| R1 Never add a *required* field to an old record | Old records are **not** touched. The adapter *derives* a view; every property of the view has a default. |
| R2 New optional fields only ever live on **new** records (`svcJobs`) | Legacy rows get at most one optional marker `promotedTo` (and only when a human promotes). |
| R3 Unknown/missing data must render, not throw | `svcRenderJobSummary` prints any `data` key not in the template under "Other details"; `svcGetTemplate` returns a template for *any* string (unknown type ⇒ `other`). |
| R4 Field ids are forever | A golden file `tests/fixtures/svc-field-ids.json` lists every shipped field id per type; `svc-templates.test.mjs` fails if an id disappears or changes `type`. Labels may change freely. |
| R5 Status keys are forever | Same golden rule for status keys; renames are label overrides only (`svcConfig` `statuses`). Custom statuses are prefixed `x_`. |
| R6 Reads tolerate older app releases | Every engine reader tolerates a record lacking any engine field (`job.payments || []`). Every writer writes only fields the *oldest supported engine release* (B1) understands. |
| R7 No silent destructive edit of money/service records | Charges, payments, materials, status history are append-only with `voidedAt`/`rev`; `svcCommit` refuses to shrink those arrays (test). |

---------------------------------------------------------------------------------------------------

## 2. The ENGINE

### 2.1 Where the code lives (decision D1) and why the alternatives lose

| Option | Verdict | Reasons |
|---|---|---|
| A. `//@fn svc*` functions in `src/shared/functions.js` | Rejected for the bulk | Works mechanically (name added to the Services `@shared:begin names=` list; `tools/sync-shared.mjs` checks unmet deps), but: the file is shared by 7 apps and edited by everyone (conflicts); a function-per-entry format is hostile to big declarative tables (templates, vehicle makes); every change re-syncs all apps; `drift-report` noise. **Used only for 3 tiny inert hooks** (§2.6). |
| B. `services/engine.js` loaded by `<script src>` | Rejected | `boot()` (tests/helpers.mjs) builds `new JSDOM(html,{runScripts:'dangerously', pretendToBeVisual:true, virtualConsole})` — no `resources:'usable'`, no file fetch → the engine would not exist in any jsdom test, and changing `boot` would touch ~120 tests. Also needs: `SHELL_ASSETS` entry + `SW_VERSION` bump in `services/sw.js` (hash of shell bytes → any skew between cached `index.html` and `engine.js` = broken app offline); `_headers` has no CSP so loading works, but stale-HTML/new-JS skew has no owner. |
| **C. Shared-block files → inline `<script>`/`<style>`/markup in `services/index.html`** | **Chosen** | Precedent: `receipt-extras`, `sales-journal`, `staff-session`, `storage-and-photos`, `orders-tab` … (blocks sit *after* the main app script and reach its `let` globals by name; e.g. `ARR.salesLog = function(){ return typeof salesLog === 'undefined' ? null : salesLog; }`). Offline: part of `index.html`, so the existing SW precache (`./index.html`, hashed) already covers it, **no sw.js structural change** (only the mandatory `SW_VERSION` bump). Tests: `boot('services/index.html')` sees everything; pure blocks are additionally loadable in node via `vm`. Ownership: one file per block → parallel agents never edit the same file. `npm run check` fails if anyone hand-edits generated content in `services/index.html`. |

**Mechanics of option C (B1 "seam" work, done once by the integrator, see Appendix A):**

1. `tools/lib.mjs`: add to `SHARED_BLOCKS` one entry per block, each `{ startMarker:'<!-- SVC …', only:['services/index.html'] }`.
2. `tools/sync-shared.mjs`: one new line in the block loop: `if (def.only && !def.only.includes(m)) continue;` (today the only per-module filter is `skip`, which would need a 6-entry list per block). `BLOCK_TARGETS` already includes `services/index.html`; `owner/` is excluded because `owner:true` is absent.
3. `services/index.html`: for every block, one marker pair `<!-- @shared-block:svc-x:begin --><!-- @shared-block:svc-x:end -->` placed in the block area that follows the main script (next to `<!-- @shared-block:receipt-size:begin -->`), **in dependency order** (table below). `npm run sync` fills them.
4. `tools/lint-globals.mjs` already parses every inline script of the page → new blocks are linted for free. **Name rule: every global symbol introduced by blocks starts with `svc`/`Svc`/`SVC_`** (test `svc-names.test.mjs` asserts no collision with `src/shared/functions.js` names nor with other top-level names in `services/index.html`).
5. Blocks must not do heavy work at parse time (47k-line page; old phones): only declare; `svcBoot()` (called from a guarded seam in `DOMContentLoaded` handler) does cheap init; templates resolve lazily and are memoised per `(type, cfgVersion)`.

**Block list, order on the page, purity, owner** (phases defined in §8):

| # | Block file (`src/shared/blocks/…`) | Pure? | Contents | Phase/agent |
|---|---|---|---|---|
| 1 | `svc-core.html` | yes | constants, ids, phone/plate/IMEI validation, money/dates, `svcTotals`, job numbering, pub-sub, permissions core (`svcCan`), audit helper | B1-A |
| 2 | `svc-templates.html` | yes (data) | `SVC_TYPES` (10 templates), vehicle/phone reference data, default notification texts, default catalog seeds, `svcGetTemplate`, `svcTerm` | B1-A |
| 3 | `svc-form.html` | DOM only for renderer; `svcValidate`/`svcVisibleFields` pure | field-schema renderer, widget registry, validator, summary renderer | B1-F |
| 4 | `svc-store.html` | no (touches globals/localStorage) | list globals, load/save, `svcCommit`, sync hooks, asset/customer upsert, job create/update/status, legacy adapter, business type config | B1-D |
| 5 | `svc-ui-home.html` | no | tab root, New Service flow, job list, job drawer shell + tab registry, settings shell + page registry, business-type chooser, sign-up select, terminology application, classic-mode banner | B1-U |
| 6 | `svc-metrics.html` | yes | queue counts, dashboard metrics, search index/score, asset history math | B2-Q |
| 7 | `svc-ui-board.html` | no | queue board, dashboard cards injection, global search UI | B2-Q |
| 8 | `svc-appts.html` | pure part + UI | appointment logic (`svcApptClashes`, slots), day/week/list, walk-in, convert | B2-A |
| 9 | `svc-reports.html` | pure builders + tiny UI | `SVC_REPORTS` registry, builders, registration into `window.reportExtraBuilders`, customer/vehicle history screens | B2-R |
| 10 | `svc-catalog.html` | pure + UI | catalog CRUD, price resolution, consumption defaults, import from inventory services | B3-C |
| 11 | `svc-inventory.html` | no | `svcUseMaterial`, `svcReverseMaterial`, consumption application, materials widget | B3-C |
| 12 | `svc-quote.html` | pure + UI | quote lifecycle, approvals, additional charges | B3-Q |
| 13 | `svc-pay.html` | no | deposits/partial/balance, bill/sale creation, M-Pesa reuse, checkout | B3-P |
| 14 | `svc-notify.html` | pure + UI | template fill, wa.me/sms:/mailto: openers, optional provider send, notify log | B3-N |
| 15 | `svc-perms.html` | no | 16 permissions UI in staff panel, specialties, Secondary-Admin section | B3-N |
| 16 | `svc-config-ui.html` | no | Settings → Services pages: Statuses, Staff Roles, Notifications, Vehicle Config, Custom Fields, Disclaimers, Numbering | B3-N |
| 17 | `svc-photos.html` | no | condition/valuables photo capture, IndexedDB queue, `/api/media` (kind `ref`) upload/view | B3-C (or B3-N) |

Every block file starts with a header comment `<!-- SVC <NAME> ... -->` and wraps code in an IIFE-free plain script (functions must be global — tests call them with `w.eval("svcX(...)")`).

**Node loading of pure blocks** (B1-A writes `tests/svc-helpers.mjs`):
```js
export function loadSvc(blocks = ['svc-core','svc-templates','svc-form-pure'], globals = {}) // returns the vm context object
// reads src/shared/blocks/<name>.html, extracts <script>…</script> text (regex like tools/lib.mjs scriptBlocks), runs them in one vm context
// pre-populated with: console, Date, Math, JSON, crypto (webcrypto), localStorage stub, and the few app globals pure code may call
// (genSaleId, bizDayKey, tillNumber, round2, escapeHtml shims). Functions are then plain properties of the context.
```
Pure blocks **must not reference `document`/`window` at top level** (they may use `typeof window !== 'undefined'` guards).

### 2.2 SERVICE_TYPES registry — the template object (MP §3, §4, §29)

```js
var SVC_TYPES = { phone_repair: {...}, car_wash: {...}, garage: {...}, salon: {...}, barber: {...},
                  laundry: {...}, cleaning: {...}, electronics_repair: {...}, tailoring: {...}, other: {...} };
var SVC_TYPE_ORDER = ['phone_repair','car_wash','garage','salon','barber','laundry','cleaning','electronics_repair','tailoring','other'];
```
Template (all keys required unless marked `?`; a test validates every template against `svcValidateTemplate(t)`):

```js
{
  key: 'car_wash', version: 1,                       // version bumps only when fields/statuses are ADDED (R4/R5); stored on jobs as templateVersion
  label: 'Car Wash', icon: '🚗', description: '…',
  prefix: 'CW',                                      // job-number prefix
  assetKind: 'vehicle',                              // 'phone' | 'vehicle' | 'equipment' | 'garment' | 'none'
  terms: {                                           // MP §29 — read via svcTerm(typeKey, 'job'); DOM: data-svc-term="job"
    job:'Wash Job', jobs:'Wash Jobs', customer:'Owner', customers:'Owners', asset:'Vehicle', assets:'Vehicles',
    staff:'Assigned Staff', staffs:'Assigned Staff', service:'Wash', services:'Wash Services',
    newButton:'+ New Vehicle Job', walkInButton:'+ New Vehicle Job', quickButton:'Quick add', queue:'Wash Queue',
    tabLabel:'🔧 Wash Counter', registerLabel:'🗂️ Vehicle Register', appointmentsLabel:'📅 Bookings',
    ready:'Ready for collection', done:'Completed'
  },
  sections: [ Section… ],                            // §2.3 — form structure
  quick: { fields:['veh_plate','services'], required:['veh_plate'], submitLabel:'Add to queue' },   // MP §28 walk-in/quick create
  statuses: [ Status… ], initialStatus:'waiting', appointmentInitialStatus:'checked_in',
  queueGroups: [ {key:'waiting', label:'Waiting', statuses:['waiting']}, … ],      // MP §14/§25
  staffRoles: [ {key:'washer', label:'Washer'}, {key:'detailer', label:'Detailer'} ],
  staffAssignment: { mode:'multi', perTask:true, taskLabels:['Exterior','Interior','Engine','Finishing'], required:false, filterBySpecialty:true },
  catalog: { seeds:[ {name:'Basic Wash', category:'Wash', price:500, durationMin:30, priceByAssetType:{sedan:500,suv:700}, consumption:[{label:'Shampoo',unit:'ml',qty:50}] }, … ],
             categories:['Wash','Interior','Exterior','Detailing','Add-ons'] },
  inventory: { mode:'optional', partsLabel:'Products used', unitChoices:['ml','l','pcs'], deductOn:'record' },   // 'record' (when staff records use) | 'status:<key>' (auto from catalog consumption) | 'off'
  quote: { mode:'optional', requireApprovalWhen:{ additionalOver: 500 }, validityDays:1, statusesAllowingQuote:['waiting','in_progress'] },
  pricing: { labour:false, materials:'included', discount:true, taxMode:'cfg' },
  notify: { events:{ received:{tpl:'…'}, ready:{tpl:'Hello {first_name}, your vehicle {asset} is ready for collection from {business}. Total amount due: {balance}. Thank you.'}, … } },
  dashboard: [ {id:'remaining', label:'Vehicles remaining', metric:'remaining'}, {id:'waiting', label:'Waiting', metric:'group:waiting'}, … ],
  reports: ['vehicles_washed','revenue_per_vehicle','popular_washes','repeat_customers','avg_turnaround','jobs_created','jobs_completed','revenue','outstanding','staff_activity','inventory_consumption'],
  appointments: { mode:'optional', defaultDurationMin:45, slotStepMin:15, doubleBookingCheck:'staff', depositField:true },   // 'off' | 'optional' | 'primary'
  search: { extraKeys:['asset.plate','asset.make','asset.model'] },
  disclaimers: { valuables:'The business is not responsible for items left in the vehicle unless recorded here.' },
  legacyMap?: {…}                                   // only phone_repair: how a legacy record projects (§4)
}
```
**Status object**
```js
{ key:'in_progress', label:'In Progress', icon:'🔧', color:'#2980b9',
  group:'working',            // queue group / dashboard bucket
  phase: 1,                   // 0 open-waiting, 1 working, 2 ready, 3 closed-success, 4 closed-other  (monotone hint used by server merge rank + archive)
  scope:'job',                // 'job' | 'appt' | 'both'  (salon: booked/confirmed/no_show are appt-only)
  terminal:false, successful:null,
  next:['ready','waiting','cancelled'],             // allowed transitions; moving to a key not in `next` needs permission svc:edit + reason
  requires:['assigned_staff'],                      // optional guards: 'assigned_staff' | 'quote_approved' | 'deposit' | 'services' | 'balance_zero'
  notifyOn:'ready',                                 // offers the notification sheet after entering
  stamp:'startedAt' }                               // job field set on first entry: startedAt|completedAt|collectedAt|readyAt
```
**Resolution**: `svcGetTemplate(typeKey, cfg)` returns `base + overrides`: status label/hidden/custom from `svcConfig` (`statuses:<type>` record), extra fields from `customFields`, catalog seeds never merged here, terminology never overridable in v1. Memoised by `typeKey + '|' + cfgRevision`. **Jobs never store the resolved template**, only `serviceType` and `templateVersion`; rendering a job uses the *current* resolved template for that type (R3/R4 guarantee it still works).

### 2.3 Field-schema format (ONE renderer for every industry — MP §2, §30, §35)

```js
Section = { id:'vehicle', title:'Vehicle', icon:'🚗', phase:'intake'|'work'|'both',   // which form/drawer tab shows it
            collapsed:false, when?:Cond, fields:[Field…] }
Field   = {
  id:'veh_plate',                      // STABLE FOREVER (R4). Custom fields: 'cf_<slug>'.
  type:'plate',                        // see type table
  label:'Number plate / registration', placeholder?, help?, default?,
  required: true | false | 'quickOff', // true = must be non-empty when visible; 'quickOff' = required in full form, optional in quick mode
  requiredWhen?: Cond,                 // dynamic required
  visibleWhen?: Cond,                  // unmounted when false. Cond = { field:'dev_type', in:['phone','tablet'] } | {field, eq} | {field, truthy:true} | {all:[Cond…]} | {any:[Cond…]} | {not:Cond}
  options?: [{v:'sedan', l:'Sedan'}],  optionsFrom?: 'vehicleMakes' | 'vehicleModels:veh_make' | 'vehicleTypes' | 'staff:mechanic' | 'phoneBrands' | 'catalog' | 'inventoryParts',
  min?, max?, step?, maxLength?, pattern?, rows?, multiple?, 
  validate?: 'phone' | 'phoneOptional' | 'plate' | 'imei' | 'year' | 'money' | 'odometer' | 'email' | <fnName registered in SVC_VALIDATORS>,
  level?: 'error'|'warn',              // warn = shown, does not block save (plate format, IMEI checksum, unknown country number)
  storesIn: 'data'|'customer'|'asset'|'job',   // where the value lands (see below)
  assetAttr?: 'plate',                 // when storesIn:'asset' — attribute name on svcAssets.attrs
  sensitive?: true,                    // excluded from search index, print, notification variables, CSV
  width?: 'half'|'full', keyboard?: 'tel'|'numeric'|'email'|'text', autocomplete?: 'plate'|'customer'|'asset',
  widget?: 'services'|'staff'|'materials'|'valuables'|'condition'|'quote'|'payment'|'photos'   // complex widgets (registry, below)
}
```
**Field types (all implemented once in `svc-form`)**

| type | DOM | value |
|---|---|---|
| `text`, `longtext`, `email` | `<input>`/`<textarea>` | string |
| `number`, `money`, `year`, `odometer` | `<input inputmode="decimal|numeric">` | number or `''` |
| `phone` | `<input type="tel" inputmode="tel">` + live `svcNormPhone` hint | string as typed; normalised on save into `customer.phone` |
| `plate`, `imei` | upper-casing text + asset lookup-on-blur (`autocomplete:'asset'` fires `svcFindAssetByKey`, shows a "Known vehicle" card with history, pre-fills owner + attributes) | string |
| `date`, `time`, `datetime` | native inputs (separate date + time; avoid `datetime-local` on the appointment form) | `YYYY-MM-DD`, `HH:MM`, ms |
| `dropdown` | `<select>` | option `v` |
| `combo` | searchable input + list (vehicle makes/models, phone brands); free text allowed (`allowOther:true` ⇒ stores typed text and offers "add to list" to admins) | string |
| `checkbox`, `yesno` | checkbox / two-button segmented | bool / `'yes'|'no'|''` |
| `chips` | multi-select chips (`accessories`) | string[] |
| `photo` | camera/file button + thumbnails, via `svcPhotoAdd` (B3) | `[{id,kind,at}]` (media ids) |
| `widget` | see widget registry | widget-specific |

**Widget registry** (so B2/B3 agents add rich controls without touching `svc-form`):
```js
svcRegisterWidget(name, { render(field, mount, api), read(mount) , setValue?(mount, v), validate?(v, ctx)->errors, summary?(v, ctx)->html }, { priority:0 })
// api = { get(fieldId), set(fieldId,v), job, template, mode, emit(), rerender(), can(perm) }
// Highest priority wins => B1 ships simple fallbacks (priority 0); B3 overrides 'services','materials','quote','payment','valuables','condition','photos' with priority 10.
```
**Renderer/validator API (B1-F; signatures are contracts)**
```js
svcRenderForm(mountEl, template, opts) -> handle
   opts = { mode:'create'|'edit'|'quick', values:{}, ctx:{ job?, asset?, customer?, cfg }, onChange(handle), onSubmit(values) }
   handle = { getValues()->flat {fieldId:value}, setValue(id,v), validate()->{ok, errors:[{id,msg,level}]}, focusFirstError(), destroy(), el }
svcVisibleFields(template, values, mode)  -> Field[]      // PURE; mode 'quick' uses template.quick; evaluates visibleWhen
svcValidate(template, values, {mode, cfg, existingJobs?}) -> { ok:boolean, errors:[{id,msg,level}], visible:string[] }   // PURE; validates ONLY visible fields (MP §30)
svcSplitValues(template, values) -> { customer:{name,phone,altPhone,email,notes}, asset:{kind,attrs}, job:{…top-level job fields}, data:{…} }   // PURE; by storesIn
svcRenderJobSummary(job, template, opts) -> html          // read-only rendering from the same schema; unknown keys under "Other details"
```
Tests (B1-F): for every template × mode, `svcVisibleFields` never returns a field whose id belongs to another asset kind (vehicle fields absent for salon/phone, etc. — assert by id-prefix sets `veh_*`, `dev_*`, `cond_*`, `val_*`); `svcValidate` with empty values returns only that type's required fields; DOM: after `svcRenderForm` into jsdom, `mount.querySelectorAll('[data-fid]')` ids ⊆ visible ids.

### 2.4 Custom fields (MP §35)

Stored in `svcConfig` record `cfg-customFields`: `value.fields = [{ id:'cf_fuel_level', label:'Fuel level', type:'dropdown'|'text'|'number'|'date'|'checkbox'|'yesno'|'longtext'|'photo', options:[…], required:false, serviceTypes:['car_wash'], section:'extra', order:10, active:true, createdAt, createdBy }]`.
`svcGetTemplate` appends, per type, a final section `{id:'extra', title:'Extra details', fields:[…]}` built from the active fields whose `serviceTypes` includes the type (empty ⇒ not offered anywhere). Values land in `job.data['cf_fuel_level']`. **Deactivating** a custom field hides it from new forms but existing jobs still render it (R3: unknown key ⇒ "Other details" with the stored label from `svcConfig` if present, else prettified id). Ids are slugs generated once, never re-used.

### 2.5 Generic behaviours provided by the engine (not by templates)

| Behaviour | Function (owner) | Notes |
|---|---|---|
| Status machine | `svcAllowedNext(job)`, `svcCanEnter(job, statusKey)->{ok, why}` (B1-D) | evaluates `requires`, permissions (`svc:status`), backwards moves |
| Totals | `svcTotals(job)` (B1-A, pure, **final contract** §3.6) | used by lists/board/reports/pay/quote |
| Queue grouping | `svcQueueGroups(typeKey, jobs, now)` (B2-Q) | counts: total/remaining/waiting/assigned/in_progress/awaiting_approval/awaiting_parts/ready/completed/cancelled/no_show |
| Terminology | `svcTerm(typeKey,key)`, `svcApplyTerms(root)` | `data-svc-term` attributes + tab labels (`svcApplyTabLabels()`) |
| Notifications | `svcNotifyBuild(job, eventKey, channel)` (B3-N) | templates from template defaults overridden by `svcConfig` |
| Asset rules | `svcAssetKey(kind, attrs)` | plate normalised upper, no spaces/dashes; phones = IMEI 15 digits else `serial`; else no key (random id) |

### 2.6 Three tiny inert hooks in shared code (B1-S integrator; safe for all apps)

1. `src/shared/functions.js reportsGenerate`: after the `builders` map is built add `if (window.reportExtraBuilders) Object.assign(builders, window.reportExtraBuilders);` and let the `noRange` list also honour `window.reportNoRange` (array). Other apps never define these ⇒ no-op. (`sales-journal.html` wraps `reportsGenerate`; keep it working: it only reads `kind`.)
2. `src/shared/functions.js slimPayloadForPush`: extend the `MERGED` set and `LOG_FIELDS`/`CAP` — see §3.4. (These names are simply absent from other apps' payloads.)
3. Nothing else in `functions.js`. All other integration is via guarded calls placed in module-local code of `services/index.html` (`typeof svcX === 'function' && svcX(…)`), the same pattern the file already uses for `extraSettingsCollect`.

### 2.7 The ten templates (contract for B1-A; ids are the R4 golden list)

Shared building blocks (defined once in `svc-templates`, referenced by each type):

* **S_CUSTOMER** (storesIn `customer`; labels vary by type): `cust_name` text *required*, `cust_phone` phone *required* (`quickOff`), `cust_alt_phone` phone, `cust_email` email, `cust_notes` longtext. Quick mode for salon/car wash: name + phone optional (MP §28 "quick creation must not require unnecessary information").
* **S_SERVICES** (widget `services`, required ≥1 for car_wash/salon/barber/laundry/cleaning/tailoring; optional for repairs).
* **S_STAFF** (widget `staff`; `staffAssignment` from template), **S_MATERIALS** (widget `materials`), **S_QUOTE** (widget `quote`), **S_PAYMENT** (widget `payment`: deposit amount, method, M-Pesa/bank ref), **S_STATUS** (`status` dropdown in create = initial statuses only).
* `phase:'both'` sections show in the New Service form (collapsed "Add later" when not required) **and** in the job drawer **Work** tab — so MP §44–§47 "verify Diagnosis/Parts/Quote/Payment exist in the form" holds while staying usable on a phone.

| Type | Asset kind | Sections → field ids (★ required) |
|---|---|---|
| **phone_repair** (prefix `PR`) | `phone` | **Customer**: `cust_name`★ `cust_phone`★ `cust_alt_phone` `cust_email` `cust_notes`. **Device** (asset): `dev_type`★ dropdown(Phone, Tablet, Laptop, Smartwatch, Other) · `dev_brand`★ combo(`phoneBrands`: Samsung, Apple, Tecno, Infinix, Itel, Xiaomi, Oppo, Vivo, Huawei, Nokia, Realme, Google, OnePlus, Other) · `dev_model`★ · `dev_imei` (`visibleWhen dev_type∈phone,tablet`, validate `imei`, level warn) · `dev_imei2` · `dev_serial` · `dev_color` · `dev_condition` longtext · `dev_accessories` chips(Charger, SIM, SD card, Case, Battery) · `dev_passcode` (sensitive, optional). **Problem**: `rep_problem`★ longtext. **Diagnosis** (phase both): `rep_diagnosis` · `rep_recommended`. **Repair**: `services` widget · `parts` = widget `materials` (required parts vs used) · `rep_labour` money · `rep_tech` staff(role `technician`). **Quote**: `quote` widget (estimate → quote → approval → revised charges → discount). **Payment**: `payment` widget. **Status**: `status`. |
| **car_wash** (`CW`) | `vehicle` | **Customer/Owner** (labels "Owner name") · **Vehicle**: `veh_plate`★ plate · `veh_make`★ combo(`vehicleMakes`) · `veh_model`★ combo(`vehicleModels:veh_make`) · `veh_type`★ dropdown(`vehicleTypes`: Sedan, Hatchback, SUV, Crossover, Pickup, Van, Minibus, Bus, Truck, Motorcycle, Other) · `veh_color` · `veh_year` · `veh_odometer` · `veh_notes`. **Services**: `services`★. **Vehicle condition**: `cond_scratches` `cond_dents` `cond_damage` `cond_broken` `cond_other` (text) · `cond_photos` photo(multi). **Valuables / items left in vehicle**: `valuables` widget (+ `val_ack` checkbox, required when ≥1 item and `disclaimer.requireAck`). **Staff**: `staff` (multi, per-task). **Products used**: `materials`. **Quote**, **Payment**, **Status**. |
| **garage** (`GR`) | `vehicle` | Customer/Owner · Vehicle (same ids as car_wash, `veh_*`) · **Complaint**: `cmp_problem`★ · `cmp_symptoms` · `cmp_notes` · **Diagnosis**: `dx_diagnosis` · `dx_inspection` · `dx_recommended` · **Repair**: `services` · `parts`(materials, chargeable) · `rep_labour` · `mechanic` staff(role `mechanic`) · additional charges (via quote widget) · **Quote** (+ approval, additional work, revised quote) · **Payment** · **Status**. |
| **salon** (`SL`) | `none` (client only) | **Client** (labels "Client name") · **Appointment / Walk-in**: `appt_mode` dropdown(`walk_in`,`booking`) · `appt_date`★ & `appt_time`★ (`visibleWhen appt_mode=booking`) · `appt_staff` (staff filtered by `role` of chosen services) · `appt_notes` · `appt_special` · `appt_deposit` (money; feeds payment widget) · **Services**: `services`★ · **Staff**: `staff` (multi) · **Products used**: `materials` · **Quote** · **Payment** (deposit) · **Status**. No `veh_*`, `dev_*`. |
| **barber** (`BB`) | `none` | as salon minus products by default (`inventory.mode:'optional'`), specialty `barber`, walk-in first (`quick`), statuses without `booked` emphasis. |
| **laundry** (`LD`) | `garment` | Customer · **Items**: `ld_tag` (auto ticket no.) · `ld_items` (repeater count by kind) or `ld_weight` number(kg) · `ld_express` yesno · `ld_notes` (stains, damage) · Services (wash/iron/dry-clean…) · Payment · Status: `received → sorting → washing → drying → ironing → ready → collected`, `cancelled`. |
| **cleaning** (`CN`) | `none` | Customer · **Site**: `site_address`★ · `site_type` dropdown(Home, Office, Shop, Event…) · `site_area` number · `site_rooms` number · `site_access` longtext · **Schedule**: `sched_date`★ `sched_time`★ `sched_duration` (appointment `mode:'primary'`) · Services · Staff (crew, multi) · Supplies(materials) · Quote (quote often required) · Payment · Status: `booked → scheduled → on_the_way → in_progress → completed`, `cancelled`, `no_show`. |
| **electronics_repair** (`ER`) | `equipment` | as phone_repair but asset ids `eq_type` (TV, Laptop, Fridge, Printer, Other), `eq_brand`, `eq_model`, `eq_serial`, `eq_condition`, `eq_accessories`; IMEI absent. |
| **tailoring** (`TL`) | `garment` | Customer · **Garment**: `tl_item` dropdown · `tl_fabric` · `tl_color` · `tl_measurements` (key/value repeater: chest, waist, length …) · `tl_fitting_date` date · `tl_due_date`★ · Services (alterations/new) · Materials (fabric/thread) · Quote · Payment (deposit normal) · Status: `received → measured → cutting → stitching → fitting → alteration → ready → collected`, `cancelled`. |
| **other** (`SV`) | `none` | Customer · **Service details**: `oth_item` (what was left / what is needed) · `oth_details` longtext · Services · Staff · Materials · Quote · Payment · Status: `received → in_progress → ready → completed`, `cancelled`. This is also the generic fallback for unknown types. |

**Statuses, groups, terminology, dashboards of the four headline types** (key → label; `*` = terminal; groups drive queue and dashboard):

| Type | Statuses (initial → …) | Queue groups (MP §14/25) | Dashboard cards (MP §26) | Staff label | Buttons |
|---|---|---|---|---|---|
| phone_repair | `received`, `diagnosing`, `awaiting_approval`, `awaiting_parts`, `in_progress`, `ready`, `completed*`, `collected*`, `cancelled*` | Received · Diagnosing · Approval · Parts · In repair · Ready · Done | Devices received · Diagnosing · Awaiting parts · In progress · Ready for collection (+ Jobs due, Outstanding) | Technician | `+ New Repair` |
| car_wash | `waiting`, `in_progress`, `ready`, `completed*`, `cancelled*` (`assigned` is derived: waiting + has jobStaff) | Waiting · In Progress · Ready · Completed; counters Total, Remaining, Waiting, Assigned, In Progress, Awaiting Approval, Awaiting Parts, Ready, Completed, Cancelled (only those with ≥1 status in the template are shown) | Vehicles remaining · Waiting · In progress · Ready · Completed · Today's jobs · Revenue · Current queue | Assigned Staff | `+ New Vehicle Job` |
| garage | `received`, `inspection`, `diagnosing`, `awaiting_approval`, `awaiting_parts`, `in_progress`, `ready`, `completed*`, `cancelled*` | Received · Inspection/Diagnosing · Approval · Parts · In progress · Ready · Completed | Vehicles received · Diagnosing · Awaiting approval · Awaiting parts · In progress · Ready | Mechanic | `+ New Repair Job` |
| salon | job: `checked_in`, `waiting`, `in_progress`, `completed*`, `cancelled*`; appointment-scope: `booked` ("Booking"), `confirmed`, `no_show*` | Waiting (checked_in+waiting) · Being served · Completed; counters: Remaining, Waiting, In Progress, Completed, Cancelled, No Show (from appointments) | Upcoming appointments · Walk-ins today · Waiting clients · In progress · Completed · No shows · Available staff | Stylist | `+ Walk-In` (and `+ Booking`) |

Status `phase` values (for server merge rank + archive; engine-wide): `0` waiting/intake · `1` working (incl. diagnosing, parts, approval) · `2` ready · `3` closed-success · `4` closed-other (cancelled/no-show). `closedAt` is set on entering phase ≥3.

**Default notification templates** (variables `{customer} {first_name} {asset} {plate} {job_no} {business} {amount} {balance} {paid} {service} {staff} {ready_time} {date} {time}`; `{plate}` = vehicle plate, `{asset}` = device model / vehicle make-model-plate / garment): per type, events `received`, `ready` (MP §33 exact sample wording for vehicles), `approval_needed`, `balance_due`, `appointment_confirmed`, `appointment_reminder`, `completed_thanks`. Defaults live in `svc-templates`; shop overrides in `svcConfig` `cfg-notify`.

**Vehicle reference data** (`svc-templates`): ~40 makes with models for the Kenyan market (Toyota: Premio, Allion, Axio, Fielder, Vitz, Probox, Harrier, Prado, Land Cruiser, Hilux, Noah, Voxy, Corolla, Rav4, Passo, Mark X, Wish, Sienta…; Nissan: Note, X-Trail, Juke, March, Tiida, Wingroad, Navara, Serena, Sylphy; Subaru: Forester, Impreza, Legacy, Outback, XV; Mazda: Demio, CX-5, Axela, Atenza; Honda: Fit, Vezel, CR-V, Civic, Freed; Mitsubishi: Outlander, Pajero, L200, Canter, RVR; Isuzu: D-Max, NPR, FRR, MU-X; Suzuki: Swift, Alto, Escudo, Jimny…; + Mercedes-Benz, BMW, VW, Ford, Hyundai, Kia, Peugeot, Land Rover, Lexus, Audi, Volvo, **Other**). Stored compactly as one string per make (`'Premio|Allion|…'`) and parsed on first use. Admin additions/hidden entries are `svcConfig` `cfg-vehicle` (`{makes:[{name, models:[…], hidden}], types:[…], hiddenMakes:[…]}`) — never mutate the built-in data. Vehicle types: the 11 in MP §8 (`sedan…other`) ; per-type price tiers via catalog `priceByAssetType` keyed by `veh_type`.

**Kenya/i18n (MP §34)**: `svcConfig` `cfg-business.value = { country:'KE', currency:'KES', currencyLabel:'KSh', dialCode:'254', phoneRule:'ke', plateRule:'ke' }`. Every validator reads the rule from config (`svcNormPhone(raw, cfg)`); non-`ke` rules fall back to generic E.164-ish (`^\+?\d{7,15}$`, level warn). Defaults applied only when config has no country.

---------------------------------------------------------------------------------------------------

## 3. DATA MODEL (synced shop state)

State reality check (verified in code): a shop's state is one JSON document (`collectSyncPayload()` ≈ `services/index.html` line ~25185; `applyRemotePayload(data)` ≈ 25265, which **replaces arrays wholesale** — note `serviceJobs = Array.isArray(data.serviceJobs) ? data.serviceJobs : []` would *empty* the list if a pull lacks the field; new lists must use guarded `if (Array.isArray(data.svcJobs))`). The server merges per record by `id` for every name in `MERGE_BY_ID_FIELDS` (`functions/api/_merge.js`; the per-shop SQLite Durable Object `wildcard-router/shop-store.js` iterates the same constant, so **one constant edit covers both backends**). Everything else is whole-value with `_fieldTimes` (last writer wins per field) — that is what legacy `serviceJobs` and `bookings` use today.

### 3.1 The five lists

| List (state field) | localStorage key | Record key | Server merge | Delta push (`slimPayloadForPush`) | Archive | Size class |
|---|---|---|---|---|---|---|
| `svcJobs` | `pos_svc_jobs` | `id` = `sj-<genSaleId()>` (promoted legacy: `sj-lg-<legacyId>`) | `MERGE_BY_ID_FIELDS` + `FINAL_TOMBSTONE_FIELDS` + `NESTED_MERGE.svcJobs` (§3.5) | **yes** — add to `LOG_FIELDS`, `CAP.svcJobs = 120` | **yes** — add to `ARCHIVE_LOG_FIELDS` (server), `FIELDS`/`ARR` (client `storage-and-photos`), `window.__LOG_KEYS`; open jobs (`closedAt == null`) never archived | hot: ≤ 1.5 KB typical closed job, hard cap 8 KB |
| `svcAssets` | `pos_svc_assets` | deterministic `sa-<kind>-<key>` when a unique key exists (plate / IMEI), else `sa-<genSaleId()>` | `MERGE_BY_ID_FIELDS` (+ `NESTED_MERGE.svcAssets` arrays `['history']` union by `jobId`/`id`) | no (small) | no | ≤ 4 KB each (history ring of 30) |
| `svcCatalog` | `pos_svc_catalog` | `sc-<genSaleId()>`; seeds `sc-seed-<type>-<slug>` | `MERGE_BY_ID_FIELDS` + `FINAL_TOMBSTONE_FIELDS` | no | no | ≤ 1 KB × ~100 |
| `svcAppointments` | `pos_svc_appts` | `sp-<genSaleId()>` | `MERGE_BY_ID_FIELDS` + `FINAL_TOMBSTONE_FIELDS` | yes (`CAP 150`) | yes, open = `closedAt == null` | ≤ 1 KB |
| `svcConfig` | `pos_svc_config` | **deterministic** `cfg-<kind>[-<type>]` (two tills creating the same config converge) | `MERGE_BY_ID_FIELDS` (per-record newest wins) | no | no | one record per kind, ≤ 20 KB (vehicle lists) |

Why `svcConfig` is a *list of records* and not one object: settings objects sync as whole values (`_fieldTimes`), so two admins editing different pages would clobber each other; per-record merge confines a conflict to one config kind. It also avoids touching the single `extraSettingsCollect/Apply` hook that `receipt-extras.html` already owns.

Not new lists: customers (existing `customers[]`), staff (existing `staff[]`, extended with optional fields `svcSpecialties:[]` and roles strings `svc:*`), inventory, salesLog, bills, stockMovementLog — all reused.

### 3.2 `svcJobs` record (new jobs only; every field beyond the first block is optional for readers — R6)

```js
{
  // identity & immutables
  id:'sj-1759230000000-ab12cd34ef', no:'CW-250930-T3-014', serviceType:'car_wash', templateVersion:1,      // serviceType/templateVersion NEVER change (MP §41)
  createdAt, createdBy:{id,name}, till:3|null, device:'<deviceId>', source:'walkin'|'appointment'|'quick'|'promoted',
  updatedAt, rev:N,                                    // updatedAt stamped by svcCommit; rev increments per commit (debug + tie-break)
  // workflow
  status:'in_progress', statusAt, statusHistory:[{id,s,at,by,byId,note?}],                     // append-only; `status` is a cache: svcHealJob() re-derives it from the newest history entry
  phase:1, closedAt:null, startedAt?, readyAt?, completedAt?, collectedAt?, dueAt?, appointmentId?, legacyId?,
  // who / what
  customer:{ id:'cu-<phoneKey>'|null, name, phone:'0712345678', phoneKey:'712345678', altPhone?, email? },
  assetId:'sa-vehicle-KDA123A'|null, assetSnap:{ kind:'vehicle', label:'Toyota Premio KDA 123A', plate:'KDA123A', make, model, type },   // display/search snapshot — survives asset edits/deletes
  data:{ veh_notes:'…', cond_scratches:'…', cf_fuel_level:'1/2', … },                          // type-specific form values (ids from the template). No photos bytes, only ids.
  jobServices:[{id, catalogId|null, name, category, qty:1, price:1500, durationMin:30, source:'base'|'additional', staffIds:[], done:false, doneAt?, doneBy?, note?}],
  jobStaff:[{id, staffId, name, roleKey, task:'Exterior', lineId?, assignedAt, assignedBy, startedAt?, doneAt?, removedAt?, rev}],
  materials:[{id, code|null, name, qty, unit, cost, price, chargeable:false, lineId?, staffId?, at, by, movementIds:[…], reversedAt?, reversedBy?, rev}],   // inventory usage traceable to this job
  valuables:[{id, kind, desc, qty, notes, photoId?, at, by}],    // MP §12  + data.val_ack:{at,by,text} (disclaimer wording snapshot)
  photos:[{id, kind:'condition'|'valuable'|'before'|'after'|'other', at, by, bytes}],          // media ids only (D10)
  // money (append-only; void via voidedAt)
  quoteVersions:[{id, v, at, by, lines:[{id,kind:'service'|'labour'|'part'|'charge'|'discount', name, qty, price, refId?}], subtotal, discount, tax, total, note, validUntil?}],
  quoteLog:[{id, at, by, act:'draft'|'send'|'await'|'approve'|'reject'|'expire'|'revise', v, amount?, via?, approvedBy?, method?, note?}],   // quote state = DERIVED from the newest entry (svcQuoteState)
  charges:[{id, kind:'additional'|'labour'|'fee'|'discount', label, amount, reason, at, by, quoteV?, approved:true|false|null, voidedAt?, voidedBy?, rev}],
  payments:[{id, at, amount, method:'cash'|'mpesa'|'card'|'bank'|'split'|'other', ref, by, kind:'deposit'|'partial'|'balance', billPayId?, saleId?, voidedAt?}],
  billId:null|'<bill id>', saleIds:[…],                 // link to the Bills machinery (D9); cash/M-Pesa split detail lives in salesLog lines
  discount:{amount, reason, by, at}|null,
  // comms & audit
  notify:[{id, at, by, channel:'whatsapp'|'sms'|'email'|'print', event:'ready', toKey, preview:'first 80 chars', state:'opened'|'sent'|'failed'}],   // ring of 12
  audit:[{id, at, by, byId, act, ref?, from?, to?, note?}],                                   // ring of 60; acts: created, edited, assigned, status, quote.*, charge.add, charge.void, material.use, material.reverse, payment, cancel, notify
  notes?:string, tags?:string[], _deleted?:true
}
```
**Derived, never stored as truth** (`svcDerive(job)` recomputes on read; `totals`/`pay` may be cached as `job._t` but are ignored by merge and rebuilt at load): `status` (from history), quote state, `totals`, `paid`, `balance`, `paymentStatus`, `assigned`.

### 3.3 Other records

```js
svcAssets  { id, kind:'vehicle'|'phone'|'equipment'|'garment', key:'KDA123A'|'356789012345678'|null,
             label, attrs:{ plate, make, model, type, color, year, odometer, imei, imei2, serial, brand, … },
             ownerKey:'712345678', ownerName, ownerPhone, ownerHistory:[{key,name,phone,from}], notes,
             createdAt, updatedAt, lastJobAt, jobCount,
             history:[{id:jobId, no, at, serviceType, services:'Full Wash, Vacuum', total, paid, status}] /* ring 30 — keeps "previous visits" after jobs are archived */ }
svcCatalog { id, name, category, description, price, priceMode:'fixed'|'from'|'variable', priceByAssetType:{sedan:1200,suv:1800}|null, durationMin,
             serviceTypes:['car_wash']|[] /* [] = offered in every type */, staffRole:''|'loctician',
             consumption:[{code, name, unit, qty}],            /* inventory items consumed, default quantities (MP §21/§22) */
             invCode:''|'<inventory service code>', active:true, sort, createdAt, updatedAt, createdBy, _deleted? }
svcAppointments { id, serviceType, no?, customer:{id,name,phone,email}, assetId?, assetSnap?, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', startAt, endAt (ms, Kenya business day),
             durationMin, services:[{catalogId,name,price,durationMin}], staffIds:[…], status:'booked'|'confirmed'|'checked_in'|'completed'|'cancelled'|'no_show',
             deposit:{amount, method, ref, at, by, billId?}|null, notes, special, createdAt, createdBy, updatedAt, closedAt, jobId?, legacyBookingId?, log:[{at,by,act,from?,to?}] ring 20, _deleted? }
svcConfig  records: cfg-business  {businessType, enabledTypes:[…], legacyType, chosen:bool, chosenAt, chosenBy, source:'signup'|'settings'|'owner-link'|'default', uiMode:'engine'|'classic',
                                   country, currency, currencyLabel, dialCode, phoneRule, plateRule, taxMode:'none'|'inclusive'|'exclusive', taxRate, numbering:{prefixOverrides:{}} , bannerDismissedAt}
                   cfg-statuses-<type>   {labels:{key:label}, hidden:[keys], custom:[{key:'x_…', label, color, group, after}]}
                   cfg-roles             {specialties:[{key,label,types:[…]}]}                    // adds to template staffRoles
                   cfg-notify            {templates:{ '<type>.<event>.<channel>': text }, autoSms:false, autoEmail:false, autoWhatsapp:false /* never; wa.me only */}
                   cfg-vehicle           {makes:[{name,models:[…],hidden}], types:[{v,l,hidden}], hiddenMakes:[…]}
                   cfg-customFields      {fields:[…]} (§2.4)
                   cfg-disclaimer        {valuables:'text', requireAck:true, carWashWaiver:'…'}
                   cfg-quote             {perType:{garage:{requireApproval:true, approvalThreshold:0, validityDays:7}}}
                   cfg-seed              {seeded:{car_wash:true}}  // catalog seeded once per type
             each: { id:'cfg-business', kind:'business', type?:'car_wash', value:{…}, updatedAt, updatedBy, log:[{at,by,what}] ring 30 }
staff[] (existing) + optional  svcSpecialties:['stylist','braider'], roles gets strings 'svc:create' …   (see §6.4)
customers[] (existing) — engine creates {id:'cu-<phoneKey>', name, phone, tokens:0, createdAt} via svcEnsureCustomer; never edits legacy customers except filling a blank name (same rule as registerOrUpdateCustomer)
```

### 3.4 Exact sync registration (B1-S integrator; all edits are additive)

| # | File / symbol | Edit |
|---|---|---|
| 1 | `functions/api/_merge.js` `MERGE_BY_ID_FIELDS` | append `'svcJobs','svcAssets','svcCatalog','svcAppointments','svcConfig'` |
| 2 | `functions/api/_merge.js` `FINAL_TOMBSTONE_FIELDS` | append `'svcJobs','svcAppointments','svcCatalog'` (unique ids never re-created; a deleted record stays deleted even if a stale till touches it) |
| 3 | `functions/api/_merge.js` `NESTED_MERGE` | add `svcJobs` and `svcAssets` (spec below); `mergeNestedRecord` gets an optional `rankBy:'phase'` (rank from a numeric field instead of `spec.status[r.status]`) |
| 4 | `functions/api/_state-store.js` `ARCHIVE_LOG_FIELDS`, `isOpenRecord` | add `svcJobs`, `svcAppointments`; open = `!r._deleted && r.closedAt == null` (**server and the client copy in `storage-and-photos.html isOpen` must agree**). `recordTime` already reads `createdAt`. |
| 5 | `src/shared/functions.js slimPayloadForPush` | `MERGED` set += the five names; `LOG_FIELDS` += `'svcJobs','svcAppointments'`; `CAP` += `svcJobs:120, svcAppointments:150` |
| 6 | `src/shared/blocks/storage-and-photos.html` | `FIELDS` += `svcJobs, svcAppointments`; `ARR` += accessors `typeof svcJobs === 'undefined' ? null : svcJobs`; `isOpen(f,r)` += same rule as #4 |
| 7 | `services/index.html` inline `window.__LOG_KEYS` | add `"svcJobs":"pos_svc_jobs","svcAppointments":"pos_svc_appts"` |
| 8 | `services/index.html collectSyncPayload()` | add `...(typeof svcSyncCollect === 'function' ? svcSyncCollect() : {})` before `updatedAt` (same pattern as `extraSettingsCollect`) |
| 9 | `services/index.html applyRemotePayload(data)` | add `if (typeof svcSyncApply === 'function') svcSyncApply(data);` — implementation replaces each list **only when `Array.isArray(data.<name>)`**, relies on the pull-after-flush guarantee (§3.10), re-derives, persists, re-renders open svc screens |
| 10 | `services/index.html ensureExtraSyncedFieldsInitialized()` | **do NOT** `registerSyncedField` `svcJobs`/`svcAppointments`: `extraRecSig` = `JSON.stringify` of every record at every push (O(total bytes)). The engine stamps `updatedAt` itself in `svcCommit`. `svcAssets/svcCatalog/svcConfig` *may* be registered (small) as a belt-and-braces stamp. |
| 11 | `tests` | `tests/svc-sync.test.mjs` (two devices via `tests/e2e-harness.mjs makeServer/openDevice`) — §8 |

`NESTED_MERGE` additions (server, B1-S):
```js
svcJobs:   { arrays:['statusHistory','charges','materials','payments','audit','notify','jobStaff','valuables','photos','quoteVersions','quoteLog'],
             status:{}, rankBy:'phase',
             better:(a,b)=> ((b&&b.rev)||0) > ((a&&a.rev)||0) ? b : (b&&b.voidedAt&&!(a&&a.voidedAt) ? b : a) },   // in-place edits of an element (void, reverse) carry a higher per-element `rev`
svcAssets: { arrays:['history','ownerHistory'], status:{}, better:(a,b)=> ((b&&b.at)||0) > ((a&&a.at)||0) ? b : a }
```
Effect: two tills that add a charge / material / payment / status entry to the same job at the same time **both survive**; a job already closed (`phase` 3/4) is never put back to open by a stale copy; the scalar fields (`data`, customer, dueAt…) are newest-`updatedAt`-wins per record. **Known residual** (documented in §9): two people editing *different scalar fields* of the same job at the same instant → newest wins; `data` is whole-object.

### 3.5 Merge safety rules the engine must obey (tested)

1. Every mutation goes through `svcCommit(list, rec, {reason})` which sets `rec.updatedAt = Date.now()`, `rec.rev++`, persists (`safeSetItem`), calls `queuePush()`. Direct writes outside `svcCommit` are a bug (static test greps block sources for `svcJobs.push(` / assignments outside `svcCommit`/`svcLoad`/`svcSyncApply`).
2. Append-only arrays only grow; an element is changed in place only with `rev++` (and `voidedAt`/`reversedAt` markers, never splice). `svcCommit` asserts `nextArray.length >= prevArray.length` for the guarded arrays.
3. Element ids are minted with `genSaleId()` *at action time* (idempotent retry: the action takes the id from the caller, e.g. the form's `draftPaymentId`).
4. Deletion = `_deleted:true` tombstone with `updatedAt` (as `inventoryCategories` does). UI "Delete job" requires `svc:cancel` and a reason and is shown only for jobs with no payments and no material use; otherwise "Cancel" (status) is the only path.

### 3.6 `svcTotals(job)` — final pure contract (B1-A; B3 must not redefine)

```js
svcTotals(job) -> {
  servicesTotal,   // Σ jobServices (qty*price), source 'base' AND 'additional'
  materialsTotal,  // Σ materials where chargeable && !reversedAt (qty*price)
  labour,          // Σ charges kind 'labour' (!voided) + legacy laborFee when _legacy
  additional,      // Σ charges kind 'additional'|'fee' (!voided)   — recorded separately per MP §24
  discount,        // Σ charges kind 'discount' (!voided, stored positive) + job.discount.amount
  subtotal,        // servicesTotal + materialsTotal + labour + additional − discount
  tax,             // cfg taxMode 'exclusive': round2(subtotal*rate); otherwise 0 (inclusive prices contain tax)
  total,           // subtotal + tax   (never < 0)
  paid,            // Σ payments (!voided) — for promoted/legacy also bill.amountPaid if billId and payments empty
  balance,         // round2(max(0,total − paid))
  paymentStatus,   // 'unpaid'|'partial'|'paid'|'overpaid'
  approvedAmount,  // amount of the approved quote version or null
  lines: [...]     // flat printable/bill lines {kind,name,qty,price,amount}
}
```
Money is rounded with `round2`; all comparisons use 0.005 tolerance (same as `recomputeBillStatus`). Test vector from MP §23: Premium Wash 1500 + Interior 500 + Heavy-dirt charge 300 ⇒ `total 2300`.

### 3.7 Size / performance budget (SCALE_PLAN.md numbers: ~1.7 KB per sale+movement; server "Large" 4 MB, refused 12 MB; localStorage ~5 MB)

| Item | Typical | Hard cap / rule |
|---|---|---|
| New job (intake only) | ~0.9 KB | |
| Completed job (3 services, 4 status entries, 1–2 payments, 6 audit) | ~1.8 KB | cap **8 KB**: `svcCommit` trims `audit` to 60, `notify` to 12, truncates notes; photos are ids only |
| All-in cost of a finished car-wash visit (job + sale line + movements) | ~4 KB | 100 vehicles/day ⇒ ~400 KB/day ⇒ hits the server "Large" line in ~10 days **without archiving** ⇒ archiving `svcJobs` (row 4 above) is **mandatory in B1**, not an option |
| Asset history ring | 30 × ~140 B | keeps "previous visits" after a job is archived |
| `svcConfig` | few KB | vehicle lists ≤ 20 KB |
| Per-push CPU | `pushSigOf` hashes every record of each `LOG_FIELDS` list on every push (same as `salesLog`) | acceptable to ~10k records; `svcJobs` is windowed by archive; do **not** register it with `registerSyncedField` |
| Render | list/board must virtualise: render ≤ 60 cards/rows then "Show more"; queue board only loads **open** jobs + today's closed | |
| Memory indexes | `svcIdx` = `{byId, byPhone, byAsset, byNo, byDay}` built lazily, invalidated by array identity + `length + lastUpdated` sentinel; O(n) rebuild on sync only | |

### 3.8 Job numbers, ids, idempotency

* **Record id**: `'sj-' + genSaleId()` (`<Date.now()>-<10 random chars>`, collision-free across tills, already the app's convention). The New Service form mints `draftId` when it opens; `svcCreateJob` with an existing id returns the existing job (double-tap / retry safe).
* **Human number** `svcNextJobNo(typeKey)` → `PFX-yymmdd-T<till>-<seq3>` e.g. `CW-250930-T3-014`. `yymmdd` = Kenya business day (`bizDayKey(Date.now())`), `till` = `tillNumber()` (server-assigned 1–99); a device without a till number uses `D<last 3 of getOrCreateDeviceId()>` (mirrors `generateReceiptRef`'s `ref-D…` form). `seq` is a per-device per-day counter in `localStorage` `pos_svc_seq` = `{day, n}`. Two tills can never produce the same number by construction; `svcCreateJob` still checks local `byNo` and bumps `seq` on a clash. Legacy jobs display `J-` + last 6 chars of their id.
* **Idempotency table**: job create (`draftId`), payment (`payments[].id` = caller-minted; `svcRecordPayment` returns `{ok, duplicate:true}` when present), material use (`materials[].id`; movement ids derived `mv-<materialId>-<n>`), charge add (`charges[].id`), status change (same target status already current ⇒ no-op), notification open (log only).

### 3.9 Photos (condition, valuables, custom `photo` fields)

1. `svcPhotoAdd(jobId, kind, file)` → `compressImageToTarget(file,{maxW:1400,maxH:1400,maxBytes:300*1024})` (exists in the page) → SHA-256 → id `svc-<hex20>` (**same photo twice = same id = stored once**, the server answers `{existed:true}`).
2. Bytes go to IndexedDB `svc_photos` (`{id, jobId, dataUrl, tries}`) — *not* into any synced list, not localStorage. The job immediately gets `photos[{id,kind,at,by,bytes}]`; "still uploading" is simply *the id is present in the IDB queue on this device* (other devices see a placeholder until the bytes are on the server).
3. `svcPhotoFlush()` (online, every sync tick and after add) `POST /api/media {k:'ref', id, dataUrl}`; on `ok` delete the IDB row. **No server change**: `_media.js MEDIA_KINDS.ref` = private (paired device only), 1100 KB max, id regex `^[A-Za-z0-9_-]{6,80}$` (`svc-` + 20 hex = 24 chars ✓). Viewing: `GET /api/media?k=ref&id=` through `fetch` + `URL.createObjectURL` (as hotel's `hospViewReferenceImage`; `<img src>` cannot send the device headers).
4. If a new kind is ever wanted (per-job deletion, retention): `MEDIA_KINDS.svc = {label:'service photo', maxBytes:900*1024, private:true}` is a 1-line server change + `tests/…media…`; not needed for B1–B3.
5. Old WebView without IndexedDB: keep bytes in memory for the session + toast "photos upload when online; don't close the app" (documented limitation, §9).

### 3.10 Offline behaviour

Everything is local-first: all engine actions work offline (they only touch localStorage lists + `queuePush()`); photo upload, STK push, SMS-provider send and `/api/sms-config` need the network and degrade as above. **Pull safety is inherited, not re-invented:** `pullStateOnce()` refuses to apply a server copy while `hasUnsyncedWork()` (it flushes first: "changes made on this device but not yet acknowledged must reach the server BEFORE its copy is applied"), so `svcSyncApply` may replace each list wholesale like every other list — **provided `svcCommit` goes through `queuePush()`/`markLocalDirty()`** (test: create a job offline, pull a server copy lacking it, job survives). `svcHealJob` runs after every apply.

---------------------------------------------------------------------------------------------------

## 4. Mapping the existing phone-repair data/screens onto the engine (adapter, zero data loss)

### 4.1 Read path (B1-D, pure function in `svc-store`, tested with real legacy fixtures)

`svcAllJobs({types, includeLegacy:true})` = `svcJobs` (non-deleted) ∪ `svcLegacyToJob(l)` for every `serviceJobs` element **whose id is not the `legacyId` of a promoted `svcJobs` record**. The view object is shaped exactly like a `svcJobs` record plus `_legacy:true` (so every list/board/report/search/history/drawer renders it without special cases), but it is **frozen** (`Object.freeze` deep-ish) and every engine *write* function refuses `_legacy` jobs with `{ok:false, code:'legacy', action:'promote'}` — the UI then offers the legacy action or "Upgrade".

| Legacy field | View field | Rule |
|---|---|---|
| `id` | `id` (same), `no:'J-'+id.slice(-6)`, `legacyId:id`, `_legacy:true` | |
| `createdAt` (ISO) | `createdAt` (ms) | `Date.parse`; invalid ⇒ 0 |
| `serviceType` | `cfg-business.legacyType` (set once, default `phone_repair`, **never changed afterwards**) | so switching business type later does not re-label old jobs |
| `clientName`, `clientPhone` | `customer.name/phone/phoneKey` (`svcPhoneKey`) | no validation on read |
| `idNumber` | `data.leg_id_number` | shown under "Other details" |
| `itemDetails` | `data.leg_item_details` (full text) and `assetSnap.label` = first line (≤ 60 chars), `assetSnap.kind:'phone'` | IMEI/serial are **not** parsed into fields (R1: no invented data); the search index does a substring/regex scan of `itemDetails` for 15-digit runs so "search by IMEI" still finds legacy jobs (`svc-metrics`) |
| `servicesRequired[{code,name}]` | `jobServices[{id:'lg-'+code, catalogId:null, name, qty:1, price:0, source:'base'}]` | price 0 because the old model priced only at checkout |
| `serviceNotes` | `data.leg_notes` and `notes` | |
| `quoteAmount` | `quoteVersions:[{v:1,total:quoteAmount}]`, `quoteLog:[{act:'approve'}]` only if `finalAmount` present, else `act:'draft'` | display only |
| `promisedPickup` | `dueAt` (ms; accepts ISO or `datetime-local`) | |
| `status` | `pending→received`, `in_progress→in_progress`, `ready→ready`, `completed→completed`, `collected→collected` (template keys are a superset, R5) | `statusHistory:[{s:mapped, at:completedAt||createdAt}]` synthesised for display only |
| `components[{code,name,qty,price,unit}]` | `materials[{id:'lg-'+i+code, code,name,qty,unit,price,cost:0,chargeable:true}]` | |
| `laborFee`, `finalAmount` | `charges:[{kind:'labour',amount:laborFee}]`; `totals.total = finalAmount ?? quoteAmount ?? labour+components` | `svcTotals` special-cases `_legacy` so the legacy agreed-price override (`SERVICE-ADJUSTMENT`) is honoured |
| `billId`, `saleId` | `billId`, `saleIds` | `paid`/`balance` derived from `bills.find(id).amountPaid/paymentHistory` exactly like `renderClientRegistry` (`itemsTotal − amountPaid`); `saleId` ⇒ paid in full |
| `paymentMethod`, `completedAt` | `payments` synthesised single display entry / `completedAt` | |
| (absent) | `rev:0`, `updatedAt:0`, `audit:[]`, `jobStaff:[]`, `valuables:[]`, `photos:[]`, `charges` as above | every engine reader treats absent arrays as `[]` (R6) |

Legacy bookings → appointments view `svcLegacyBookingToAppt(b)`: `id:'BK-…'` kept, `customer`, `date/start/end` (+ `startAt/endAt` ms), `status` map `confirmed→confirmed`, `cancelled→cancelled`, `no-show→no_show`, `completed→completed`, `services:[{catalogId:null, name:inventory[b.serviceCode].name}]`, `staffIds:[b.staffId]`, `_legacy:true`. The appointment **clash check (`svcApptClashes`) always includes legacy bookings** so a salon that opts in never double-books against its existing calendar.

### 4.2 Write path for legacy rows (B1 = delegate, B3 = optional promotion)

* **B1**: legacy rows show in every engine list with the **old row actions**, routed by a tiny dispatcher `svcLegacyAction(jobId, action)` that calls the *existing* functions: status → `setJobStatusQuick`, edit → `openClientRegistryModal`, bill/checkout → `sendJobToServicesCounter`, notify → `openClientNotifyModal`, tag → `printIntakeTag`, remove → `deleteClientRegistryJob`. Nothing in the legacy path is modified.
* **B3 — Promotion** `svcPromoteLegacy(legacyId) -> {ok, job}`: creates `svcJobs` record id `sj-lg-<legacyId>` (**deterministic ⇒ two tills promoting at once converge**) with `serviceType = legacyType`, `templateVersion` current, `legacyId`, all mapped fields **copied** (materials/charges/billId/saleIds kept so money links survive), then sets the optional marker `promotedTo` on the legacy row via the existing save path. The view rule "hide legacy rows whose id is some `svcJobs.legacyId`" makes a lost marker harmless. Offered automatically when staff pick a status that does not exist in the legacy vocabulary (e.g. `awaiting_parts`) or use engine-only features (diagnosis, staff assignment, quote approval) on a legacy job. Promotion is *never automatic* and never bulk.
* `completeServiceJob()` (classic checkout) stays as is. For promoted jobs the engine checkout (§6.3) is used; `resolveJobBillStatuses()` ignores promoted legacy rows (already true: it iterates `serviceJobs`, and a promoted job's bill link lives on the new record — **the legacy row keeps its own `billId` untouched** so the old screen still shows consistent data).

### 4.3 Screens

| Existing | After B1 (engine mode) | Classic mode |
|---|---|---|
| `#services-counter-tab` (id kept) | New `<div id="svc-root">` inserted at the top: header (terminology-aware), search, **+ New …** button, segmented tabs *Board · List · Appointments (if template supports) · Reports*. The old `.pos-grid` is wrapped in `<div id="svc-classic-wrap">` and offered as a collapsed **"Classic counter / quick checkout"** panel (still the only checkout for legacy rows until promotion). | untouched; plus the choose-type banner |
| `#client-registry-tab` | Same list component in **history mode** (All types default) — legacy + engine rows, filters status/type/date/staff, row click → job drawer | untouched |
| `#bookings-tab` | For appointment-enabled types: day/week/list calendar (`svc-appts`) including legacy bookings; otherwise unchanged | untouched |
| Intake Tag print, notify modal, due bell | still used for legacy rows; engine jobs get their own print/notify (B3) and join `getDueServiceJobs()` via `svcDueJobs()` (seam) | untouched |

### 4.4 Business-type switching keeps history intact (MP §41, §48)

* `job.serviceType` immutable; `svcSetBusinessType(newType)` only writes `cfg-business` (`businessType`, `chosen:true`, log entry). No job/asset/appointment is touched.
* Lists default to **Current type**; a header filter chip row `Current type ▾ | All types | <each type that has jobs>` (counts shown). The board/dashboard/queue show the current type's jobs only (open jobs of *other* types show in a slim banner "3 open jobs from Car Wash — view") so nothing silently disappears.
* Forms: `svcOpenNewJob(typeKey?)` uses the current type; editing an old job renders **its own type's template** (`svcGetTemplate(job.serviceType)`), so a Phone Repair job opened while the shop is "Salon" still shows device fields and nothing else.
* Reports: each builder takes `opts.types` (default current; "All types" = union; revenue always from `salesLog` lines tagged `svcJobId`, so it is type-agnostic and complete).
* Dropdown of status keys for a job uses *its* type's statuses. Terminology (`svcTerm`) resolves against the **viewed job's type** when a job is in focus, otherwise the current type.
* Multi-type shops (extension, B2 stretch): `cfg-business.enabledTypes` (default `[businessType]`); New button shows a type chooser when `length>1`.

---------------------------------------------------------------------------------------------------

## 5. Business type at sign-up, in Settings, and defaults for existing shops (MP §5)

### 5.1 Where the question goes (all exact anchors)

| Place | Change | Owner |
|---|---|---|
| **In-app sign-up** `#auth-signup-box` (after `#signup-biz-name`) | Add `<label>What type of business do you operate?</label><select id="signup-biz-type">` (10 options from `SVC_TYPE_ORDER`, default `other`, filled by `svcFillTypeSelect('signup-biz-type')` at DOMContentLoaded; a static `<option value="other">Other</option>` fallback stays in the HTML so the screen works if JS fails). `submitDirectSignup()` reads it into `window.__svcSignupType` (client-side only — the `/api/demo-account register` body is **not** changed). `finishDirectAuth(name,password)` calls `typeof svcApplySignupType === 'function' && svcApplySignupType()` **before** its `await pushNowOrWarn('Setup')` so the choice rides the first push. | B1-U (markup + 2-line seams by B1-S) |
| **Fresh device of an existing shop** | `svcConfig` arrives by sync. If it has no `cfg-business` *and* this device is the owner (`currentServer == null`): first-run chooser modal (non-blocking, dismissible). Staff never see it. | B1-U |
| **Settings → 🔧 Services → Business Type** | New settings sub-tab `data-section="settings-section-services"` (button inserted after *Attendance Roster* in `#settings-subnav`; content `<div class="settings-section-content" id="settings-section-services">`). First page = Business Type: radio cards for the 10 types (+ "Also offer" checkboxes = `enabledTypes`), current type badge, explanation "Existing jobs keep the type they were created with", confirm dialog, then `svcSetBusinessType`. Add the section id to `ADMIN_GRANTABLE_SETTINGS_SECTIONS` (`{id:'settings-section-services', label:'🔧 Services'}`) so a Secondary Admin can be granted it (= permission `svc:manageConfig`). | B1-U (page) / B1-S (seam) |
| **Owner console / licence (optional, B2)** | `functions/api/owner-clients.js` POST accepts `svcType`; `_license.js createClient(…, extra)` stores `record.svcType`; `license-status.js` echoes `svcType`; the app's licence poll reads it and, **only if `cfg-business` is absent**, offers it as the pre-selected option (`source:'owner-link'`). `owner/index.html` link-generation UI gets a select when product = services. Purely a convenience; nothing depends on it. | B2 (server+owner) |
| **Public-site demo** (`public-site/app.html` has a `services` product blurb) | Out of scope for B1–B3; same optional `svcType` passthrough as above. | later |

### 5.2 `svcSetBusinessType(typeKey, {source, alsoOffer})` (contract, B1-D)

Validates key ∈ `SVC_TYPES`; requires `svc:manageConfig` (owner always); writes `cfg-business` via `svcCommit('svcConfig', …)` with `{businessType, enabledTypes, chosen:true, chosenAt, chosenBy, source, uiMode:'engine'}`; appends a `log` entry; `legacyType` is **not** set here: it is fixed once at `svcBoot()` per §5.3 and never changes; seeds the catalog for the type (`svcSeedCatalog`, once per type, deterministic ids); emits `config:changed`; re-applies terminology (`svcApplyTerms`, `svcApplyTabLabels`), re-renders the open screen. **Does not reload the page, does not touch any job.**

### 5.3 Defaults for existing shops — decision and justification

| Shop state at first load of the new release | `legacyType` | Effective type (`svcBusinessType()`) | UI |
|---|---|---|---|
| has `serviceJobs` (any) | `phone_repair` (the module's documented purpose: *"Check in a client's job… model, serial/IMEI, condition"*; MP §6 says the existing module is phone repair) | `phone_repair` | **classic** + banner "Services now adapts to your business — choose your type" (owner only, dismissible, re-offered after 7 days until chosen) |
| no jobs, has bookings and/or `type:'service'` inventory items | `other` | `other` | classic + banner |
| nothing at all (fresh, came via sign-up) | `other` | what they chose at sign-up (`chosen:true`) | **engine** |

Justification: (1) any silent change of a live till's primary screen is a support incident — opt-in honours MP §1; (2) the default `phone_repair` for shops with jobs matches the legacy job shape; it only affects how *old rows are labelled*, and the owner can pick anything; (3) `other` for empty shops is a neutral generic form (customer, what was left, services, quote, payment) rather than guessing an industry; (4) `uiMode:'classic'` remains available forever as an escape hatch (`Settings → Services → Interface`, also a per-device override `localStorage pos_svc_ui = 'classic'` for support calls).

---------------------------------------------------------------------------------------------------

## 6. Integration plan (each row names the existing function reused and the new seam)

### 6.1 Customers (MP §9, §17)

| Need | Design |
|---|---|
| Kenyan normalisation/validation | `svcNormPhone(raw) -> {ok, e164, national, key, reason}`. Accept `^0[17]\d{8}$`, `^\+?254[17]\d{8}$`, `^[17]\d{8}$` (9 digits, leading 0 dropped). Strip spaces/dashes/dots/parens first (reuse `normalizeKenyanPhone` for the string step). `key` = last 9 digits. Landlines `^0[2-6]\d{7,8}$` accepted with `level:'warn'`. Non-Kenyan `+<cc>…` (8–15 digits) accepted `warn` (tourists). Invalid ⇒ form error only when the field is `required`; otherwise warn. |
| Dedupe | `svcEnsureCustomer({name,phone,email,allowCreate})` looks in `customers` by `svcPhoneKey(c.phone)===key` (so `0712…`, `+254712…`, `254 712…` all match), else creates with **deterministic id `cu-<key>`** (offline tills converge; `customers` is already merged by id). Uses `registerOrUpdateCustomer` for the write so loyalty/VIP logic is untouched; the job stores `customer:{id,name,phone,phoneKey}` snapshot (so a later rename does not rewrite history). No phone ⇒ walk-in: `customer.id=null`. |
| Duplicate UX | On phone blur the form calls `svcCustomerLookup(key)` → inline chip "Jane Wanjiru · 7 jobs · last 12 Sep [Use]" (customer history from `svcAllJobs` filtered by `phoneKey`). Name typed differently ⇒ non-blocking hint only. |
| Customer history | Drawer tab "History": jobs by `phoneKey` (all types), assets owned, total spend (`salesLog` lines with `svcJobId`), outstanding balances. No new data. |
| Privacy | customer rows are never duplicated into `svcJobs` beyond the snapshot; `svcAssets.ownerKey` only. |

### 6.2 Inventory (MP §22)

| Need | Design |
|---|---|
| Consumption | `svcUseMaterial(jobId,{code,qty,unit,serviceLineId,staffId}) -> {ok,material,errors}` validates via `getAvailableStock(code)` (and `stockLedgerOn` state), then calls **`deductStockForSaleUnit(code,qty,unit)`** (the same path a sale uses: handles units/pack sizes/batches), then retags the `stockMovementLog` rows it just appended (`reason:'Job '+job.no`, `jobId`, `staffId`, `serviceLineId`). `svcCommit` appends `materials[{id,code,name,qty,unit,price,cost,chargeable,at,by}]`. Not legacy `completeServiceJob` (which writes `product.qty` directly and logs nothing — left alone, see §1). |
| Reversal | `svcReverseMaterial(jobId,materialId,{reason})` → `restoreStockForSaleUnit`, appends a negative material row (`void:true, of:id`), never deletes. |
| Auto-consumption | Service lines with `catalog.consumption:[{invCode,qty,unit}]` create **suggested** materials when the status first reaches the template's `consumeAt` phase (default `in_progress`); staff confirm/edit quantities (one tap) — never silent. Toggle `cfg-business.autoConsume`. |
| Low stock | Insufficient ⇒ blocking unless `cfg-business.allowNegativeStock`; warn row "only 2 left" otherwise. After deduct, existing `checkLowStock` logic runs as today. |
| Cost/margin | `materials[].cost` snapshot from inventory `cost`; `svcTotals` returns `materialCost`, `margin`; only shown with `svc:financials`. |
| Uninstalled items | Free-text material (no `code`) allowed, no stock effect, flagged in report "Untracked materials". |

### 6.3 Payments (MP §23, §24) — reuse Bills

* **First payment** of a job: `svcEnsureBill(job)` creates a `bills` record (id from `genSaleId()`-style, `items` = charge lines from `svcTotals(job).lines`, tags `svcJobId`, `svcJobNo`), and stores `billId` on the job. Later charges (additional work/parts) are **appended as bill lines** (never edit earlier lines) and `recomputeBillStatus` runs.
* `svcRecordPayment(jobId,{amount,method,reference,kind:'deposit'|'partial'|'balance'|'refund', idemKey})`: rejects amount ≤ 0 or > balance (unless `kind:'refund'` with `svc:pay` + reason); `idemKey` default `job.id+':'+kind+':'+amount+':'+reference` — a repeat returns the existing record. Writes (a) `paymentHistory` entry via the existing `confirmBillSettleImpl` path, (b) a `salesLog` line "Service Deposit/Payment — <jobNo>" with `billId`, `svcJobId` (revenue recognised on **cash basis**; the classic "Bill Payment — This Installment" convention is followed so `reportsGenerate` totals include it), (c) job `payments[]` mirror row (for merge/audit), (d) `payment:recorded` event, (e) job audit row.
* **M-Pesa**: `method:'mpesa'` ⇒ if `createMpesaStkFlow` is configured use it (prompt STK push to `customer.phone`), else manual `reference` (validate `^[A-Z0-9]{10}$` warn-only). Cash/card/bank/other as in bills.
* `svcCheckout(jobId)`: requires balance 0 or explicit "release with balance" (`svc:financials` + reason, recorded); sets `collected`; prints receipt through the shared receipt path.
* Derived, never stored as truth: `paid`, `balance`, `paymentStatus` (`unpaid|deposit|partial|paid|overpaid`) from `svcTotals` + bill (MP §23 vector 1500+500+300 = 2300).
* Refunds/voids: append-only negative payment + `salesLog` reversal line; no deletion.

### 6.4 Staff & permissions (MP §10, §11)

| Item | Design |
|---|---|
| Permissions | 16 keys stored as `staff[].roles` strings (existing mechanism): `svc:view, svc:create, svc:edit, svc:assign, svc:status, svc:quote, svc:approve, svc:charge, svc:inventory, svc:customers, svc:financials, svc:pay, svc:cancel, svc:history, svc:manageServices, svc:manageConfig`. `svcCan(perm, staffOrNull)` = owner/`isManager` ⇒ true; explicit `svc:*` present ⇒ exact check; else **implicit legacy grant** if the member holds `services-counter-tab` or `client-registry-tab` ⇒ all except `approve`, `manageServices`, `manageConfig`. Any `svc:*` tick switches that member to explicit mode (removing the implicit grant), so rights can only narrow. |
| Existing role guards | unchanged: `isTabLocked`, `LOCKABLE_TABS`, `ROLE_TABS` (tab ids). Not touched; `svcCan` is an additional check inside engine actions and hides buttons. Server still trusts the client (same as every other module; documented risk). |
| Where the UI lives | The per-staff checkbox UI is `renderStaffPanel` (module-local, services/index.html) plus `renderNewStaffRoleCheckboxes` (shared fn in functions.js). Seam: one guarded call `typeof svcStaffPermHtml==='function'&&svcStaffPermHtml(member)` appended into each member card (B1-S), implementation in `svc-perms`. Save through `updateStaffRole(id, permKey, checked)` (works for any string). Preset buttons: Receptionist, Technician/Stylist/Mechanic/Washer, Supervisor, Cashier. |
| Role names per type | `template.staffRoles` (e.g. Technician/Stylist/Mechanic/Washer) are **labels + default permission bundles** only; `cfg-roles` holds owner overrides. `staff[].svcSpecialties` (tags) drive suggestion ordering in assignment pickers. |
| Multi-staff | `job.jobStaff[{id,staffId,role,taskId?,share?,at}]` append-only; `svc:assign` required; tasks = `jobServices[].assignees`. Per-staff report counts jobs/revenue by share (equal split default). |
| Logged in actor | `svcActor()` → `{id,name}` from the session staff (`currentStaff` / owner) used in every audit row. |

### 6.5 Notifications (MP §25) — never auto-send

| Channel | Mechanism |
|---|---|
| WhatsApp | `https://wa.me/<e164 digits>?text=<encodeURIComponent(msg)>` via `svcNotifyOpen(jobId,{channel:'wa',templateKey})`, opened with `window.open(url,'_blank','noopener')`. |
| SMS | `sms:<e164>?body=<msg>` (Android) / `sms:<e164>&body=<msg>` (iOS detected by UA). |
| Email | `mailto:<email>?subject=…&body=…` only if email present. |
| Templates | `cfg-notify` records per type+event: `received, quote_ready, approved, in_progress, ready, delayed, collected, payment_received, balance_due, appointment_reminder, custom`. Variables `{customer} {shop} {jobNo} {item} {balance} {total} {eta} {status} {date} {time}` resolved by `svcNotifyBuild(job,templateKey) -> {text, vars, missing[]}`; unknown variable left visible + warning. |
| Log | every open appends `job.notify[{id,at,by,channel,templateKey,text}]` (mark "Prepared", not "Delivered" — we cannot know). |
| Auto-send | Only when a provider is configured (`/api/sms-config?status=1` true) **and** `cfg-notify.auto===true` **and** event flagged; then `POST /api/sms-send`. Default off. Not in B3 acceptance for real delivery (cannot be verified without a provider). |
| Prompts | After status change with `notifyOn`, a dismissible toast "Notify Jane that her phone is ready? [WhatsApp] [SMS] [Skip]". |

### 6.6 Audit (MP §26)

`svcAuditEvents()` returns normalised events from `job.audit[]` and `svcConfig.log` in the exact shape `buildAuditEvents` produces; one guarded seam (`typeof svcAuditEvents==='function'`) appends them and adds a "Services" option to `#audit-module-select`. Every state change writes `audit:{id,at,by,act,from,to,detail}` inside `svcCommit` (actions: create, edit, status, assign, quote.*, charge, material, payment, notify, photo, valuables, cancel, reopen, config). Also calls `logAdminActivity` for config/permission changes (owner-visible log already exists).

### 6.7 Reports (MP §27), search (§28), dashboards (§29), queue (§30)

* **Reports** plug into the shared `reportsGenerate(kind)` via **`window.reportExtraBuilders = {kind: fn(range, opts) -> {title,html,csv}}`** (inert hook added to functions.js by B1-S; existing builders untouched, legacy kinds byte-identical). Registry in `svc-reports`: `SVC_REPORTS[{key,label,types:['*'|…],perm,build}]`. Builders use `reportCards`/`reportTable`, revenue from `salesLog` (`svcJobId`), counts from `svcAllJobs`.
  * General: Jobs (created/completed/collected by period), Revenue by service/staff/payment method, Outstanding balances, Turnaround time, Quotes (conversion, expired), Deposits held, Parts/materials used, Customer visits/spend, Staff workload, Appointments (no-shows), Cancellations, Legacy jobs included flag.
  * Per type (from `template.reports`): phone_repair — faults, brands, IMEI lookup, warranty returns; car_wash — vehicles/day, package mix, peak hours; garage — vehicle history, parts by vehicle, awaiting-parts ageing; salon — stylist revenue, rebooking rate, no-shows; tailoring — fittings, ready-by ageing; laundry — items/weight, pickup due; shoe_repair/electronics — fault mix; photo_studio — sessions, delivery; other — generic.
  * Must keep: every existing report kind/output unchanged (snapshot test on `reportsGenerate` for all legacy kinds).
* **Universal search** `svcSearch(q,{types,limit}) -> [{kind:'job'|'customer'|'asset'|'appt', id, title, sub, score}]`: indexes job no, customer name, phoneKey (digits), asset key (plate/IMEI/serial/reg), status, `itemDetails` text of legacy jobs; in-memory index rebuilt lazily on `render:home` with incremental updates on `svcCommit`; debounced 120 ms; ≤ 200 results; search box in `#svc-root` header and in drawer; plate/IMEI normalisation via `svcNormPlate`/`svcValidImei`.
* **Dashboards** `svcDashboardMetrics(typeKey) -> {cards:[{key,label,value,sub,tone,onClick}]}` from `template.dashboard` (today's intake, in progress, ready for pickup, overdue, awaiting approval, unpaid balance, today's revenue, appointments today, low stock for consumables). Cards render in `#svc-root` header and into the shared dashboard via one guarded seam (`svcDashboardHtml()`), with click-through to the board filtered by the card.
* **Queue boards** `svcQueueGroups(typeKey,{filters}) -> [{key,label,color,jobs[]}]` from `template.queueGroups` (each maps statuses); vertical accordion on phones, horizontal columns ≥ 900 px; card = job no, customer, asset label, due/overdue chip, balance chip, assignee avatars; quick status action button ("Next: Ready ▸") using `svcAllowedNext`; overdue = `dueAt<now && phase<3`. Bell: `svcDueJobs()` merged into `getDueServiceJobs()` via seam.

### 6.8 Appointments, walk-ins, vehicle history, valuables, photos, catalog, quotes

| Feature | Design (function) |
|---|---|
| Appointments (MP §20) | `svcAppointments` records: `{id,no,customer,assetSnap,services[],staffIds[],resourceId?,date,start,end,startAt,endAt,status,notes,jobId,createdAt,updatedAt,rev}`. Views: Day (time grid per staff/resource), Week, List. `svcApptClashes(appt) -> [{withId, staffId, kind:'staff'|'resource', overlapMin}]` (includes legacy bookings); **warning not block** (owner can override with a reason logged). Slots: `svcFreeSlots(date, durationMin, staffId)` using `cfg-business.hours` and durations from catalog. `svcApptToJob(apptId)` creates a job pre-filled from the appointment (deterministic idempotence: if `appt.jobId` exists, open it), sets appt `status:'arrived'→'converted'`. No-show/cancel append reason. |
| Walk-ins (§19) | `svcQuickIntake(typeKey,{assetKey?,phone?,serviceIds[]})` — a 3-field "quick" form from `template.quick` (car wash: plate, package, phone optional); creates a job with status `received` (or `in_progress` if `template.quickStart`), prints/opens a token number. |
| Vehicle history (§21) | `svcAssetHistory(assetId)` → jobs + services + mileage timeline; plate search finds the asset; on entering a plate the form shows "Last visit 12 Aug — Oil service, 82,300 km" and pre-fills make/model/owner (user confirms). `svcUpsertAsset` appends `history` entry `{jobId,at,summary,odometer}` (append-only, unions across devices). Ownership change: `ownerHistory`. |
| Valuables (§16) | `job.valuables[{id,item,note,photoIds[],ackAt,ackBy,ackMethod:'tick'|'initials',returnedAt?,returnedBy?}]`; acknowledgement checkbox mandatory (template disclaimer text from `cfg-disclaimer`) before `received` can be left; return tick required at `collected` (blocking unless waived with reason). |
| Vehicle condition photos (§15) | `svcPhotoAdd(jobId,{slot:'front|rear|left|right|interior|damage|…', file})` → compress (`compressImageToTarget`, ≤ 1100 KB), store blob in IndexedDB `svc_photos`, job gets `photos[{id,slot,at,by,state:'pending'|'uploaded'}]`; `svcPhotoFlush()` uploads (`/api/media` kind `ref`, id `svc-<sha20>`) on online/foreground; `svcPhotoUrl(id)` resolves object URL or `/api/media?...`. Slot checklist per template (`template.photoSlots`). Damage marking: tap-on-diagram is **stretch** (B4 optional); B3 = slot photos + free text. |
| Catalog (§12–14) | `svcCatalog` records `{id,typeKeys[],name,code?,category,basePrice,priceByAssetType:{sedan,suv,…},durationMin,taxable,active,consumption[],invCode?,sort}`; Manager UI = table + editor drawer; price resolution `svcPriceFor(catalogItem, assetType)`; variants (car size, hair length) by `priceByAssetType`; import from inventory `type:'service'` items via "Import from inventory" button; seeds per type from `template.catalog`. |
| Quotes (§17, §18) | Lifecycle derived from `quoteLog[{v,act,at,by,total,note}]` acts `draft|send|await|approve|reject|expire|revise`; states **Draft → Sent → Awaiting Approval → Approved/Rejected/Expired**; `svcQuote*(jobId,…)` functions; each revision appends `quoteVersions[{v,lines,total,validUntil}]`; approval records method (`verbal|whatsapp|signed|in_person`) + note + actor; `validUntil` ⇒ `expired` computed at read time. **Additional charges** are a separate list `charges[{id,kind,label,amount,reason,approved:'pending'|'yes'|'no',approvedBy,at}]`, never merged into an approved quote: `svcTotals` = approved quote lines + approved charges + chargeable materials − discounts. Unapproved extra charge blocks checkout (warn). Print/share quote via notify template `quote_ready`. |

---------------------------------------------------------------------------------------------------

## 7. UI plan (mobile-first, wireframe level)

### 7.1 Screens

| # | Screen | Replaces / extends | Wireframe (390 px wide) |
|---|---|---|---|
| S1 | Services home (`#svc-root`) | extends `#services-counter-tab` | `[Search 🔍 plate/phone/job]`  `[+ New <Job term>]`  ⟶ KPI strip (horizontal scroll cards) ⟶ segmented `Board | List | Appts | Reports` ⟶ content |
| S2 | New job form | replaces "Check in" intake in engine mode | full-screen sheet; sticky header (title, Save), sections as collapsible cards from `template.sections`; sticky footer: `Save draft` / `Create job` (48 px); field-level errors inline; phone chip lookup; asset autocomplete |
| S3 | Quick intake | new (walk-ins) | bottom sheet with 3 fields + big `Start` |
| S4 | Queue board | new | accordion groups (status colour bar, count), cards with swipe-free quick-next button |
| S5 | Job drawer | replaces `openClientRegistryModal` for engine jobs | bottom sheet (full-height on phone, right panel ≥ 900 px), tabs via `svcDrawerRegister`: **Overview · Work (services/materials/staff) · Quote & charges · Payments · Photos & valuables · Timeline/audit · Notify** ; header: job no, status pill, balance chip; footer primary action = next status |
| S6 | Appointments | extends `#bookings-tab` | Day (time grid), Week (7 columns, dots on phone), List; FAB `+`; clash warning banner; `Convert to job` |
| S7 | History / all jobs | extends `#client-registry-tab` | searchable list with type chips, status filter, date range, CSV export |
| S8 | Reports | extends shared Reports tab | extra group "Services" in report picker (seam via `reportExtraBuilders`) |
| S9 | Settings → Services | new `settings-section-services` with sub-pages registered by `svcSettingsRegister` | Business Type · Catalog · Statuses & workflow · Staff roles · Notifications · Vehicle config · Custom fields · Disclaimers & numbering · Interface (classic/engine) |
| S10 | Dashboard cards | extends main dashboard | one `<div id="svc-dash-cards">` injected by seam |

### 7.2 Routing & navigation
* `#services-counter-tab` id **kept** (role system, `ROLE_TABS`, `LOCKABLE_TABS`, `showTab`, tests depend on it). Inside: `#svc-root` first, then `#svc-classic-wrap` (old grid, collapsed in engine mode, expanded in classic).
* Internal routing: no hash router; `svcRoute(view,params)` swaps the content region and stores last view in `localStorage pos_svc_view` (try/catch); browser back handled with `history.pushState({svc:1})` only for the drawer and form sheets so the Android back button closes them instead of leaving the app (`popstate` listener registered once, in `svcBoot`).
* `svcApplyTabLabels()` renames the three tab buttons using `svcTerm` (e.g. "Job Board", "History", "Appointments"); ids untouched.
* Touch targets ≥ 48 px, font ≥ 16 px in inputs (no iOS zoom), CSS variables from the existing theme (dark-mode safe: only `var(--…)` colours, no hard-coded white), `env(safe-area-inset-bottom)` padding on sticky footers, `prefers-reduced-motion` respected, no hover-only affordances.
* Loading: heavy UI built lazily on first `showTab('services-counter-tab')` (`svcBoot()` only registers; `svcRenderHome()` builds DOM on demand) to keep cold start unchanged for non-services modules (not applicable — these blocks are only synced into services/index.html).

---------------------------------------------------------------------------------------------------

## 8. Phased implementation plan (parallel agents, non-overlapping ownership)

**Rules for all agents**: one owner per file/block/function name (table below is exhaustive); all names start `svc`/`SVC_`; ES2018 only; no edits to `services/index.html` between the marker pairs except by the owner of that block; blocks are pure/DOM-free where marked (§2.1); every mutation through `svcCommit`; run `npm run sync` after editing a block and `node --test tests/svc-*.test.mjs` only (never the whole suite until B4); never kill processes by pattern.

### 8.1 Ownership map

| Agent | Phase | Owns (files) | Must not touch |
|---|---|---|---|
| **B1-S** seam integrator | B1 (first, ~1 h, unblocks others) | `tools/lib.mjs` (SHARED_BLOCKS + `only:`), `tools/sync-shared.mjs`, empty block stubs `src/shared/blocks/svc-*.html` (17 files with marker-only content), all seam edits listed in Appendix A (services/index.html, functions.js hooks, `_merge.js`, `_state-store.js`, `storage-and-photos.html`, `services/sw.js`, `build-guides.mjs`), `tests/svc-helpers.mjs`, `tests/svc-names.test.mjs`, `tests/svc-es2018.test.mjs` | block bodies |
| **B1-A** core/templates | B1 | `svc-core.html`, `svc-templates.html`, `tests/svc-core.test.mjs`, `tests/svc-templates.test.mjs`, `tests/fixtures/svc-field-ids.json` | |
| **B1-F** form | B1 | `svc-form.html`, `tests/svc-form.test.mjs` | |
| **B1-D** store/sync/adapter | B1 | `svc-store.html`, `tests/svc-store.test.mjs`, `tests/svc-legacy-adapter.test.mjs`, `tests/svc-sync.test.mjs`, `tests/svc-merge.server.test.mjs`, `tests/fixtures/legacy-*.json` | |
| **B1-U** UI home/settings/sign-up | B1 | `svc-ui-home.html`, `svc-config-ui.html` (Business Type page only in B1), `tests/svc-ui-boot.test.mjs` | |
| **B2-Q** board/metrics/search | B2 | `svc-metrics.html`, `svc-ui-board.html`, tests | |
| **B2-A** appointments | B2 | `svc-appts.html`, tests | |
| **B2-R** reports/history | B2 | `svc-reports.html` (reports + history view), tests | `svc-ui-board.html` |
| **B3-C** catalog+inventory+photos | B3 | `svc-catalog.html`, `svc-inventory.html`, `svc-photos.html`, tests | |
| **B3-Q** quotes/charges | B3 | `svc-quote.html`, tests | |
| **B3-P** payments | B3 | `svc-pay.html`, tests | |
| **B3-N** notify/perms/config/custom | B3 | `svc-notify.html`, `svc-perms.html`, `svc-custom.html` (custom fields + widgets), `svc-config-ui.html` is B1-U's: B3-N adds settings pages only via `svcSettingsRegister` calls inside its own blocks | `svc-config-ui.html` |
| **B4** acceptance | B4 | `tests/svc-*.browser.test.mjs`, `tests/svc-acceptance-matrix.md` (test notes), bug reports only | all src |

Block count: 18 (the 17 listed in §2.1 plus `svc-custom`); `SHARED_BLOCKS` gets 18 entries.

### 8.2 Phases

**B1 — Core (prerequisite for everything)**

| Item | Detail |
|---|---|
| Functions | per §8.3 contracts: svc-core, svc-templates (10 templates), svc-form, svc-store (lists, sync collect/apply, commit, create/update/status, adapter, asset/customer upsert, business type/config), UI home (`svcBoot`, `svcRenderHome`, `svcOpenNewJob`, drawer registry + Overview tab + status change, list view), sign-up select, Business Type settings page, terminology (`svcTerm`, `svcApplyTerms`, `svcApplyTabLabels`) |
| Tests | `svc-core` (phone/plate/IMEI vectors, job numbers, totals 2300), `svc-templates` (every template validates against schema; golden field-id file; statuses reachable; no duplicate ids), `svc-form` (render/read/validate/visibleWhen/custom widget), `svc-store` (create→status→history; idempotent create; immutability of `serviceType`), `svc-legacy-adapter` (real legacy fixtures → view; promoted hidden), `svc-sync` (two devices via `makeServer`: concurrent creates both survive; nested arrays union; legacy lists still behave), `svc-merge.server` (MERGE_BY_ID + NESTED_MERGE), `svc-names`, `svc-es2018`, `svc-ui-boot` (boot(services) renders `#svc-root`, classic path intact, sign-up select present) |
| Acceptance | MP §1 (no regression: existing `tests/*` for services still pass), §2–§4 engine/templates, §5 business type, §6 adapter, §7 data model, §8 job create/edit/status, §9 customer capture, §41 switch keeps history. Existing shop boots in classic mode with banner; choosing type flips to engine without reload. |

**B2 and B3 run in parallel after B1 merges** (they only add blocks and register via `svcDrawerRegister`/`svcSettingsRegister`/`svcOn`; no shared file edits).

**B2 — Operations**

| Agent | Functions | Tests | Acceptance (MP) |
|---|---|---|---|
| B2-Q | `svcQueueGroups`, `svcDashboardMetrics`, `svcSearch`, `svcDueJobs`, `svcRenderBoard`, `svcRenderKpis` | metrics vectors (overdue, balances), search ranking incl. legacy IMEI scan, board groups per template | §29 dashboards, §28 search, §30 queue board, overdue bell |
| B2-A | `svcApptClashes`, `svcFreeSlots`, `svcApptCreate/Update/Cancel`, `svcApptToJob`, `svcQuickIntake`, `svcRenderAppts` (day/week/list), legacy bookings view | clash matrix (staff, resource, edge touch = no clash), legacy booking included, convert idempotent, walk-in flow | §19 walk-ins, §20 appointments, double-booking warning |
| B2-R | `SVC_REPORTS`, `svcReportBuild(kind,range,opts)`, `svcRenderHistory`, `svcAssetHistory` UI, registers via `window.reportExtraBuilders` | legacy `reportsGenerate` snapshot unchanged; each report with fixtures incl. legacy rows; CSV | §27 reports, §21 vehicle history, customer/asset history |

**B3 — Money, stock, comms, governance**

| Agent | Functions | Tests | Acceptance (MP) |
|---|---|---|---|
| B3-C | `svcCatalogList/Upsert/Archive`, `svcPriceFor`, `svcSeedCatalog`, `svcImportFromInventory`, `svcUseMaterial`, `svcReverseMaterial`, `svcSuggestConsumption`, `svcPhotoAdd/Flush/Url`, catalog manager UI, Materials drawer tab | stock deducted once; retag fields; reverse restores; insufficient stock; price by asset type; photo queue offline→flush (fake `/api/media`) | §12–14 catalog, §22 inventory, §15 photos |
| B3-Q | `svcQuoteDraft/Send/Approve/Reject/Expire/Revise`, `svcQuoteState(job)`, `svcAddCharge/ApproveCharge`, quote tab UI | lifecycle transitions legal/illegal, expiry at read time, charges separate from quote, totals vector | §17–§18 quotes, additional charges |
| B3-P | `svcEnsureBill`, `svcRecordPayment`, `svcCheckout`, `svcRefund`, payments tab UI | deposit+partial+balance=2300 vector, idempotent repeat, overpay rejected, salesLog lines tagged, bill status | §23–§24 payments, M-Pesa manual ref |
| B3-N | `svcCan`-UI (`svcStaffPermHtml`, presets), `svcNotifyBuild/Open`, notify tab, `svcAuditEvents`, settings pages (Statuses, Roles, Notifications, Vehicle config, Disclaimers/numbering, Interface) and `svc-custom` (custom fields: `svcCustomFieldUpsert`, renderer integration), valuables tab | implicit vs explicit grant matrix, wa.me/sms/mailto URL encoding, template vars, custom field round-trip + field id stability, audit events | §10–§11 staff, §25 notifications, §26 audit, §16 valuables, §31–§33 config |

**B4 — Real-browser acceptance** (Playwright, skip-if-missing; run last, sole agent): per-type flow for each of the 10 templates (create → diagnose/work → quote → approve → pay → collect), MP §44–§48 scripts; **switch test** (create Phone Repair jobs, switch to Car Wash, old jobs intact and visible under All types, new car-wash form works, switch back); mobile 390×844 (no horizontal scroll, sticky footer visible, drawer back button); two-tab sync; existing-shop upgrade path (classic → choose → engine); ES2018 guard on real Chromium; full suite run once; bump `SW_VERSION`; `npm run guides`.

### 8.3 Cross-phase function-signature contracts (frozen at end of B1; changes need architect sign-off)

**svc-core (B1-A)**

| Signature | Returns / notes |
|---|---|
| `svcNow()` | ms epoch (test-overridable `window.__svcNow`) |
| `svcId(prefix)` | `prefix + genSaleId()`-style unique id, `[A-Za-z0-9_-]`, ≤ 40 |
| `svcNormPhone(raw)` | `{ok,e164,national,key,reason,level:'ok'|'warn'|'error'}` |
| `svcPhoneKey(raw)` | last 9 digits string or `''` |
| `svcNormPlate(raw)` | upper-case, spaces/dashes collapsed, e.g. `KDA 123A`; `{ok,norm,level}` for `svcCheckPlate` |
| `svcValidImei(raw)` | `{ok,digits,luhn}` (Luhn fail = warn) |
| `svcNextJobNo(typeKey)` | `PFX-yymmdd-T<till>-<seq3>` (per-till per-day counter in `localStorage` + scan of `svcJobs` for max to survive cleared storage) |
| `svcCan(perm, member?)` | boolean (§6.4) |
| `svcActor()` | `{id,name}` |
| `svcTotals(job)` | `{lines[],services,materials,charges,discount,tax,total,paid,balance,materialCost,margin,paymentStatus}` (pure) |
| `svcOn(evt,fn)`, `svcEmit(evt,payload)` | events: `job:created, job:status, job:updated, payment:recorded, material:used, charge:added, quote:changed, config:changed, render:home` |

**svc-templates (B1-A)**: `SVC_TYPES` (object key→template, §2.2), `SVC_TYPE_ORDER` (array), `svcGetTemplate(typeKey, cfgOverride?)` (merges owner overrides from `svcConfig`, returns frozen copy), `svcTerm(key, typeKey?)` (fallback chain: override → template.terms → generic), `svcFillTypeSelect(selectId)`.

**svc-form (B1-F)**: `svcRenderForm(mountEl, template, opts{values,mode:'create'|'edit'|'quick',readOnly,onChange}) -> {getValues(), setValues(v), validate(), focusFirstError(), destroy()}`; `svcVisibleFields(template, values)`; `svcValidate(template, values) -> {ok, errors:{fieldId:msg}, warnings:{…}}`; `svcSplitValues(template, values) -> {customer, asset, data, services}`; `svcRegisterWidget(name, spec, {priority})`; `svcRenderJobSummary(job, mountEl)`.

**svc-store (B1-D)**

| Signature | Notes |
|---|---|
| globals `svcJobs, svcAssets, svcCatalog, svcAppointments, svcConfig` | module-scope `let` arrays initialised `[]` |
| `svcLoad()` / `svcSave(list)` | localStorage keys `pos_svc_*`; called by the existing load/save seams |
| `svcSyncCollect() -> {svcJobs,…}` / `svcSyncApply(data)` | used in `collectSyncPayload`/`applyRemotePayload` |
| `svcCommit(list, rec, {reason, noAudit}) -> rec'` | bumps `rev`, `updatedAt`, stamps actor, appends audit, `queuePush()`, `markLocalDirty()`, emits event |
| `svcCreateJob(input{typeKey,values,services[],staffIds[],apptId?}) -> {ok,job,errors}` | validates, ensures customer/asset, job no, idempotent on `input.idemKey` |
| `svcUpdateJob(id, patch, {reason}) -> {ok,job,errors}` | refuses `_legacy`; rejects immutable keys |
| `svcSetStatus(id, statusKey, {note,by,force}) -> {ok,job,code}` | checks `svcAllowedNext`/`svcCanEnter` (`requires`), stamps `statusHistory`, emits |
| `svcAllowedNext(job) -> statusKey[]`, `svcCanEnter(job,statusKey) -> {ok,missing[]}` | |
| `svcAllJobs({includeLegacy=true, types, since, status, q}) -> job[]` | sorted `createdAt` desc |
| `svcGetJob(id)` | engine or legacy view |
| `svcLegacyToJob(l)`, `svcLegacyBookingToAppt(b)` | §4.1 |
| `svcEnsureCustomer(o)`, `svcUpsertAsset(o)`, `svcFindAssetByKey(kind,key)`, `svcAssetHistory(assetId)` | §6.1 |
| `svcBusinessType()`, `svcSetBusinessType(key,opts)`, `svcConfigGet(id)`, `svcConfigSet(id,obj)` | §5 |
| `svcHealJob(id)` | recompute derived fields after a merge |
| `svcDrawerRegister(tabKey,{label,order,render(job,el),visibleWhen(job)})`, `svcSettingsRegister(pageKey,{label,order,render(el)})` | UI registries (B1-U implements; everyone else calls) |

**B2**: `svcQueueGroups(typeKey,filters)`, `svcDashboardMetrics(typeKey)`, `svcSearch(q,opts)`, `svcDueJobs()`, `svcApptClashes(appt)`, `svcFreeSlots(date,min,staffId)`, `svcApptToJob(id)`, `svcQuickIntake(typeKey,o)`, `SVC_REPORTS`, `svcReportBuild(key,range,opts)`.

**B3**: `svcUseMaterial`, `svcReverseMaterial`, `svcRecordPayment`, `svcEnsureBill`, `svcCheckout`, `svcQuote*`, `svcAddCharge/ApproveCharge`, `svcNotifyBuild(job,templateKey)`, `svcNotifyOpen(jobId,{channel,templateKey})`, `svcPhotoAdd/Flush/Url`, `svcPriceFor`, `svcCustomFieldUpsert`, `svcAuditEvents()`, `svcStaffPermHtml(member)`.

**Dependency direction** (enforced by `svc-names` test scanning for cross-block calls): B1 blocks call no B2/B3 function; B2/B3 call B1 freely; B2 ↔ B3 communicate only through events and registries (`svcOn`, `svcDrawerRegister`). Cross-block calls are guarded with `typeof`.

---------------------------------------------------------------------------------------------------

## 9. Risks and open questions (with recommended decision)

| # | Risk / question | Recommended decision |
|---|---|---|
| R1 | **47k-line single file parse/startup cost** — adding ~8–10k lines of blocks to `services/index.html` (3 MB today) slows cold start on low-end Android | Blocks only define functions; no DOM built at load; `svcBoot()` only registers listeners; heavy render on first tab open; keep blocks minified? **No** (debuggability) — budget +350 KB, measured in B4 (`performance.now()` around script eval on throttled CPU); if > 150 ms added, split rarely used blocks (reports, config UI) to lazy `<script type="text/plain">` chunks evaluated on first use. |
| R2 | **Sync payload growth** — 100 jobs/day car wash | svcJobs/svcAppointments archived via `_state-store.js ARCHIVE_LOG_FIELDS` + hot window in `shop-store.js` (B1-S); push is delta (`slimPayloadForPush` CAP); job cap 8 KB; photos never in state. Open: confirm archive restore path on a fresh device in B4. |
| R3 | **Mixed-release tills** (one till on old build) — old build ignores unknown keys and (per `applyRemotePayload`) drops them on next push? Unknown fields go through generic per-field LWW on the server, so svc lists survive server-side; an old client simply never sends them | Decision: acceptable; add `svcMinClient` note in `cfg-business` and show "update other tills" hint when a pulled payload contains svc keys but local build lacks them (old build can't show it — document in release notes). |
| R4 | **Legacy `serviceJobs`/`bookings` whole-value LWW** (concurrent adds lose one) | Not fixed in B1–B3 (out of scope, risk to live shops); promotion to `svcJobs` is the escape route. Open: separate small change to add both to `MERGE_BY_ID_FIELDS` — **recommend doing it in a later hotfix** after server test, since it is safe (union by id) but touches live merge for all services shops. |
| R5 | **Old WebViews** (Android 5–7 Chrome ≤ 60) | ES2018 max (enforced by acorn test); no `?.`, `??`, `replaceAll`, `Object.fromEntries`, `.flat`, `structuredClone`; IndexedDB required only for photos — if `indexedDB` missing, photo buttons hide and a note explains; no service-worker-only features. |
| R6 | **Photo storage** | `/api/media` kind `ref` (private, 1100 KB cap) needs a paired-device session; unpaired/demo shops get "photos need a connected shop" message and photos remain local-only (`state:'pending'`); orphaned R2 objects on job delete are acceptable (tiny; add server sweeper later). Open: R2 retention policy for private refs. |
| R7 | **Kenyan number/plate validation strictness** | Phones: error only when `required` and unparseable; `warn` for landline/foreign; plates: `^K[A-Z]{2}\s?\d{3}[A-Z]$` ok, old/custom/government (`GK`, `CD`, motorcycle `KMxx 123A`) `warn` only — never block a vehicle entering a garage. IMEI Luhn failure = warn. |
| R8 | **Tax (VAT)** on services | Reuse line-level `vatCategory` ('A' = 16%) as inventory does; job-level tax computed only when `cfg-business.priceIncludesTax===false`; default prices tax-inclusive. Open: confirm with the owner/accountant; verify in B3 against the receipt renderer. |
| R9 | **svcCatalog vs inventory `type:'service'`** | Separate store with optional `invCode` link + one-way "Import from inventory"; avoids polluting stock screens and lets prices vary by asset type. |
| R10 | **Revenue recognition** | Cash basis at payment (salesLog lines); quotes/unpaid balances reported separately; dashboard labels say "Collected today". |
| R11 | **`sms:`/`wa.me` behaviour** | URL schemes differ per OS/PWA; prepared-not-delivered semantics in log; fallback shows the text with a Copy button. |
| R12 | **Clock skew / job numbers across tills** | `T<till>` segment makes numbers unique per till; device without till uses `D<3 hex>` like `generateReceiptRef`; uniqueness also guarded by `svcCreateJob` idempotency and id uniqueness (number is display only). |
| R13 | **Service worker staleness** | `SW_VERSION` bump in B1-S and again at the end of B4; the approved-release checklist includes verifying `precache` still lists `./index.html` only (blocks are inline, no new files — a decisive advantage of D1). |
| R14 | **Test-suite cost** (boot of 3 MB HTML in JSDOM) | Pure-block tests use `loadSvc` (vm, milliseconds); only `svc-ui-boot` and B4 boot the page. |

**Cannot be verified without real devices / infra**: camera capture quality and permission prompts on Android/iOS; `sms:`/`wa.me` hand-off inside an installed PWA and iOS Safari; Bluetooth/thermal printing of job tags and receipts; real M-Pesa STK flow and callbacks; real Cloudflare KV/DO/R2 behaviour under concurrent tills (local tests use `makeServer()` fakes); low-end-device performance; background-sync/ offline→online transitions in real WebViews; push/SMS provider delivery.

**Open questions (decided unless the owner objects)**: (1) default UI mode for existing shops = classic until chosen (D7); (2) "All types" default in history = on; (3) auto-consume = suggest, never silent; (4) appointment clash = warning not block; (5) damage diagram = stretch; (6) licence-delivered `svcType` = optional B2.

---------------------------------------------------------------------------------------------------

## Appendix A. Seam edits (B1-S only; anchor by name, never by line number — another agent edits these files concurrently)

| File | Anchor | Edit |
|---|---|---|
| `tools/lib.mjs` | `SHARED_BLOCKS` | add 18 entries `{name:'svc-<x>', file:'svc-<x>.html', only:['services/index.html'], after:<marker of previous shared block>}` |
| `tools/sync-shared.mjs` | per-module filter (`skip`/`owner`) | honour `only:[…]` (skip modules not listed) |
| `services/index.html` | after last shared block end marker | 18 empty marker pairs `<!-- @shared-block:svc-x:begin/end -->` |
| same | `collectSyncPayload()` | `if(typeof svcSyncCollect==='function'){Object.assign(data,svcSyncCollect());}` |
| same | `applyRemotePayload(data)` | `if(typeof svcSyncApply==='function')svcSyncApply(data);` |
| same | `window.__LOG_KEYS` | add `svcJobs`, `svcAppointments` |
| same | `#services-counter-tab` | insert `<div id="svc-root"></div>` and wrap the classic grid in `<div id="svc-classic-wrap">` |
| same | `#settings-subnav`, settings content area | button + `<div class="settings-section-content" id="settings-section-services">`; append to `ADMIN_GRANTABLE_SETTINGS_SECTIONS` |
| same | `renderStaffPanel` | guarded `svcStaffPermHtml(member)` |
| same | `buildAuditEvents`, `#audit-module-select` | guarded `svcAuditEvents()` + option |
| same | `getDueServiceJobs` | guarded `svcDueJobs()` concat |
| same | main dashboard render | `<div id="svc-dash-cards">` + guarded `svcDashboardHtml()` |
| same | `#auth-signup-box`, `submitDirectSignup`, `finishDirectAuth` | select + guarded `svcApplySignupType()` before `pushNowOrWarn('Setup')` |
| same | `DOMContentLoaded` | guarded `svcBoot()` |
| `src/shared/functions.js` | `slimPayloadForPush` (`MERGED`, `LOG_FIELDS`, `CAP`, `TRACKED`), `reportsGenerate` | add svc names; consult `window.reportExtraBuilders` for unknown kinds only |
| `functions/api/_merge.js` | `MERGE_BY_ID_FIELDS`, `NESTED_MERGE`, `mergeNestedRecord` | add 5 names; specs from §3.4; `rankBy` support |
| `functions/api/_state-store.js` | `ARCHIVE_LOG_FIELDS` | add `svcJobs`, `svcAppointments` |
| `src/shared/blocks/storage-and-photos.html` | `FIELDS`, `ARR` | mirror the two archive fields |
| `services/sw.js` | `SW_VERSION` | bump `zip-161` → next |
| `tools/build-guides.mjs` | tab descriptions | Services chapter; run `npm run guides` |

## Appendix B. Test matrix (owner → file → key assertions)

| File | Owner | Key assertions |
|---|---|---|
| `tests/svc-helpers.mjs` | B1-S | `loadSvc(blockNames[]) -> sandbox` (vm, stubs for `localStorage`, `genSaleId`, `customers`…) |
| `svc-es2018.test.mjs` | B1-S | acorn `ecmaVersion:2018` parses every `svc-*.html` script |
| `svc-names.test.mjs` | B1-S | all top-level `svc*`/`SVC_*` names unique across blocks and absent from services/index.html outside markers; dependency direction (§8.3) |
| `svc-core/templates/form` | B1-A/F | §8.2 B1 list; golden `svc-field-ids.json` only grows |
| `svc-store`, `svc-legacy-adapter`, `svc-sync`, `svc-merge.server` | B1-D | two-device convergence, archive of svc lists, legacy unaffected |
| `svc-ui-boot` | B1-U | boot(services): classic intact, engine after choose, sign-up select |
| B2/B3 tests | per agent | §8.2 tables |
| `svc-*.browser.test.mjs` | B4 | §8.2 B4 |

## Appendix C. Definition of done (all phases)
No edit to legacy behaviour (existing service/bookings/client-registry tests green); every new money record append-only and idempotent; no `svc*` name collisions; ES2018 guard green; `npm run sync` leaves no diff; `SW_VERSION` bumped; guides regenerated; B4 switch test and mobile pass.

---------------------------------------------------------------------------------------------------

## B1-S handoff (seam integrator) — what exists now, exact names, deviations

State after B1-S: `npm run sync`, `npm run check`, `npm run lint` are green; `tests/svc-seams.test.mjs`, `tests/svc-names.test.mjs`, `tests/svc-es2018.test.mjs` pass; every existing test that boots `services/index.html` still passes. All 18 blocks are marker-only stubs, so the app boots in classic mode exactly as before.

### Tooling
* `tools/lib.mjs SHARED_BLOCKS`: 18 entries `svc-*` with `{ startMarker:'<!-- SVC <NAME>', only:['services/index.html'] }`. Order = page order = §2.1 order, **`svc-custom` is last** (after `svc-photos`; §2.1 lists 17 + `svc-custom`). `tools/sync-shared.mjs` honours `only` (`--check` too); `tools/extract-shared.mjs` skips `only` blocks.
* `src/shared/blocks/svc-<x>.html`: header comment only (owner, kind, contract, spec). **Owners: add your `<script>` (and style/markup) BELOW the header comment and never write a literal script/style open tag inside an HTML comment** (`tools/lint-globals.mjs` and `tools/lib.mjs scriptBlocks` match tags with a regex and would pair it with the next real `</script>`).
* Marker pairs are in `services/index.html` directly after `<!-- @shared-block:receipt-size:end -->`, before `receipt-extras` (all after the main script).
* `tests/svc-helpers.mjs`: `loadSvc(blocks=['svc-core','svc-templates'], globals)` (vm context; functions are properties, `let/const` via `ctx.__eval('name')`; **cross-realm: use `toPlain()` or loose `assert.deepEqual` on arrays/objects built inside**), `blockNames()`, `blockScripts(name)`, `scriptsOfHtml`, `topLevelNames`, `es2018Problems/assertEs2018` (mode `acorn` — acorn is in node_modules: script must parse as `ecmaVersion:2018`, plus an AST walk for `replaceAll/fromEntries/flat/flatMap/matchAll/allSettled/trimStart/trimEnd/structuredClone/globalThis/BigInt`; regex fallback only if acorn cannot be imported). `tests/svc-es2018.test.mjs` and `tests/svc-names.test.mjs` (names prefix/unique/collision/dependency direction B1 → B2/B3 and B2 ↔ B3 only via `typeof` guard) are live.

### Seams in `services/index.html` (all guarded with `typeof`/try-catch; names the block owners must provide)
| Seam | Hook name (who implements) |
|---|---|
| `collectSyncPayload()` spreads `...(typeof svcSyncCollect==='function' ? svcSyncCollect() : {})` before `updatedAt` | `svcSyncCollect()` returns `{svcJobs,svcAssets,svcCatalog,svcAppointments,svcConfig}` (B1-D) |
| `applyRemotePayload(data)` calls `svcSyncApply(data)` (try/catch) right BEFORE `snapshotExtraSyncedFields()`/`renderAllViews()` | `svcSyncApply(data)` (B1-D): replace each list only when `Array.isArray(data.<name>)`, re-derive, persist, re-render |
| `ensureExtraSyncedFieldsInitialized()` | `registerSyncedField` for `svcAssets`, `svcCatalog`, `svcConfig` with a getter that returns `[]` while the global is absent/TDZ (so registration never depends on script order). `svcJobs` / `svcAppointments` deliberately NOT registered (§3.4 #10): **svcCommit must stamp `updatedAt` itself** |
| `window.__LOG_KEYS` | `+ svcJobs:'pos_svc_jobs', svcAppointments:'pos_svc_appts'` (B1-D must use exactly these localStorage keys) |
| `#services-counter-tab` | `<div id="svc-root"></div>` first, then `<div id="svc-classic-wrap">` wrapping the untouched `.pos-grid` |
| Settings | subnav button `#svc-settings-tab-btn` (**`display:none` — B1-U's svc-config-ui must show it**), content `#settings-section-services` > `#svc-settings-root`; `showSettingsSection('settings-section-services')` calls **`svcRenderSettings()`** (new name, B1-U implements it on top of `svcSettingsRegister`); `ADMIN_GRANTABLE_SETTINGS_SECTIONS += {id:'settings-section-services', label:'🔧 Services'}` |
| `renderStaffPanel` | `svcStaffPermHtml(member)` appended right after the "Allowed tabs" `.role-checkbox-grid` (B3-N) |
| `buildAuditEvents` / `#audit-module-select` | `svcAuditEvents()` returning `{at,user,module:'Services',action,detail,ref}`; static `<option value="Services">` (B3-N) |
| `getDueServiceJobs` | `svcDueJobs()` must return an array in the **legacy shape the bell reads** (`id, clientName, itemDetails, promisedPickup`) (B2-Q) |
| Dashboard | `<div id="svc-dash-cards">` + `renderShopDashboard` sets its innerHTML from `svcDashboardHtml()` (B2-Q) |
| `DOMContentLoaded` | `svcBoot()` right after `setupModalCloseButtons()` (B1-U) |
| Sign-up | `#signup-biz-type-wrap` (**hidden**) > `<select id="signup-biz-type">` with the static `other` option. **`svcFillTypeSelect('signup-biz-type')` (B1-A) / svcBoot (B1-U) must fill it AND show the wrapper.** `submitDirectSignup()` sets `window.__svcSignupType` = select value only when the list has >1 option (else `''` = no choice offered); the register body is unchanged. `finishDirectAuth` calls `svcApplySignupType()` (B1-D; try/catch) before `pushNowOrWarn('Setup')`. An existing shop that signs in (not up) never sets it |
| Licence | `licenseInfo.svcType` (from `/api/license-status`) is available to the page for the "pre-select only if `cfg-business` is absent" rule (§5.1) |

### Shared code / server (additive)
* `src/shared/functions.js`: `slimPayloadForPush` (`LOG_FIELDS += svcJobs,svcAppointments`; `CAP svcJobs:120, svcAppointments:150`; `MERGED += the five`), `hydrateOlderHistory` (`FIELDS`/arrays += the two logs), `reportsGenerate` (`window.reportExtraBuilders` consulted **for unknown kinds only — it can never replace a built-in kind**; `window.reportNoRange` array). All no-ops in the other six apps (covered by a jsdom test on every other app).
* `src/shared/blocks/storage-and-photos.html`: `FIELDS`, `ARR` accessors, `isOpen` (`!_deleted && closedAt == null`).
* `functions/api/_merge.js`: `MERGE_BY_ID_FIELDS` += 5; `FINAL_TOMBSTONE_FIELDS` += `svcJobs,svcAppointments,svcCatalog`; `NESTED_MERGE.svcJobs` (spec §3.4, `rankBy:'phase'` implemented in `mergeNestedRecord`) and `NESTED_MERGE.svcAssets`. **Elements of `svcAssets.ownerHistory` need an `id` to be unioned** (elements without one are ignored by the union). Legacy `serviceJobs`/`bookings` still whole-value (R4 unchanged).
* `functions/api/_state-store.js`: `ARCHIVE_LOG_FIELDS += svcJobs,svcAppointments`; `isOpenRecord`. `history.js` and `wildcard-router/shop-store.js` pick these up generically (same constants).
* Licence: `_license.js` exports `SVC_BUSINESS_TYPES`, `normalizeSvcType`; `createClient` stores `record.svcType` **only for product `services`** (unknown text → `other`, empty → `''`); `license-status.js` returns `svcType`; `owner-clients.js` POST and `demo-account.js` (register + generate-demo) pass `body.svcType`. `owner/index.html` link-generation select is NOT done (B2).
* `services/sw.js`: **all eight `sw.js` bumped `zip-161` → `zip-162`** because `tests/user-fixes.test.mjs` requires every app to ship the same stamp (B4 bumps again at the end).
* `tools/build-guides.mjs`: anchor `SVC_GUIDE_CHAPTERS = []` (spread into `MODS.services.custom`); guide output is byte-identical until B4 adds chapters.

### Deviations from the document
1. **No registry stubs**: `svcOn`/`svcEmit` (B1-A, svc-core), `svcDrawerRegister`/`svcSettingsRegister` (B1-U), `svcCommit` (B1-D) are NOT defined by B1-S (the doc assigns them to those owners). Seams call only guarded names.
2. `reportsGenerate`: Appendix A ("unknown kinds only") followed instead of §2.6's `Object.assign`.
3. `TRACKED` in `slimPayloadForPush` was NOT extended (Appendix A names it, §3.4 does not): svc deletions are `_deleted` tombstones written by the engine.
4. Extra seams not listed in Appendix A: `svcRenderSettings` (settings section opened), `hydrateOlderHistory` (new device fetches archived svc jobs), `#signup-biz-type-wrap` hidden wrapper, `SVC_GUIDE_CHAPTERS` anchor, all-app SW bump.
5. Sign-up type for licence links is stored only for `services` links.
