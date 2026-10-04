// MyDukaPOS for Windows (Electron). zip 148.
//
// The POS itself is this shop's MyDukaPOS web app (its own address, e.g. georgehardware.mydukapos.store), run in a window with a
// DURABLE storage partition: the web app keeps every sale on this computer (localStorage + IndexedDB journal) and syncs by itself —
// offline included. What a browser tab cannot do, this app adds (preload.js → window.MyDukaNative):
//   * printing to a chosen Windows printer WITHOUT the print dialog (USB / network / shared printers with their Windows driver);
//   * raw ESC/POS to a network thermal printer (IP address, port 9100);
//   * the list of Windows printers, with their real status from Windows.
// First start: the launcher asks for the shop's link and checks it with the server (licence + module: a Hotel link does not open in
// the Shop app). After that the app opens straight into the shop.
const { app, BrowserWindow, ipcMain, shell, net, session, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const netSock = require('net');
const rawPrint = require('./printraw');             // raw ESC/POS to a Windows printer through the spooler (zip 206)

const PKG = require('./package.json');
const APP = PKG.mydukaApp || { key: 'shop', name: 'MyDukaPOS', product: 'shop', path: '/', rootDomain: 'mydukapos.store' };
const PARTITION = 'persist:mydukapos-' + APP.key;           // on disk, survives restarts and updates
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch (e) { return {}; } }
function writeConfig(c) { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2)); }

function isOurs(u) {
  try { const x = new URL(u); const h = x.hostname.toLowerCase(); return x.protocol === 'https:' && (h === APP.rootDomain || h.endsWith('.' + APP.rootDomain)); } catch (e) { return false; }
}
function isLauncher(u) { return typeof u === 'string' && u.startsWith('file:') && (u.includes('launcher.html') || u.includes('offline.html')); }

let win = null;

// zip 176 — "the Windows app hangs and is too zoomed".
//  * Size: the window opens at ~92% of the usable screen (never bigger than it), centred — not a fixed 1280x820.
//  * Zoom: the web app is laid out for ~1600 CSS px of width. On a laptop at Windows scaling 125% / 150% the screen is only 1280-1536
//    "device-independent" px wide, so everything looked magnified. We start at a zoom that fits the screen (0.8 .. 1.0) and the cashier
//    can change it with Ctrl +  /  Ctrl -  /  Ctrl 0; the choice is remembered.
//  * Hangs: a page that stops answering for 6 s is reloaded (its data is on this PC), and "Safe graphics" (View menu) turns off GPU
//    acceleration for old graphics drivers that freeze Chromium.
const ZOOM_MIN = 0.5, ZOOM_MAX = 1.6;
function clampZoom(z) { z = Number(z); return isFinite(z) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100)) : 1; }
function autoZoom() {
  try { const w = screen.getPrimaryDisplay().workAreaSize.width; return clampZoom(Math.min(1, w / 1600)); } catch (e) { return 1; }
}
function currentZoom() { const c = readConfig(); return c.zoom ? clampZoom(c.zoom) : autoZoom(); }
function applyZoom() { try { if (win && !win.isDestroyed()) win.webContents.setZoomFactor(currentZoom()); } catch (e) { /* closing */ } }
function stepZoom(delta) {
  const z = delta === 0 ? autoZoom() : clampZoom(currentZoom() + delta);
  const c = readConfig(); if (delta === 0) delete c.zoom; else c.zoom = z; writeConfig(c);
  applyZoom();
}
// Safe graphics must be decided before the app is ready
try { if (readConfig().safeGraphics) app.disableHardwareAcceleration(); } catch (e) { /* first start: no config yet */ }

function launcherPath() {
  const packed = path.join(process.resourcesPath || '', 'launcher', 'launcher.html');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'launcher', 'launcher.html');
}

function offlinePath() {
  const packed = path.join(process.resourcesPath || '', 'launcher', 'offline.html');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'launcher', 'offline.html');
}

