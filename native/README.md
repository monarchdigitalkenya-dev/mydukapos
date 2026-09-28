# MyDukaPOS native apps — Android and Windows

The seven apps (MyDukaPOS, Hotel, HMIS, Production, Pharmacy, Services, AquaPOS) are defined once in **`native/apps.json`**:
name, application id, licence product, colour, icon and version.

Each native app is a **real app around the shop's own MyDukaPOS web app**. It opens the shop's own link, with its durable offline
storage and automatic sync, and adds what a browser cannot do:

| | Android (`native/android`, Java) | Windows (`native/windows`, Electron) |
|---|---|---|
| Application id | `com.mydukapos.shop`, `.hotel`, `.hmis`, `.production`, `.pharmacy`, `.services`, `.aquapos` | `com.mydukapos.<app>.desktop` |
| First start | enter the shop link once; the app checks it with the server (active licence, and the link is for THIS app) | same |
| Storage | the WebView's own localStorage + IndexedDB (kept across restarts) | a persistent partition per app (kept across restarts and updates) |
| Printing | Android print dialog (any printer Android can reach); **paired Bluetooth thermal printers (ESC/POS)** | any Windows printer **without the dialog**; **network thermal printers (IP:9100)** |
| Other | camera (barcodes), file picker, WhatsApp / phone / e-mail links open outside | camera, one window per app, external links open in the browser |

Printer statuses are the device's real answers: a print is reported only after the bytes were written, or after Windows accepted
the job.

## Building

The builds run on GitHub (Actions → `android` / `windows`) at every push that changes `native/`. Each run keeps its artifacts for
30 days.

* **Android**: `mydukapos-android` artifact. For each app: `…-release.apk` (or `…-release-UNSIGNED.apk` when no signing key is
  set up) and `…-debug-TEST-ONLY.apk`. `manifest.json` lists each package id, version, signer, size and SHA-256. The workflow also
  installs the Shop app on an Android emulator and checks that it starts and that its link check works.
* **Windows**: `mydukapos-windows` artifact: `<App>-<version>-Setup.exe` and `<App>-<version>.msi` (x64), plus `manifest.json`.
  The workflow also installs the Shop app silently, starts it and uninstalls it.

On your own computer:

```
# Android (needs Android Studio / the Android SDK, and JDK 17)
cd native\android
gradlew assembleRelease            # all 7 apps; or e.g. gradlew assembleHotelRelease
# -> native\android\app\build\outputs\apk\<app>\release\

# Windows installers (on Windows, Node 20)
cd native\windows
npm install
node build.mjs                     # all 7; or: node build.mjs hotel
# -> native\windows\dist\<app>\
```

Icons: after changing an app's icon (`<app>/icons/icon-512.png`), run `python tools/native-icons.py` (needs Pillow).

## Signing (required before customers install)

**Android.** Android refuses to install an unsigned APK. Create the release key ONCE and keep it safe: every future update must be
signed with the same key, or phones will refuse the update.

```
keytool -genkeypair -v -keystore mydukapos-release.jks -alias mydukapos -keyalg RSA -keysize 4096 -validity 10000
```

Then, in GitHub → Settings → Secrets and variables → Actions, add these secrets:
- `MYDUKA_KEYSTORE_B64` (the `.jks` as base64; on Windows: `certutil -encode mydukapos-release.jks out.txt`, and remove the header and footer lines)
- `MYDUKA_KEYSTORE_PASSWORD`
- `MYDUKA_KEY_ALIAS` (`mydukapos`)
- `MYDUKA_KEY_PASSWORD`

The next run builds signed `…-release.apk` files. Never commit the keystore (`.gitignore` excludes `*.jks`).

**Windows.** This is optional but recommended. Without it, SmartScreen says "Unknown publisher". Add a code-signing certificate
as the secrets `CSC_LINK` (base64 of the `.pfx`) and `CSC_KEY_PASSWORD`.

## Publishing to shops

1. Download the artifact from the GitHub run.
2. In the Owner Console → **📦 Apps & Versions**, add a release (app, platform, file type, version, build), then **Upload** its file.
   The server checks the file really is an APK, EXE or MSI, and records its size and SHA-256.
3. **Publish** it. Each shop then sees **only its own app** under Settings → Install App. A Hotel shop is never offered, and cannot
   download, the Shop app.
4. Optionally, send an **installation offer** from **📣 Messages**. Shops then see "Install Android App / Continue Using Web App /
   Don't Show Again".

Installing is always optional. The Web App keeps working, including on iPhone and iPad (there is no iPhone app).
