# Moving to a new Cloudflare account (zip 269) - Windows cmd, in `C:\dev\mydukapos`

The plan: deploy this zip to the OLD account, download the data, build the NEW account, restore, switch the domain, carry on.
Read `docs/SHOP_BACKUP_RESTORE.md` once first (what the backup carries, what it never carries).

## Before you start - three things that decide whether the restore can work
1. **The NEW Cloudflare account must be on the Workers Paid plan** (USD 5 a month, Billing -> Subscriptions) BEFORE you restore. The free plan allows only 1,000 KV writes and 100,000 D1 row writes a day and 50 requests per call; this restore writes tens of thousands of KV keys and over a million rows. On the free plan it stops half way. (R2 also needs to be switched on, with a card.)
2. **Use a desktop Chrome or Edge with plenty of free memory (8 GB+) for the backup and for the restore.** The browser builds and reads the whole file in memory. Close other tabs, keep the screen awake, do not use a phone. The restore takes a long time (hours for 1.1 million rows): keep the tab open and the computer awake until it says "All restored shops verified".
3. **Make the final backup when the shops are closed** and do not let anything be sold on the old account after it starts. Anything sold after a shop was read is not in the file.

## The one rule about the config files
`wrangler.toml` and `wildcard-router\wrangler.toml` hold the ids of ONE account (the KV namespace and three D1 databases). After you switch them to the
new account, **never mirror the zip over the folder again** (robocopy /MIR would put the old ids back). Use `node tools\switch-account.mjs --show` any time to see which account the files point at.
`node tools\switch-account.mjs --back` puts the old account's ids back.

---
## PART A - the OLD account (do this first, shops can keep selling)
1. Deploy this zip as usual (see the top of `DEPLOY.md`): `mkdir C:\dev\zip269`, `tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_269.zip" -C C:\dev\zip269`, `cd /d C:\dev\mydukapos`,
   `robocopy C:\dev\zip269 C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml`, `npm install`, `npm run check`, `npm run deploy:fast`.
   (The router Worker is unchanged in this zip: no `deploy:router`.)
2. Write down every Pages variable and secret of the old project (Cloudflare dashboard -> Workers & Pages -> mydukapos -> Settings -> Variables and Secrets) and the router Worker's (mydukapos-wildcard-router -> Settings -> Variables).
   Secrets show no value: take them from wherever you stored them. The ones that matter: `PAYMENT_SECRETS_KEY`, `ROUTER_SHARED_SECRET`, `OWNER_SETUP_TOKEN`, `STAFF_SESSION_SECRET` (only if you set it), `TURNSTILE_SECRET`, `ROOT_DOMAIN`, `PAY_CALLBACK_ORIGIN`, `HEALTH_URL`, `WHATSAPP_*`, `SHA_*`, `UPCITEMDB_*`, `CONTACT_NOTIFY_EMAIL`, `MPESA_ENV`.
