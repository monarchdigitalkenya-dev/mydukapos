# MyDukaPOS

A family of offline-first point-of-sale apps (Shop, Aqua POS/water, Hotel, Hospital, Production, Services, Pharmacy) plus an Owner Console and a public
website. It deploys as ONE Cloudflare Pages project (static apps + Pages Functions in `functions/`) and one small Worker (`wildcard-router/`) that routes
`*.mydukapos.store` and hosts the Durable Objects. The old CRM module was removed in zip 186.

| Folder | What it is |
|---|---|
| `index.html`, `water/`, `hotel/`, `hospital/`, `production/`, `services/`, `pharmacy/`, `order/` | the POS apps and the QR order page (each a single-file PWA) |
| `owner/` | Owner Console |
| `public-site/` | marketing site + client dashboard |
| `functions/api/` | server endpoints (Cloudflare Pages Functions) |
| `wildcard-router/` | subdomain router + `SyncRoom` and `ShopStore` Durable Objects |
| `migrations/` | D1 schema migrations for `mydukapos-ledger` (applied in order) |
| `src/shared/` | code shared by every app (edit here, then `npm run sync`) |
| `tools/`, `tests/` | sync / drift / backup tools, automated tests |
| `docs/` | design notes and history (`docs/history/CHANGES_ZIP_*.md`, newest last) |

Not public: `docs/`, `migrations/`, `backup/`, `sql/`, `tests/`, `tools/`, `src/`, `wildcard-router/`, `functions/`, `node_modules/`, every `*.md`, and any
`.sql` / `.zip` / `.bak` / `.cmd` file answer 404 on the live site (`functions/_middleware.js`, `isInternalPath`). Keep database exports in `backup/`
(git-ignored).

## Deploy (Windows cmd, in `C:\dev\mydukapos`; run `npm install` once first)

Order matters: backup -> migrations -> router (only if `wildcard-router/` changed) -> Pages.

```
npm run db:backup      # tools\backup-all.cmd  (always before a migration that drops or rewrites data)
npm run db:migrate     # wrangler d1 migrations apply mydukapos-ledger --remote
npm run deploy:router  # the Durable Object router Worker
npm run deploy         # check + all tests + upload to Cloudflare Pages (production)
```

Other commands: `npm run sync` (write `src/shared/` into every app after editing shared code), `npm run check` (fail if any app is out of sync),
`npm run lint`, `npm test` (all tests, several minutes), `npm run deploy:staging`.

Read next: `DEPLOY.md` (step by step, per zip), `STAGING_SETUP.md` (try things safely), `SCALE_PLAN.md` (storage design), `CHANGELOG.md`, `GIT_SETUP.md`.
