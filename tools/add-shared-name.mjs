// Adds shared function name(s) to the @shared names list of every app (or only the listed ones), keeping the list sorted.
//   node tools/add-shared-name.mjs fnA fnB            all apps
//   node tools/add-shared-name.mjs --apps hotel,index fnA
import { MODULES, REGION_RE, read, write } from './lib.mjs';
const args = process.argv.slice(2);
let only = null; if (args[0] === '--apps') { only = args[1].split(','); args.splice(0, 2); }
for (const m of MODULES) {
  const key = m === 'index.html' ? 'index' : m.split('/')[0];
  if (only && !only.includes(key)) continue;
  const html = read(m); const mm = html.match(REGION_RE); if (!mm) continue;
  const names = new Set(mm[1].split(',').filter(Boolean)); args.forEach((a) => names.add(a));
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  write(m, html.replace(mm[1], sorted.join(',')));
}
