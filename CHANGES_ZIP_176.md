# Zip 176 — Windows app size/zoom/hangs, and a new full-screen Sales Counter

## Windows app (native/windows/main.js)
- **Window size**: opens at ~92% of the usable screen, centred (was a fixed 1280 x 820).
- **Zoom**: the app is laid out for ~1600 CSS px wide. On a laptop at Windows scaling 125% / 150% the screen is only 1280-1536 "device" px wide, so everything looked magnified. The app now starts at a zoom that fits the screen (0.5 - 1.0) and the cashier can change it: **Ctrl +**, **Ctrl -**, **Ctrl 0** (= fit to this screen). The choice is remembered. (View menu.)
- **Hangs**: a page that stops answering for 6 seconds is reloaded automatically (the data is on the PC and on the server). View menu -> **Safe graphics** turns GPU acceleration off (restarts the app) for old graphics drivers that freeze Chromium.
- A new Windows build is needed for this part (push to GitHub, download the new .exe / .msi). The web part below is live after `npm run deploy`.

## Sales Counter (all modules, shared block `receipt-extras.html`)
- The product card and the checkout card are now the SAME height - everything below the header - so nothing stops half way down the screen. The product grid fills its card and scrolls inside it; the cart list fills its card (it showed one row before).
- Product cards: bigger, with name (2 lines), green price, hover lift, stock pill; rows keep their natural height.
- "Click a matching product..." hint + **Sell Unlisted Item** are one footer row under the grid (hint hidden on desktop).
- Payment details use the full width of the checkout card: customer phone + cash/card side by side; **Split** = phone | cash + M-Pesa + tendered; the **M-Pesa prompt is one row** (phone | payer | code | Send) when the card is wide. No more empty left column.
- Cleaner look: rounded cards with soft shadows and an accent title bar, rounded search box with focus ring, uppercase cart header, "🛒" empty state, tinted Total box, rounded method buttons, Confirm button with depth.
- Short screens (laptops up to 860 px high) get tighter spacing so the cart, total and Confirm all stay visible.
- Tests: `tests/zip176-workspace.test.mjs`. Stamp `zip-176`. No migration.

## Tests (found while running the full suite)
- Since zip 170 the device storage cuts values into 16,000-character slices. Truly incompressible TEXT (random characters, which the tests use as "filler") now expands ~1.6x instead of ~1.3x, so the fillers in `auto-archive.test.mjs` and `svc-seams.test.mjs` no longer fitted the 5 MB test quota. The fillers were made smaller; real shop data (sales) compresses ~10x and is unaffected. `npm run deploy` runs the tests, so this would have stopped a deploy.
