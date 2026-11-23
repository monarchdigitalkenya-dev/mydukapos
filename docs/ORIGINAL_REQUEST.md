# ORIGINAL REQUEST (verbatim) - myDukapos ULTIMATE MASTER IMPLEMENTATION PROMPT

> Saved exactly as the owner wrote it, so a new chat has the full brief. Progress against it is in `docs/HANDOFF.md`.

---

myDukapos — ULTIMATE MASTER IMPLEMENTATION PROMPT

Professional Cash Management, Full Inventory, Serialized Items, Product Variants, Bulk Imports and Complete POS Integration

YOUR ROLE

Act as a principal software architect, senior full-stack engineer, database engineer, financial-control specialist, inventory-management expert, QA engineer, and premium POS UI/UX designer.

Your task is to upgrade my existing myDukapos POS into a more reliable, professional, fully integrated business-management system.

This is a real production codebase, not a new demonstration project.

You must implement three major capabilities:

1. Professional cash float and reconciliation: Opening cash counts, closing cash counts, shared-terminal session handling, separate cashier points, cash movements, and accurate reconciliation.
2. Serialized inventory: Individually identifying physical units such as phones using IMEIs, laptops using serial numbers, and other products requiring unique identifiers.
3. Full inventory management: Product variants, stock control, inventory imports, variant imports into existing products, stock movement history, purchasing integration, reporting, and reliable synchronization.

All three capabilities must integrate with my existing POS, including the Sales Counter, Store/inventory area, Purchases, staff accounts, payment methods, receipts, reports, audit logs, tenant management, terminal registration, and online/offline functionality.

Do not merely describe how you would implement these features. Inspect the repository, implement them, run tests, fix failures, and verify the finished result.

---

PHASE 1 — AUDIT THE EXISTING SYSTEM BEFORE CHANGING ANYTHING

First inspect the entire relevant codebase.

Identify:

- Application framework, architecture, and existing design system.
- Database schema, migrations, relationships, and transaction mechanisms.
- Authentication and staff accounts.
- Tenant and branch isolation.
- Terminal and device registration.
- Sales Counter and checkout workflow.
- Existing Store/product/inventory functionality.
- Product categories, SKUs, barcodes, pricing, and stock quantities.
- Purchases, suppliers, receiving, expenses, and delivery fees.
- Payment methods, including cash and M-Pesa.
- Refunds, voids, reversals, and transaction corrections.
- Receipts and tax-compliant invoicing.
- Stock-taking, inventory adjustments, and transfers.
- Existing cash float or shift functionality, if any.
- Reports and audit logs.
- Offline storage, synchronization, conflict resolution, and multi-device behavior.
- Existing testing framework and deployment/build process.

Trace the actual lifecycle of sales, payments, refunds, stock movements, and purchases before modifying their logic.

Create a written implementation checklist mapping each requirement in this prompt to the relevant existing modules and planned changes.

Reuse existing components and services wherever possible.

Do not create duplicate systems when an existing module can be safely extended.

Do not rebuild the application from scratch, replace authentication unnecessarily, or break working features to simplify implementation.

If you find existing functionality that partially meets a requirement, extend it instead of introducing a competing implementation.

---

PART 1 — PROFESSIONAL CASH FLOAT AND RECONCILIATION

1.1 Feature settings and defaults

Implement a complete cash-management feature within the existing POS.

Defaults:

- Cash float and reconciliation enabled.
- Opening cash count enabled.
- Closing cash count enabled.
- Denomination-based counting recommended as the default.
- One opening count per cash session.
- One final closing count per cash session.
- Separate sessions for independently managed cashier points.
- Multiple staff accounts can share the same cashier point and active session.

For existing tenants, enable the feature through a safe migration or initialization process without destroying existing settings or business data.

Provide authorized business owners with tenant-specific settings to enable or disable the feature and configure the applicable counting rules.

When disabled, preserve the ordinary sales workflow without unnecessary prompts. Never delete historical cash counts or reconciliation records when the feature is disabled.

If counting is explicitly made optional, record whether a count was completed, skipped, or exempted. Never falsely report an uncounted session as reconciled.

1.2 Distinguish staff, devices, cashier points, and sessions

This distinction is essential.

The system must separately understand:

1. Staff account: the authenticated employee performing an action.
2. Physical terminal/device: the computer, tablet, or device used to access the POS.
3. Cashier point: the independently managed physical cash collection point.
4. Cash session: the operating period for a particular cashier point, from opening to closing.

Do not assume that one staff account equals one cash drawer.

Do not assume that one device always equals one cash drawer.

Do not assume that every login requires a new cash count.

Use the existing terminal registration and staff-management architecture wherever possible.

