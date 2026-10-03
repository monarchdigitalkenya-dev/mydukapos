# Zip 145 — Installed apps showing "Offline" with working internet

Zip 145 includes zips 131–144.

## Cause
1. **Installed apps were stuck on an old release.** An installed app opens through its service worker, which asked the server for the
   page and gave up after 3.5 seconds — showing the cached copy AND cancelling the download. On a phone whose connection takes longer
   than that to answer, every open showed the old copy and the copy was never refreshed. And `sw.js` had not changed for many releases,
   so the browser never installed a newer service worker either. Those phones kept running the release they were installed with —
   including its old offline detection, which showed "Offline" whenever a sync was slow.
2. **The connectivity check gave up too early on slow lines.** When the phone *said* it was offline (installed apps on some Android
   phones say so with working internet), the check waited only 4 s for the server and 3 s for the internet; on a slow line every
   check timed out and the dot stayed "Offline".

## Fix
* **Service worker (all 8 apps):** the page download is never cancelled. After 3.5 s the cached app opens (still fast on a slow line),
  but the download carries on and replaces the cached copy, so the next open is the current release. The open app is told, and shows
  **"A newer version of the app is ready — Update now"**.
* **`SW_VERSION` stamp in every `sw.js`** (bump it with every release). Because the file changed, every installed phone installs this
  service worker on its next open, which re-downloads the whole app for offline use — the stuck phones catch up by themselves.
* **Connectivity check:** the same patience whatever the phone reports — 12 s for the server, 9 s for the internet probe (a phone that is
  really offline still fails at once). The server check no longer waits on a storage read.

## Tests
* Real Chromium, real service worker, a server that takes 6 s to answer: the installed app opens from cache at once, is told of the
  update, and the next open is the new release. The same test FAILS on Zip 144's service worker (stuck on the old copy).
* Service-worker unit tests for all 8 apps (slow line with a cached copy, first visit on a slow line, network down, broken cache),
  and a check that all 8 carry the same release stamp.

## Deploy
`npm run deploy` (no router change). Installed phones update on their next open while online; the "Update now" bar appears if a newer
copy lands while the app is open. For a phone still showing Offline right after deploying: close the app fully and open it once while
online.
