// tools/build-guides.mjs — writes src/shared/blocks/guide-data/<module>.html (the text of the 📖 user guide of each module).
// Run `npm run guides` after editing this file, then `npm run sync`. Text style: `**bold**` and `code` are allowed inside any string.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/shared/blocks/guide-data');
const ch = (id, icon, title, o = {}) => ({ id, icon, title, ...o });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// One-line meaning of every tab. The "Every tab at a glance" chapter of a module lists ITS tabs (in the order they appear) from this table;
// a module can override a line. A test checks that every tab of every app is described.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const TAB = {
  'Sales Counter': 'Where every sale is made: search or scan items, build the cart, take payment, print the receipt.',
  'Gas Refill': 'Gas cylinders: refills/exchanges, full cylinders, empties and accessories, with a Full/Empty count per size.',
  'Dashboard': 'Today at a glance: sales, money in by payment method, low stock and what needs attention.',
  'Inventory': 'Everything you stock: search, edit prices and quantities, import/export Excel, opening stock.',
  'Add New Items': 'Add items one by one, many at once (bulk), or from a photo of a list (Capture List).',
  'Restock': 'Record stock you received: quantity and buying price; low-stock buttons add items for you.',
  'Orders': 'Purchase orders to suppliers: create, send on WhatsApp, mark in transit, receive (stock goes up on arrival).',
  'Stock Take': 'Count the shelf, type the counts, and correct the system to what is really there.',
  'Accounts': 'Owner/admin books built from the till\u2019s own records: ledger, trial balance, income statement, balance sheet, cash flow, ageing, bank reconciliation, fixed assets.',
  'Reports': 'Generate sales, insights (busiest hours, best workers, trends), staff, stock, bills & debts, expenses & profit reports. Includes X/Z Reports and an automatic scheduled Daily Sales Report.',
  'Audit': 'A searchable, read-only timeline of who did what and when — sales, voids, discounts, stock changes, X/Z Reports and KRA/eTIMS classification changes.',
  'Store': 'A separate warehouse list (not your selling stock); take items from it into inventory.',
  'Barcode': 'Save, generate and print barcodes for your items.',
  'Tables & Rooms': 'Set up tables, rooms and utensils (used by tabs and orders).',
  'Returned Goods': 'Customer returns and exchanges: refund, swap, faulty items.',
  'Deliveries': 'Delivery orders assigned to drivers: picked up, on route, delivered.',
  'Cross-Branch Sales': 'Sell an item that another of your branches holds.',
  'Daily Sales': 'Every sale for a day / week / month / range, by payment method, with printing.',
  'Stock Report': 'Stock movement over a period: opening, received, sold, closing, with values.',
  'Profits & Expenses': 'Record expenses and see gross and net profit for any period.',
  'Demand Trends': 'What sells most, and when: best sellers and slow movers.',
  'Bills': 'Pay-Later sales still owing: settle in full or in part, see closed bills.',
  'Debts': 'Money customers owe you outside of bills; record and settle.',
  'Trade Credits': 'Money owed between you and another business (I owe them / they owe me).',
  'My Customers': 'Your customer list with purchase history and loyalty.',
  'Contracts': 'Wholesale contracts and their outstanding balances.',
  'Staff': 'Add staff, choose which tabs each can use, send invite links, see who is serving.',
  'Attendance': 'Staff clock in / out and hours worked.',
  'Materials': 'Raw materials and their suppliers: stock levels, costs and restocking.',
  'Payroll': 'Create Payroll: staff register and documents, pay runs, payslips. Admin / payroll rights only; a worker sees just their own payslips. Needs internet and a staff PIN sign-in.',
  'Settings': 'Business details, receipts, tax, hardware, security, backups and more.',
  'More': 'The rest of the tabs that do not fit on the screen.',
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Chapters every module has, with the module's own words filled in.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function start(M) {
  return ch('start', '🚀', 'Getting started', {
    intro: `${M.name} works on a phone, tablet or computer, online or offline. Everything below applies on every device you use.`,
    steps: [
      'Open the link your provider gave you (or the app icon, once installed). The very first time on a new business, tap **Sign Up**, type the business name, your name and a **password** — you become the **Admin**. After that, tap **Log In**.',
      'On **Who\u2019s logging in?** pick **Admin** (type the password) or a staff member (type their PIN). Staff only see the tabs the Admin gave them.',
      'Look at the small dot at the top: **green** = online and saved, **orange** = syncing, **black** = offline. Offline is fine — keep selling; everything is saved on the device and sent when the internet is back.',
      'Tabs run across the top. **☰ More** holds the ones that do not fit. Tap the **📖** button at the top any time to open this guide.',
      'Install it like an app: **⚙️ Settings ▸ 📱 Install App ▸ Install / Add to Home Screen**. After the first load it opens with no internet at all.',
    ],
    tips: ['Do the first load of the app **while online** on every device — that is what lets it open offline later.', 'Settings ▸ Install App ▸ Version shows the version and the build on this device, so you can confirm an update reached it.'],
  });
}
function setup(M) {
  return ch('setup', '🧭', 'Set up your business (first 20 minutes)', {
    intro: 'Do these once, in this order, as the Admin:',
    steps: [
      '**⚙️ Settings ▸ General** — business name, logo, phone and address. They print on every receipt.',
      '**Settings ▸ 🧾 Receipt Settings** — header and footer lines, **🔠 Adjust receipt size** (paper 58 mm, 80 mm or custom, and how big the letters are), how many copies, whether to print the reference number and its barcode.',
      '**Settings ▸ 🧾 Tax & Alerts** — VAT rates, and the **low-stock level** (items at or below it are flagged and offered as buttons when you restock).',
      '**Settings ▸ 💳 Payment Gateway** — connect M-Pesa (Safaricom Daraja with your Till/Paybill, KCB Buni, Paywave Express, Pesapal or Co-op Bank) so you can send payment prompts to customers.',
      '**Settings ▸ 🖨️ Hardware** — connect your receipt printer (see the **Printers & hardware** chapter).',
      `Add your ${M.itemsPlural} (see **${M.addTab}**), then **Settings ▸ 👥 Staff Accounts** to invite your staff.`,
      '**Settings ▸ 🗄️ Backups** — check that backups are on. **Settings ▸ 📥 Data Import** brings in data from another system.',
    ],
    tips: ['Settings ▸ 🔒 Security & Access lets the Admin lock tabs behind the management password.', 'Settings ▸ 🧾 eTIMS (KRA) is only for businesses registered for KRA eTIMS — leave it off otherwise.'],
  });
}
function payments(M) {
  const cash = M.key === 'hotel'
    ? '**Cash** — type the amount the customer gave and the change shows. In the Hotel the amount is **optional but recommended**: left empty it means the exact total.'
    : '**Cash** — type the amount the customer gave; the change due shows at once. The amount must cover the total.';
  return ch('payments', '💳', 'Taking payment: cash, M-Pesa, card, split, Pay Later', {
    intro: 'Choose the payment method under the cart, then complete the sale.',
    steps: [
      cash,
      '**M-Pesa** — enter the customer\u2019s number and tap **Send M-Pesa Prompt** (the customer approves on their phone), or type the M-Pesa code if they paid to your till. The sale completes once it is confirmed.',
      '**Card** — take the card payment on your machine, optionally type the slip reference, and complete.',
      '**Split** — part cash, part M-Pesa: type both amounts. They must add up to the total exactly, or the sale is refused.',
      '**Bill (Pay Later)** — for customers who pay later: type the customer\u2019s name (and phone), optionally an amount paid now. The sale becomes a **bill** that you settle later from the **Bills** tab; it only counts in Daily Sales as money is paid.',
    ],
    sections: [
      { title: 'Hold a sale (customer not ready to pay)', steps: ['Build the customer\u2019s cart, then tap **⏸️ Hold sale**. The cart clears so you can serve the next person; **one** sale can be held at a time.', 'When the customer is ready, finish the sale you are on, then tap the **held sale** button that appears where Hold sale was — the held cart comes back exactly as it was.'] },
      ...(M.noPastSale ? [] : [{ title: 'Record a past sale (forgot to record it)', steps: ['On the Sales Counter tap **Record a Past Sale**, pick the item, date and time, quantity, price and payment method (cash, M-Pesa, card, split or Bill).', 'It is saved on that date and takes the stock off, like a normal sale.'] }]),
    ],
    tips: ['Nothing is deducted from stock while a sale is only being built or held.', 'A wrong sale can be **voided** from Daily Sales (stock comes back).', 'The **💰 Sales** panel (the day\u2019s Total / Cash / M-Pesa) can stay open all the time: tick **📌 Keep open** on the panel, or in **Settings ▸ View**. This is for the device you tick it on.', 'With category tiles on, **Settings ▸ Category Images & Order** lets you hide the "All items" / "All <category>" buttons and choose the order of categories, sub-categories and (Hotel) items: your own numbers, A–Z, most popular, price.'],
  });
}
function receipts(M) {
  return ch('receipts', '🧾', 'Receipts: print, share, reprint', {
    steps: [
      'When a sale completes a **receipt preview** opens. Tap **🖨️ Print** — it prints **once**, and the preview closes so it cannot be printed twice by accident.',
      'The sale is **saved before the receipt appears** — the preview says "✓ Sale saved". **Cancel / Save** only closes the screen: it never cancels the sale (to reverse one, **void** it in Daily Sales).',
      'Every receipt of the day carries a **Customer number** (Customer 1, 2, 3…) just above the reference number. It starts again at 1 each day, so the last receipt of the day tells you how many customers you served.',
      'To print the same receipt again later, open it from **Daily Sales** and tap Print — the app asks "already printed at 14:32 — print another copy?" so copies are always deliberate.',
      '**📤 Share** sends the receipt as a **PDF** (WhatsApp shows it as a document). On a phone it opens your apps. On computers and some browsers that cannot hand a file to another app, the PDF is **saved to Downloads** instead — attach it in WhatsApp or email yourself.',
      '**⬇️ Download** always saves the PDF.',
    ],
    tips: ['If the print fails (printer off, paper out) the preview stays open so you can try again — the sale is already saved.', 'Settings ▸ 🧾 Receipt Settings controls what appears on the receipt.'],
  });
}
function billsChapter(M) {
  return ch('bills', '📒', M.billsTitle || 'Bills (Pay Later) and Debts', {
    steps: M.billsSteps || [
      'A **Bill (Pay Later)** sale appears in the **🧾 Bills** tab with what is owed. Tap **Settle** to take a full or part payment (cash, M-Pesa, card or split). A partial payment reduces the balance; the bill stays open.',
      'When a bill is paid in full it becomes **closed** and moves out of the open list. Tick **Show closed bills** to see paid bills too (closed bills are tidied away after 90 days).',
      '**Save (no receipt)** in the settle window records the payment without printing a receipt.',
      '**📒 Debts** is for money customers owe you outside a bill — add a debt with the customer\u2019s name and amount, and settle it in parts or in full.',
      'The Sales Counter has a small **Bills** panel for staff: green = money they collected on bills, red = still owed.',
    ],
    tips: ['Pay-Later sales are not counted as sales until money is paid on them.'],
  });
}
function stock(M) {
  return ch('stock', '📥', `Restock, Orders and Stock Take`, {
    sections: [
      { title: `${M.restockTab}: record stock you received`, steps: [
        `Open **${M.restockTab}**. Tap a **⚠️ low-stock button** to add that ${M.itemWord} to the form (with its last buying price), or start typing a name — a drop-down of your ${M.itemsPlural} appears; pick one to fill the code, unit and buying price, or keep typing a new name.`,
        'Enter the quantity and the buying price, then save. Stock goes up and an expense is logged automatically.',
      ] },
      { title: '🛍️ Orders: order from suppliers', steps: [
        'Open **Orders** ▸ **New Order**. Tap low-stock buttons to add what is running out, or type names (same drop-down). Enter quantities and prices and choose or type the supplier.',
        'Tap **💬 Save & send on WhatsApp** to save the order and open WhatsApp addressed to the supplier with the order written out (their number is asked once and remembered). Or **Save Order** now and press **💬 WhatsApp** on it later.',
        'Mark it **In Transit** when the supplier dispatches, and **Arrived** when the goods come — that adds the stock.',
      ] },
      { title: '📋 Stock Take: correct the system to the shelf', steps: [
        'Open **Stock Take**, count each item on the shelf and type the number next to it. Only items you type a count for are touched.',
        'The screen shows each difference and its value at cost. Tap **✔ Update stock to my counts** — every change is recorded as a "Stock take" adjustment.',
      ] },
    ],
    tips: ['Do a stock take after a stock delivery day or at the end of the month.', '↩️ **Returned Goods** puts returned items back on the shelf (or into the faulty register) and can refund the customer.'],
  });
}
function reports(M) {
  return ch('reports', '📊', 'Reports and Daily Sales', {
    steps: [
      '**🧾 Daily Sales** lists every sale for Today, a Week, a Month or a Custom range, filtered by payment method. Print the day\u2019s report from there, or void a wrong sale.',
      '**📦 Stock Report** shows stock movement (opening, received, sold, closing) with values at cost and retail.',
      '**💰 Profits & Expenses** — add expenses (rent, fuel, wages…) and see gross and net profit.',
      '**📊 Reports** is the one place to generate everything: pick a **period** (Today … Last 90 days … Custom), then a report.',
    ],
    sections: [{ title: 'The reports in 📊 Reports', points: [
      '**Sales** — total, number of sales, average sale, by payment method and the items sold, best first.',
      '**Business insights** — busiest hour, best-earning hour, best day of the week, best worker; charts of sales by hour and by weekday; and a **trend line** you can switch between **daily, weekly (12 weeks) and monthly (12 months)**.',
      '**Staff performance** — sales, average sale, share and sales per hour worked for each person.',
      '**Stock** — stock value at cost and retail, low stock, out of stock and items that did not sell in the period.',
      '**Bills & debts** — who owes what, oldest first, with ageing.',
      '**Expenses & profit** — sales, cost of goods, gross profit, expenses by category and net profit.',
    ] }],
    tips: ['Every report can be **🖨️ printed / saved as PDF** or **⬇️ downloaded for Excel (CSV)**.', '**📊 Dashboard** gives today\u2019s figures the moment you open the app.'],
  });
}
function people(M) {
  return ch('people', '👥', 'Staff, access and security', {
    steps: [
      'Open **⚙️ Settings ▸ 👥 Staff Accounts** (or the **👥 Staff** tab) and add a staff member\u2019s name. Tick the tabs they may use — the Sales Counter too; a staff member sees only the tabs ticked for them. Tap **Generate invite link**.',
      'Send the link to them. They open it, choose a **PIN** (4+ characters) and they are in — no shop password needed. The link then turns into their personal login link: they should bookmark it.',
      'A staff member is listed once: a double tap on "Create my account" cannot make two copies.',
      '**🕐 Attendance** — staff clock in and out; hours worked show in Reports ▸ Staff performance.',
      '**💼 Payroll** — add staff and their documents, run payroll (review ▸ approve ▸ pay) and give out payslips. Needs internet; a paid or approved run is never edited — corrections are a reversal run.',
      '**Settings ▸ 🔒 Security & Access** — change the password, lock tabs behind the management password, and use fingerprint where the device supports it.',
      '**Settings ▸ 🔐 Admin Activity Log** shows what was changed and by whom.',
      '**⬇️ Sync to this device** (Settings ▸ 🔐 Devices & Security) sends this device\'s unsent sales first, then fetches everything the shop has on the server — step by step, with nothing deleted or duplicated.',
      '**Settings ▸ 🔐 Devices & security** lists every device that syncs your shop (its till number, app release and last sync). Tap **🔒 Only paired devices may sync** so that knowing your shop link is no longer enough to see or change your data. Your devices pair themselves; a new one needs the shop password once, or a **6-digit pairing code** made here (so staff never need the password). Revoke a lost phone from the same list. Signing in and selling always work offline either way.',
      '**👤 My Customers** keeps your customers and their purchases; **🎟️ Loyalty Tokens** (Settings) rewards repeat customers where enabled.',
    ],
    tips: ['To remove a staff member, remove them under Staff Accounts — their old sales stay in the records.', 'If someone forgets the Admin password, use **Forgot it? Email me a reset link** on the login screen (needs the recovery email set up).'],
  });
}
function hardware(M) {
  return ch('hardware', '🖨️', 'Printers & hardware', {
    intro: 'Open **⚙️ Settings ▸ 🖨️ Hardware** (or tap the small printer icon at the top). There are three ways to print:',
    sections: [
      { title: '1. System print dialog (works with any installed printer)', steps: ['Set **Printer mode** to **System print dialog**.', 'Print a receipt: the device\u2019s print window opens — choose your receipt printer once. The receipt prints on a slip only as long as its lines (paper is not wasted).', 'Browsers never allow silent printing, so this mode always shows that window. Use Bluetooth or USB to avoid it.'] },
      { title: '2. USB thermal printer (computer or Android)', steps: ['Plug the printer in and switch it on.', 'Set **Printer mode** to **USB**, tap **Connect USB Printer**, choose your printer and allow access.', 'From then on the app **reconnects by itself** whenever the printer is switched off and on, unplugged and replugged, or the app is reopened — it keeps checking every few seconds and prints the moment the printer is back. You do not go back to Settings.'] },
      { title: '3. Bluetooth thermal printer (phones and tablets)', steps: ['Switch the printer on and pair it in the phone\u2019s Bluetooth settings if it asks.', 'Set **Printer mode** to **Bluetooth**, tap **Connect Bluetooth Printer** and pick it from the list (once).', 'After a power cut or the printer going out of range, the app reopens the same printer by itself (no chooser). Some browsers cannot reopen a remembered Bluetooth printer after the page reloads — the screen then says **Tap Connect once**.'] },
      { title: 'Paper, copies and the cash drawer', steps: ['**Receipt Settings ▸ 🔠 Adjust receipt size** opens a window where you choose the paper (58 mm, 80 mm or custom) and the letter size in points (7 is the standard; try 9, 10, 11 if receipts look too small). A sample receipt with items changes as you tap **−** or **+**; press **🖨️ Print test receipt** to check it on your printer, then **Save** — that is how every receipt will print. **Cancel** throws the changes away, **Reset to standard** goes back to 7 pt. The number of copies is set in Receipt Settings too.', 'Each till can have a different printer: under **THIS device\'s printer paper** choose 58 mm or 80 mm for the printer on this device (or tap **58 mm / 80 mm** at the top of any receipt). **If words break or numbers jump to the next line, the printer is 58 mm on an 80 mm setting — choose 58 mm.** The receipt preview is exactly what will print.', '**📏 Print a width test** (USB / Bluetooth) prints a 32- and a 48-character line: if the 48 one breaks in two, the printer is 58 mm.', 'The **cash drawer** plugs into the **printer** (RJ11/RJ12 port), not the computer; turn on "open drawer on print" in Hardware settings.', 'To check paper width and the drawer, print a small sale receipt, or reprint one from Daily Sales.'] },
      { title: 'Barcode scanners', steps: ['A USB or Bluetooth **scanner** works like a keyboard: click the search box on the Sales Counter and scan.', 'The 📷 button next to search scans with the phone camera.'] },
    ],
    tips: ['Printing waits up to 4 seconds for a printer that has just been switched on before saying it is not connected.', 'If a print fails half-way the receipt is **not** sent again automatically (so you never get a doubled half-receipt) — reprint from Daily Sales.'],
  });
}
function offline(M) {
  return ch('offline', '📶', 'Offline, sync, backups and importing data', {
    steps: [
      '**Offline:** the app keeps working with no internet. Sales, stock and receipts are saved on the device — and every completed sale is also kept in the device\'s own backup journal until the server has it, so it survives a restart or a full device.',
      '**Sync:** when the internet returns the dot turns green and every device catches up. Several tills can work at once — stock changes from each add up correctly.',
      '**Daily Sales shows each sale\'s sync state:** ✓ synced, ⏳ not sent yet, 🔄 sending, ⚠ retrying — unsent sales are always listed, and are sent again automatically until the server has them. **🔎 Check for missing sales** compares this device, its journal, its printed receipts and the server for the day, and puts back anything missing.',
      '**Older sales always show:** Daily Sales and Reports fetch any sale of the chosen days that is not on this device — kept on the server, in the server\'s archive of old history, or in this device\'s own archive — and list it with a **📦 history** mark. Reprint or void it as usual.',
      'Days follow **Kenya time** on every device, whatever the device\'s own time zone; a device whose clock is wrong is told so, and its sales are dated by the correct time.',
      '**If the dot stays black** with internet, wait a few seconds (it checks the server itself and recovers without a refresh). If it stays black, check the device\u2019s connection.',
      '**Backups:** ⚙️ Settings ▸ 🗄️ Backups. Your data is also stored on the server, so a lost phone does not lose your business — log in on another device.',
      '**Importing from Excel/CSV:** on the Inventory tab tap **⬆️ Import from Excel/CSV**. A "please wait" bar shows while the file is read. Check the review list, then **Batch Commit**. Tap **⬇️ Download Excel/CSV** to export.',
      '**More than one branch:** Settings ▸ 🏢 Branches links branches so items and cross-branch sales work.',
    ],
    tips: ['Use **Settings ▸ Install App ▸ 🔄 Re-download for Offline Use** after an update if the app ever fails to open offline.'],
  });
}
function trouble(M) {
  return ch('trouble', '🛟', 'When something is wrong', {
    steps: [
      '**Printer does not print:** check paper and power, then Settings ▸ Hardware ▸ status. Switch it off and on — the app finds it again by itself. As a fallback use the system print dialog.',
      M.key === 'water' ? '**"Only 0 available" when selling:** the product has no stock. Record it in Restocking, or correct it on the Inventory tab.' : '**"Only 0 available" when selling:** the item has no stock. Record it in Restock, or run a Stock Take.',
      '**A sale is missing from Daily Sales:** tap **🔎 Check for missing sales** under the list. Pay-Later bills only count when paid; check Bills. In Aqua POS check the site selected at the top.',
      '**The login window appears again:** just log in; it will not reappear over a running session.',
      '**Forgot the password:** tap **Forgot the password?** on the login screen and use **Email me a reset link**.',
      '**Something looks out of date on a device:** wait for the green dot, then reload the page once.',
      '**Still stuck:** the Owner sees errors from every shop in the Owner Console ▸ Errors tab — tell your provider what you were doing and roughly when.',
    ],
  });
}
const OVR = {
  waterPayments: (M) => ch('payments', '💳', 'Taking payment', {
    steps: [
      '**Cash** — type the amount the customer gave; the change shows.',
      '**M-Pesa** — enter the customer\u2019s number and tap **Send M-Pesa Prompt**, or type the M-Pesa code if they paid to your till.',
      '**Split** — part cash, part M-Pesa; the two amounts must add up to the total.',
      '**Bill (Pay Later)** — the customer\u2019s name and phone; the sale waits in **🧾 Bills** until you **Settle** it.',
      '**Delivery orders:** choose **💰 Paid Now** or **🧾 Pay on Delivery**; the driver collects and you settle from Bills or Deliveries.',
    ],
    sections: [{ title: 'Hold a sale', steps: ['Tap **⏸️ Hold sale** to park the customer\u2019s cart while you serve someone else (one held sale at a time); bring it back when they are ready.'] }],
  }),
  waterStock: (M) => ch('stock', '📥', 'Restocking and stock control', {
    steps: [
      '**📥 Restocking:** choose the material or product (or type a new name), type the quantity (decimals allowed) and the cost ▸ **💾 Record Restock**. Use **⬆️ Import Excel/CSV** for a list.',
      '**📋 Inventory:** tap any item to correct its quantity or price. Materials used by refills and production are deducted automatically from their recipes.',
      '**📦 Stock Report** shows movement for the period; **↩️ Returned Goods** puts returned bottles/bales back or records faulty ones.',
    ],
    tips: ['Check the **🚰 Bulk Tank** level regularly — refill sales draw from it.'],
  }),
  waterReports: (M) => ch('reports', '📊', 'Reports and Daily Sales', {
    steps: [
      '**📊 Daily Sales** lists every sale for Today, a Week, a Month or a Custom range, by payment method, for the **site you are in**. Print the report from there; a wrong sale can be voided (stock and tank litres come back).',
      'On the same tab, **📋 X Report** gives an interim reading of today’s trading (transactions, sales, tax breakdown) that can be generated any number of times without closing anything; **🔒 Z Report** shows the same totals and lets the Admin **finalize** the trading day once, behind the management password.',
      '**🔍 Audit** is a searchable, read-only timeline of sales, voids, discounts, stock changes, X/Z Reports and KRA/eTIMS classification changes — who did what, and when.',
      '**📦 Stock Report** — movement of products and materials.',
      '**💰 Profits & Expenses** — add expenses (fuel, wages, electricity…) and see profit.',
      '**📈 Demand Trends** — which refill sizes and products sell most, and when.',
      '**📊 Dashboard** — today\u2019s figures the moment you open the app.',
    ],
  }),
  waterOffline: (M) => ch('offline', '📶', 'Offline, sync and backups', {
    steps: [
      '**Offline:** the app keeps working with no internet; sales, tank levels and receipts are saved on the device.',
      '**Sync:** when the internet returns the dot turns green and every device catches up.',
      '**Backups:** ⚙️ Settings ▸ 🗄️ Backups. Your data is also stored on the server, so a lost phone does not lose your business.',
      '**Sites:** switching between the Shop and Production only changes what you look at and record; both are always saved.',
    ],
    tips: ['Use **Settings ▸ Install App ▸ 🔄 Re-download for Offline Use** after an update if the app ever fails to open offline.'],
  }),
  ownerOffline: (M) => ch('offline', '📶', 'Backups and your own data', {
    steps: ['The console keeps working through short internet cuts and catches up when it is back.', 'Settings ▸ 🗄️ Backups keeps your own business data safe; every client\u2019s data is stored on the server and can be restored by you.', 'Use **Settings ▸ ✉️ Email (Password Resets)** so clients (and you) can reset a forgotten password by email, and **📸 AI Capture List** to add the AI key that reads photos of stock lists for your clients.'],
  }),
  ownerTrouble: (M) => ch('trouble', '🛟', 'When something is wrong', {
    steps: [
      '**A client says the app is slow or broken:** open **🐞 Errors** and **💾 Storage** — a shop that is too big or repeating an error shows up there.',
      '**A client is locked out:** find them under **Demo** or **Permanent** and unlock, or extend the demo.',
      '**A staff member cannot sign in:** send them a fresh staff link from **👥 Staff** (an old link may pre-date a change).',
      '**A payment reminder keeps showing for a client:** it stays until their admin taps OK; settle or remove the bill under their record.',
    ],
  }),
};
function tabsChapter(M) {
  const tabs = M.tabs.map((t) => {
    const stem = t.replace(/^[^\p{L}]+/u, '').replace(/\d+$/, '').trim();
    const text = (M.tabText && M.tabText[stem]) || TAB[stem];
    if (!text) throw new Error(`${M.key}: no description for the tab "${stem}"`);
    return [stem, text];
  });
  return ch('alltabs', '🗂️', 'Every tab at a glance', { intro: `The tabs of ${M.name}, in the order they appear:`, tabs });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------------------------------------------------------------------------
const MODS = {};

MODS.shop = {
  name: 'Shop POS', title: 'Shop POS — User Guide', tagline: 'Retail shops, supermarkets, hardware and general stores — selling, stock, bills and reports.',
  itemsPlural: 'items', itemWord: 'item', addTab: '📦 Add New Items', restockTab: '📥 Restock',
  tabs: ['🛒 Sales Counter', '🔥 Gas Refill', '📊 Dashboard', '📋 Inventory', '📦 Add New Items', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🍽️🛏️ Tables & Rooms', '↩️ Returned Goods', '🚚 Deliveries', '🔀 Cross-Branch Sales', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Demand Trends', '🧾 Bills', '📒 Debts', '🤝 Trade Credits', '👤 My Customers', '📑 Contracts', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  custom: [
    ch('items', '📦', 'Adding items', {
      steps: [
        'Open **📦 Add New Items**. Choose **Add One Item**: type the name, the **selling price**, the **buying (cost) price**, the starting **quantity** and the unit (pieces, kg, litres, box…). Save.',
        'For many items at once use **Add Multiple Items (Bulk)**, or **⬆️ Import from Excel/CSV** on the Inventory tab (columns: Category, Code, Name, Price, Cost Price, Unit, Qty).',
        '**Item already there?** If the name you typed (any capitals or spacing) or a bulk row matches an item you already have, the app does not give an error or add a second copy: it says so and asks — **✏️ Update the existing item** (the price you typed is applied and the quantity is **added** to its stock), **➕ Add as a variant** (a new size / colour of the same item; Hotel and Hospital save it as its own item named like "Mango Shake — Large"), or **Cancel**. In Bulk Add you choose per row, or set all rows at once.',
        '**📸 Capture List:** photograph a supplier invoice or handwritten stock list and the app reads the lines; check them and confirm.',
        'Give each item a **code** or scan its barcode (📷) so it can be found by scanning. **🔖 Barcode** prints labels.',
        'Items sold by the box **and** by the piece: tick **Dual unit**, enter pieces per box and the piece price. Bags sold whole **and** loose (cement in 50 kg bags and by the kilo): set the loose unit; one stock balance serves both.',
      ],
      tips: ['Edit any price or quantity later from the **📋 Inventory** tab (tap the item).', 'Set the **low-stock level** in Settings ▸ Tax & Alerts.'],
    }),
    ch('sale', '🛒', 'Making a sale (Sales Counter)', {
      steps: [
        'Open **🛒 Sales Counter**. Type part of a name or code in the search box (or scan a barcode, or tap a picture in the items grid). The item goes into the cart.',
        'Change the quantity with **+ / −** or type it. For box/piece or bag/kg items, tap the unit toggle on the line.',
        'Optional: type the customer\u2019s phone to send a thank-you SMS, pick **Delivery** to add an address, zone, fee and driver.',
        'Choose the **payment method** (see **Taking payment**) and tap **Complete**. The receipt preview opens — print or share it.',
        'Stock is reduced automatically. To undo a sale, **void** it from Daily Sales.',
      ],
    }),
    ch('gas', '🔥', 'Gas refills', {
      steps: [
        'Open **🔥 Gas Refill**. **➕ Add size** for each cylinder size (6 kg, 13 kg…) with its Full and Empty counts and the refill, full-cylinder and empty prices.',
        'Sell: **🔄 Refill / Exchange** (customer returns an empty, gets a full: Full −1, Empty +1), **🛢️ Full cylinder** (to keep), **📦 Complete set** (cylinder plus ticked accessories like a regulator) or **⚪ Empty cylinder** on its own.',
        '**Cylinders with the supplier:** send empties to the supplier and receive them back full — the Full / Empty / With supplier counts stay right.',
        'Accessories are ordinary inventory items: mark them under **Mark as accessory** to offer them in sets.',
      ],
    }),
    ch('delivery', '🚚', 'Deliveries', {
      steps: [
        'Set **Settings ▸ 🚚 Delivery Zones** (each zone\u2019s fee and cost) and **🛵 Delivery Agents** (your drivers).',
        'On the Sales Counter choose **Delivery**, fill the address, zone and agent, and pick **Paid Now** or **Pay on Delivery**.',
        'The driver sees the order in **🚚 Deliveries** and moves it: Picked Up → On Route → Delivered.',
      ],
    }),
    ch('more', '🏬', 'Store, branches, contracts and credits', {
      steps: [
        '**🏬 Store** is a separate warehouse list; take items from it into inventory when you move them to the shop.',
        '**🔀 Cross-Branch Sales** — with branches linked (Settings ▸ Branches) you can sell an item another branch holds.',
        '**📑 Contracts** — wholesale customers with agreed terms and a running balance.',
        '**🤝 Trade Credits** — money you owe another business, or that they owe you.',
      ],
    }),
  ],
};

MODS.hotel = {
  name: 'Hotel POS', title: 'Hotel POS — User Guide', tagline: 'Restaurants, bars, hotels and lodges — dishes, kitchen, tabs for tables and rooms, bills and reports.',
  itemsPlural: 'items and dishes', itemWord: 'item', addTab: '📦 Add New Items', restockTab: '📥 Restock',
  tabs: ['🛒 Sales Counter', '🍳 Kitchen', '🧾 Tabs', '🍽️ Service Orders', '📺 Kitchen & Bar Display', '🍺 Bar & Kegs', '🎱 Facilities', '🏨 Hotel', '🎂 Custom Orders & Events', '📈 Hospitality Reports', '📊 Dashboard', '📋 Inventory', '📦 Add New Items', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🍽️🛏️ Tables & Rooms', '↩️ Returned Goods', '🚚 Deliveries', '🔀 Cross-Branch Sales', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Demand Trends', '🧾 Bills', '📒 Debts', '🤝 Trade Credits', '👤 My Customers', '📑 Contracts', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Kitchen': 'Dishes prepared and sold today: log portions prepared, see sold and left, shelf life.',
    'Tabs': 'Open tabs for a table, room or guest: add rounds of orders over time, settle at the end.',
    'Service Orders': 'Waiters take orders here — no Sales Counter needed: pick the table or room (and a customer name if you like), tap the items, then POST ORDER: the kitchen and the bar each get their slip (no prices). Tap 📋 Orders to see your own orders: UPDATE ORDER to add, remove or exchange items (only the change prints), SETTLE to print the customer\'s bill with prices, the total and the shop\'s payment details — the cashier takes the payment. Cashiers and supervisors also see QR orders, move / split / merge and the station settings here.',
    'Bar & Kegs': 'Shots, doubles and bottles from open bottles; draught kegs (take from the store, connect, replace, wastage, measure), low-keg alerts, keg reconciliation and the bar audit.',
    'Kitchen & Bar Display': 'The screen for the kitchen, the bar, the bakery… each sees only its own items: New → Accepted → Preparing → Ready → Served, with the waiting time, late orders in red and rush orders first. Waiters are told when their items are ready.',
    'Facilities': 'Pool, pool / snooker tables, cabanas, conference rooms…: start, pause and end timed sessions, sell pool passes (with capacity and expiry), and book any facility without double booking. Time and passes go on the customer\u2019s one bill with their food and drinks.',
    'Custom Orders & Events': 'Custom cakes, special meals and platters, catering and events: take the details (size, flavour, message, allergies, guests, menu…) and reference pictures, quote, record the customer\u2019s approval, take the deposit (a real payment with a receipt), schedule, produce, quality-check, tell the customer it is ready, and collect the balance. Events can book their venue; packages (e.g. a family pool package) sell food, drinks and pool access as one priced item.',
    'Hospitality Reports': 'For a day or a period: sales, payments (cash, M-Pesa — with any not verified — card), what is still outstanding and the estimated profit, kept apart; by outlet, order type, source, waiter and table; top products and drinks; every order change with its reason; hotel occupancy and room revenue; pool passes and busiest hour; pool-table hours and use; custom orders and their balances.',
    'Hotel': 'Rooms at a glance for the next 14 days, reservations (never sold twice), arrivals and check-in, housekeeping (dirty → cleaning → clean → inspected), service requests (towels, cot, decorations…) and room types with their nightly rates.',
    'Tables & Rooms': 'Set up your tables, rooms and utensils (generate Table 01… in one go).',
  },
  custom: [
    ch('items', '🍽️', 'Adding your menu, drinks and ingredients', {
      intro: 'The Hotel has three kinds of thing. Pick the kind at the top of **📦 Add New Items**:',
      steps: [
        '**📦 Item** — something you stock and count: a bottle of soda, a packet of sugar. It has a quantity and goes down when sold.',
        '**🧂 Ingredient** — a raw material used in recipes (flour, cooking oil). Counted in kg / litres; it goes down when a dish made from it is sold.',
        '**🍽️ Dish** — a menu item the kitchen makes (Tea, Rice, Beef Stew). A plain dish just has a **price**. Tick **Made from ingredients** to add a recipe so its ingredients are used up as it sells. **Dishes always sell — they are never blocked by stock.**',
        '**Upload a whole menu:** on **📋 Inventory** tap **⬆️ Import from Excel/CSV**. A sheet with names and prices (or a column **Item Type = Dish**) is added as Dishes — the review says "Add these as: Dishes". Re-importing a menu updates prices and turns items that were imported by mistake into Dishes.',
        '**Photograph a menu:** **📸 Capture List**, tick **This is a menu / price list — add it as Dishes**, take the photo, check the prices, confirm.',
      ],
      tips: ['Give dishes a category (Hot Beverages, Meals…) — the import keeps it.', 'The Inventory **Used** column shows how much of each ingredient the sales have consumed.'],
    }),
    ch('categories', '🏷️', 'Categories and importing a list', {
      intro: 'Every kind of stock (Items, Ingredients, Dishes, Services, Utensils, Bar) has its own categories. "Drinks" under Dishes and "Drinks" under Items are two separate categories, and stock with no category is just **Uncategorized** — nothing is ever lost.',
      steps: [
        'On **📋 Inventory** tap **🗂️ Categories & assign**, choose the kind, then create, rename, switch on/off, reorder or delete categories. Deleting asks where the stock goes (another category of the same kind, or Uncategorized) — the stock itself is never deleted.',
        'To change many at once, tick the records and choose a category under **Assign selected**. A category can only be given to stock of its own kind.',
        'On the **🛒 Sales Counter** and in **🍽️ Service Orders**, the categories are chips above the pictures: tap one to filter, **All** to clear. Search works inside the chosen category and **Show more** loads the next page.',
        'Tap **⬆️ Import** for an Excel or CSV list: pick the file, check the columns, read the preview, then confirm. In **All** mode each row needs a type (a Type column, your choice, or the built-in suggestion).',
        'New categories in a file are created only when you agree. Similar names (Beverage / Beverages) are never merged automatically — you decide. For records that already exist choose **Skip**, **Update** or **Create new**; quantities and pictures are only changed if you tick that box.',
        'Rows with a problem are listed (you can download them) and the rest are imported.',
      ],
      tips: ['Only staff with Inventory or Add New Items access can manage categories or import.', 'A category you turn off disappears from the chips, but its stock is still sold under All.'],
    }),
    ch('sale', '🛒', 'Making a sale — walk-in customers', {
      steps: [
        'Open **🛒 Sales Counter**, search or tap dishes and drinks to build the cart, set quantities.',
        'Choose the **payment method** (cash tendered is optional but recommended) and **Complete**. A **kitchen / bar ticket** prints for the order and the receipt preview opens.',
        'The order ticket prints as a short slip in pure black, the same width as the receipt.',
      ],
    }),
    ch('opentabs', '🧾', 'Tabs: tables, rooms and guests who pay later', {
      steps: [
        'Set up tables and rooms once in **🍽️🛏️ Tables & Rooms** (**Generate Tables**, **Generate Rooms**).',
        'Open **🧾 Tabs** ▸ **➕ Open New Tab**, choose the table, room or guest.',
        'Each time they order, add the items to the tab: **every round prints its own kitchen/bar ticket**. The tab keeps a running total.',
        'When they leave, **settle the tab** (cash, M-Pesa, card, split) — it becomes a normal sale and receipt. A tab can also be put on **Bill (Pay Later)**.',
        'Voiding a tab gives its dishes and ingredients back.',
      ],
    }),
    ch('kitchen', '🍳', 'Kitchen tab: prepared, sold, left', {
      steps: [
        'Open **🍳 Kitchen**. Without logging anything, each dish just shows how many it **sold today**.',
        'To track portions, log **Servings Prepared** when the kitchen cooks a batch (optionally a batch with a **shelf life** in days). The tab then shows **Prepared / Sold / Left**.',
        'Sales use up the prepared portions; a void gives a portion back. Two tills\u2019 sales and preparations add up on both.',
      ],
      tips: ['A finished batch is closed so old sales never eat a new batch.'],
    }),
    ch('split', '👥', 'Splitting a bill', {
      intro: 'Guests at one table can pay separately. Open the order, tap **Settle**, then:',
      steps: [
        '**👥 Split by person** — tick what this person had (e.g. 1 burger, 1 beer). Their share of the service charge is added. Choose cash, M-Pesa or card and **Take this payment**. They get their own receipt.',
        '**➗ Pay a share (amount)** — type what this person pays, or tap **÷ equally** to split the balance between a number of people.',
        'Repeat for each person. The order shows **paid so far** and the **balance**. The last payment closes it, or **Settle** takes the rest — its receipt lists what was not paid yet, less the shares already taken.',
        'Items already paid for can\u2019t be removed or moved to another table. A voided part puts its amount back on the balance.',
      ],
    }),
    ch('bar', '🍺', 'Shots, doubles, bottles and draught kegs', {
      intro: 'Everything is in **🍺 Bar & Kegs**. Packaged drinks (a 500 ml Tusker bottle, a can) stay ordinary items: 1 sold = 1 off.',
      steps: [
        '**A bottle sold by the shot:** in **⚙️ Set up a drink**, pick the bottle (e.g. Johnnie Walker Black), its size (750 ml), and tick the servings with their size and price — **Shot 30 ml KES 350**, **Double 60 ml KES 650** — and the price of the whole **Bottle**. The business default shot size is set once (e.g. 30 ml); a product can use its own (40 ml, 50 ml).',
        '**Selling:** on the **🛒 Sales Counter** the bartender taps **SHOT**, **DOUBLE** or **BOTTLE** under the drink. Nobody types millilitres. A shot takes 30 ml from the open bottle; a new bottle is opened by itself; a whole bottle is always a sealed one. The till never sells more than is there ("Only 20 ml left").',
        '**Stock:** each bottle shows **full bottles · 1 open (450 ml) · ml in all**. In **📋 Stock Take** count the full bottles and the ml in the open one — an open bottle is never counted as full.',
        '**A keg:** set up the keg product (e.g. Tusker Lager Keg, **50 L**, low alert at **5 L**) with its servings (**300 ml**, **500 ml**, **1 L**) and prices. Receive kegs in **📥 Restock** (they are the sealed kegs in the store).',
        '**Take a keg from the store** and connect it to a tap. Each keg has its own number, tap, status (Full, Active, Low, Empty, Disconnected, Closed, Spoiled) and history. Selling 500 ml takes 500 ml from the oldest active keg; when it runs dry the next full keg is connected by itself (you can switch that off).',
        '**Replace** a keg (the old one is closed at what is left, written off with its history kept, and the next one goes on the same tap), record **💧 Wastage** (spillage, foam, leakage… — a reason is required), **📏 Measure** what is really in a keg, **Close** or mark **Spoiled**.',
        '**🧮 Keg reconciliation:** opening − sold − wastage = expected; measured − expected = **variance**. **📈 Hospitality Reports** also show beverage sales by serving, shots, and kegs.',
        'Keg and shot drinks work everywhere: tables, bar orders, room service, charge to a room, split bills, QR orders (only when there is stock). Two bartenders on two tills — even offline — always add up.',
        'Only managers, supervisors and storekeepers (**bar.manage**) can set up drinks, change sizes or prices, take / replace / close kegs, record wastage or measure. Bartenders sell and see the kegs. Every action is in the **📜 Bar audit**.',
      ],
    }),
    ch('levels', '⭐', 'Loyalty member levels', {
      steps: [
        'In **⚙️ Settings ▸ Loyalty**, under the spend brackets, add **member levels** (e.g. Silver from KES 20,000, Gold from KES 100,000) with a **token multiplier** and **perks**, and the period that counts (365 days, or 0 for ever).',
        'A customer\u2019s level comes from what they spent in that period — worked out from the sales, so every till agrees. Their sales earn tokens × the multiplier; reaching a level is announced.',
        'When you settle an order for a member, their level and perks are shown. Paying an order (tab) now earns tokens too. Any discount stays your decision.',
      ],
    }),
    ch('staffsessions', '👤', 'Staff sessions (the server checks who is working)', {
      steps: [
        'Staff still sign in with their PIN, even offline. When the device is online, the same PIN also starts a **server session** for that person.',
        'Every new sale is signed with the serving staff member\u2019s session, and the server checks it. **📈 Hospitality Reports ▸ Who made each sale** shows confirmed, waiting, not signed and ⚠ flagged sales (e.g. a waiter who may not take payments, or a sale changed after it was made). No sale is ever refused or hidden.',
        'Signed in offline? The sales are signed once the device is back online (covering up to a day).',
        '**⚙️ Settings ▸ 🔐 Devices & Security ▸ Staff sessions required** (Admin or a manager): the server then refuses QR codes, the online menu, bookings and M-Pesa checks without a confirmed staff member, and QR codes / the menu need a supervisor. Selling is never blocked.',
      ],
    }),
    ch('closed', '🧾', 'Bills for hotels', {
      steps: ['Rooms and corporate customers often pay later: use **Bill (Pay Later)** or leave the tab open.', 'Settle from **🧾 Bills**. Paid bills stay under **Show closed bills** so you can look back.'],
    }),
  ],
};

MODS.hospital = {
  name: 'Hospital POS', title: 'Hospital POS — User Guide', tagline: 'Clinics and hospitals — registration, queue, consultation charges, laboratory, pharmacy, wards and beds, insurance and reports.',
  itemsPlural: 'medications and supplies', itemWord: 'medication', addTab: '➕ Add Medication', restockTab: '📥 Restock',
  tabs: ['📊 Dashboard', '🛎️ Reception', '📅 Appointments', '🚦 Triage', '🩺 Clinic / Consultation', '🚑 Emergency', '🤰 ANC / Maternity', '⏱️ Labour & Delivery', '🤱 Postnatal', '👶 Newborn / Child Health', '🧪 Laboratory', '🩻 Radiology', '🩹 Procedures / Theatre', '💳 Cashier / Counter', '💊 Pharmacy (Dispensing)', '📦 Pharmacy Stock', '➕ Add Medication', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🏥🛏️ Wards & Beds', '↩️ Returned Goods', '🚚 Deliveries', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Medication Demand', '🧾 Patient Bills', '📒 Debts', '📊 Hospital Report', '👤 My Customers', '🏥 Insurance / Institutions', '🗂️ Patient Records', '➡️ Referrals', '🏁 Discharge', '💵 Cashier Shift', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Reception': 'Search for one patient (name, patient number or phone) or register a new one, then ask \u201cWhere are you going today?\u201d: tap the service (General Clinic, ANC, Maternity, Child Health, Immunization, Family Planning, TB, HIV/CCC, Dental, Eye, Lab, Pharmacy, Emergency\u2026) and the patient gets a ticket in THAT queue. No clinical history is shown here.',
    'Clinic / Consultation': 'The consulting clinics (General Clinic / OPD, Chronic, TB, HIV/CCC, Dental, Eye, Specialist, Family Planning and any you add), each with its own queue: NOW SERVING, the next 5, CALL NEXT PATIENT. Open the consultation, then send the patient on (lab, pharmacy, cashier, discharge). You can still search any patient below.',
    'Triage': 'The triage queue: call the next patient, record vitals, then choose where they go next (the vitals travel with them). The table below lists everyone in the facility today.',
    'Emergency': 'The Emergency / Casualty queue \u2014 emergency patients are always called first. Treat, then send on or finish the visit with the outcome.',
    'ANC / Maternity': 'The ANC and Maternity admission queues, plus every current pregnancy (gestation, EDD, risk flags). The maternity record holds the ANC profile and visits, labour, delivery, postnatal care and the newborn \u2014 one record for the mother\u2019s whole journey.',
    'Labour & Delivery': 'The labour ward queue and the mothers in labour (latest dilation, partograph alert). Record observations and the delivery in the mother\u2019s record; the baby is registered and joins the Newborn care queue.',
    'Postnatal': 'The postnatal queue and the mothers delivered in the last 6 weeks.',
    'Newborn / Child Health': 'Newborn care, Child Health (CWC) and Immunization queues, and the babies of the last 28 days (each with its own record linked to the mother).',
    'Referrals': 'Every referral: internal ones (the patient is put straight into the other department\u2019s queue) and external ones (print the letter, track sent / received / completed).',
    'Discharge': 'The discharge queue and every visit finished today with its outcome (discharged, follow-up, admitted, referred out) and the patient\u2019s journey.',
    'Appointments': 'Schedule patients ahead; mark completed, cancelled or no-show.',
    'Laboratory': 'Every lab test requested, with results; requests get their own reference.',
    'Cashier / Counter': 'The Cashier: load a patient\u2019s bill (or sell to a walk-in), take payment, print. Paid medicines then go to the Pharmacy to be collected.',
    'Pharmacy (Dispensing)': 'The Pharmacy station: its own queue, and every paid prescription waiting to be handed over. Mark each one dispensed (or not collected, with a reason); unpaid ones go to the Cashier first.',
    'Pharmacy Stock': 'The medication stock list: valuation, expiry horizon, current inventory and services.',
    'Patient Records': 'Admin/records tool: the full patient registry, with edit, merge, timeline and maternity/newborn access. Day-to-day lookup should use Reception or Diagnosis instead.',
    'Add Medication': 'Add medications (with dosing rules) and services (consultation, procedures, nursing).',
    'Wards & Beds': 'Set up wards and beds; admit patients, collect deposits, charge bed and nursing rates, discharge.',
    'Medication Demand': 'Which medications sell most and when.',
    'Patient Bills': 'Bills waiting to be paid (Pay Later) and outstanding balances; settle them here.',
    'Hospital Report': 'Illness statistics, ICD-10 coded diagnoses, doctor consultation volumes and the audit log.',
    'Insurance / Institutions': 'Register NHIF, insurers and employers; bill visits to their account and track claims.',
    'Cashier Shift': 'Open a shift with a cash float, count and close it, and request/approve refunds.',
    'Radiology': 'X-ray, ultrasound, CT, MRI: request, schedule, perform, report and verify imaging. Attach the images from the device (🖼️ Add images): they are compressed before upload and can be viewed on any device.',
    'Procedures / Theatre': 'The Procedures / Treatment queue, and surgical cases: schedule, consent, pre-op, team, procedure/anaesthesia/post-op notes, consumables.',
  },
  custom: [
    ch('flow', '🏥', 'The patient journey, step by step', {
      steps: [
        '**Register or find:** **🛎️ Reception / Registration** ▸ search the patient, or register a new one (they get a **patient number**).',
        '**Where are you going today?** Tap the service \u2014 General Clinic, ANC, Maternity, Child Health, Immunization, Family Planning, TB, HIV/CCC, Dental, Eye, Laboratory, Pharmacy, Emergency, Triage\u2026 Set **Priority** if needed (the reason is recorded). The patient gets a **ticket** (e.g. **G-012**) in THAT station\u2019s queue. Nobody is forced through stations they do not need.',
        '**Every station** (Triage, each clinic, ANC, Labour, Lab, Pharmacy, Cashier\u2026) shows **NOW SERVING**, the **NEXT 5** in order, and **📢 CALL NEXT PATIENT**. Emergency and priority patients are called first. **📺 Display** shows only ticket numbers for a waiting-room screen.',
        '**Serving:** the buttons match the station \u2014 record vitals (Triage), open the consultation (clinics), the maternity record (ANC / Labour / Postnatal), tests and results (Lab), take payment (Cashier), hand over the medicines (Pharmacy).',
        '**Send to\u2026:** when you are done, send the patient on \u2014 the likely next station is highlighted (a pending test \u2192 Lab; medicines \u2192 Pharmacy). From the Lab they come **back to the same clinic for review**. Tick **internal referral** to also record a referral.',
        '**Finish visit:** discharged home, follow-up (books the appointment), admitted, referred to another facility (print the letter from the consultation), left before being seen. Nothing is deleted.',
        '**🧭 Journey** shows every station the patient went through, who sent and called them, and when \u2014 it is also on the patient\u2019s Full History.',
        '**Charges:** a consultation files everything as an **unpaid bill** under a **visit reference** (like `V260921-4F2K`); the **Cashier** loads it at the counter and takes one payment (cash, M-Pesa, SHA / insurance as set up). Stock comes out when it is paid. The patient then collects the medicines at **💊 Pharmacy**, which records who dispensed what. A cashier who needs a void or a discount can **request** it: a manager approves it in **💵 Cashier Shift ▸ Approvals**, from any device.',
      ],
      tips: ['Settings ▸ 🏥 Stations & Services: switch stations on or off, rename them, set ticket letters, choose what Reception offers, add your own clinics.', 'A patient already on today\u2019s list is MOVED, never added twice \u2014 even if two devices did it at once while offline.'],
    }),
    ch('meds', '💊', 'Adding medications and services', {
      steps: [
        'Open **➕ Add Medication**. Type the name, selling price, buying price, quantity, unit and **expiry date**. Choose **Service** for fees that are not stocked (consultation, dressing, nursing) and give it a **department**.',
        '**Tablets sold loose from a pack:** set a **minimum dose** and the **allowed pack sizes** (for example 4, 6, 12, 24) in the medication\u2019s dosing settings. The counter then works in valid doses only (quick-select buttons; anything else is refused) and counts stock in tablets, so 6 tablets from a 24-tablet box leaves 18 loose.',
        'Watch expiry in **💊 Pharmacy** (**Expiry Horizon**) and stock value under **Stock Valuation**. **📥 Restock** adds deliveries; low-stock buttons make it quick.',
      ],
    }),
    ch('dispense', '💊', 'Dispensing and the dosage box', {
      steps: [
        'On **💊 Dispense / Bill** you can also sell straight to a walk-in: search a medication, add to the cart.',
        'Under every medication in the cart there is a **Dosage** box: type the instruction (for example "1 x 3 for 5 days"). It is saved on the sale and printed under the medicine.',
        'The receipt is **sectioned**: **SERVICES & HOSPITAL FEES** and **DISPENSED MEDICATIONS**.',
        'Payment: cash, M-Pesa, split or Bill (Pay Later); or bill an **institution** (below).',
      ],
    }),
    ch('lab', '🧪', 'Laboratory', {
      steps: ['Request a test from **🧪 Laboratory** (**+ Request**) or from inside a patient\u2019s visit; it gets its own reference and goes to the cashier.', 'Once paid it shows **Paid — ready for sample**. Enter the result when ready; filter by Pending / Completed / All.'],
    }),
    ch('wards', '🛏️', 'Wards and beds (inpatients)', {
      steps: [
        'In **🏥🛏️ Wards & Beds** type how many wards and beds you have and tap **Generate Wards** / **Generate Beds** (10 gives Ward 01–10).',
        '**Admit Patient:** choose the patient and bed, type the admission diagnosis, **deposit collected**, the **daily bed rate** and **daily nursing rate**.',
        'Active admissions show under **Active Admissions**; discharging bills the stay, and it appears in **Discharge History**.',
      ],
    }),
    ch('insurance', '🏢', 'Insurance and institutions', {
      steps: ['In **🏥 Insurance / Institutions** ▸ **Register Institution**: NHIF, an insurer or an employer, with a contact person and phone.', 'A visit can then be billed to the institution\u2019s **account** instead of the patient. Track what each owes under **Institution Accounts** and **Insurance Claims**, and settle it when they pay.'],
    }),
    ch('hreport', '📊', 'Hospital report and audit', {
      steps: ['**📊 Hospital Report** shows illness statistics, the top illnesses by month, **ICD-10 coded diagnoses** (print the ICD-10 report), doctor consultation volumes, and the audit log.'],
    }),
  ],
};

MODS.pharmacy = {
  name: 'Pharmacy POS', title: 'Pharmacy POS — User Guide', tagline: 'Pharmacies and chemists — dispensing with dosage instructions, batches and expiry, patients and laboratory.',
  itemsPlural: 'medicines', itemWord: 'medicine', addTab: '📦 Add New Items', restockTab: '📥 Restock',
  tabs: ['🛒 Sales Counter', '🧑‍⚕️ Patients', '📊 Dashboard', '🧪 Laboratory', '📋 Inventory', '📦 Add New Items', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🍽️🛏️ Tables & Rooms', '↩️ Returned Goods', '🚚 Deliveries', '🔀 Cross-Branch Sales', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Demand Trends', '🧾 Bills', '📒 Debts', '🤝 Trade Credits', '👤 My Customers', '📑 Contracts', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Patients': 'Optional patient registry: build a history of what each patient was sold.',
    'Laboratory': 'Lab test requests and results linked to the patient.',
    'Sales Counter': 'Dispense and sell medicines: search or scan, dosage instructions, payment, receipt.',
  },
  custom: [
    ch('items', '💊', 'Adding medicines (with batches and expiry)', {
      steps: [
        'Open **📦 Add New Items**: name, selling price, buying price and unit. Medicines are tracked in **batches**: add a batch row for each delivery with its **quantity and expiry date**. Stock is always sold from the **soonest-expiring batch first**.',
        'Import a whole list with **⬆️ Import from Excel/CSV** on the Inventory tab, or photograph a supplier invoice with **📸 Capture List**.',
        'Received an order? When an order **arrives**, each item becomes a **new batch** with its own expiry, so the oldest batch is watched separately.',
        'Items close to expiry are flagged **⏳ Expiring soon**; on the Inventory tab tap **🖨️ Print Expiring Items** for a list you can act on.',
      ],
    }),
    ch('sale', '🛒', 'Selling and dispensing', {
      steps: [
        'Open **🛒 Sales Counter**, search or scan the medicine and add it to the cart.',
        'Under each medicine there is a **Dosage** box: type the instruction ("1 x 3 for 5 days"). It is saved on the sale and printed under the medicine on the receipt.',
        'Optionally attach a patient (if registered) and the customer\u2019s phone, then take payment (cash, M-Pesa, card, split or Bill).',
        'Complete — the receipt preview opens; print or share it.',
      ],
    }),
    ch('patients', '🧑‍⚕️', 'Patients and laboratory (optional)', {
      steps: ['**🧑‍⚕️ Patients ▸ + Register New Patient**: registering is always optional — walk-in customers can still be sold prescription items. Register regulars to build a purchase history.', '**🧪 Laboratory ▸ + New Lab Request**: order a test here or from a patient\u2019s profile; results are linked back to the patient.'],
    }),
  ],
};

MODS.production = {
  name: 'Production POS', title: 'Production POS — User Guide', tagline: 'Workshops and manufacturers — build items from components, sell, hire items out, gas refills, stock and reports.',
  itemsPlural: 'items and components', itemWord: 'item', addTab: '📦 Add New Items', restockTab: '📥 Restock',
  tabs: ['🛒 Sales Counter', '🔥 Gas Refill', '🔄 Hiring Counter', '📊 Dashboard', '🏭 Production', '📋 Build an Item', '🔄 Hires', '📋 Inventory', '📦 Add New Items', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🍽️🛏️ Tables & Rooms', '↩️ Returned Goods', '🚚 Deliveries', '🔀 Cross-Branch Sales', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Demand Trends', '🧾 Bills', '📒 Debts', '🤝 Trade Credits', '👤 My Customers', '📑 Contracts', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Hiring Counter': 'Start a hire: search a hireable item, take the client\u2019s details, billing type, deposit and payment.',
    'Production': 'Assemble a batch of an item from its components; assembly history.',
    'Build an Item': 'Define a finished item\u2019s recipe (its components); production history.',
    'Hires': 'Everything currently out on hire: who has what, when due, history and past hires.',
  },
  custom: [
    ch('items', '📦', 'Adding items and components', {
      steps: ['Open **📦 Add New Items** and add finished items you sell **and** the components you build them from (cells, casings, acid…) with buying prices and quantities.', 'Mark an item **hireable** and give it a **hire price per day** if it can be rented out.', 'Import lists from Excel on the **📋 Inventory** tab.'],
    }),
    ch('build', '🏭', 'Building (producing) items', {
      steps: [
        '**📋 Build an Item:** choose an item (or **+ Create Item**), then add its **components per 1 unit** with **+ Add Component** (for example a battery = cells + casing + acid). Set the selling price; the cost is auto-filled from the recipe (you may override it). **💾 Save Item**. This only declares the recipe — it does not use stock.',
        '**🏭 Production:** choose the item and the **quantity to assemble**, then **🔨 Assemble & Add to Stock**. The components are deducted and the finished items are added. **📜 Assembly History** lists every batch.',
      ],
      tips: ['If a component is short the assembly tells you which one.'],
    }),
    ch('sale', '🛒', 'Selling', {
      steps: ['Open **🛒 Sales Counter**, search or scan items, set quantities, choose the payment method and **Complete**. The receipt preview opens.', '**🔥 Gas Refill** works exactly as described in the Shop guide: refills, full cylinders, empties, accessories and cylinders with the supplier.'],
    }),
    ch('hire', '🔄', 'Hiring items out', {
      steps: [
        'Open **🔄 Hiring Counter**. Search for a hireable item and tap it — it goes into the **Current Hire Cart**.',
        'Tap **Complete Checkout**: enter the **client name, ID number and phone**, choose the **billing type** — **Fixed days** (enter the number of days) or **Count as you go** (charged when returned) — and take a **deposit** if you want one.',
        'Pay now with **Cash / M-Pesa / Split**, or **Bill (Pay Later)**.',
        'Follow everything that is out in **🔄 Hires**: tap a client for what they have, when it is due and a shareable PDF. When items come back, return them there and the balance is worked out. **🕓 Record Past Hire** records a hire you forgot to enter.',
      ],
    }),
  ],
};

// Services engine chapters (SERVICES_ARCHITECTURE.md Appendix A): empty until the engine UI ships (B4 adds them, then runs `npm run guides` and `npm run sync`).
// Add ch(...) entries here (e.g. 'Choosing your business type', 'Job board and quotes'); they are appended to the Services POS guide after its own chapters.
// Keep every tab label of the Services app described in TAB / tabText (tests/guides.test.mjs).
const SVC_GUIDE_CHAPTERS = [];

MODS.services = {
  name: 'Services POS', title: 'Services POS — User Guide', tagline: 'Repair shops, salons and service businesses — job intake, client registry, bookings, parts sales and reports.',
  itemsPlural: 'items and services', itemWord: 'item', addTab: '📦 Add New Items', restockTab: '📥 Restock',
  tabs: ['🛒 Sales Counter', '🔧 Services Counter', '🔥 Gas Refill', '📊 Dashboard', '🗂️ Client Registry', '📋 Inventory', '📦 Add New Items', '📥 Restock', '🛍️ Orders', '📋 Stock Take', '📊 Reports', '🔍 Audit', '📒 Accounts', '🏬 Store', '🔖 Barcode', '🍽️🛏️ Tables & Rooms', '↩️ Returned Goods', '🚚 Deliveries', '🔀 Cross-Branch Sales', '📅 Bookings', '🧾 Daily Sales', '📦 Stock Report', '💰 Profits & Expenses', '📊 Demand Trends', '🧾 Bills', '📒 Debts', '🤝 Trade Credits', '👤 My Customers', '📑 Contracts', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Services Counter': 'Check in a client\u2019s job (item left, condition, quote, promised time), track its status, take payment when done.',
    'Client Registry': 'Every service job: what was left, what is being done, when it is due back.',
    'Bookings': 'Book a service against a staff member\u2019s schedule; two bookings can never overlap for the same person.',
    'Sales Counter': 'Sell parts and products over the counter.',
  },
  custom: [
    ch('items', '📦', 'Adding items and services', {
      steps: ['Open **📦 Add New Items**. Choose **Item** for things you stock (parts, accessories) and **Service** for work you charge for (a screen replacement, a haircut) — a service has a price but no stock.', 'Bulk-add or import lists from Excel on the **📋 Inventory** tab.'],
    }),
    ch('jobs', '🔧', 'Checking in and finishing a service job', {
      steps: [
        'Open **🔧 Services Counter**. Optionally open an existing **Client Registry** job, or leave blank for a walk-in.',
        'Type the **client name and phone**, and describe **what was left** (model, serial/IMEI, condition, accessories). Set the **date and time left** and the **promised pick-up** (quick buttons **+1h, +4h, +1 day, +3 days**). Type a **quote** if you want it on the waiting receipt, and add notes.',
        'Add the services and any parts to the job. Tap **💾 Save & Check In** (or **📋 Full Intake Form** for the long form) and **🖨️ Print Intake Tag** to stick on the item.',
        'Track the job\u2019s **status** in **🗂️ Client Registry** (**+ New Client / Job** to log one directly).',
        'When the client collects: choose the payment (**Cash / M-Pesa / Split**, or **📲 Send STK Push**) and tap **✅ Complete & Print Receipt**.',
      ],
    }),
    ch('bookings', '📅', 'Bookings', {
      steps: ['Open **📅 Bookings ▸ + New Booking**: pick the date, the service (anything set up as a Service), the client and the staff member.', 'Two bookings cannot overlap for the same staff member — the app tells you when a slot is taken.'],
    }),
    ch('sale', '🛒', 'Selling parts', {
      steps: ['**🛒 Sales Counter** works like the Shop: search, add, choose payment, **Complete**. **🔥 Gas Refill** handles cylinder refills and exchanges.'],
    }),
    ...SVC_GUIDE_CHAPTERS,
  ],
};

MODS.water = {
  name: 'Aqua POS', title: 'Aqua POS — User Guide', tagline: 'Water refill stations, bottled-water producers and distributors — refills, sealed bottles, bales, bulk tanks, production and deliveries.',
  itemsPlural: 'products and materials', itemWord: 'product', addTab: '📋 Inventory', restockTab: '📥 Restocking',
  tabs: ['🧾 Sales Counter', '📊 Dashboard', '📋 Inventory', '➕ Add New Items', '🧩 Materials', '📥 Restocking', '📋 Stock Take', '🚰 Bulk Tank', '🏭 Production', '🚚 Dispatch', '📅 Bulk Orders', '↩️ Returned Goods', '🚚 Deliveries', '📊 Daily Sales', '🔍 Audit', '📦 Stock Report', '💰 Profits & Expenses', '📈 Demand Trends', '🧾 Bills', '📒 Debts', '👤 My Customers', '👥 Staff', '🕐 Attendance', '💼 Payroll', '⚙️ Settings', '☰ More'],
  tabText: {
    'Sales Counter': 'New sale: refills by size or custom litres, sealed bottles, dispensers, bales; walk-in or delivery.',
    'Inventory': 'Products (bottled water, bales, accessories), materials and refill sizes with prices and recipes.',
    'Restocking': 'Top up a material or product (decimals allowed) and see restock history.',
    'Stock Take': 'Count what is really at this site — products, bottles, tank litres, materials — and correct the system to it.',
    'Bulk Tank': 'Your bulk water tanks: add water, and see each site\u2019s level drop as refills are sold.',
    'Production': 'Record what you produced; materials are deducted from its recipe.',
    'Dispatch': 'Under Logistics. Send stock and pre-filled refills from Production to a shop branch, see factory stock, shop requests and Dispatch History.',
    'Bulk Orders': 'Book large future orders with a deposit and delivery date.',
    'Daily Sales': 'Every sale for a day / week / month, filtered by payment method, for the site you are in.',
    'Demand Trends': 'Which sizes and products sell most, and when.',
    'Stock Report': 'Stock movement of products and materials.',
  },
  custom: [
    ch('sites', '🏭', 'Sites: Shop and Production', {
      steps: ['Aqua POS can run more than one **site** — for example the **Shop** and the **Production** plant. Pick the site you are working at from the switcher at the top.', 'Each site has **its own bulk tanks, refill sizes/prices and stock** — water at one site is never drawn down by a sale at another. **Both sites** is a way of *looking* at the reports; sales made while it is selected belong to the Shop.'],
    }),
    ch('sizes', '💧', 'Refill sizes and prices', {
      steps: [
        'Open **⚙️ Settings ▸ General**. Set the **Price per Litre (KES)**; every size on **Auto (× 1L rate)** follows it (a 20 L refill is 20 × the litre price).',
        'Untick **Auto** on a size to type its own price. Tap **+ Add a Size Not Listed** to add a new size (a label, its volume in **millilitres** — 2.5 L is 2500 — and a price). It appears in the list and on the counter at once; a duplicate size is refused.',
        'Set the VAT category per size, and the 🧩 **Recipe** (materials used per refill) so materials are tracked.',
      ],
    }),
    ch('sale', '🧾', 'Making a sale', {
      steps: [
        'Open **🧾 Sales Counter**. Use the filters **🧺 All / 🔄 Refill / 🍼 Sealed Bottles / 🚰 Dispensers & Accessories / 📦 Bales (Cases)** or search.',
        'Tap a **refill size** to add it, or use **Custom Refill — Litres Needed** for any volume. Tap sealed bottles, dispensers or bales to add them.',
        'Choose **🚶 Walk-In** or **🚚 Delivery** (address, zone, fee, driver). For delivery pick **💰 Paid Now** or **🧾 Pay on Delivery**.',
        'Choose the payment method (see **Taking payment**) and **Complete**. Water is drawn from the site\u2019s **bulk tank**; the app warns you if the tank is short.',
      ],
    }),
    ch('tank', '🚰', 'Bulk tanks', {
      steps: ['Open **🚰 Bulk Tank**. **+ Add Tank** for each tank at the site. When a water delivery arrives choose the tank, type the **litres added** (and cost and supplier if you like) ▸ **💾 Record Tank Refill**.', 'Every refill sale reduces the tank; **📜 Tank Refill History** lists all additions and corrections. A tank must be empty before you remove it, and each site keeps at least one.'],
    }),
    ch('prod', '🏭', 'Production', {
      steps: ['Open **🏭 Production**. Pick the item and how many you produced ▸ **💾 Record Production**; its saved **recipe** (set in Inventory ▸ 🏭 Recipe) deducts the materials and adds the finished stock.', 'For multi-stage products use **🧙 Multi-Step Production Wizard**. **Factory Floor Stock**, **Production History** and **Dispatch History** follow what was made and sent out.'],
    }),
    ch('bulk', '📅', 'Bulk orders', {
      steps: ['Open **📅 Bulk Orders**. Type the client, business, phone, **delivery date**, address, **deposit paid** and notes, add the products and quantities and **💾 Save Booking**.', 'On the delivery day fulfil the order; the deposit is counted against the total.'],
    }),
    ch('stocktakew', '📋', 'Stock Take (per site)', {
      steps: [
        'Pick the site you are counting at the top (a stock take counts **one site at a time**), then open **📋 Stock Take**. It lists that site\u2019s products (a bottle-tracked bale is counted in **bottles**), its **tank litres** and its **materials**.',
        'Type what you actually counted next to each line — lines left blank are not touched. Tap **💾 Update** on one line, or **✔ Update stock to my counts** for all of them.',
        'Each change is recorded once as a **count** ("there are 12"), not as a +/−, so refreshing, going offline or opening another device can never apply it again. **Recent stock takes** shows Was / Counted / Now for every device, with ✓ applied or ⏳ waiting to sync.',
      ],
    }),
    ch('stockw', '📥', 'Inventory and restocking', {
      steps: ['**📋 Inventory** holds bottled products, bales, accessories, materials and refill prices. Edit stock and prices by tapping an item.', '**📥 Restocking** tops up a material or product (decimals are fine, e.g. 0.5 bale, 10.5 litres) — record the supplier and cost; **⬆️ Import Excel/CSV** loads a whole list; history shows below.'],
    }),
  ],
  billsTitle: 'Bills, Pay on Delivery and Debts',
  billsSteps: ['**Pay Later / Pay on Delivery** sales wait in **🧾 Bills**. Tap **Settle** when the money is collected (full or part).', '**📒 Debts** records other money customers owe.', 'A settled bill stays visible under **Show closed bills**.'],
  noPastSale: true,
  overrides: { stock: 'waterStock', reports: 'waterReports', payments: 'waterPayments', offline: 'waterOffline' },
};

MODS.owner = {
  name: 'Owner Console', title: 'Owner Console — User Guide', tagline: 'For the owner of the software business — create and manage client links, watch their health, and run your own shop.',
  itemsPlural: 'items', itemWord: 'item', addTab: 'the Inventory', restockTab: 'Restock', noPastSale: true,
  overrides: { offline: 'ownerOffline', trouble: 'ownerTrouble', hardware: false },
  tabs: ['📊 Dashboard', '🔗 Generate Link', '🕐 Demo', '✅ Permanent', '🗑️ Trash', '🍽️🛏️ Tables & Rooms', '🌐 Website', '🛍️ Catalogue', '🧾 Bills', '🧾 Daily Sales', '💰 Profits & Expenses', '👥 Staff', '🐞 Errors', '💾 Storage', '🩺 Health', '📣 Messages', '🏷️ Offers', '💳 Billing', '📦 Apps & Versions', '⚙️ Settings', '☰ More'],
  tabText: {
    'Messages': 'Send announcements, app updates, installation offers, maintenance or security notices to all shops, chosen apps or chosen shops — optionally only on the browser, Android or Windows app and certain app versions, from / until a date. Shops see them in their app (one at a time, and under Settings ▸ Install App); a device that is offline gets them when it reconnects.',
    'Apps & Versions': 'The Android (APK) and Windows (EXE / MSI) apps of each product: add a version, upload the real file (the server records its size and SHA-256), publish, withdraw. A shop is offered only its own app under Settings ▸ Install App.',
    'Health': 'Every paying shop at once: does its stock agree with its history, items below zero, its devices and their app release, whether it only syncs with paired devices, and whether it should move to its own database. Also runs by itself each morning and emails you only when something needs attention.',
    'Dashboard': 'Your business at a glance: clients, demos, income.',
    'Generate Link': 'Create a demo or permanent POS link for a client on their own address.',
    'Demo': 'Every demo link across all products, grouped by client.',
    'Permanent': 'Every permanent (paid) client: manage, record income, remind, storage.',
    'Trash': 'Deleted links, restorable for 30 days before they\u2019re removed for good.',
    'Website': 'Edit the public website, payment methods and testimonials. Prices and the subscription are set under Billing.',
    'Billing': 'One place for every price and the subscription: Pricing (new link, add-ons, subscription, grace), Launch & exempt shops (the start date, the switch that blocks overdue shops, who is affected), Discounts, Referrals (rewards for shops that bring a paying customer), Shops (each shop\u2019s plan, paid-through date, allowances, suspend / reactivate / complimentary, payment history, audit trail) and Payments (renewals waiting for you, the ledger, reversals). Existing shops stay exempt. Every price on the website, sample shops, checkout and receipts comes from here.',
    'Catalogue': 'The products, complete systems, categories, prices, offers and pictures shown on the public /shop page and home page.',
    'Offers': 'Timed offers for the public website: write the offer, set the start and end in Nairobi time, then Publish. The website judges the countdown by the server clock; Pause, Back to draft or Archive hide it. Every change is logged.',
    'Bills': 'What clients owe you (permanent-link balances) — settle or remind.',
    'Daily Sales': 'Your own sales and income records.',
    'Profits & Expenses': 'Your expenses and profit.',
    'Staff': 'Your own staff and their access to the console.',
    'Errors': 'Errors reported by every client\u2019s app, grouped so one bug on many devices is one line.',
    'Storage': 'How big each shop\u2019s data is; compress, move to a database, shrink photos.',
    'Tables & Rooms': 'Set-up used by your own hospitality POS.',
    'Settings': 'Business details, email for password resets, AI capture key, security, backups.',
  },
  custom: [
    ch('signin', '🔑', 'Signing in', {
      steps: ['Open the Owner Console address. The **first time**, tap **Create Account** and make the owner account (email or phone and a password). After that, sign in with the same details — you stay signed in on that device.', '**Staff do not use your email.** A staff member opens their own invite / personal link and signs in with their PIN.'],
    }),
    ch('links', '🔗', 'Creating a client link', {
      steps: [
        'Open **🔗 Generate Link**. Choose the **Product** (Shop, Hotel, Hospital, Production, Services, Pharmacy or Aqua), type the **client name** (and phone/email), a **link name** and the **Link type**.',
        '**🕐 Demo (72 hours)** lets the client try it; **✅ Permanent** is a paid link. Tap **Generate Link** and **Copy** — it is live on its own subdomain at once.',
        'Send the client the link. On the client\u2019s first visit they sign up and become that shop\u2019s Admin.',
      ],
    }),
    ch('manage', '✅', 'Managing demo and permanent clients', {
      steps: [
        'Open **🕐 Demo** or **✅ Permanent** and tap a client for full details: link, product, notes, storage size.',
        'From there you can **lock/unlock**, **extend** a demo, **confirm** a demo as permanent (its data is moved to its own database), and **delete**.',
        'Under **Permanent**, use the **💰 income toggle** to record money agreed and paid: paying part creates a bill for the balance with **Settle** and **Remind** (the client\u2019s admin sees a payment reminder banner until they press OK).',
      ],
    }),
    ch('catalogue', '🛍️', 'The hardware catalogue', {
      steps: ['Open **🛍️ Catalogue**. The first time, tap **⬇️ Load starter items** to import a starting list, or add your own with **➕ New product**.', '**Products:** name, category, price, picture style, stock status, SKU, short and full description, specs, up to 12 pictures (the first is the main one), related products. **Hide** keeps an item off the website without deleting it; **☆ Feature** puts it on the home page.', '**Special offers:** tick *This item is on offer*, enter the offer price and the start and end time (Nairobi time). The website works out the discount amount and percent, and stops the offer by itself at the end time.', '**Complete systems:** pick existing products and quantities. The website shows the Individual value, the System price and **YOU SAVE** automatically (only when every part has a price). A product that is part of a system cannot be deleted until you remove it from the system.', '**Categories:** make as many as you like (product categories and system types). Changes show on the website within about 30 seconds.'],
    }),
    ch('website', '🌐', 'The public website', {
      steps: ['Open **🌐 Website** to change the logo, headline, feature cards, showcase photos, **price** and **payment methods**, and testimonials. **Save & Publish Changes** updates the public site and the upgrade prompt every demo shows when its trial ends.'],
    }),
    ch('health', '🐞', 'Errors and Storage', {
      steps: [
        '**🐞 Errors** lists errors reported by every client app in the last 7 days; the same bug on many devices is one line with a count. Tap a line for the stack and device.',
        '**💾 Storage** shows every shop\u2019s data size. Use **🗜️ Compress all large shops**, **📏 Measure unknown**, **🗄️ Move all to database** (permanent shops), **🖼️ Shrink all photos**, and **🧪 Test the database**.',
        'A shop that gets very large is told to archive old history; Storage shows which shops are near their limit.',
      ],
    }),
    ch('ownpos', '🛒', 'Using the console as your own shop', {
      steps: ['The tabs **Bills, Daily Sales, Profits & Expenses, Staff** and the Settings sections work like the Shop POS for your own business — see the Shop guide chapters for making sales, receipts and printers (Settings ▸ Hardware).'],
    }),
  ],
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
function assemble(key) {
  const M = { key, ...MODS[key] };
  const isPOS = key !== 'owner';
  const order = [];
  order.push(start(M));
  if (isPOS) order.push(setup(M));
  const byId = Object.fromEntries((M.custom || []).map((c) => [c.id, c]));
  // module chapters first (the way the business actually works), then the shared ones
  const firstIds = ['items', 'sale', 'flow', 'setup2', 'fees', 'jobs', 'hire', 'build', 'signin', 'links', 'manage'];
  const placed = new Set();
  const place = (c) => { if (c && !placed.has(c.id)) { placed.add(c.id); order.push(c); } };
  firstIds.forEach((id) => place(byId[id]));
  (M.custom || []).forEach((c) => { if (!['ownpos', 'health'].includes(c.id)) place(c); });
  const O = M.overrides || {};
  const pick = (id, fn) => (O[id] === false ? null : (O[id] ? OVR[O[id]](M) : fn(M)));
  if (isPOS) { [pick('payments', payments), receipts(M), billsChapter(M), pick('stock', stock), pick('reports', reports), people(M), pick('hardware', hardware)].forEach((c) => c && order.push(c)); }
  else { place(byId.health); place(byId.ownpos); }
  [pick('offline', offline), pick('trouble', trouble), tabsChapter(M)].forEach((c) => c && order.push(c));
  return { key, title: M.title, tagline: M.tagline, module: M.name, version: '1.0.0', chapters: order };
}

fs.mkdirSync(OUT, { recursive: true });
for (const key of Object.keys(MODS)) {
  const g = assemble(key);
  // stable ids, no duplicates
  const ids = g.chapters.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${key}: duplicate chapter ids: ${ids.join(',')}`);
  const json = JSON.stringify(g).replace(/</g, '\\u003c');
  fs.writeFileSync(path.join(OUT, `${key}.html`), `<!-- GUIDE DATA (${key}) — generated by tools/build-guides.mjs; edit that file, not this one. -->\n<script>window.__GUIDE_DATA = ${json};</script>\n`);
  console.log(`${key.padEnd(11)} ${String(g.chapters.length).padStart(2)} chapters  ${(json.length / 1024).toFixed(1)} KB`);
}