If the application does not already have a formal cashier-point entity, implement one with appropriate tenant, branch, device, staff, and session relationships.

1.3 Required shared-terminal behavior

Example: a hardware shop has one computer at the Sales Counter.

Three employees use their own staff accounts on that same terminal throughout the day.

Required workflow:

1. The first authorized employee opens the cashier point.
2. The employee counts the opening float and confirms it.
3. The system records one authoritative opening count.
4. Another employee subsequently logs in.
5. The second employee sees the existing active session and can continue selling without recounting the float.
6. The third employee can do the same.
7. Each sale is attributed to the actual authenticated employee who made it.
8. All relevant cash movements are associated with the correct cashier point and session.
9. Closing the session requires one final cash count, not one count per staff account.

The original opening-count operator must remain recorded in the audit trail.

Subsequent employees must not silently replace or overwrite the opening count.

Logging out, refreshing the page, restarting the application, or changing staff accounts must not automatically create a duplicate session.

1.4 Independent cashier points

Example:

- Till 1 is assigned to one physical cash drawer.
- Till 2 is assigned to another physical cash drawer.

Each must have its own:

- Opening float.
- Opening count.
- Cash sales.
- Cash refunds.
- Cash additions and removals.
- Cash expenses and payouts.
- Expected cash balance.
- Closing count.
- Variance.
- Session history and reconciliation report.

Closing Till 1 must not close Till 2.

The owner must be able to view each till independently and see consolidated totals without double-counting.

Provide an authorized configuration interface for creating, naming, assigning, activating, and deactivating cashier points.

Support a default cashier point for existing single-till businesses.

When a device is assigned to a cashier point, use that assignment to determine the appropriate session. Do not create a new session merely because an authorized replacement device is used.

If the device's assignment is ambiguous, explain the problem and require an appropriate resolution rather than mixing cash from different drawers.

1.5 Opening float workflow

Integrate the opening-count workflow into the existing Sales Counter.

When a new session is required, display a polished interface showing:

- Business and branch.
- Cashier-point name.
- Registered terminal.
- Opening operator.
- Date and time.
- Session status.
- Currency, defaulting to KES for Kenyan businesses where appropriate.

Provide denomination counting.

Suggested KES denominations:

Notes: KES 1,000, 500, 200, 100, 50.

Coins: KES 40, 20, 10, 5, 1.

Allow denomination lists to be configured and validated for the applicable currency.

Each denomination must have a quantity field and automatically calculated subtotal.

Example:

- Two KES 1,000 notes = KES 2,000.
- Three KES 500 notes = KES 1,500.
- Two KES 200 notes = KES 400.
- One KES 100 note = KES 100.

Total opening float = KES 4,000.

Allow blank or zero quantities, prevent negative quantities, and validate numeric input.

Support a configurable total-only counting mode if desired, but recommend denomination counting.

Include optional opening remarks and a final confirmation.

After confirmation, store the opening count as an authoritative record.

The opening float is starting cash, not sales revenue or profit.

Prevent simultaneous opening requests from creating duplicate sessions or competing opening counts.

Use database constraints, atomic transactions, or equivalent concurrency-safe mechanisms.

Corrections must require appropriate permissions, a reason, and an audit entry.

1.6 Live cash-session dashboard

Within the Sales Counter, provide an accessible active-session summary.

Display:

- Opening float.
- Cash sales.
- Cash refunds.
- Cash additions.
- Cash payouts and expenses.
- Cash transfers to safe.
- Bank deposits and other cash removals.
- Other approved cash movements.
- Expected cash currently in the drawer.
- Cashier point.
- Session start time.
- Session status.
- Synchronization status when applicable.

Provide an easy-to-use cash-movement interface.

Each manual movement must record the amount, category, reason, operator, timestamp, session, cashier point, and reference where applicable.

Support categories such as cash added, cash removed, petty cash, supplier payment, safe transfer, bank deposit, and other authorized movements.

Do not classify a cash addition as revenue or a cash removal as an inventory purchase unless the relevant business transaction explicitly establishes that relationship.

Prevent duplicate movements caused by retries or synchronization.

1.7 Correct cash accounting

Calculate expected cash using actual committed transaction records.

Expected closing cash:

Opening float

+ cash sales
+ cash received outside sales
+ approved cash additions
  − cash refunds paid
  − cash payouts and expenses
  − cash removed or deposited
  − other approved cash outflows.

Count every movement exactly once.

Only the cash component of a split-payment transaction affects physical drawer cash.

Example: a KES 1,000 sale paid using KES 600 cash and KES 400 M-Pesa adds KES 600 to expected drawer cash.

