// Deploys the LIVE Pages project from a clean temporary copy of the project.
//
//   npm run deploy:fast        (checks the shared code, then deploys)
//
// Why a copy: `wrangler pages deploy .` uploads EVERYTHING in the folder, and Cloudflare Pages refuses any file over 25 MiB - so a freshly built
// installer (native\windows\dist\...\Setup.exe, 100+ MB) or node_modules made the deploy fail with "Pages only supports files up to 25 MiB".
// The copy leaves out build output, node_modules, git data, installers and zips, and ANY file over 24 MiB (it is listed, so nothing is dropped silently).
// The live wrangler.toml (your KV / D1 / R2 bindings) is copied as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const SKIP_DIRS = new Set(['lan-chat', 'node_modules', '.git', '.wrangler', 'dist', 'build-output', '.idea', '.vscode']);
const SKIP_EXT = /\.(zip|exe|msi|apk|aab|dmg|log)$/i;
const MAX = 24 * 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mydukapos-deploy-'));
const left = [];
// zip 356: RETIRED FILES NEVER GO LIVE AGAIN. robocopy copies a new zip OVER the old folder but never deletes what a release removed, so the
// Chama app, the old CRM and their API files (removed in zips 186 / 269) were still in C:\dev\mydukapos and were uploaded with every deploy -
// they kept showing up. Each zip now carries tools/release-files.json (every file in that release); a file that is not in it is left out of
// the upload (your own wrangler*.toml and *.old-account backups excepted - they are local settings) and listed, so nothing is dropped silently.
let release = null;
try { release = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'release-files.json'), 'utf8')).files); } catch (e) { release = null; }
const LOCAL_OK = /^(wrangler[^/]*\.toml|[^/]*\.old-account|\.deploy-target\.json)$/i;
const retired = [];
fs.cpSync(ROOT, tmp, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).replace(/\\/g, '/');
    if (!rel) return true;
    const base = path.basename(src);
    let st; try { st = fs.statSync(src); } catch (e) { return false; }
    if (st.isDirectory()) return !SKIP_DIRS.has(base);
    if (release && !release.has(rel) && !LOCAL_OK.test(rel)) { retired.push(rel); return false; }
    if (SKIP_EXT.test(base)) { left.push(rel + ' (installer / archive)'); return false; }
    if (st.size > MAX) { left.push(rel + ' (' + Math.round(st.size / 1048576) + ' MiB)'); return false; }
    return true;
  },
});
if (left.length) console.log('Left out of the upload (not part of the website):\n  - ' + left.slice(0, 30).join('\n  - '));
if (retired.length) console.log('Old files from earlier releases left out of the upload (' + retired.length + ', not part of this release - safe to delete from this folder):\n  - ' + retired.slice(0, 40).join('\n  - ') + (retired.length > 40 ? '\n  - ...' : ''));
if (!release) console.log('(tools/release-files.json not found - uploading every file in the folder, as before.)');
import { readTarget, listDeployments, productionBranch, banner, PREVIEW_BRANCH, PROJECT } from './deploy-target.mjs';

// zip 283: PRODUCTION or PREVIEW. Pages calls a deployment "Production" only when --branch equals the project's production branch; any other
// branch is published as a PREVIEW and your domains do not change. So the branch is chosen from the target (node tools\deploy-target.mjs --show / --production / --preview).
const extra = process.argv.slice(2);
const target = readTarget().target;
const deps = listDeployments();
let branch = PREVIEW_BRANCH;
if (target === 'production') {
  branch = productionBranch(deps) || 'main';
  if (!deps) console.log('(Could not read your deployment list - using branch "' + branch + '" for production.)');
}
banner(target === 'production'
  ? ['DEPLOYING TO:  PRODUCTION  (LIVE on your domains)', 'project ' + PROJECT + '   branch ' + branch]
  : ['DEPLOYING TO:  PREVIEW  (test copy - your domains do NOT change)', 'project ' + PROJECT + '   branch ' + branch + '   -> https://' + branch + '.<your-project>.pages.dev',
     'NOTE: a preview uses the SAME KV/D1 data as live. Do not run real sales on it.'], target === 'production' ? '#' : '~');
console.log('Deploying the clean copy to Pages from', tmp, '\n');
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', '.', '--project-name=' + PROJECT, '--branch=' + branch, '--commit-dirty=true', ...extra], { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp folder, harmless */ }
if (r.status === 0) {
  // read back what Cloudflare really recorded, so a silent "went to preview" can never be mistaken for live
  const after = listDeployments();
  const last = after && after[0];
  if (last) {
    const live = last.env === 'production';
    banner([live ? 'RESULT:  PRODUCTION - this release is LIVE.' : 'RESULT:  PREVIEW - this release is NOT live on your domains.', last.url,
      ...(target === 'production' && !live ? ['You asked for production but Cloudflare filed it as preview: its production branch is not "' + branch + '".',
        'Fix:  node tools\\deploy-target.mjs --branch <your production branch>   (see the branch on the Production line of --show), then deploy again.',
        'Or in the dashboard: Workers & Pages > ' + PROJECT + ' > Settings > Builds > Production branch = "' + branch + '".'] : [])], live ? '#' : '!');
  }
}
process.exit(r.status ?? 1);
