# Zip 374 - Delivery guard: orders and bills must never silently stop arriving

## What was wrong (plain words)
Kitchen and cashier devices worked at first, then after a while stopped getting new orders / bills. A phone or tablet that sits idle can
(a) freeze the page's timers when the screen dims, or (b) keep a live connection that LOOKS open but is dead. The app trusted that
connection and only checked the server every 30-45 seconds, or not at all - so nothing told anyone it had stopped.

## What this zip adds (every app, nothing to switch on)
1. A watchdog checks every 10 seconds whether this device REALLY heard from the server in the last 30 seconds. It does not trust the connection.
2. 30 s of silence: it asks the server again. 45 s: it drops the connection and opens a new one. 90 s: it also clears every pause/back-off and re-sends anything stuck.
3. A change made on this device that the server has not confirmed for 40 s is sent again.
4. When the device wakes up, comes back to the app, or the internet returns, it catches up at once.
5. The screen is kept on (turn it off with the small pill at the bottom-left: tap "Screen on").
6. If it still cannot reach the server after 60 s, a RED bar appears at the top ("Not receiving new orders - last update 1 min ago") with a Retry now button, a beep and a vibration. Nobody waits for an order that is not coming.
7. The pill at the bottom-left shows Live (green) / Checking (amber) / Not receiving (red). Tap it to check for new orders now.

## Honest limits
- A web page cannot run when the phone is switched off, the app is force-closed, or Android kills it to save battery. Keep the app open on the kitchen / cashier device, plugged in, and (on Android) set the app's battery to "Unrestricted".
- If the server itself is full or down, the red bar tells you; only the server side can fix that.
- Tested here with automated tests on a simulated browser, not on your real devices. Please test on the kitchen and cashier devices: send an order, lock the kitchen screen for 5 minutes, unlock, and send another.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip374
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_delivery-guard_374_11161720.zip" -C C:\dev\zip374

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip374 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip374-delivery-guard.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check on the real devices
15. On the kitchen and cashier devices open the app, press Ctrl+Shift+R (or close and reopen the installed app). You should see a small green "Live" pill at the bottom-left.
16. Send an order from the waiter device, lock the kitchen screen for 5 minutes, unlock it, send another. Both must arrive. If the red bar ever appears, tap Retry now and tell me what the bar said.
