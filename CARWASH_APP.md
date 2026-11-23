# Car Wash & Cleaning — standalone application (zip 361)

## What was created
| Piece | Where |
|---|---|
| The app (its own product `carwash`, own URL path `/carwash/`, own service worker / manifest / icons) | `carwash/index.html`, `carwash/sw.js`, `carwash/manifest.webmanifest`, `carwash/icons/` |
| Pure rules: statuses (car / pickup / on-site flows), money, loyalty accounts, SMS templates, default settings, search, every report | `src/shared/blocks/cw-core.html` |
| State and actions: customers, vehicles, jobs, status, assignment, payments, loyalty ledger, SMS queue, complaints, staff, photos, Services import, sync hooks | `src/shared/blocks/cw-store.html` |
| Application shell (sidebar, top bar, universal search, phone bottom bar), Dashboard, Jobs Board, Car Check-in, Cleaning form, Job drawer | `src/shared/blocks/cw-ui.html` |
| Customers & Vehicles, Billing & Payments, Invoice, Loyalty, SMS, Staff & Teams, Reports (Excel / CSV / PDF), Settings, Activity Log, job dialogs | `src/shared/blocks/cw-ui2.html` |
| Owner Console tab "🚗 Car Wash" (generate / copy / open / activate / deactivate / identity / usage / move from Services) | `src/shared/blocks/cw-owner.html` |
| Owner usage endpoint | `functions/api/owner-carwash.js` |
| Services notice ("Car Wash has its own app now") + Car Wash removed from the business-type choosers | `src/shared/blocks/svc-carwash-moved.html` |
| Public demo seed (customers, vehicles, a month of jobs, payments, loyalty, cleaning, staff with roles, Team A) | `functions/api/_demo-seeds.js` `carwash()` |
| Public website card + product page `/products/carwash` + demo | `public-site/product-cards.json`, `public-site/app.html`, `functions/_site.js`, `public-site/img/card-carwash-*.webp`, `demo-carwash.webp` |
| User guide | `src/shared/blocks/guide-data/carwash.html` |
| Tests (the 20 mandatory scenarios + merge + website) | `tests/zip361-carwash.test.mjs` |

The app reuses the platform: sign-in (owner password, staff PINs, online and offline), sync, device pairing, SMS gateway (`/api/sms-send`), M-Pesa STK (`createMpesaStkFlow`), private photo storage (`/api/media` kind `ref`), printing, backups. It has **no sales counter, cart, retail checkout or inventory sales**: the shell covers the page once someone signs in and every shilling is a payment on a job.

## Data (synced records, merged per record by id on the server)
| List | Record |
|---|---|
| `cwCustomers` | id, name, phone (normalised 2547…, unique), altPhone, type (car_owner / walk_in / home / office), location, estate, town, building, house, floor, notes, createdAt |
| `cwVehicles` | id, plate (normalised, unique), make, model, colour, category (small / saloon / suv / van), customerId, notes, ownerHistory |
| `cwJobs` | id, no (CW-/CL-YYMMDD-NNN), kind (car / clean), customerId, vehicleId, items[], discount, cleaning{type, dims, qty, delivery, pickup{…}, scheduledAt, expectedAt, deliveredAt}, assignments[] (append-only), statusHistory[] (append-only; status derived), photos[], free, loyaltyKey, invoiceNo, collection{…} |
| `cwPayments` | id, jobId, amount (refund negative), method, ref, type (payment / deposit / refund), at, by — reversals are marked, never deleted |
| `cwLoyalty` | ledger: earn / reverse / redeem / unredeem with deterministic ids (`cwl-earn-<job>-<n>`) — the same award can never be written twice |
| `cwSms` | one record per event and job (`cws-<event>-<job>`), status pending / sent / failed, tries, error |
| `cwAudit`, `cwComplaints`, `cwConfig` | activity log; complaints / rework (involved staff listed, responsibility decided by a manager); settings |

Server: `_merge.js` — the nine lists in `MERGE_BY_ID_FIELDS`, unique-id lists in `FINAL_TOMBSTONE_FIELDS`, `NESTED_MERGE.cwJobs` (history / assignments / photos unioned by element id, `rankBy: 'phase'` so a collected job never reopens). Shared `slimPayloadForPush` sends only new or changed Car Wash records. No D1 migration needed.

## Migrated from Services
On first open (and on every pull until done) the app imports every Services job of type `car_wash`: customers (by phone), vehicles (by plate), jobs (number, services, statuses, staff, photos), payments and the loyalty points those payments earned. Ids are deterministic (`cwj-m-<svc id>`), so it never imports twice. Nothing in Services is changed or deleted. Shops kept on the server database also have their older Services history read once from `/api/history`.

## Removed from Services
"Car Wash" is gone from the sign-up and Settings business-type choosers. A Services shop still set to car wash sees "🚗 Car Wash has its own app now" with an "Open the Car Wash app" button (same address, `/carwash/`) instead of the car wash screens; New Task and the dashboard queue cards are off for it. The old template stays so old records still read.

## Owner Console
New "🚗 Car Wash" tab: GENERATE APPLICATION LINK (saved like every client link, opens the Car Wash sign-in at `https://<business>.<domain>/carwash/`), Copy link, Open, Usage (jobs today / 30 days / open, collections, customers, vehicles, SMS, staff, devices, last activity, import status), Activate / Deactivate (revoke), Identity, and "Move to Car Wash app" for Services links still set to car wash. The product is also in Generate Link, Edit Link, the client lists and Apps & Versions.

## Needs configuring per business
1. SMS gateway (System settings ▸ SMS) — until then messages wait as "failed" and can be resent.
2. M-Pesa gateway for STK prompts (System settings ▸ Payment Gateway); Till / Paybill shown on SMS and invoices: Settings ▸ Payments.
3. Staff accounts and roles (Staff & Teams), services and prices (Price List tab).

## Zip 362 additions
- **Price List** (left menu, permission `prices`): the standard Splash & Dash list is preloaded - Exterior (Wash Compact 400, with Vacuum 700, Wash Large 500, with Vacuum 800, Body Polish Waxing 1,000, with Own Polish 500, Engine Wash Normal 500, Ceramic Coating 15,000), Interior (Leather Polish 1,000, Dressing 300, Interior Roof Wash 1,000, Seats 4,000), Other services (Floor Wash 1,000, Buffing Compact 5,000, Buffing Large 10,000), Carpet/Rug (Small 1,000, Medium 1,500, Large 2,000). Edit, add, delete, per-vehicle-type prices, vehicle types, reload the standard list, print.
- **Vehicle types:** Compact, Large, SUV, Truck, Cab/Uber (editable). Older installs' small / saloon / van keep their labels.
- **Customer fields:** email, gender, preferred contact method; vehicle year. Delete customer / vehicle (blocked while a job is open; deletions sync to every device).
- **Staff tabs:** each staff member's own list of screens (`cwTabs`), set by the owner in Staff & Teams.
- **Printables:** 📝 Intake form (A4, one page, signature lines), 🧾 Receipt (80 mm), 📄 Invoice (A4), price list, blank intake form.
