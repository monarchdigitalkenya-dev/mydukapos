// What the pages in the MyDukaPOS Windows app may ask of it (see main.js; every request is checked there again).
//   window.MyDukaLauncher — the first-start screen only.   window.MyDukaNative — the shop's web app.
// Results reach the page as promises (Windows) — the web app's native helper (native-app block) handles both this and Android.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MyDukaLauncher', {
  info: () => ipcRenderer.sendSync('launcher:info'),
  forget: () => ipcRenderer.invoke('launcher:forget'),
  open: (raw, id) => { ipcRenderer.invoke('launcher:open', raw).then((r) => window.postMessage({ type: 'launcherCb', id, r }, '*')); },
});

contextBridge.exposeInMainWorld('MyDukaNative', {
  info: () => ipcRenderer.sendSync('native:info'),
  printers: () => ipcRenderer.invoke('native:printers'),
  print: (opts) => ipcRenderer.invoke('native:print', opts),
  netPrint: (host, port, base64) => ipcRenderer.invoke('native:netPrint', host, port, base64),
  forgetShop: () => ipcRenderer.invoke('native:forgetShop'),
});
