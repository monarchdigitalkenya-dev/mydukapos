// Re-inserts src/dashboard-pro/dashboard-pro.{css,js} into the dashboard pages between their markers. Run after editing either source file.
//   node tools/inject-dashboard.mjs                       -> index.html, pharmacy/, production/, services/ (the four apps that use the command center)
//   node tools/inject-dashboard.mjs pharmacy/index.html   -> only the pages named
//   node tools/inject-dashboard.mjs --install [pages...]  -> first-time setup of a page that has no markers yet (CSS block, #dash-pro-root + <details id="dash-classic">
//                                                            around the old stat cards, the script, and the DashPro.open() hook); a page that already has them is only refreshed.
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const ALL = ['index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html'];
const argv = process.argv.slice(2), install = argv.includes('--install');
const pages = argv.filter((a) => !a.startsWith('--')); if (!pages.length) pages.push(...ALL);
const css = read('src/dashboard-pro/dashboard-pro.css'), js = read('src/dashboard-pro/dashboard-pro.js');
const cssRe = /\/\* zip186-dashboard-pro:begin \*\/\n[\s\S]*?\/\* zip186-dashboard-pro:end \*\/\n/;
const jsRe = /<script id="dashboard-pro">\n[\s\S]*?\n<\/script>\n/;
const cssBlock = () => '/* zip186-dashboard-pro:begin */\n' + css + '/* zip186-dashboard-pro:end */\n';
const jsBlock = () => '<script id="dashboard-pro">\n' + js + '\n</script>\n';
const once = (html, anchor, what, page) => { const n = html.split(anchor).length - 1; if (n !== 1) { console.error(`${page}: expected exactly one ${what}, found ${n}`); process.exit(1); } };
function setup(html, page) {
  // 1. CSS after the dashboard stat-card rules
  const cssAnchor = '        .dashboard-stat-sub { font-size: 12px; color: #95a5a6; margin-top: 4px; }\n';
  once(html, cssAnchor, 'dashboard-stat-sub rule', page); html = html.replace(cssAnchor, () => cssAnchor + '\n' + cssBlock());
  // 2. #dash-pro-root + <details id="dash-classic"> around the old cards, tables
  const open = '            <div id="dashboard-money-details">\n';
  once(html, open, 'dashboard-money-details', page);
  html = html.replace(open, () => open + '            <div id="dash-pro-root"><div class="dp-skel"><i></i><i></i><i></i><i></i></div></div>\n\n            <details id="dash-classic"><summary>Quick snapshot — today &amp; this month (used by branch compare and the printed report)</summary>\n');
  const close = '            </table>\n            </div>\n\n            <div id="dash-branches-section"';
  once(html, close, 'end of the top-staff table', page);
  html = html.replace(close, () => '            </table>\n            </div>\n\n            </details>\n\n            <div id="dash-branches-section"');
  // 3. script, last thing in the page
  const end = '<!-- @shared-block:form-controls:end -->\n</body></html>';
  once(html, end, 'page end', page); html = html.replace(end, () => '<!-- @shared-block:form-controls:end -->\n' + jsBlock() + '</body></html>');
  // 4. hook: first statement of renderShopDashboard
  const hook = '        function renderShopDashboard() {\n';
  once(html, hook, 'renderShopDashboard', page);
  html = html.replace(hook, () => hook + "            try { if (window.DashPro) window.DashPro.open(); } catch (e) { try { console.error('dashboard', e); } catch (e2) { /* none */ } }\n");
  return html;
}
for (const page of pages) {
  let html = read(page);
  if (!cssRe.test(html) || !jsRe.test(html)) {
    if (!install) { console.error(`markers not found in ${page} (run with --install for first-time setup)`); process.exit(1); }
    html = setup(html, page);
  } else {
    html = html.replace(cssRe, () => cssBlock()).replace(jsRe, () => jsBlock());
  }
  fs.writeFileSync(new URL(page, root), html);
  console.log('dashboard injected into ' + page);
}
