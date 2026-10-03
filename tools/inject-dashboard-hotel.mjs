// Re-inserts src/dashboard-pro/adapters/hotel.{css,js} into the Hotel page (hotel/index.html) between their zip187-dashboard-hotel markers.
// The first run creates the markers (CSS just before the print-page style, script just before the shared form-controls block); every later run
// only replaces what is between them. Run after editing either source file.
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
let html = read('hotel/index.html');
const css = read('src/dashboard-pro/adapters/hotel.css'), js = read('src/dashboard-pro/adapters/hotel.js');
const cssRe = /<style id="dashboard-hotel-css">\n\/\* zip187-dashboard-hotel:begin \*\/\n[\s\S]*?\/\* zip187-dashboard-hotel:end \*\/\n<\/style>\n/;
const jsRe = /<!-- zip187-dashboard-hotel:begin -->\n<script id="dashboard-hotel">\n[\s\S]*?\n<\/script>\n<!-- zip187-dashboard-hotel:end -->\n/;
const cssBlock = '<style id="dashboard-hotel-css">\n/* zip187-dashboard-hotel:begin */\n' + css + '\n/* zip187-dashboard-hotel:end */\n</style>\n';
const jsBlock = '<!-- zip187-dashboard-hotel:begin -->\n<script id="dashboard-hotel">\n' + js + '\n</script>\n<!-- zip187-dashboard-hotel:end -->\n';
if (cssRe.test(html)) html = html.replace(cssRe, () => cssBlock);
else {
  const at = html.indexOf('    <style id="print-page-style">');
  if (at < 0) { console.error('anchor for the CSS not found in hotel/index.html'); process.exit(1); }
  html = html.slice(0, at) + cssBlock + html.slice(at);
}
if (jsRe.test(html)) html = html.replace(jsRe, () => jsBlock);
else {
  const at = html.indexOf('<!-- @shared-block:form-controls:begin -->');
  if (at < 0) { console.error('anchor for the script not found in hotel/index.html'); process.exit(1); }
  html = html.slice(0, at) + jsBlock + html.slice(at);
}
fs.writeFileSync(new URL('hotel/index.html', root), html);
console.log('hotel dashboard injected into hotel/index.html');
