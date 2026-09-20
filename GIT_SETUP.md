# Putting this folder in Git

The repository already exists at https://github.com/samuelmugwe/mydukapos with history. The zips never contained a `.git` folder, so DON'T run
`git init` in the unzipped folder — that starts a second, unrelated history that GitHub will refuse to merge. Bring the new files into a clone of the real repo instead.

## Every time you get a new zip (Windows, PowerShell)

```
# once: get the repository
git clone https://github.com/samuelmugwe/mydukapos.git C:\dev\mydukapos

# each new zip: unzip it somewhere temporary, e.g. C:\dev\zip31, then mirror it into the clone (keeps .git and node_modules, deletes files that were removed)
robocopy C:\dev\zip31 C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml

cd C:\dev\mydukapos
git status                      # look at what changed
npm install                     # first time only (creates package-lock.json — commit it)
npm run check                   # must say "All apps match src/shared/"
git add -A
git commit -m "Zip 31: settings no longer revert; send-before-pull"
git push
```

Mac/Linux: `rsync -a --delete --exclude .git --exclude node_modules --exclude package-lock.json zip31/ mydukapos/`

## If the clone shows almost EVERY file as changed
That is line endings. This folder ships a `.gitattributes` that forces LF. Run once in the clone:
```
git config core.autocrlf false
git add --renormalize .
```
and commit. (`npm run check` needs LF: with CRLF it reports every app as out of sync.)

## What is deliberately not in Git
`node_modules/`, `.wrangler/`, `.dev.vars` / `.env*` (secrets), `*.zip`. Cloudflare secrets (SMS, M-Pesa, Paystack keys, `SESSION`/owner data) live in the Pages project's
environment variables and KV, never in the code. `wrangler.toml` contains a placeholder KV id on purpose; the real binding is set in the Cloudflare dashboard.

## Deploying is separate from Git
Pushing to GitHub does NOT deploy. Deploy with `npm run deploy` from the clone (it runs the checks and tests first).
