# Zip 160 - real-browser verification of the hotel categories / import (zip 159) and the receipt-size screen (zip 158)

Everything from zips 158 and 159 had only been run in jsdom. This zip drove the real thing in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) at phone 390x844 (touch + mobile emulation), tablet 820x1180 (touch) and desktop 1366x800, light and dark, with a seeded hotel shop and real files. Screenshots: `docs/screens-zip160/` (about 65 small PNGs, named `<viewport>-<n>-<what>.png`).

Scope: `hotel/index.html`, `src/shared/blocks/receipt-size.html` (then `npm run sync`), `tests/zip160-hotel-browser.test.mjs`.

## How it was run

- A tiny static node server served the repo; `/api/*` answered 503 (offline), so sync/pull noise ("Failed to load resource", WebSocket) is expected and filtered. Every other `console.error` and every `pageerror` was collected: **none in any scenario**.
- Seed: 50 sellable records (+ ingredients and 2 utensils) across items / dishes / services / bar with legacy string categories, mixed case ("Soft Drinks"/"soft drinks"), some uncategorised, about two thirds with small SVG data-URL photos, some without, a few with a dead https photo link (aborted in the browser). Signed in with `finishDirectAuth()`.
- Real `.xlsx`: generated in the test with SheetJS 0.18.5 from the npm registry (`npm i xlsx` in the scratchpad, not added to the repo). The CDN was blocked by the sandbox proxy, so the browser's request for the app's SheetJS CDN URL was answered with that same real file (`page.route`). The app's own lazy loader and `XLSX.read` did the parsing; files were sent with `setInputFiles` and one through a real file chooser.
- Screenshots were looked at one by one (not only measured).

## What was verified in a real browser

| Area | Result |
|---|---|
| Sales Counter: chips + image grid, 3 viewports | OK. Chips scroll horizontally inside their bar (no page scroll: `scrollWidth - innerWidth = 0` everywhere). Tapping a chip (real touch tap on phone/tablet) shows only that category (Snacks: 3 of 50). Search + chip together: only matches inside the chip. Out-of-stock stays greyed. Placeholders show for records without a photo and for a dead photo link. |
| Service Orders (Orders tab) chips + menu | OK, same. (Found and fixed a ragged-row layout, see defects.) |
| Show more | OK: "Show 60 more (210 left)" tapped on the Sales Counter: 60 -> 120 cells. On the Orders menu the button is present (60 shown) and 44 px tall; it was not tapped there. 300 records phone, 5,000 records desktop. |
| Inventory > Categories & assign | Create, rename (mirror name on records follows), delete-with-move (records kept, tombstone), filter Uncategorized + select all shown + bulk assign: all worked by real clicks; chips on the Sales Counter updated afterwards. |
| Import (per type Items and All) with a real CSV | Preview correct: 11 rows -> 6 to import, 3 duplicates (by code / by name / inside the file), 2 errors (no name, bad price), 2 new categories, 2 similar names ("Snaks" ~ "Snacks", "Hot Drinks" ~ "Soft Drinks") that BLOCK the import until answered. After answering: 6 imported, 3 skipped, 2 need attention, 2 categories created; a per-row override to "Update existing" updated the price. Chips reflect the new categories. |
| Import from All (CSV with a Type column) | Dish, Item, Ingredient, Service, Bar and Utensil rows all landed in the right type (utensil in `utensils`); the row without a type was held until a type was chosen. |
| Import with a real `.xlsx` (2 sheets) | Real SheetJS parse; header names mapped (Dish Name / Section / Selling Price / Description), 4 rows, 3 categories (1 new), sheet picker shown. |
| Receipt size (Settings > Receipts > Adjust receipt size) | 58 / 80 / custom 100 / custom 45 / invalid 20 mm; 5, 7, 8.5, 9, 10, 12, 20 pt via chips, +/-, typed box, Reset. The dummy receipt redraws every time (columns 32/22/18 at 58 mm for 7/10/12 pt, 48/28 at 80 mm, 61/50/21 at custom 100, 11 at 58 mm/20 pt with the "very big" warning). The receipt grid never overflows its paper (`scrollWidth == clientWidth`). Invalid width disables Save and Print. Save stores 9 pt / 80 mm (`pos_receipt_font_pt = 9`), Cancel after a change keeps the saved value, body scroll lock is released. |
| Tap targets (new UI) | After the fixes below: no control in the chips, "Show more", manager, import or receipt-size screens under 44 px (checkbox/radio glyphs are 24 px inside 44 px labels). |
| Dark theme | Chips, manager, import and receipt-size checked (screenshots `*-3x-dark-*`). |
| Speed (real Chromium, 5,000 records) | Index rebuild 15 ms, validate 1.2 ms, chip switch 230-275 ms, search 48 ms (most of the chip-switch time is the pre-existing bar panel, see limits). 300 records: chip switch 14 ms. |
| Sort | "Bar Bravo 2" now sorts before "Bar Bravo 10" (natural order) in the chips' grid. |