Do not count M-Pesa, card, credit, or other non-cash payments as physical drawer cash.

Cash refunds reduce expected cash only when cash was actually refunded.

Non-cash refunds must be handled through their actual payment method.

Voids, reversals, cancelled sales, failed transactions, and corrections must be accounted for according to their final committed state without double-counting the original transaction and reversal.

1.8 Closing cash count

Provide an explicit Close Cash Session action within the appropriate Sales Counter workflow.

Before closing, display the calculated expected cash and its breakdown.

The cashier counts the physical notes and coins using the same denomination interface.

Calculate:

Cash variance = Actual cash counted − Expected cash.

Examples:

- Expected KES 19,200; actual KES 19,200: balanced.
- Expected KES 19,200; actual KES 19,000: shortage of KES 200.
- Expected KES 19,200; actual KES 19,500: surplus of KES 300.

The displayed variance must be clear and unambiguous.

Require a confirmation before finalization.

If there is a discrepancy, enforce the configured reason and manager-approval rules.

Never silently adjust the expected cash balance to match the actual count.

Never invent sales, expenses, refunds, or inventory transactions to eliminate a discrepancy.

After finalization:

- Store the authoritative closing count.
- Store expected cash, actual cash, variance, and movement breakdown.
- Record the closing operator and timestamp.
- Mark the session closed.
- Prevent further ordinary sales from being assigned to the closed session.
- Preserve all historical transactions and reports.
- Allow a new session to be opened when appropriate.

Support a controlled handover process if the existing business workflow requires one, without weakening the one-authoritative-opening-count and one-final-closing-count rules.

1.9 Cash reports and printing

Integrate reporting into the existing reports and Owner/Admin Console.

Provide filters for date, branch, cashier point, opening operator, closing operator, session status, and variance.

Show opening float, cash sales, refunds, additions, removals, expected cash, actual cash, variance, session duration, and approval details.

Support individual-till and consolidated reporting.

Generate professional closing reports for:

- 58 mm receipt printers.
- 80 mm receipt printers.
- A4 printing.

Include the business details, cashier point, session reference, opening float, cash movements, denomination breakdown, expected cash, actual cash, variance, operators, timestamps, and approvals.

Support spreadsheet or CSV exports where consistent with existing reporting capabilities.

---

PART 2 — INDIVIDUAL PHYSICAL ITEM IDENTIFICATION

2.1 Add the exact product option

On product creation and editing screens, add this exact label:

"This item has a unique identifier per item"

Supporting text:

"Track each individual unit separately using its own IMEI, serial number, or other unique identifier."

When disabled, the product follows ordinary quantity-based inventory.

When enabled, every physical unit must have its own inventory identity and traceable lifecycle.

Apply the setting at the appropriate product or variant level, supporting products whose different variants have different tracking requirements.

Do not restrict serialized tracking to mobile phones.

Examples include phones, laptops, electronics, watches, and other serialized goods.

2.2 Support identifier types

Support:

- IMEI.
- Serial number.
- Manufacturer-assigned identifier.
- Asset or unit number.
- Custom identifier.

Allow multiple identifiers to belong to one physical unit when necessary.

For example, a dual-SIM phone may have two IMEIs but remains one physical phone.

Do not count two IMEIs as two inventory units.

Allow barcode scanning, manual entry, and bulk identifier entry.

Normalize identifiers appropriately for duplicate detection while preserving the original value for display and audit purposes.

Do not use overly restrictive validation that rejects legitimate manufacturer identifiers.

2.3 Register ten identical phones correctly

Example:

Product: Samsung Galaxy A15.

Variant: 128 GB, Black.

Quantity received: ten phones.

Each phone has a different IMEI.

The system must create:

- One parent product.
- One relevant variant.
- Ten individual physical-unit records.
- Ten unique identifier records or appropriate identifier associations.
- The correct total stock quantity.

Each unit must be individually traceable.

Do not create ten unrelated parent products or treat each IMEI as a separate product variant.

Provide an efficient receiving interface that shows identifier registration progress, such as "7 of 10 units registered."

Allow scanning, keyboard entry, pasting multiple identifiers, and importing identifiers from a file.

2.4 Serialized receiving and validation

Integrate serialized registration into:

- Initial stock entry.
- Purchase receiving.
- Supplier deliveries.
- Direct stock additions.
- Stock transfers.
- Inventory imports.
- Authorized opening-stock registration.

For a receipt of ten serialized units, require the appropriate number of distinct physical-unit records before marking all ten units available.

Support partial deliveries where the existing purchasing workflow permits them. Only register units actually received.

Validate missing identifiers, duplicates within the import batch, existing identifiers, product and variant relationships, and transaction idempotency.