function createWindow() {
  let wa = { x: 0, y: 0, width: 1366, height: 768 };
  try { wa = screen.getPrimaryDisplay().workArea; } catch (e) { /* default */ }
  const ww = Math.max(Math.min(wa.width, 800), Math.min(1600, Math.round(wa.width * 0.92)));
  const wh = Math.max(Math.min(wa.height, 560), Math.min(980, Math.round(wa.height * 0.92)));
  win = new BrowserWindow({
    width: ww, height: wh, x: wa.x + Math.round((wa.width - ww) / 2), y: wa.y + Math.round((wa.height - wh) / 2),
    minWidth: 360, minHeight: 500,
    title: APP.name,
    icon: path.join(__dirname, 'build', APP.key + '.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const ses = win.webContents.session;
  ses.setUserAgent(ses.getUserAgent() + ` MyDukaPOS-Windows/${APP.key}/${app.getVersion()}`);
  // camera (barcode scanner) only for our pages
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission) && isOurs(details.requestingUrl || wc.getURL())));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow' };
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url) || isLauncher(url)) return;
    e.preventDefault();
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
  });

  // zoom that fits this screen (or the cashier's own choice), set again after every page load (the launcher, the shop, the offline screen)
  win.webContents.on('did-finish-load', applyZoom);
  win.webContents.on('dom-ready', applyZoom);
  // a frozen page: wait 6 s, then reload it instead of leaving the cashier with a dead window
  let hangTimer = null;
  win.on('unresponsive', () => { clearTimeout(hangTimer); hangTimer = setTimeout(() => { try { if (!win.isDestroyed()) win.webContents.reload(); } catch (err) { /* closing */ } }, 6000); });
  win.on('responsive', () => { clearTimeout(hangTimer); });

  // The shop's page could not be loaded at all (no internet on the very first open, DNS, server down): show the app's own
  // "Can't reach your shop" screen, which keeps trying and opens the shop by itself, instead of a blank error page.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isOurs(url)) return;               // -3 = the load was replaced by another one
    win.loadFile(offlinePath(), { query: { u: url } });
  });

  // the server answered with a failure page (Cloudflare 5xx while the shop's server restarts): same screen, same automatic retry
  win.webContents.on('did-navigate', (e, url, httpResponseCode) => {
    if (httpResponseCode >= 500 && isOurs(url)) win.loadFile(offlinePath(), { query: { u: url } });
  });
  // the page's process crashed or was killed: without this the window stays blank. Reload it (its data is on this PC and on the server).
  win.webContents.on('render-process-gone', (e, details) => {
    if (details && details.reason === 'clean-exit') return;
    setTimeout(() => { try { if (!win.isDestroyed()) win.reload(); } catch (err) { /* window closing */ } }, 500);
  });

  // Owner Console app: always the one fixed address (https://<root domain>/owner/) — no shop link, no licence check; the console has its own login
  if (APP.fixed) { win.loadURL('https://' + APP.rootDomain + APP.path); return; }
  const link = readConfig().link;
  if (link && isOurs(link)) win.loadURL(link); else win.loadFile(launcherPath());
}

// A print that never calls back must not hang the till for ever: after the limit the cashier gets an answer and the next job can go.
function withTimeout(promise, ms, message) {
  return new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: false, error: message }), ms); promise.then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); resolve({ ok: false, error: err && err.message || 'The print failed.' }); }); });
}

// One line per print job in print.log (user data folder, kept small): when, what kind, which printer, how many bytes, the result.
// Never the receipt's content, names or amounts.
function printLog(kind, info) {
  try {
    const f = path.join(app.getPath('userData'), 'print.log');
    try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.old'); } catch (x) { /* none yet */ }
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), kind, ...info }) + '\n');
  } catch (x) { /* logging never breaks printing */ }
}

// ---- IPC: every handler checks the page asking is ours ----
const fromOurs = (e) => isOurs(e.senderFrame && e.senderFrame.url);
const fromLauncher = (e) => isLauncher(e.senderFrame && e.senderFrame.url);

ipcMain.on('launcher:info', (e) => { e.returnValue = JSON.stringify({ appName: APP.name, module: APP.key, product: APP.product, version: app.getVersion(), rootDomain: APP.rootDomain }); });

ipcMain.handle('launcher:open', async (e, raw) => {
  if (!fromLauncher(e)) return { ok: false, error: 'Not allowed.' };
  try {
    let s = String(raw || '').trim();
    if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
    const u = new URL(s);
    u.protocol = 'https:';
    if (!isOurs(u.toString())) return { ok: false, error: `That is not a MyDukaPOS link. It looks like  yourshop.${APP.rootDomain}` };
    const c = u.searchParams.get('c');
    const base = 'https://' + u.hostname;
    let res;
    try { res = await net.fetch(base + '/api/license-status' + (c ? '?c=' + encodeURIComponent(c) : ''), { headers: { Accept: 'application/json' } }); }
    catch (err) { return { ok: false, error: 'No connection to the server. The first start needs internet; after that the app also works offline.' }; }
    const lic = await res.json().catch(() => ({}));
    if (!lic.valid && lic.reason !== 'expired') return { ok: false, error: 'This link is not active. Check it with your provider.' };
    const product = lic.product || 'shop';
    if (product !== APP.product) return { ok: false, error: `This link is for another MyDukaPOS app (${product}). Install that app, or use its link in the browser.` };
    const link = base + APP.path + (c ? '?c=' + encodeURIComponent(c) : '');
    writeConfig({ ...readConfig(), link, savedAt: Date.now() });
    win.loadURL(link);
    return { ok: true, link };
  } catch (err) { return { ok: false, error: 'The link could not be checked: ' + err.message }; }
});

