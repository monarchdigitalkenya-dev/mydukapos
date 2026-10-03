// Inserts / refreshes the Hospital dashboard adapter (src/dashboard-pro/adapters/hospital.{css,js}) in hospital/index.html between the
// zip187-dashboard-hospital markers. First run adds the blocks at their anchors; later runs replace what is between the markers.
// The tab button, the #dashboard-tab panel and the tab-switch hook are plain edits in hospital/index.html (not generated here).
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const page = 'hospital/index.html';
let html = read(page);
const css = read('src/dashboard-pro/adapters/hospital.css'), js = read('src/dashboard-pro/adapters/hospital.js');
const CSS_B = '/* zip187-dashboard-hospital:begin */\n', CSS_E = '/* zip187-dashboard-hospital:end */\n';
const JS_B = '<script id="dashboard-hospital">\n/* zip187-dashboard-hospital:begin */\n', JS_E = '\n/* zip187-dashboard-hospital:end */\n</script>\n';
const cssRe = /\/\* zip187-dashboard-hospital:begin \*\/\n[\s\S]*?\/\* zip187-dashboard-hospital:end \*\/\n/;
const jsRe = /<script id="dashboard-hospital">\n\/\* zip187-dashboard-hospital:begin \*\/\n[\s\S]*?\n\/\* zip187-dashboard-hospital:end \*\/\n<\/script>\n/;
if (cssRe.test(html)) html = html.replace(cssRe, () => CSS_B + css + CSS_E);
else {
  const a = '</style>\n    <style id="print-page-style"></style>';
  if (!html.includes(a)) { console.error('css anchor not found in ' + page); process.exit(1); }
  html = html.replace(a, () => CSS_B + css + CSS_E + a);
}
if (jsRe.test(html)) html = html.replace(jsRe, () => JS_B + js + JS_E);
else {
  const a = '\n<!-- @shared-block:receipt-size:begin -->';
  if (!html.includes(a)) { console.error('script anchor not found in ' + page); process.exit(1); }
  html = html.replace(a, () => '\n' + JS_B + js + JS_E + a);
}
fs.writeFileSync(new URL(page, root), html);
console.log('hospital dashboard injected into ' + page);