Do not allow serialized stock to appear as available when its required unit records have not been created.

Show errors with row numbers or unit references and allow correction before finalizing.

2.5 Individual-unit lifecycle

Each physical unit must have a stable identity and appropriate status, including:

- In stock.
- Reserved.
- Sold.
- Returned.
- Awaiting inspection.
- Damaged.
- Under repair.
- Transferred.
- Returned to supplier.
- Written off.

Use validated state transitions.

Only eligible units may be sold.

Distinguish total physical units from units available for sale.

For example, ten units may exist in the inventory, two may be sold, one may be damaged, and seven may remain available.

The overall inventory quantities must reconcile with the serialized-unit records and status rules.

2.6 Serialized sales in the Sales Counter

When a serialized product is sold, require the cashier to select or scan the actual physical unit.

The system must verify that:

- The unit belongs to the selected product and variant.
- The unit is available at the correct branch.
- The unit is eligible for sale.
- The unit has not already been sold or reserved incompatibly.
- No concurrent transaction has already committed its sale.

Associate the physical unit with the actual sale and sale line.

Mark it sold only when the existing sales architecture commits the transaction.

If the sale fails or is cancelled, restore availability correctly without duplicating stock movements.

Selling three serialized phones requires three distinct physical units.

Ordinary products without serialized tracking must retain their existing quantity-based checkout experience.

Prevent concurrent tills from selling the same unit.

2.7 Returns, exchanges, and warranty history

Link serialized returns to the original unit and sale wherever possible.

Record return reason, condition, operator, timestamp, and disposition.

A returned unit must not automatically become available if it requires inspection.

Support exchanges by preserving the histories of both the returned unit and replacement unit.

Where relevant, show identifiers on customer receipts, supplementary invoice details, returns documentation, and authorized purchase history.

Preserve the existing eTIMS integration and applicable invoice requirements.

Provide a searchable unit history covering receiving, supplier references, branch transfers, sales, returns, repairs where supported, adjustments, write-offs, and authorized corrections.

Never allow duplicate returns or duplicate stock restoration.

---

PART 3 — FULL INVENTORY MANAGEMENT AND PRODUCT VARIANTS

3.1 Upgrade the existing Store

Transform the existing Store/inventory area into a comprehensive Inventory workspace.

Do not create a disconnected second inventory module.

Preserve existing routes, permissions, product IDs, stock data, sales history, and integrations.

Rename the navigation label to Inventory if that provides a clearer experience, while maintaining backward compatibility with existing links.

The workspace must manage products, variants, individual serialized units, stock balances, locations, and inventory movements as related but distinct entities.

3.2 Product variants

Implement a proper parent-product and variant model.

Examples:

Clothing

- T-shirt, Black, Small.
- T-shirt, Black, Medium.
- T-shirt, White, Small.

Phones

- Samsung Galaxy A15, 128 GB, Black.
- Samsung Galaxy A15, 128 GB, Blue.
- Samsung Galaxy A15, 256 GB, Black.

Hardware

- Paint, 1 litre.
- Paint, 4 litres.
- Paint, 20 litres.

Beverages

- Soda, 300 ml.
- Soda, 500 ml.
- Soda, 1 litre.

Support configurable attributes such as size, colour, model, capacity, weight, volume, material, packaging, flavour, and custom attributes.

Allow users to create reusable attribute definitions and values.

Allow users to generate variant combinations and deselect combinations that are not sold.

Avoid automatically generating irrelevant combinations.

3.3 Variant-specific fields

Each variant must support the appropriate fields:

- Stable internal ID.
- Variant name and attributes.
- Unique SKU or variant code.
- Barcode.
- Cost price.
- Selling price.
- Wholesale price where supported.
- Tax configuration.
- Reorder level.
- Stock quantity and location.
- Optional variant image.
- Active/inactive status.
- Serialized-tracking setting.
- Unit-of-measure or packaging conversion where applicable.

Reuse existing pricing and tax logic.

Define inheritance and overrides clearly when a variant inherits values from its parent product.

Changing the parent's display name must not break historical sales, variant relationships, or stock movements.

Prevent duplicate normalized variant combinations within a parent product unless the existing business model explicitly supports them.

3.4 Full Inventory overview

Build an attractive, practical dashboard showing:

- Total active products.
- Total active variants.
- Total physical units.
- Stock available for sale.
- Reserved stock.
- Low-stock items.
- Out-of-stock items.
- Serialized units.
- Units awaiting inspection.
- Damaged stock.
- Inventory value at cost.
- Estimated inventory value at selling price where useful.
- Recent movements.
- Recent receipts and adjustments.

