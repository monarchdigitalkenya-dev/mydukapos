# Deploying an update (Windows CMD) — the same every time

Work folder: `C:\dev\mydukapos` (the clone). Replace `zipNN` with the folder you unzip the new zip into.

1. Unzip the new zip:       `tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_NN.zip" -C C:\dev\zipNN` (make the folder first: `mkdir C:\dev\zipNN`)
2. Go to the work folder:   `cd /d C:\dev\mydukapos`
3. Mirror the zip in:       `robocopy C:\dev\zipNN C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml`
4. Install (if tools changed): `npm install`
5. Consistency check:       `npm run check`            (must say "All apps match src/shared/")
6. See what changed:        `git status`   and   `git diff --stat`
7. Staging first (for bigger changes): `npm run deploy:staging`   (and `npm run deploy:router:staging` first if wildcard-router/ changed)
8. Live router (ONLY if wildcard-router/ changed): `npm run deploy:router`
9. Live site:               `npm run deploy`           (check + all tests + upload to PRODUCTION; branch is `mydukapos`)
10. Save to Git:            `git add -A`, `git commit -m "Zip NN: what changed"`, `git push`
11. Verify: `npx wrangler pages deployment list --project-name=mydukapos` -> newest row must be Production; open a client link and make a test sale.

Rollback: Cloudflare dashboard -> Workers & Pages -> mydukapos -> Deployments -> pick the previous Production deployment -> Rollback.
Only the changed files are uploaded (Cloudflare compares file hashes: "61 uploaded, 70 already uploaded"), so always take the WHOLE zip — never copy single files by hand.

Note: `wrangler.staging.toml` is excluded from the mirror on purpose. It holds YOUR staging KV id; copying the zip's version over it would put the placeholder back.
If you ever lose it: `npx wrangler kv namespace list` shows your namespace ids (staging is the one titled mydukapos_kv_staging).