ipcMain.handle('launcher:forget', async (e) => {
  if (!fromLauncher(e)) return { ok: false };
  const c = readConfig(); delete c.link; writeConfig(c);
  win.loadFile(launcherPath());
  return { ok: true };
});

ipcMain.on('native:info', (e) => {
  e.returnValue = fromOurs(e) ? JSON.stringify({ platform: 'windows', module: APP.key, product: APP.product, appName: APP.name, version: app.getVersion(), os: process.getSystemVersion(), arch: process.arch }) : '{}';
});

// Windows' own printer list, with the status Windows reports
ipcMain.handle('native:printers', async (e) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  try { const list = await e.sender.getPrintersAsync(); return { ok: true, printers: list.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault, status: p.status })) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Prints the page as it is on screen now (receipt / report in its print layout), to the chosen printer, without a dialog.
// The answer is Windows' own result for the job; the page gets 'afterprint' only after it.
ipcMain.handle('native:print', async (e, opts) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  const o = opts || {};
  // zip 192: let the print layout settle (two frames) before Windows gets the page - printing the instant the print CSS was switched on gave empty pages
  await new Promise((r) => setTimeout(r, 350));
  const po = { silent: !!o.deviceName, deviceName: o.deviceName || undefined, printBackground: true, margins: { marginType: 'none' } };
  const w = Number(o.widthMm), h = Number(o.heightMm);
  if (w >= 30 && w <= 320 && h >= 30 && h <= 3000) po.pageSize = { width: Math.round(w * 1000), height: Math.round(h * 1000) };
  return await withTimeout(new Promise((resolve) => {
    e.sender.print(po, (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason || 'The print failed.' }));
  }), 45000, 'Windows did not answer the print request in time.');
});

// zip 192: prints a SNAPSHOT (the receipt / kitchen ticket markup + the page's styles) from its own hidden window, so the print never depends on what
// the live window shows (viewport size, hidden modal, theme) - the cause of "prints, but the paper is empty".
ipcMain.handle('native:printHtml', async (e, opts) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  const o = opts || {};
  const html = String(o.html || '');
  if (!html || html.length > 8 * 1024 * 1024) return { ok: false, error: 'Nothing to print.' };
  const w = Number(o.widthMm), h = Number(o.heightMm);
  const win = new BrowserWindow({ show: false, width: Math.max(300, Math.round((w || 80) * 3.78)), height: 900, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  const tmp = require('path').join(require('os').tmpdir(), 'mydukapos-print-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html');   // a file, not a data: URL (a logo makes the page large)
  const done = (r) => { try { win.destroy(); } catch (x) { /* gone */ } try { require('fs').unlinkSync(tmp); } catch (x) { /* gone */ } return r; };
  try {
    require('fs').writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 400));
    const po = { silent: !!o.deviceName, deviceName: o.deviceName || undefined, printBackground: true, margins: { marginType: 'none' } };
    if (w >= 30 && w <= 320 && h >= 30 && h <= 3000) po.pageSize = { width: Math.round(w * 1000), height: Math.round(h * 1000) };
    return done(await withTimeout(new Promise((resolve) => {
      win.webContents.print(po, (success, why) => resolve(success ? { ok: true } : { ok: false, error: why || 'The print failed.' }));
    }), 45000, 'Windows did not answer the print request in time.'));
  } catch (err) { return done({ ok: false, error: err.message }); }
});

// Raw ESC/POS bytes to a network thermal printer (port 9100 by default). ok only after the bytes were sent and the printer closed.
ipcMain.handle('native:netPrint', async (e, host, port, base64) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!/^[\w.-]+$/.test(String(host || ''))) return { ok: false, error: 'Enter the printer\'s IP address.' };
  return await new Promise((resolve) => {
    const s = netSock.createConnection({ host, port: Number(port) || 9100, timeout: 8000 }, () => { s.end(bytes); });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    s.on('close', (hadError) => finish(hadError ? { ok: false, error: 'The connection to the printer failed.' } : { ok: true, bytes: bytes.length }));
    s.on('timeout', () => { s.destroy(); finish({ ok: false, error: 'The printer did not answer (check its IP address and that it is on).' }); });
    s.on('error', (err) => finish({ ok: false, error: err.code === 'ECONNREFUSED' ? 'The printer refused the connection (wrong port?).' : err.message }));
  });
});

