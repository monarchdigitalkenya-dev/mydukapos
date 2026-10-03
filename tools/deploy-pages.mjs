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

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build-output', '.idea', '.vscode']);
const SKIP_EXT = /\.(zip|exe|msi|apk|aab|dmg|log)$/i;
const MAX = 24 * 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mydukapos-deploy-'));
const left = [];
fs.cpSync(ROOT, tmp, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).replace(/\\/g, '/');
    if (!rel) return true;
    const base = path.basename(src);
    let st; try { st = fs.statSync(src); } catch (e) { return false; }
    if (st.isDirectory()) return !SKIP_DIRS.has(base);
    if (SKIP_EXT.test(base)) { left.push(rel + ' (installer / archive)'); return false; }
    if (st.size > MAX) { left.push(rel + ' (' + Math.round(st.size / 1048576) + ' MiB)'); return false; }
    return true;
  },
});
if (left.length) console.log('Left out of the upload (not part of the website):\n  - ' + left.slice(0, 30).join('\n  - '));
console.log('\nDeploying the clean copy to the live Pages project from', tmp, '\n');
const extra = process.argv.slice(2);
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', '.', '--project-name=mydukapos', '--branch=mydukapos', '--commit-dirty=true', ...extra], { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp folder, harmless */ }
process.exit(r.status ?? 1);
