// Re-inserts src/dashboard-pro/adapters/water.{css,js} into the Water/Aqua page (water/index.html) between the zip187-dashboard-water markers.
// First run (markers absent) also adds the dashboard markup + the open() hook; later runs only refresh the CSS and script. Run after editing either source file.
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
let html = read('water/index.html');
const css = read('src/dashboard-pro/adapters/water.css'), js = read('src/dashboard-pro/adapters/water.js');
const block = '<!-- zip187-dashboard-water:begin -->\n<style id="dashboard-water-css">\n' + css + '</style>\n<script id="dashboard-water">\n' + js + '\n</script>\n<!-- zip187-dashboard-water:end -->\n';
const blockRe = /<!-- zip187-dashboard-water:begin -->\n[\s\S]*?<!-- zip187-dashboard-water:end -->\n/;
if (blockRe.test(html)) html = html.replace(blockRe, () => block);
else {
  const anchor = '<!-- @shared-block:form-controls:begin -->';
  if (html.split(anchor).length !== 2) { console.error('anchor for the script block not found exactly once'); process.exit(1); }
  html = html.replace(anchor, () => block + anchor);
}
// markup: the new dashboard root + the old cards folded into <details id="dash-classic"> (ids unchanged: branch compare, print report and tests use them)
if (!html.includes('id="dash-pro-root"')) {
  const open = '                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:20px;">\n                    <div class="dashboard-stat-card">\n                        <div class="dashboard-stat-label">Today\'s Revenue</div>';
  if (html.split(open).length !== 2) { console.error('classic cards anchor not found exactly once'); process.exit(1); }
  html = html.replace(open, () => '                <div id="dash-pro-root"><div class="dp-skel"><i></i><i></i><i></i><i></i></div></div>\n\n                <details id="dash-classic"><summary>Quick snapshot — today &amp; this month (used by branch compare and the printed report)</summary>\n' + open);
  // the branches block sits between the staff table and the bulk deliveries table: lift it out so it stays visible, then close the details after the deliveries table
  const bStart = html.indexOf('                <div id="dash-branches-section" style="display:none; margin-top:24px;">');
  const bEndMarker = '                <h4 style="margin:18px 0 8px;">📅 Upcoming Bulk Deliveries</h4>';
  const bEnd = html.indexOf(bEndMarker, bStart);
  if (bStart < 0 || bEnd < 0) { console.error('branches block not found'); process.exit(1); }
  const branches = html.slice(bStart, bEnd);
  html = html.slice(0, bStart) + html.slice(bEnd);
  const tableEnd = '                    <tbody></tbody>\n                </table>\n                </div>\n                </div>\n            </div>\n        </div>\n';
  const tIdx = html.indexOf('id="dash-upcoming-bookings-table"');
  const endIdx = html.indexOf(tableEnd, tIdx);
  if (tIdx < 0 || endIdx < 0) { console.error('end of deliveries table not found'); process.exit(1); }
  const afterTable = endIdx + '                    <tbody></tbody>\n                </table>\n                </div>\n'.length;
  html = html.slice(0, afterTable) + '                </details>\n\n' + branches + html.slice(afterTable);
}
// the hook: renderAquaDashboard() opens the new dashboard first (a failure never stops the classic cards from filling in)
const hook = "try { if (window.DashPro) window.DashPro.open(); } catch (e) { try { console.error('dashboard', e); } catch (e2) { /* none */ } }";
if (!html.includes(hook)) {
  const fnHead = '        function renderAquaDashboard() {\n';
  if (html.split(fnHead).length !== 2) { console.error('renderAquaDashboard head not found exactly once'); process.exit(1); }
  html = html.replace(fnHead, () => fnHead + '            ' + hook + '\n');
}
fs.writeFileSync(new URL('water/index.html', root), html);
console.log('water dashboard injected into water/index.html');