## Defects found in the real browser, and fixed

| # | Defect (only visible in a real browser) | Fix |
|---|---|---|
| 1 | Category chips were **40 px** tall on a phone: the phone rule `.tab-content button {min-height:40px}` is more specific than `.hcat-chip`. Same for "Show more". The zip 159 note claimed 44 px. | `.tab-content .hcat-bar .hcat-chip, .tab-content .hcat-more {min-height:44px}` (46 px on phone). |
| 2 | Inventory type pills (All stock / Items / ...) were 34 px; the active one was white on #16a085 (3.3:1). | 44 px, active colour #0e7c6b (5.1:1). Same colour for the active category chip. |
| 3 | Category manager and import windows: fields and selects were bare browser controls (19-22 px high, no padding), checkboxes 13 px, close button 28 px, buttons 29-40 px. | One CSS block for `.hcat-box`: 44 px fields, 24 px check/radio in 44 px labels, 44 px close button, 44 px buttons. |
| 4 | Import preview on a phone: the global "table to cards" script turned the "Categories detected" table into cards and the two "Same thing / Different" radio labels wrapped **one letter per line**. | The multi-part status/type cells are wrapped in one `.hcat-cell` block, which the card layout treats as one value. Checked at phone width. |
| 5 | The app-wide "Turn on notifications" banner (z-index 99999) covered the bottom buttons of the import window (Import N records) and of the receipt-size window (Print / Reset / Cancel / Save) on a phone; Playwright could not tap them at all. | Banner hidden while those windows are open (CSS `:has`, in `hotel/index.html` and in `src/shared/blocks/receipt-size.html`). |
| 6 | Receipt-size, phone: the round scroll-to-top and keyboard buttons sat on the Print button. | Scroll-to-top hidden while the window is open, the keyboard button (needed to type a size on a till without a keyboard) rides above the button bar. |
| 7 | Receipt-size, dark theme: "48 characters per line" was fixed dark blue on a dark background and the selected paper/size buttons (#2c3e50) vanished. | Text uses `var(--dark)`, selected buttons #0e6e5d. Letter-size box 56 px tall (was 34). |
| 8 | Orders menu cards were vertically centred, so rows looked ragged (a picture floating in the middle of a tall cell). | `.svc-menu-btn` is a top-aligned column. |
| 9 | Status badge colours (import) below 4.5:1 (down to 3.3:1). | Darker text colours (now at least 7:1 on the dark theme box). |

Not a defect: a Playwright helper had removed the `#toast` element and produced one `pageerror`; that was the test harness, not the app.

## Requested changes

- **Natural, locale-aware name sorts** in the category code: category lists, the per-screen grid order and the manager's record list now compare with `localeCompare(b, undefined, {sensitivity:'base', numeric:true})` semantics, through one helper `hospCatNameCmp` that uses a cached `Intl.Collator` with exactly those options (the plain `localeCompare` call was 40x slower on 5,000 names: 295 ms vs 7 ms in Node) and falls back to `localeCompare` if `Intl.Collator` throws.
- **The chip index no longer depends on `queuePush` / a pull to notice edits.** `hospCatIndex()` still honours the dirty flag, the array identities and lengths, and now also validates a snapshot of the fields it was built from: per inventory record the object itself, code, name, category, categoryId, type, hospKind, the bar/keg markers, dualUnit, hospService, deleted; per utensil id, name, category, categoryId, deleted; per category record id, kind, name, active, order, deleted, createdAt. Any difference rebuilds. Quantity / price edits (every sale) do not rebuild. Cost measured in Chromium at 5,000 records: 1.2 ms per call (jsdom test budget 15 ms).
- Tests: `tests/zip160-hotel-browser.test.mjs` (3 jsdom tests): edits that bypass queuePush and hospCatTouch (category name, pushed record, replaced record at the same length, type change, categoryId, deleted flag, name, utensil, category record rename/deactivate) always show up in the index and the chips; qty/price edits and repeated calls never rebuild; 5,000-record validation cost; natural sort order (case/accents ignored, "soft 2" before "Soft 10").

## Tests run

| Command | Result |
|---|---|
| `npm run check` | All apps match `src/shared/` |
| `npm run lint` | No undeclared names; every inline handler calls a function that exists |
| `tests/zip159-hotel-categories.test.mjs` | 26 / 26 pass (run alone; when 13 test files ran at once one run was SIGKILLed by the sandbox at 366 s on load, then passed alone) |
| `tests/zip160-hotel-browser.test.mjs` | 3 / 3 pass |
| `tests/receipt-size.test.mjs` | 72 / 72 pass |
| hospitality-final 4, hospitality-orders 12, hotel-bills-quickview 6, hotel-fixes 19, hotel-ops 2, hotel-zip153-misc 4, kitchen 10, menu-import 5, waiter-orders 3, zip158-hotel-tabs 5 | all pass |

(After the last CSS edits, zip159 26/26, zip160 3/3, hotel-fixes 19/19, hospitality-orders 12/12 and zip158-hotel-tabs 5/5 were run again and pass. receipt-size 72/72 was run after the final `receipt-size.html` edit.)

## What still could not be verified

- **Real printers, paper, Bluetooth, USB, the print relay**: the sample receipt was checked on screen only. "Print test receipt" was not pressed. How 5-20 pt letters look on thermal paper is unknown.
- **Real phones and touch feel**: Chromium's touch emulation (tap events, 390 px viewport) is not an iPhone Safari or a cheap Android WebView; scroll momentum, the on-screen keyboard pushing the layout, safe-area insets, `100vh` behaviour and `:has()` support on older Android WebViews were not tested (on a browser without `:has()` the notification banner would simply still overlap those two windows).
- **The SheetJS CDN itself**: blocked here; the real library file was served instead. First-use download time and offline failure messages on a real network are unverified.
- **Real server sync**: `/api` was stubbed offline; category sync is only covered by the jsdom end-to-end test from zip 159.
- **Speed on a real till**: numbers above are this sandbox's Chromium. A slow tablet will be slower; at 5,000 records with 1,200 bar bottles the pre-existing Bar panel alone costs about 120 ms per grid redraw (not touched).
- **Pre-existing, seen but not changed**: inventory table thumbnails with a dead photo link show a broken-image icon; the Orders tab "Stations, printers & modifiers" section has 13 px checkboxes; the Table / room select label is clipped at phone width; the keyboard button overlaps the left edge of content in the manager and import windows on a phone.
- Similar-category detection flagged "Hot Drinks" as similar to "Soft Drinks" (shared word); harmless because the user decides, but a real shop may find it noisy.
