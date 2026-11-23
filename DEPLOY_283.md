# Zip 283 - deploy

Run `node tools\deploy-target.mjs --show` before deploying. It prints whether the next deploy is PRODUCTION or PREVIEW and what Cloudflare holds.
Switch with `node tools\deploy-target.mjs --production` or `--preview`. If production lands as a preview, set the branch name:
`node tools\deploy-target.mjs --branch <production branch>` (Cloudflare dashboard > Workers & Pages > mydukapos > Settings > Builds > Production branch).
A preview shares the SAME KV / D1 data as live.
