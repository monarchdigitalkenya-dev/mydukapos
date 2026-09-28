# Zip 148: Native apps (Android and Windows), app releases, owner messages, branding

Zip 148 includes zips 131–147.

## What was already in place (audited, kept)

Offline-first sales (device storage and an IndexedDB journal), automatic reconnection (one connectivity manager, never
`navigator.onLine` alone), idempotent sync (stable ids, merge by id, a stock movement ledger, the zip 146 lost-update fixes and
server confirmation), multiple tills and devices, roles and server-side authorization, the printing engine (58 mm, 80 mm and A4
from one document model), eTIMS, M-Pesa, SMS, licences and demos, generated links, the Owner Console, and the automatic daily
report. Nothing here was rewritten.

## New in this zip

### Android app: real APKs, built and verified
* `native/android`: one Java project with 7 flavours (`com.mydukapos.shop`, `.hotel`, `.hmis`, `.production`, `.pharmacy`,
  `.services`, `.aquapos`). Each has its own name, icon, splash colour and version (from `native/apps.json`).
* A WebView around the shop's own link (durable storage, the web app's offline sync), plus native features:
  * first-start link check with the server (the licence, and that the link is for this app);
  * Android printing (in a plain WebView `window.print()` does nothing);
  * **Bluetooth ESC/POS thermal printing**;
  * camera and file picker; outside links open outside the app.
* **Built on GitHub Actions** (`android` workflow), which produced 14 APKs. Each one was checked with `aapt2` and `apksigner`
  (package id, version 1.0.0 (1), label, signer), and its size and SHA-256 are recorded. The Shop APK was **installed on an Android 11
  emulator**: it launched, showed its first-start screen, and the native link check refused a foreign link.
* **Signing:** no release key exists yet, so the release APKs are **unsigned** and must be signed before customers install them (see
  `native/README.md`). The `debug-TEST-ONLY` APKs install, but are for testing only.

### Windows app: EXE and MSI installers
* `native/windows` (Electron): the same model, with a durable storage partition per app. Printing to any Windows printer
  **without the dialog** (Windows' own result for each job), raw ESC/POS to **network thermal printers**, and a list of Windows
  printers with their real status.
* The `windows` workflow builds `<App>-1.0.0-Setup.exe` and `<App>-1.0.0.msi` (x64) for all 7 apps (14 files) and records their
  sizes and SHA-256. It then **installs the Shop app silently from the Setup.exe, starts it, and checks it keeps running** (window
  "MyDukaPOS"). After that it uninstalls it and **does the same with the .msi**. Both passed on Windows Server 2025 (run 36383836616).
* **Bug found by that install test and fixed:** installers built with electron-builder 24 crashed as soon as they started on
  current Windows (exit code 0xC0000005) and installed nothing. The builder is now electron-builder 26.
* The installers are **unsigned** until a code-signing certificate is added (Windows then shows "Unknown publisher").

### Releases and Settings → Install App
* Owner Console **📦 Apps & Versions**: add a version, upload the real file (checked to be a real APK, EXE or MSI; size and SHA-256
  measured by the server), then publish, withdraw or delete. Releases are never overwritten.
* **Settings → Install App** (existing Web App install kept as it was) now also shows this shop's **own** Android and Windows app,
  only when a published file exists. It shows version, size, SHA-256 and the normal install steps (Android "Install unknown apps",
  Windows SmartScreen). A **Hotel shop is never offered, and cannot download, the Shop app**: the server decides from the licence
  (`/api/app-releases`; a request for another app's id is answered 404).
* Inside the native apps the same screen shows "You are using the … app", the app's printers (choose, test print, remove), and a
  notice when a newer version is published. Updates are never forced.

### Owner Console → 📣 Messages
* Create, edit, schedule (from and until), publish, archive and delete messages: announcements, installation offers, app updates,
  maintenance, security, sync, printing.
* Target all shops, chosen apps, or chosen shops (decided on the server). Platform (web, Android, Windows) and app version are
  decided on the device.
* Messages are stored server-side. Devices fetch them on start, every 10 minutes and whenever the connection returns, and keep the
  last list for offline. Unread ones are shown one at a time. "Don't Show Again" sticks. Installation offers show **Install Android
  (Windows) App / Continue Using Web App / Don't Show Again**. Nothing is sent to phones' notification bars (no push service is
  configured).

### Also
* **Branding:** "MinimartPOS" is replaced by each app's MyDukaPOS name (pages, manifests, service workers).
* **Pricing:** "days included" and "then per month" can be set next to the price (defaults 60 days, then KES 400). The public
  site shows the real plan and no longer says "no monthly bill" when there is one.
* **Automatic daily report:** a blocked or failed print can be retried ("🔁 Print it again"); each retry is recorded.
* The license-status response reports the link's product (used by the native apps).
* The print safety timeout waits for the native apps' own `afterprint`, so a slow print dialog never prints the wrong page.

## Not done / needs you
* **Release signing:** Android keystore and Windows certificate (the steps are in `native/README.md`).
* **Getting the files:** GitHub → Actions → the `android` / `windows` run → Artifacts. This environment's network policy blocks
  GitHub's artifact storage, so the files could not be copied into this zip.
* Local builds of the native apps are not possible here, because the environment's network policy blocks `dl.google.com` (Android
  SDK) and GitHub release downloads (Electron). GitHub's own build machines did the builds.
* Not built, as instructed: a native iPhone app (iPhone and iPad use the Web App).

## Deploy
`npm run deploy` (the Pages Functions include new endpoints). `deploy:router` is only needed if you haven't run it since zip 147.
The R2 bucket `mydukapos-media` must exist to upload installers; it already does if photos are stored in R2.
