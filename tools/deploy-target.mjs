// tools/deploy-target.mjs - zip 283. Which Cloudflare Pages environment does "npm run deploy:fast" publish to: PRODUCTION (your real
// domains) or PREVIEW (a test copy at preview.<project>.pages.dev that real customers never see)?
//
//   node tools\deploy-target.mjs --show           what is chosen now, and what Cloudflare really has (latest Production / Preview deployments)
//   node tools\deploy-target.mjs --production     the next deploy goes LIVE
//   node tools\deploy-target.mjs --preview        the next deploy goes to PREVIEW only
//   node tools\deploy-target.mjs --branch <name>  the Git branch name your project treats as production (Pages decides production by this name)
//
// WHY: Pages calls a deployment "Production" only when its --branch equals the project's production branch. Deploy with any other
// branch name and it is silently published as a PREVIEW - the site on your domain does not change, so a fix looks "not applied".
// The choice is kept in .deploy-target.json (next to package.json); an unzip/robocopy of a new release does not remove it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.deploy-target.json');
export const PROJECT = 'mydukapos';
export const PREVIEW_BRANCH = 'preview';

export function readTarget() {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* none yet */ }
  return { target: t.target === 'preview' ? 'preview' : 'production', productionBranch: t.productionBranch || '' };
}
export function writeTarget(t) { fs.writeFileSync(FILE, JSON.stringify(t, null, 2) + '\n'); }

// -> array of { env: 'production'|'preview', branch, url, created } newest first, or null when wrangler cannot list (not logged in / offline)
export function listDeployments(project = PROJECT) {
  const r = spawnSync('npx', ['wrangler', 'pages', 'deployment', 'list', `--project-name=${project}`, '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  const txt = String(r.stdout || '');
  const a = txt.indexOf('['), b = txt.lastIndexOf(']');
  if (a < 0 || b < a) return null;
  let rows; try { rows = JSON.parse(txt.slice(a, b + 1)); } catch (e) { return null; }
  const pick = (o, ...ks) => { for (const k of Object.keys(o)) if (ks.includes(k.toLowerCase().replace(/[^a-z]/g, ''))) return o[k]; return ''; };
  return rows.map((o) => ({
    env: String(pick(o, 'environment', 'env')).toLowerCase().startsWith('prod') ? 'production' : 'preview',
    branch: String(pick(o, 'branch', 'deploymentbranch')),
    url: String(pick(o, 'deployment', 'url')),
    created: String(pick(o, 'created', 'createdon')),
  }));
}

// The branch that makes a deployment "Production": the one chosen with --branch, else the branch of the newest Production deployment.
export function productionBranch(deps) {
  const t = readTarget();
  if (t.productionBranch) return t.productionBranch;
  const p = (deps || []).find((d) => d.env === 'production' && d.branch);
  return p ? p.branch : '';
}

export function banner(lines, ch = '=') {
  const w = Math.max(...lines.map((l) => l.length)) + 4, bar = ch.repeat(w);
  console.log('\n' + bar + '\n' + lines.map((l) => '  ' + l).join('\n') + '\n' + bar + '\n');
}

function main() {
  const a = process.argv.slice(2);
  const t = readTarget();
  if (a.includes('--production')) { t.target = 'production'; writeTarget(t); }
  else if (a.includes('--preview')) { t.target = 'preview'; writeTarget(t); }
  const bi = a.indexOf('--branch');
  if (bi >= 0 && a[bi + 1]) { t.productionBranch = a[bi + 1]; writeTarget(t); }
  const now = readTarget();
  const deps = listDeployments();
  const pb = productionBranch(deps);
  banner([
    now.target === 'production' ? 'DEPLOY TARGET:  PRODUCTION  (the next deploy goes LIVE on your domains)' : 'DEPLOY TARGET:  PREVIEW  (the next deploy is a test copy only - your domains do NOT change)',
    'Production branch name : ' + (pb || '(not known yet - the first production deploy will use "' + 'main' + '", or set it: --branch <name>)'),
    'Preview branch name    : ' + PREVIEW_BRANCH,
  ], now.target === 'production' ? '#' : '~');
  if (!deps) { console.log('(Could not read the deployment list from Cloudflare - run "npx wrangler login" first, then try again.)\n'); return; }
  const show = (env) => { const d = deps.find((x) => x.env === env); return d ? `${d.created}  branch=${d.branch}  ${d.url}` : '(none yet)'; };
  console.log('Latest PRODUCTION deployment on Cloudflare : ' + show('production'));
  console.log('Latest PREVIEW    deployment on Cloudflare : ' + show('preview') + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
