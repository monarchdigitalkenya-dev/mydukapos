# Zip 292 - deploy

1. `node tools\deploy-target.mjs --show` - confirm PRODUCTION or PREVIEW. Switch with `--production` / `--preview`. A preview shares the SAME KV / D1 data as live.
2. No D1 migration is needed (`npx wrangler d1 migrations apply mydukapos-ledger --remote` is safe to run, it will say nothing to apply).
3. New fields on a hotel order (`billPrintedAt`, `billFirstPrintedAt`, `billPrintCount`) are optional; old orders keep working. Items with no station set keep the automatic rule.
4. After deploy, open each app once so the service worker (`zip-292`) updates, then tap anywhere once on kitchen / bar screens to unlock sound.
