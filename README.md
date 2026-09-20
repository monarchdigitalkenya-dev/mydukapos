# MyDukaPOS

A family of offline-first point-of-sale apps (Shop, Aqua POS/water, Hotel, Hospital, School, Production, Services, Pharmacy) plus an Owner Console and a public
website, deployed as one Cloudflare Pages project with Pages Functions (`functions/`) and a router/Durable Object Worker (`wildcard-router/`).

| Folder | What it is |
|---|---|
| `index.html`, `water/`, `hotel/`, `hospital/`, `school/`, `production/`, `services/`, `pharmacy/` | the POS apps (each a single-file PWA) |
| `owner/` | Owner Console |
| `public-site/` | marketing site + client dashboard |
| `functions/api/` | server endpoints (Cloudflare Pages Functions) |
| `wildcard-router/` | subdomain router + `SyncRoom` and `ShopStore` Durable Objects |
| `src/shared/` | code shared by every app (edit here, then `npm run sync`) |
| `tools/` | sync / drift / promotion tools |
| `tests/` | automated tests (`npm test`) |

Everyday commands (run `npm install` once first):

```
npm run sync     # write src/shared/ into every app after editing shared code
npm run check    # fail if any app is out of sync
npm test         # all tests (about 8 minutes)
npm run deploy   # check + tests + upload to Cloudflare Pages
```

Read next: `STAGING_SETUP.md` (how to try things safely), `SCALE_PLAN.md` (storage design and status), `CHANGES_ZIP_24.md` (what changed, newest last), `GIT_SETUP.md`.
