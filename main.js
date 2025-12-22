const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

let win;

function createWindow() {
  const indexPath = path.join(__dirname, 'renderer', 'index.html');

  win = new BrowserWindow({
    width: 900,
    height: 700,

    // Lock step: fullscreen + frameless (still NOT always-on-top)
    fullscreen: true,
    frame: false,
    alwaysOnTop: false,

    backgroundColor: '#111111',
    show: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // DevTools detached so you can see renderer errors even if UI is blank
  win.webContents.openDevTools({ mode: 'detach' });

  console.log('[MAIN] loading:', indexPath);

  win.webContents.on('did-finish-load', () => {
    console.log('[MAIN] did-finish-load OK');
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[MAIN] did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[MAIN] render-process-gone', details);
  });

  win.loadFile(indexPath).catch((err) => {
    console.error('[MAIN] loadFile() threw:', err);
  });

  // Emergency exits (do not remove)
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (win) win.reload();
  });
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) { win.show(); win.focus(); }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
