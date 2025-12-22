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
    alwaysOnTop: false,

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

  // Emergency quit
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  // Emergency reload
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (win) win.reload();
  });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
