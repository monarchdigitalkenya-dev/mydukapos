# Zip 284 - deploy (new Cloudflare account)

Fix: `node tools\switch-account.mjs --kv .. --ledger .. --audit .. --owner .. --pages-host <address>` used to write the four ids and silently IGNORE `--pages-host`.
The router then kept forwarding shop addresses to the OLD account's project (error 1016 / 503 on shop subdomains). Both are now written by one command.
Also fine to run `--pages-host` on its own. Always run `--show` afterwards: it must say `Router forwards shop addresses to: mydukapos-3ao.pages.dev`.

The robocopy line below skips every `wrangler.toml` (also the one in `wildcard-router`), so your account's ids and PAGES_ORIGIN are never overwritten by the zip.

Deploy order: router first, then the site. Never use `/MIR`.
