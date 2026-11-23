// zip 304: writes src/owner/owner-pro.html (the Owner Console's Money tab, dashboard and look) into owner/index.html between its markers.
//   node tools/inject-owner-pro.mjs          write it
//   node tools/inject-owner-pro.mjs --check  change nothing; exit 1 if owner/index.html is out of date (part of `npm run check`)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
const check = process.argv.includes('--check');
const file = path.join(ROOT, 'owner', 'index.html');
const src = fs.readFileSync(path.join(ROOT, 'src', 'owner', 'owner-pro.html'), 'utf8').replace(/\n+$/, '');
const B = '<!-- zip304-owner-pro:begin -->', E = '<!-- zip304-owner-pro:end -->';
let html = fs.readFileSync(file, 'utf8');
const block = `${B}\n${src}\n${E}`;
let next;
if (html.includes(B)) next = html.replace(new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + E.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), () => block);
else { const i = html.lastIndexOf('</body>'); next = html.slice(0, i) + block + '\n' + html.slice(i); }
if (next === html) { console.log('owner pro in sync'); process.exit(0); }
if (check) { console.error('owner/index.html is out of date - run: node tools/inject-owner-pro.mjs'); process.exit(1); }
fs.writeFileSync(file, next); console.log('owner pro written');
