const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

let win;

function createWindow() {
  const indexPath = path.join(__dirname, 'renderer', 'index.html');

  win = new BrowserWindow({
    width: 900,
    height: 700,

    fullscreen: true,
    frame: false,
    alwaysOnTop: false, // enable after load

    backgroundColor: '#111111',
    show: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile(indexPath).catch((err) => {
    console.error('[MAIN] loadFile failed:', err);
  });

  // Emergency quit (KEEP)
  const quitOk = globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log('[MAIN] Quit shortcut triggered');
    app.quit();
  });

  // Emergency reload (CHANGE: Cmd+Shift+L)
  const reloadOk = globalShortcut.register('CommandOrControl+Shift+L', () => {
    console.log('[MAIN] Reload shortcut triggered');
    if (win && !win.isDestroyed()) {
      win.reload();
    }
  });

  if (!quitOk || !reloadOk) {
    console.error('[MAIN] Failed to register emergency exits', { quitOk, reloadOk });
    app.quit();
    return;
  }

  // Apply final strictness AFTER content loads
  win.webContents.once('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true);
    console.log('[MAIN] alwaysOnTop enabled');
  });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