Clearly distinguish product counts, variant counts, unit counts, and stock quantities.

Do not double-count products with multiple variants.

Use a consistent inventory-costing method supported by the existing architecture. Do not assume that selling price is inventory cost.

3.5 Comprehensive inventory table

Provide a responsive, searchable, filterable inventory list.

Display:

- Product.
- Variant.
- SKU.
- Barcode.
- Category.
- Supplier where available.
- Branch or stock location.
- Cost price.
- Selling price.
- Quantity on hand.
- Available quantity.
- Reorder level.
- Serialized tracking status.
- Stock status.
- Last updated.

Support search by product name, SKU, barcode, variant attributes, and authorized serialized identifiers.

Provide filters for category, supplier, branch, stock status, low stock, serialized products, and variants.

Use efficient database queries, pagination or virtualization, and appropriate indexes for large inventories.

3.6 Inventory detail workspace

Clicking a product should open an organized detail view with appropriate sections or tabs:

- Overview.
- Variants.
- Stock by location.
- Serialized units.
- Stock movement history.
- Purchases and suppliers.
- Sales history.
- Reorder information.
- Product settings.

Show parent-level and variant-level stock accurately.

Do not load every serialized unit merely to display an inventory total.

3.7 Stock adjustments and transfers

Support controlled workflows for:

- Opening stock.
- Stock additions.
- Stock reductions.
- Damage and loss.
- Write-offs.
- Stock-take variances.
- Corrections.
- Inter-branch transfers.

Every adjustment must record the operator, reason, timestamp, location, reference, and affected products, variants, quantities, or serialized units.

Never let a manual quantity edit silently bypass the inventory ledger.

For transfers, support creation, dispatch, receiving, discrepancies, and history.

Prevent transferred stock from being available at both locations simultaneously.

Reuse existing stock-taking and transfer functionality where appropriate.

3.8 Low-stock management

Support reorder thresholds at the appropriate level, preferably per variant and location when necessary.

Provide low-stock reports and a way to initiate purchasing or restocking through existing workflows.

Do not automatically create purchases or alter stock merely because a reorder threshold has been reached.

If an existing AI restocking feature is available, ensure it uses actual variant-level stock and inventory movements.

---

PART 4 — BULK IMPORTING PRODUCTS, VARIANTS AND SERIALIZED ITEMS

4.1 Professional import wizard

Build a complete Excel/CSV import wizard integrated into Inventory.

Support:

- New product imports.
- Existing product updates.
- New variant imports.
- Updating existing variants.
- Adding variants to existing parent products.
- Opening-stock imports.
- Serialized-unit registration.
- Validation-only previews.

Use the existing file-processing architecture.

Provide downloadable example templates for ordinary inventory, variants, and serialized units.

4.2 Column mapping

Allow users to map spreadsheet columns to fields including:

- Product name.
- Parent product ID or SKU.
- Variant SKU.
- Variant name.
- Size.
- Colour.
- Model.
- Storage capacity.
- Barcode.
- Cost price.
- Selling price.
- Quantity.
- Category.
- Supplier.
- Branch.
- Reorder level.
- Serialized-tracking setting.
- Identifier type.
- IMEI or serial number.
- Other supported custom attributes.

Do not force users to use one exact spreadsheet header format.

4.3 Import workflow

Implement the following steps:

1. Upload an Excel or CSV file.
2. Choose the import type.
3. Map columns.
4. Preview the parsed rows.
5. Validate data.
6. Display errors and warnings.
7. Confirm the import behavior.
8. Execute the import safely.
9. Show the results and allow rejected rows to be downloaded.

Show row numbers and clear explanations for missing values, duplicate SKUs, duplicate identifiers, unmatched parent products, invalid quantities, ambiguous variants, and conflicting records.

Support appropriate inline corrections or a retry using a corrected file.

4.4 Import variants into existing inventory

This requirement is mandatory.

I must be able to import variants into a product that already exists without recreating the parent product.

Example:

Existing product: Samsung Galaxy A15.

Spreadsheet:

Parent SKU| Variant SKU| Model| Storage| Colour| Cost| Selling Price| Quantity
SAM-A15| SAM-A15-128-BLK| A15| 128 GB| Black| 12000| 15000| 10
SAM-A15| SAM-A15-128-BLU| A15| 128 GB| Blue| 12000| 15000| 5
SAM-A15| SAM-A15-256-BLK| A15| 256 GB| Black| 15000| 18000| 4

These values are illustrative.

Match the existing parent using a stable internal identifier or SKU.

Create the missing variants and attach them to that parent.

Do not create duplicate parent products.

If the parent cannot be identified unambiguously, flag the rows for correction instead of guessing.

