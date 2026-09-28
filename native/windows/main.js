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
const { app, BrowserWindow, ipcMain, shell, net, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const netSock = require('net');

const PKG = require('./package.json');
const APP = PKG.mydukaApp || { key: 'shop', name: 'MyDukaPOS', product: 'shop', path: '/', rootDomain: 'mydukapos.store' };
const PARTITION = 'persist:mydukapos-' + APP.key;           // on disk, survives restarts and updates
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch (e) { return {}; } }
function writeConfig(c) { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2)); }

function isOurs(u) {
  try { const x = new URL(u); const h = x.hostname.toLowerCase(); return x.protocol === 'https:' && (h === APP.rootDomain || h.endsWith('.' + APP.rootDomain)); } catch (e) { return false; }
}
function isLauncher(u) { return typeof u === 'string' && u.startsWith('file:') && u.includes('launcher.html'); }

let win = null;

function launcherPath() {
  const packed = path.join(process.resourcesPath || '', 'launcher', 'launcher.html');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'launcher', 'launcher.html');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 360, minHeight: 500,
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

  const link = readConfig().link;
  if (link && isOurs(link)) win.loadURL(link); else win.loadFile(launcherPath());
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
  return await new Promise((resolve) => {
    e.sender.print({ silent: !!o.deviceName, deviceName: o.deviceName || undefined, printBackground: true, margins: { marginType: 'none' } },
      (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason || 'The print failed.' }));
  });
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
      { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