3. Second copy of the transaction database: `npm run db:backup` (writes the `backup\` folder).

## PART B - build the NEW account (nothing here touches the live site)
1. `npx wrangler logout` then `npx wrangler login` with the NEW account, then `npx wrangler whoami` - it must show the new account.
2. In the dashboard: turn on R2 (Storage & databases -> R2; it asks for a card once).
3. Create the resources:
   - `npx wrangler kv namespace create mydukapos_kv`   (prints an id: 32 characters)
   - `npx wrangler d1 create mydukapos-ledger`   then   `npx wrangler d1 create mydukapos-audit`   then   `npx wrangler d1 create mydukapos-owner`   (each prints a database_id)
   - `npx wrangler r2 bucket create mydukapos-media`, `npx wrangler r2 bucket create mydukapos-audit-archive`, `npx wrangler r2 bucket create mydukapos-db-backups`
   Lost an id? `npx wrangler kv namespace list` and `npx wrangler d1 list` show them.
4. Point both config files at the new account (all four ids together, nothing else changes):
   `node tools\switch-account.mjs --kv <KV_ID> --ledger <LEDGER_ID> --audit <AUDIT_ID> --owner <OWNER_ID>`
   then `node tools\switch-account.mjs --show` (the two files must agree).
5. Create the tables:
   - `npx wrangler d1 migrations apply mydukapos-ledger --remote`
   - `node tools\setup-audit-db.mjs`
   - `node tools\setup-owner-db.mjs`
6. The router Worker (it holds the Durable Objects the Pages project binds to, so it goes FIRST). Your domain is not in the new account yet, and a route on a zone the account does not have makes the deploy fail, so deploy it without the route:
   `node tools\switch-account.mjs --noroute` then `npx wrangler deploy --config wildcard-router\wrangler.noroute.toml`
7. Secrets on the router: `npx wrangler secret put ROUTER_SHARED_SECRET --config wildcard-router\wrangler.toml` (and `HEALTH_URL` if you used it).
8. The Pages project and its secrets:
   - `npx wrangler pages project create mydukapos --production-branch=mydukapos`
   - `npx wrangler pages secret put PAYMENT_SECRETS_KEY --project-name=mydukapos` (any 24+ random characters; it may differ from the old one)
   - `PAYMENT_SECRETS_KEY` MUST exist before the restore (without it the restored payment keys would be stored unsealed).
   - the same for `ROUTER_SHARED_SECRET` (the SAME value as on the router), `OWNER_SETUP_TOKEN`, and every other secret from A2. Plain variables (`ROOT_DOMAIN` = `mydukapos.store`, `PAY_CALLBACK_ORIGIN`, ...) go in the dashboard: mydukapos -> Settings -> Variables and Secrets.
   **Your project's address:** `pages project create` (and every deploy) prints it. If `mydukapos` was already taken it is something like `mydukapos-3ao.pages.dev`, NOT `mydukapos.pages.dev`. Wherever this runbook says `mydukapos.pages.dev`, use YOUR address.
   **Tell the router (important):** `node tools\switch-account.mjs --pages-host mydukapos-3ao.pages.dev` (your address) writes it into `wildcard-router\wrangler.toml`; the router forwards EVERY shop address there. Without it the router forwards to `mydukapos.pages.dev`, which on a new account is the OLD account's project (zip 273: found after the first move). Then `npm run deploy:router` (or the `--noroute` deploy before the domain is active). `node tools\switch-account.mjs --show` prints which address the router uses.
9. Deploy the site: `npm run deploy:fast`. Then open `https://mydukapos.pages.dev/api/health?deep=1` - it must say `"d1":true`.
10. The owner console: open `https://mydukapos.pages.dev/owner/`, sign up the owner account (it asks for `OWNER_SETUP_TOKEN`).

## PART C - the night of the move (shops closed)
1. OLD console -> Permanent tab -> Download Permanent Shops Backup. Tick *secret keys*, *platform settings* and *pictures*, choose a passphrase (10+ characters, typed twice). Wait for **Complete.** (anything saying INCOMPLETE: do not use the file). Keep the file and the passphrase apart. Make this the LAST thing done on the old account: whatever is sold after it is not in the file.
2. NEW console (`https://mydukapos.pages.dev/owner/`) -> Permanent tab -> Restore Permanent Shops Backup -> choose the file -> type the passphrase -> read the preview -> Restore. Wait for "All restored shops verified".
3. Check two shops: `https://<slug>.mydukapos.pages.dev` does not exist (subdomains come with the domain), so open them by `https://mydukapos.pages.dev/?c=<id>` (the console shows each shop's id), sign in with the old password / PIN and compare sales and stock.
4. Move the domain: Cloudflare (new account) -> Add a site -> `mydukapos.store` (Free plan). Check that every DNS record from the old account is there (copy any that are missing: MX/TXT for e-mail, etc.). At Namecheap -> the domain -> Nameservers -> Custom DNS -> the two nameservers Cloudflare gave you. Wait until the new account says the site is **Active**.
5. Attach the domain: Pages -> mydukapos -> Custom domains -> add `mydukapos.store` (and `www` if you use it).
6. Make sure the router points at your NEW project (`node tools\switch-account.mjs --pages-host <your project>.pages.dev`, see Part B8), then deploy the router WITH its route: `npm run deploy:router` (then delete `wildcard-router\wrangler.noroute.toml`).
7. Open `https://<a-real-slug>.mydukapos.store` and make a test sale; sign in at `https://mydukapos.store/owner/`.
8. Daraja / Paywave: the callback URLs are on the same domain, so they keep working. Send a test STK from one shop.
9. Everyone signs in once more (sessions are not carried over). Keep the old account untouched for a week.

## Things the backup does NOT carry (copy by hand if you use them)
- R2: payslip PDFs older than 90 days (`DB_BACKUPS` bucket, `payslips/`), archived audit rows (`AUDIT_ARCHIVE`, `audit-archive/`), archived ledger batches (`db-archive/`), the APK downloads (`MEDIA`, `app-releases/`) and the website catalogue pictures (`MEDIA`, `shop/site/`). Cloudflare's R2 "Super Slurper" (dashboard -> R2 -> Data migration) or rclone can copy a bucket to another account.
- Shop pictures ARE carried when "Include shop pictures" is ticked.
- Till numbering and device registry of "database" shops, the demo sign-ups / leads, trashed shops, the platform owner account (you create it again), and sessions (everyone signs in once more).
- The tills' own saved data is on the devices: a device that was offline during the move syncs when it reconnects.

## If the restore is interrupted
While rows are being restored the ledger's audit triggers are OFF (so the restore does not invent audit rows) and they are switched on again when the restore finishes. If the tab was closed or the computer slept before that, run the restore again (it adds only what is missing and switches audit back on at the end) or run this once in the new account:
`npx wrangler d1 execute mydukapos-ledger --remote --command "DELETE FROM ledger_meta WHERE k='audit_disabled'"`
Do not run the restore again on a shop that has already been trading on the new site except to finish an interrupted restore: it keeps what is newer, but check the preview ("Already here").

## If something goes wrong
- Wrong account in the files: `node tools\switch-account.mjs --show`. Old ids back: `node tools\switch-account.mjs --back`.
- Restore says a binding is missing: the preview names it; fix it (Part B) and run the restore again - a second run changes nothing that is already there.
- The domain is not active yet but you need the router deployed: use the `--noroute` copy (Part B6).
- Going back: change the nameservers at Namecheap back to the old account's; nothing was removed there.
