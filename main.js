const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,

    // SAFE DEFAULTS (do not change yet)
    fullscreen: false,
    frame: true,
    alwaysOnTop: false,
    backgroundColor: '#ffffff',

    show: false, // show only after ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // ok if file exists; if not, remove this line
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile('renderer/index.html');

  // Show window only when ready (prevents "blank flash" confusion)
  win.once('ready-to-show', () => win.show());

  // Emergency exit #1: Cmd+Shift+Q / Ctrl+Shift+Q (works even on blank UI)
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit();
  });

  // Emergency exit #2: Cmd+Shift+R / Ctrl+Shift+R to reload
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (win) win.reload();
  });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());
