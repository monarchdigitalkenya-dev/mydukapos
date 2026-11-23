# Built-in printer of the H10S handheld terminal (zip 336)

## What was confirmed, and what was not
| Item | Status | Evidence |
|---|---|---|
| H10S is a **Senraise** handheld POS terminal, Android 13, built-in **58 mm** thermal printer (roll 40 mm, 80 mm/s) | from the maker's page | senraise.com/products/senraise-h10s-handheld-pos-terminal.html |
| Senraise terminals carry a system printer service, package `recieptservice.com.recieptservice`, service `recieptservice.com.recieptservice.service.PrinterService`, Binder/AIDL interface `PrinterInterface` (`printEpson(byte[])`, `printText`, `printBitmap`, `getServiceVersion` …). Apps bind to it; it is not a Bluetooth/USB printer | from two independent open-source wrappers (MIT: github.com/shaxxx/flutter_senraise; BSD-3: github.com/Mrkrabss/flutter_senraise_printer_sdk) — tested by them on other Senraise-built terminals | their source code |
| The service renders ESC/POS itself (converts to bitmaps), UTF-8 only, no code pages | wrapper author's note | flutter_senraise README |
| **Your own unit has this service** | **NOT verified** — no device or ADB was available | run Settings ▸ Install App ▸ "Use this terminal's built-in printer": it reports yes/no from the device itself |
| Senraise's own SDK / licence terms for the H10S | **not seen** (their download page needs a verification code). The AIDL here is the 11-method subset used by the open-source wrappers, in the same order | ask vicky@senraise.com for the official SDK if you want to confirm |

## Chosen method (and why)
Option 2 of your list: the vendor's documented-by-usage Binder service, through a dedicated adapter (`BuiltinPrinter.java`), exposed to the web app by two new bridge calls (`builtinStatus`, `builtinPrint`). Not Bluetooth (the printer is not exposed that way, nothing in the evidence says it is), not a generic ESC/POS library, not `window.print()`. Nothing about Bluetooth printers, USB, Windows or the Android print dialog was changed — they keep their own code paths.

No root, no firmware changes, no security bypass. Only the Android "queries" declaration was added so Android 11+ lets the app see the printer service.

## What the app does
* Settings ▸ Install App ▸ This app's printers: on a terminal that has the service, **🖨️ Use this terminal's built-in printer** (no pairing). It checks the service, saves the choice, switches receipts to the thermal path, sets the receipt width to **58 mm only if you never chose one**, and prints a test page.
* A health box shows the real answers: service connected / not responding, device model, service version. Paper-out and cover-open **cannot be detected** (this service does not report them) and the screen says so.
* Every existing thermal workflow (sales receipts, reprints, invoices, bills, kitchen tickets, reports) already goes through one function (`nativeSendBytes`), so all of them reach the built-in printer without per-module changes; kitchen tickets keep their own format.
* A print is shown as successful only when the printer service accepted the job. A sale is saved separately and never fails because of the printer.
* Duplicates: the same bytes sent twice within 2.5 s are one job; the Android side also remembers each job id for 10 minutes. A failed print can be retried at once. Printing needs no internet.

## Files
New: `native/android/app/src/main/java/com/mydukapos/app/BuiltinPrinter.java`, `native/android/app/src/main/aidl/recieptservice/com/recieptservice/PrinterInterface.aidl`, `tests/zip336-builtin-printer.test.mjs`.
Changed: `NativeBridge.java`, `AndroidManifest.xml`, `native/android/app/build.gradle` (`aidl true`), `src/shared/blocks/native-app.html` (and its copy in all 7 apps).
No new libraries; the AIDL is an interface description, no vendor binary is bundled.

## Tested
* Automated (pass, 7/7 + the 9 existing native tests): AIDL order, bridge/manifest wiring, page flow against a fake bridge (detect, choose, test, real sale + receipt bytes, width rule, duplicate suppression, failed-then-retry, reprint, terminal without the service, ordinary phone unchanged).
* **Not run:** compiling the Android app (no Android SDK here — the GitHub "android" workflow compiles it), anything on a real H10S: real printing, paper alignment/readability, logo (raster GS v 0 may or may not be rendered by the service), feed/cut (this model may have no cutter), app restart/reconnect, paper-out behaviour.

## Test on the terminal (after installing the new APK)
1. Settings ▸ Install App ▸ "Use this terminal's built-in printer". Expect: a test receipt prints.
2. Read the health box. If it says the service is missing, send me the box text and the Print log (Settings ▸ printer ▸ Print log).
3. Print: a short sale, a sale with 30 items, a long product name, a receipt with KES amounts and `é ü ’`, a reprint from history, your logo.
4. Turn Wi-Fi off, make a sale, print it. Close and reopen the app, print again.
5. Open the paper cover and print: expect no paper and NO error (the printer cannot report it). Then reload paper and reprint.
6. If the text is clipped or too narrow: Settings ▸ Adjust receipt size (58 mm; letter size 7 pt gives 32 columns).
