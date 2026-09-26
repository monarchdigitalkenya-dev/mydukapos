# Zip 128 — Every hidden sale appears, including the ones from before zip 127

Builds on zip 127, which stops sales from going missing from now on. This release brings back the sales that were already
hidden. Nothing is deleted or rewritten. It works online and offline.

## Where the "hidden" sales were — and what now shows them
| Where they were | Why nobody saw them | Now |
|---|---|---|
| **The server's archive of old history.** A shop at 80% of its size limit moved old history into archive records on the server. | `/api/history` and the day check read only the live shop. A shop moved to its own database (zip 123) left its archives behind. **No device could reach these sales.** | `/api/history` and `/api/day-summary` also read the shop's archives, in both kinds of shop. The live copy of a sale wins, with no duplicates. |
| **This device's archive.** Old sales were moved to the device's archive to free space. | Daily Sales and Reports read only the device's list. | Shown for the chosen days. |
| **Only on the server.** A device that lost sales before zip 127, a new device, or older history of a database shop. | A device only fetched "what changed since" its last sync, so a sale it had lost never came back. Older history was fetched once, 180 days at most. | **Once per device:** a full fetch from the server plus a fresh history fetch. **Always:** Daily Sales and Reports fetch the chosen days from the server's history. |
| **A broken record** (no usable date, or no item list). | It showed on no day. It could also stop the app from drawing its screens at start-up. | Repaired on every start, **before the app draws**. The date comes from the sale's own id (the moment it was made), otherwise from its payment. The original value is kept on the sale. |
| **An impossible date** (the device clock was wrong: in the future, or before 2015). | It showed on no normal day. | Listed in **🔎 Check for missing sales**, with **Move to today** (the original date is kept). |
| Already fixed in zip 127: sales between midnight and 3 a.m. counted on the wrong day (the UTC date). | | |

## How it looks
* **Daily Sales and Reports** show every sale of the chosen days, whether it is on this device or not. Sales fetched from history
  carry **📦 history**.
* History sales are **shown, not copied** onto the device, so the device never fills up again. Reprinting, voiding or
  marking one paid first takes it into the device's list, as a normal sale.
* **Once per device,** when this release first runs online: repairs, a full fetch and a history fetch. The Audit notes what came
  back, e.g. "3 sales that were missing on this device fetched from the server".

## To bring everything back
1. Deploy (steps below).
2. **Open the app once, online, on every device that sells.** Its first sync sends everything it still holds; zip 127 already
   does this. Its one-time recovery fetches what it lacks.

A sale that never reached the server and was lost from its device before zip 127 cannot be rebuilt, because no copy of it
exists anywhere. Its printed receipt is the only record.

## Tests
`tests/hidden-sales.test.mjs`:
* the server's archive through `/api/history` and the day check (single-record shop);
* a shop moved to its own database still reaching its old archive, with page sizes 2 and 1000;
* Daily Sales for an old day showing a server-archive sale and a device-archive sale (📦), and reprinting one;
* the one-time recovery: a broken record repaired and a sale this device lost fetched back;
* an impossible date moved to today.