If a variant already exists, follow the selected update policy.

Never silently overwrite existing quantities, prices, identifiers, or historical records.

4.5 Safe quantity semantics

Clearly distinguish between:

- Setting an opening stock balance.
- Adding newly received stock.
- Updating product information.
- Updating a variant.
- Registering individual serialized units.

An import containing quantity ten must not automatically replace an existing balance of twenty with ten when the user intended to add ten units.

Likewise, a repeated import must not add the same stock twice.

Use stable import IDs, row-level idempotency, duplicate detection, and accurate transaction records.

For serialized products, require the appropriate identifier records before marking the imported units available.

If a spreadsheet contains quantity ten and ten distinct IMEIs, register ten units after validation.

If it contains quantity ten but no required identifiers, report the missing identifiers rather than inventing ten fully identified units.

Support both one-row-per-variant and one-row-per-physical-unit import formats.

4.6 Import reporting

After each import, display:

- Total rows.
- Created records.
- Updated records.
- Skipped rows.
- Failed rows.
- Duplicate identifiers.
- Validation errors.
- Import reference.
- Timestamp.
- Operator.

Allow rejected rows to be exported with error explanations.

For large imports, use safe chunked or resumable processing. Report exactly what was committed if processing partially fails.

---

PART 5 — PURCHASES, SALES, PAYMENTS AND LEDGER INTEGRATION

5.1 Purchasing integration

Integrate the upgraded inventory with the existing Purchases tab.

Allow users to select products and variants, record quantities and costs, register serialized identifiers, identify suppliers and receiving locations, and record optional delivery fees.

Only update stock according to the actual receiving and posting state.

Do not add inventory twice because a purchase is edited, retried, or synchronized from another device.

Ensure supplier returns and purchase corrections create the appropriate inventory movements.

5.2 Sales integration

Preserve the existing Sales Counter.

For non-serialized products, deduct the correct variant quantity.

For serialized products, deduct only the selected physical units.

Both cash and non-cash sales must update inventory correctly when the sale commits.

Payment method must not determine whether inventory is deducted.

Prevent concurrent sales of the same serialized unit and prevent unauthorized overselling.

Use atomic operations where connected and the existing durable offline queue when disconnected.

5.3 Keep financial and inventory ledgers separate

The cash-management ledger and inventory ledger must remain logically distinct.

A purchase paid from the drawer can generate both an inventory movement and a cash outflow, but they must be linked to the same genuine transaction so the cash movement is not duplicated.

Product creation, variant creation, inventory imports, and stock adjustments must not automatically become sales or cash movements.

Cash float is not revenue.

Inventory value is not cash balance.

A cash shortage must not silently modify stock, and an inventory discrepancy must not silently modify cash.

Preserve all existing payment integrations, tax calculations, eTIMS behavior, receipts, and reporting.

---

PART 6 — DATABASE INTEGRITY, SECURITY AND OFFLINE OPERATION

6.1 Database and migration safety

Adapt the design to the actual existing database architecture.

Introduce or extend appropriate entities for:

- Cashier points.
- Terminal assignments.
- Cash sessions.
- Opening and closing counts.
- Cash movements.
- Reconciliation and approvals.
- Products.
- Variants.
- Serialized physical units.
- Unit identifiers.
- Inventory balances.
- Inventory movements.
- Import batches and row results.

Do not blindly create duplicate tables if equivalent structures already exist.

Use stable internal IDs, appropriate foreign keys, indexes, constraints, atomic transactions, and tenant-scoped relationships.

Prevent duplicate opening counts, duplicate closing records, duplicate cash movements, duplicate serialized units, and duplicate inventory deductions.

Use precise monetary representations supported by the existing database rather than unsafe floating-point calculations.

Do not change historical product IDs that existing sales depend on.

Migrate existing ordinary products safely, preserving their current stock balances and historical transactions.

Where an existing product has no explicit variant, use a compatible default variant or equivalent representation.

Do not silently enable serialized tracking on products whose existing physical units have not been registered.

Provide a controlled conversion workflow when businesses want to enable serialization for existing stock.

6.2 Tenant isolation and authorization

Apply existing role-based permissions and enforce them on the server.

Respect tenant, branch, staff, and cashier-point boundaries.

Prevent users from accessing other tenants' records by changing IDs in URLs, API requests, or frontend state.

Implement appropriate permissions for:

- Opening and closing cash sessions.
- Recording cash movements.
- Approving cash variances.
- Creating products and variants.
- Enabling serialized tracking.
- Registering or correcting identifiers.
- Importing inventory.
- Adjusting stock.
- Receiving purchases.
- Transferring or writing off stock.
- Viewing sensitive unit histories.
- Approving corrections.