// RAW ESC/POS bytes to a Windows-installed printer (USB, shared, or any with a driver) through the spooler. ok = the spooler took every byte and
// Windows shows no fault for the printer/job - see printraw.js. This is what makes the cutter, drawer, logo and raster bytes reach the printer.
ipcMain.handle('native:rawPrint', async (e, deviceName, base64) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  const r = await rawPrint.sendRaw({ deviceName: String(deviceName || ''), bytes });
  printLog('raw', { printer: String(deviceName || '').slice(0, 80), bytes: bytes.length, ok: !!r.ok, stage: r.stage, job: r.jobId || 0, status: r.printerStatus || '', jobStatus: r.jobStatus || '', err: r.ok ? '' : String(r.error || '').slice(0, 160) });
  return r;
});

// What Windows says about ONE printer right now (or about the saved one): present? offline? paper out? Used by Settings > Printer health.
ipcMain.handle('native:printerStatus', async (e, deviceName) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  try {
    const list = await e.sender.getPrintersAsync();
    const p = list.find((x) => x.name === deviceName);
    if (!p) return { ok: true, found: false, count: list.length, error: 'Windows does not list a printer called "' + deviceName + '" (removed or renamed).' };
    const st = rawPrint.decodeStatus(p.status);
    return { ok: true, found: true, name: p.name, isDefault: !!p.isDefault, status: st, driver: (p.options && (p.options['printer-make-and-model'] || p.options.driverName)) || '' };
  } catch (err) { return { ok: false, error: err.message }; }
});

// The last lines of print.log, for the diagnostics panel
ipcMain.handle('native:printLog', async (e) => {
  if (!fromOurs(e)) return { ok: false, error: 'Not allowed.' };
  try { const t = fs.readFileSync(path.join(app.getPath('userData'), 'print.log'), 'utf8').trim().split('\n').slice(-40); return { ok: true, lines: t }; }
  catch (err) { return { ok: true, lines: [] }; }
});

ipcMain.handle('native:forgetShop', async (e) => {
  if (!fromOurs(e)) return { ok: false };
  const c = readConfig(); delete c.link; writeConfig(c);
  win.loadFile(launcherPath());
  return { ok: true };
});

// ---- one window per app; keyboard shortcuts; start ----
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.mydukapos.' + APP.key + '.desktop');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'App', submenu: [{ role: 'reload', label: 'Reload' }, { role: 'toggleDevTools', visible: false }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => stepZoom(0.05) },
        { label: 'Zoom in (numpad)', accelerator: 'CmdOrCtrl+numadd', visible: false, click: () => stepZoom(0.05) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => stepZoom(-0.05) },
        { label: 'Zoom out (numpad)', accelerator: 'CmdOrCtrl+numsub', visible: false, click: () => stepZoom(-0.05) },
        { label: 'Fit to this screen', accelerator: 'CmdOrCtrl+0', click: () => stepZoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Safe graphics (use if the app freezes) — restarts the app', type: 'checkbox', checked: !!readConfig().safeGraphics,
          click: (item) => { const c = readConfig(); c.safeGraphics = item.checked; writeConfig(c); app.relaunch(); app.quit(); } },
      ] },
    ]));
    createWindow();
    // zip 213: PowerShell is started only once the shop page has finished loading and the PC has been quiet for a while (it used to start
    // 2.5 s after launch, right while the page was still loading, and made opening the app slow); the first print waits for it if needed
    const warmLater = () => setTimeout(() => { try { rawPrint.warm().catch(() => {}); } catch (e) { /* printing falls back to the slower way */ } }, 12000);
    let warmQueued = false;
    const queueWarm = () => { if (!warmQueued) { warmQueued = true; warmLater(); } };
    try { win.webContents.once('did-finish-load', queueWarm); } catch (e) { /* the timer below covers it */ }
    setTimeout(queueWarm, 15000);   // safety: never skipped
    app.on('before-quit', () => { try { rawPrint.workerKill(); } catch (e) { /* closing anyway */ } });
  });
  app.on('window-all-closed', () => app.quit());
}
