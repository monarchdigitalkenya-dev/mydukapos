# ZIP 161 - Buttons that hang or need several presses

## Causes (measured; Chromium against a real HTTP server running the real pos-sync code, plus jsdom)

| Case | Before | After |
|---|---|---|
| Idle, click to link | 188 ms | Ready 18 ms |
| Slow POST 3 s | link at 3258 ms, no busy state | box shown about 2 ms, Ready 3014 ms |
| 503 busy x1 | 2246 ms | visible "trying again" |
| 503 busy x2 | 4273 ms | Ready about 4.2 s, message shown |
| 503 busy x3 | no link, toast after 4.3 s, second press made a second pending invite | Ready 6.9 s |
| Pull in flight (4 s GET) | 3912 ms (waits on pre-pull); a pull could erase the pending invite | Ready without waiting (skipPrePull); invite re-added if a pull removes it |
| Offline | no link, toast only | retry state at about 230 ms |
| 5 rapid presses | 5 pending invites, 8 POSTs | 1 invite, 1 push |
| Invitee "Create My Account" | frozen 2.6 to 4.1 s, button not disabled | closes in 158-254 ms |

Root causes:
1. No busy state and no single-flight, so users pressed again (duplicates, extra pushes).
2. pushNow pre-pulled (up to 8 s) and retried 503 busy up to 3 times before showing anything.
3. The invite was never marked dirty, so a pull could overwrite it while its link was on screen.
4. ?invite= / ?staff= was decided before the first pull and never re-checked: a new phone never saw the invite screen.
5. Staff list and roster were rebuilt on every pull (4 rebuilds in 18 s), replacing cards between pointerdown and pointerup.
6. Two Open controls (anchor plus window.open button); the invite-box Open was usable before the link was live.
The exact "dead Open" was not reproduced in Chromium (both opened tabs in 128-219 ms); 5 and 6 are the likely causes.

## Fixes
- src/shared/functions.js: inviteGenerate (single-flight, reuse token for same name, show link at once as "Making it live", Ready only when acked), inviteMakeLive (12 s budget, retry button, watcher), inviteSubmitRun, inviteAccountPush, authLinkRecheck, staffListRefresh/staffPanelRefresh (signature-gated), pushNow options (skipPrePull, priority, maxAttempts, timeoutMs), copyInviteLink refuses until live, openStaffLoginLink uses a real anchor.
- One real Open anchor (target=_blank rel=noopener) per staff card in every module; the duplicate JS button was removed.
- clickGuardInstall: capture-phase guard, lazy wrapping of async globals named in onclick, re-entrancy block, busy state after 250 ms, "Still working..." at 6 s, rejection toast, window.__noClickGuard / data-no-click-guard, AsyncFunction only (session-keep wrappers carry __cgAsync). Installed at boot in all 8 apps.
- savePrintRoutingRule duplicate-rule check.

## Audit (tools/audit-buttons.mjs, exit 0, allowlist empty)
| App | Handlers | Async |
|---|---|---|
| index | 582 | 103 |
| water | 448 | 79 |
| hotel | 750 | 118 |
| hospital | 666 | 99 |
| production | 643 | 96 |
| services | 612 | 104 |
| pharmacy | 563 | 95 |
| owner | 238 | 71 |

Info-only: 6 dup-covered (savePrintRoutingRule x6, also fixed directly), 108 no-try (async handlers whose helpers catch internally, or whose rejection the guard now toasts).

## Click-through (Chromium, API delayed 1.5 s)
index.html 33 screens (~772 clicks), hotel 24 screens (~522 clicks): no errors, no busy-forever, no dead buttons. Identical with the guard on. Kitchen/KDS/bar/etc. had no visible controls in the seeded state.

## Unverified
- Installed PWA / Android WebView / iOS behaviour of target=_blank anchors.
- Water fresh-device claim path (attemptClaimedLinkAutoLogin).
- Crawl "ok" is weak (any DOM change); only uniform latency was used, not 503s.
- The dead-Open cause was not reproduced.
- Offline background retries showed 9-16 POSTs (pre-existing timers).
- Owner console has its own pushNow, so skipPrePull is ignored there (harmless).
- Real phones and touch feel.