Maintain immutable or appropriately protected audit history.

6.3 Online/offline and multi-device behavior

Integrate with the existing myDukapos offline architecture.

Support durable local records, stable operation IDs, safe retries, idempotent processing, conflict detection, and reliable synchronization.

The system must distinguish locally recorded actions from server-confirmed actions.

For cash sessions, offline operations must not create duplicate openings, movements, or closures.

For serialized inventory, two disconnected devices must not permanently sell the same physical unit. If exclusive allocation cannot be guaranteed offline, flag conflicting transactions for reconciliation rather than silently accepting both as valid.

Never discard inventory updates or overwrite newer records with stale cached data.

Show useful synchronization states and actionable recovery options.

Respect existing web/PWA, Android, and Windows deployment workflows where supported. Do not introduce an iOS-specific application requirement.

6.4 Audit trail

Record relevant actions with:

- Actor.
- Timestamp.
- Tenant and branch.
- Cashier point or inventory location where applicable.
- Affected record.
- Action.
- Before/after values where appropriate.
- Reason or reference.
- Synchronization and approval status where relevant.

Cash counts and finalized inventory transactions must not be silently overwritten.

Authorized corrections must preserve the original history.

---

PART 7 — PREMIUM USER EXPERIENCE

7.1 Design standards

Use the existing myDukapos design system and make the new functionality feel like a native part of the product.

The interfaces must be modern, clean, touch-friendly, responsive, accessible, and fast enough for busy retail environments.

Design for small shops as well as supermarkets, hardware businesses, electronics retailers, and multi-branch businesses.

Use clear monetary totals, structured forms, searchable tables, intuitive filters, keyboard-friendly scanning, appropriate confirmations, and meaningful empty/loading/error states.

Avoid unnecessary modals, excessive navigation, clutter, and repeated prompts.

Do not create decorative screens with nonfunctional buttons.

7.2 Sales Counter

Keep the Sales Counter fast and familiar.

Integrate cash opening and closing where appropriate.

Require serialized-unit selection only for products configured for individual-unit tracking.

Show relevant variant details and available stock.

Do not force cashiers to navigate away from checkout unnecessarily.

7.3 Inventory workspace

Make product management, variants, stock levels, serialized units, imports, purchases, and stock movement history easy to discover.

Use clear status indicators and informative details rather than overwhelming the user with every field simultaneously.

Make bulk importing efficient and transparent.

7.4 Settings

Provide appropriately organized settings for cash management, cashier points, product tracking, identifier types, variant attributes, and inventory controls.

Use sensible defaults.

Settings must be tenant-specific and must not affect other businesses.

---

PART 8 — MANDATORY TESTING

Do not mark the implementation complete until the applicable tests have actually been executed.

8.1 Cash management tests

Shared terminal

- Staff A opens a session with KES 5,000.
- Staff B logs in on the same terminal.
- Staff B sees the existing session without another opening count.
- Sales are attributed to the correct employees.
- The session has one authoritative opening count and one final closing count.

Independent tills

- Till 1 opens with KES 5,000.
- Till 2 opens with KES 3,000.
- Sales and cash movements remain separate.
- Closing Till 1 does not close Till 2.
- Consolidated reporting does not double-count.

Mixed payment

- A KES 1,000 sale is split into KES 600 cash and KES 400 M-Pesa.
- Expected cash increases by KES 600 only.

Test cash refunds, non-cash refunds, voids, reversals, failed transactions, and retries.

Variance

- Expected cash is KES 10,000.
- Actual cash is KES 9,800.
- Variance is −KES 200.
- The system preserves the discrepancy and applies the configured reason and approval rules.

Concurrency and offline operation

Test simultaneous session openings, multiple tabs, refreshes, duplicate requests, offline operations, reconnection, and multiple devices.

8.2 Serialized inventory tests

Ten identical phones

- Create one phone product and one variant.
- Enable individual-unit tracking.
- Receive ten phones with ten distinct IMEIs.
- Verify ten individual units and the correct stock quantity.

Duplicate identifiers

Attempt to register an existing IMEI again. Verify rejection or quarantine without duplicate stock.

Sales

Sell one phone and verify that only its unit becomes sold.

Attempt to sell the same unit on another till and verify that the second sale cannot commit the same unit.

Returns and transfers

Return a phone and verify its original transaction linkage, condition, and availability.

Transfer a phone between branches and verify that its physical identity is preserved and it cannot be sold simultaneously at both branches.

8.3 Variant and import tests

