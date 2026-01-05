const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let win;

console.log('[MAIN] BOOT: main.js loaded');

function createWindow() {
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
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  win.loadFile(indexPath);

  win.webContents.once('did-finish-load', () => {
    console.log('[MAIN] did-finish-load (alwaysOnTop stays false for picker)');
  });

  registerShortcuts();
}

function registerShortcuts() {
  const quitKeys = ['CommandOrControl+Shift+X', 'CommandOrControl+Shift+Z', 'F12'];
  quitKeys.forEach(k =>
    globalShortcut.register(k, () => {
      console.log('[MAIN] Quit shortcut via', k);
      app.quit();
    })
  );

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    console.log('[MAIN] Reload shortcut');
    win?.reload();
  });

  console.log('[MAIN] Shortcut registration complete');
}

/**
 * THIS IS THE IMPORTANT PART
 * Note the `linefeed` after each app name
 */
function listAppsViaSystemEvents() {
  return new Promise((resolve, reject) => {
    const script = `
      tell application "System Events"
        set output to ""
        repeat with p in (application processes where background only is false)
          set output to output & (name of p) & linefeed
        end repeat
        return output
      end tell
    `;

    exec(
      `osascript -e '${script.replace(/'/g, "'\\''")}'`,
      (err, stdout) => {
        if (err) return reject(err);

        const items = stdout
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);

        resolve(items);
      }
    );
  });
}

ipcMain.handle('list-windows', async () => {
  console.log('[MAIN] list-windows called');
  try {
    const items = await listAppsViaSystemEvents();
    console.log('[MAIN] Enumerated apps:', items.length);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e), items: [] };
  }
});

ipcMain.handle('select-window', async (_e, payload) => {
  console.log('[MAIN] Selected target:', payload?.label);
  return { ok: true };
});

ipcMain.handle('open-accessibility-prefs', async () => {
  shell.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
