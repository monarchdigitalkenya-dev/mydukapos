// Deploys to the STAGING Pages project without ever touching live.
//
//   npm run deploy:staging        (runs the shared-code check first)
//
// `wrangler pages deploy` reads ./wrangler.toml — which is bound to the LIVE KV namespace. So this copies the project to a temporary
// folder, puts wrangler.staging.toml there AS wrangler.toml, and deploys from that copy. Live config is never used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const staging = fs.readFileSync(path.join(ROOT, 'wrangler.staging.toml'), 'utf8');
if (staging.includes('REPLACE_WITH_STAGING_KV_ID')) {
  console.error('\nwrangler.staging.toml still has the placeholder KV id.\n  1) npx wrangler kv namespace create mydukapos_kv_staging\n  2) paste the id it prints into wrangler.staging.toml\n  3) run this again\n');
  process.exit(1);
}
const live = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8').match(/^id = "([0-9a-f]{32})"/m);
const stagingId = staging.match(/^id = "([0-9a-f]{32})"/m);
if (live && stagingId && live[1] === stagingId[1]) {
  console.error('\nThe staging KV id is the SAME as the live one — refusing to continue (that would let staging tests change live data).\n');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mydukapos-staging-'));
const skip = new Set(['node_modules', '.git', '.wrangler']);
fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
fs.writeFileSync(path.join(tmp, 'wrangler.toml'), staging);
console.log('Deploying a copy of the project to the STAGING project (mydukapos-staging) from', tmp);
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', '.', '--project-name=mydukapos-staging', '--branch=main'], { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