- Create a product with several size and colour combinations.
- Verify that each variant has its own SKU and stock balance.
- Import three variants into an existing parent product.
- Verify that the existing parent is reused.
- Import an existing variant again and verify the selected update policy.
- Import ten serialized units with ten identifiers.
- Reject duplicate identifiers.
- Reject missing required identifiers.
- Verify that opening-stock imports do not overwrite stock unexpectedly.
- Verify that repeated imports do not duplicate inventory.

8.4 Integration and regression tests

Verify:

- Purchases and stock receiving.
- Optional delivery fees.
- Inventory deductions on sales.
- Cash and M-Pesa payments.
- Refunds and reversals.
- Stock-taking and inventory adjustments.
- Receipts and reports.
- eTIMS compatibility.
- Tenant and branch isolation.
- Cash float and reconciliation.
- Existing offline workflows.
- Multi-device synchronization.
- Existing user accounts and historical data.

Run the repository's available unit tests, integration tests, concurrency tests, linting, type checks, migration checks, and production build.

Fix the failures introduced by the implementation.

If unrelated pre-existing failures are found, document them separately and do not misrepresent them as passing.

---

PART 9 — IMPLEMENTATION SEQUENCE

Follow this dependency order.

Phase 1: Audit and architecture

Inspect the repository and trace existing data flows. Create the requirement checklist and identify compatibility risks.

Phase 2: Database and migrations

Design and implement the minimum safe database changes for cash sessions, cashier points, products, variants, serialized units, inventory movements, and imports.

Preserve existing IDs, history, and business data.

Phase 3: Core business logic

Implement concurrency-safe cash sessions, opening and closing counts, cash movements, reconciliation, variant-level stock, serialized-unit tracking, and transaction integrity.

Phase 4: User interfaces

Implement the Sales Counter cash workflow, cashier-point configuration, Inventory workspace, product variants, serialized receiving, and individual-unit selection during sales.

Phase 5: Import and purchasing

Implement the import wizard, variant imports into existing products, serialized identifier imports, purchasing integration, and stock movements.

Phase 6: Reports and integration

Implement cash reconciliation reports, inventory reporting, serialized-unit histories, and relevant receipt and export functionality.

Phase 7: Security and synchronization

Implement authorization, tenant isolation, offline persistence, idempotency, conflict resolution, and synchronization indicators.

Phase 8: Testing and refinement

Execute the mandatory tests, fix defects, inspect the actual interfaces, and verify existing workflows.

Phase 9: Delivery

Provide an implementation report with the files changed, migrations, permissions, settings, workflows, tests executed, actual results, deployment steps, and remaining limitations.

Maintain a checklist of outstanding requirements throughout the work. If context or time becomes constrained, document the completed work and exact remaining tasks, then continue from that checklist rather than starting over or abandoning requirements.

---

FINAL ACCEPTANCE CRITERIA

The project is complete only when all of the following are true:

1. Cash float and reconciliation are enabled by default and configurable per tenant.
2. One shared terminal used by multiple staff accounts does not require repeated opening and closing counts.
3. Independently managed cashier points have independent sessions, balances, and reports.
4. Cash expected balances correctly include only real cash movements.
5. Shortages and surpluses are visible, auditable, and handled under the configured approval policy.
6. The product editor includes the exact option "This item has a unique identifier per item".
7. Ten identical phones can exist under one product and variant, each with its own IMEI.
8. Serialized units can be received, sold, returned, transferred, and traced individually.
9. The existing Store has become a comprehensive inventory-management workspace.
10. Products can have configurable variants with their own SKUs, prices, attributes, and stock balances.
11. Variants can be imported into existing parent products without duplicate parent records.
12. Bulk imports validate identifiers, quantities, prices, relationships, and update behavior before committing.
13. Purchases, sales, refunds, stock adjustments, and cash movements remain consistent.
14. Offline and multi-device operations preserve financial and inventory integrity.
15. Existing business data, staff accounts, sales, receipts, integrations, and reporting remain intact.
16. Automated and regression tests have been executed and their actual outcomes documented.
17. There are no placeholder workflows or critical buttons that look functional but do nothing.

FINAL DIRECTIVE

Build this as a production-quality extension of the existing myDukapos system.

Prioritize financial correctness, stock accuracy, concurrency safety, tenant isolation, reliable synchronization, and excellent usability.

Do not sacrifice correctness for a visually impressive interface. Do not sacrifice existing functionality to simplify the implementation.

Do not stop at planning, schema creation, or mockups.

Implement the actual functionality, validate the database and business logic, test real workflows, correct defects, and provide an honest completion report.

The final result must be a reliable POS where cash is reconciled correctly, every serialized physical unit can be tracked individually, product variants are managed properly, and the entire inventory remains accurate across purchases, sales, returns, branches, devices, and offline synchronization.
