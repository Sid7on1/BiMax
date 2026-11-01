const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bimax-renderer-boundary-'));
const security = path.join(directory, 'security.cjs');
fs.writeFileSync(
  security,
  require('esbuild').transformSync(fs.readFileSync(path.join(root, 'src/main/security.ts'), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
);
const { REQUIRED_WEB_PREFERENCES, RENDERER_CSP, isAllowedNavigation, isTrustedSender } = require(security);
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
const observations = [];
app
  .whenReady()
  .then(async () => {
    let win;
    try {
      const initial = path.join(directory, 'initial.html'),
        foreign = path.join(directory, 'foreign.html');
      fs.writeFileSync(initial, '<!doctype html><title>Trusted fixture</title>');
      fs.writeFileSync(foreign, '<!doctype html><title>Untrusted project HTML</title>');
      session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] } }),
      );
      win = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(root, 'out/preload/index.js'), ...REQUIRED_WEB_PREFERENCES },
      });
      const trusted = { webContentsId: win.webContents.id, packagedRendererUrls: [pathToFileURL(initial).href] };
      ipcMain.handle('outputs:list', (event) => {
        const accepted = isTrustedSender(
          {
            senderId: event.sender.id,
            frameUrl: event.senderFrame?.url,
            isMainFrame: event.senderFrame === event.senderFrame?.top,
          },
          trusted,
        );
        observations.push({ ipcAccepted: accepted, frameUrl: event.senderFrame?.url });
        return accepted ? ['synthetic-private-sentinel'] : [];
      });
      let navigation;
      const attempted = new Promise((resolve) => {
        navigation = resolve;
      });
      win.webContents.on('will-navigate', (event, url) => {
        const allowed = isAllowedNavigation(url, trusted);
        if (!allowed) event.preventDefault();
        observations.push({ navigationAllowed: allowed });
        navigation(allowed);
      });
      win.webContents.on('will-redirect', (event, url) => {
        if (!isAllowedNavigation(url, trusted)) event.preventDefault();
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await win.loadFile(initial);
      assert.deepEqual(await win.webContents.executeJavaScript('window.bimax.outputs.list()'), [
        'synthetic-private-sentinel',
      ]);
      await win.webContents.executeJavaScript(`location.href=${JSON.stringify(pathToFileURL(foreign).href)}`);
      assert.equal(
        await Promise.race([
          attempted,
          new Promise((_, reject) => setTimeout(() => reject(Error('navigation event missing')), 3000)),
        ]),
        false,
      );
      assert.equal(win.webContents.getURL(), pathToFileURL(initial).href);
      // Even a privileged main-process load cannot grant a foreign document IPC authority.
      await win.loadFile(foreign);
      assert.deepEqual(await win.webContents.executeJavaScript('window.bimax.outputs.list()'), []);
      const result = { passed: true, usedProductionPreload: true, electron: process.versions.electron, observations };
      console.log(JSON.stringify(result));
      if (process.env.BIMAX_SECURITY_REPORT)
        fs.writeFileSync(process.env.BIMAX_SECURITY_REPORT, JSON.stringify(result, null, 2));
    } finally {
      win?.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
