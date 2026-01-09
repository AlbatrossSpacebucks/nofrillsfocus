// main.js
const path = require("path");
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const { execFile } = require("child_process");

let pickerWin = null;
let maskWins = [];
let session = null;
// Remember previous menu-bar autohide state so we can restore it.
let menuBarPrev = null;

let pinInterval = null;
let sessionTimer = null;
let watchdogInterval = null;
let pinFailCount = 0;

// lets the picker show “Time’s up — you made it.” after timed sessions
let lastEndReason = null;

const DEBUG = {
  devtools: process.env.WORKROOM_DEVTOOLS === "1",
  showPickerOnBoot: process.env.WORKROOM_SHOW_PICKER === "1",
};

function log(...args) {
  console.log(...args);
}

/**
 * AppleScript helper: run small scripts safely.
 */
function runOSA(lines) {
  return new Promise((resolve, reject) => {
    const script = Array.isArray(lines) ? lines.join("\n") : String(lines);
    execFile("/usr/bin/osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve((stdout || "").trim());
    });
  });
}

/**
 * Toggle macOS auto-hide menu bar via `defaults` and restart relevant services.
 * No-op on non-darwin platforms.
 */
function setAutoHideMenuBar(enable) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return resolve();

    const val = enable ? "true" : "false";
    // Write both the global and the -currentHost domain; some macOS versions
    // store the menu-bar autohide per-host.
    execFile("/usr/bin/defaults", ["write", "NSGlobalDomain", "_HIHideMenuBar", "-bool", val], (err) => {
      if (err) {
        return reject(err);
      }

      execFile("/usr/bin/defaults", ["-currentHost", "write", "NSGlobalDomain", "_HIHideMenuBar", "-bool", val], (err2) => {
        // ignore second-write error but proceed to restart UI services
        execFile("/usr/bin/killall", ["Dock"], () => {
          execFile("/usr/bin/killall", ["SystemUIServer"], () => {
            resolve();
          });
        });
      });
    });
  });
}

/**
 * Read the current macOS auto-hide menu bar preference.
 * Returns 1, 0, or null if unknown.
 */
function readAutoHideMenuBar() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(null);

    execFile("/usr/bin/defaults", ["read", "NSGlobalDomain", "_HIHideMenuBar"], (err, stdout) => {
      if (!err && typeof stdout === "string") {
        const v = stdout.trim();
        if (v === "1" || v === "0") return resolve(Number(v));
      }

      // Try currentHost domain as a fallback
      execFile("/usr/bin/defaults", ["-currentHost", "read", "NSGlobalDomain", "_HIHideMenuBar"], (err2, stdout2) => {
        if (!err2 && typeof stdout2 === "string") {
          const v2 = stdout2.trim();
          if (v2 === "1" || v2 === "0") return resolve(Number(v2));
        }

        resolve(null);
      });
    });
  });
}

/**
 * Restore the previously stored menu-bar autohide value (if any).
 * Logs [MENUBAR] prev=<0/1> set=<0/1> restored=<0/1>
 */
async function restoreAutoHideMenuBar() {
  try {
    if (process.platform !== "darwin") return false;

    if (menuBarPrev === null || menuBarPrev === undefined) {
      log(`[MENUBAR] prev=<unknown> set=<unknown> restored=<0>`);
      return false;
    }

    const prevVal = Number(menuBarPrev) ? 1 : 0;
    // Apply previous value
    await setAutoHideMenuBar(Boolean(prevVal));

    log(`[MENUBAR] prev=${prevVal} set=${prevVal} restored=1`);
    // clear stored value so we don't restore twice
    menuBarPrev = null;
    return true;
  } catch (e) {
    log("[MENUBAR] restore failed:", e?.message || e);
    return false;
  }
}

/**
 * List running/available apps (simple: via System Events).
 * Returns array of app names.
 */
async function listApps() {
  const script = `
    tell application "System Events"
      set appNames to (name of every application process where background only is false)
    end tell
    set text item delimiters to ","
    return appNames as text
  `;
  const raw = await runOSA(script);
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  return items;
}

/**
 * Activate the chosen app (OK to do ONCE at session start).
 */
async function activateApp(appName) {
  if (!appName) return;
  const script = `tell application "${appName}" to activate`;
  await runOSA(script);
}

/**
 * Get whether the chosen app has at least one window.
 */
async function appHasWindows(appName) {
  if (!appName) return false;
  const script = `
    tell application "System Events"
      if not (exists application process "${appName}") then return "NO"
      tell application process "${appName}"
        if (count of windows) is 0 then return "NO"
        return "YES"
      end tell
    end tell
  `;
  const out = await runOSA(script);
  return out === "YES";
}

/**
 * Force the front window of the chosen app into the opening rect.
 * rect = {x,y,w,h}
 */
async function setFrontWindowBounds(appName, rect) {
  if (!appName || !rect) return;

  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.round(rect.w);
  const h = Math.round(rect.h);

  log(`[PIN] TRY  ${appName} -> x=${x} y=${y} w=${w} h=${h}`);

  const script = `
    tell application "System Events"
      if not (exists application process "${appName}") then return "NOAPP"
      tell application process "${appName}"
        if (count of windows) is 0 then return "NOWIN"

        set frontmost to true
        try
          perform action "AXRaise" of window 1
        end try

        -- make sure it's not minimized
        try
          set value of attribute "AXMinimized" of window 1 to false
        end try

        set position of window 1 to {${x}, ${y}}
        set size of window 1 to {${w}, ${h}}
        return "OK1"
      end tell
    end tell
  `;

  const out = await runOSA(script);
  log(`[PIN] DONE ${appName} -> ${out}`);
}

/**
 * Compute opening rect (the tunnel) from workArea bounds.
 * Returns {x,y,w,h}
 *
 * UX:
 * - Centered horizontally
 * - Positioned based on workArea
 */
function computeOpening(workArea) {
  const openW = Math.floor(workArea.width * 0.55);
  const openH = Math.floor(workArea.height * 0.76);

  const x = Math.floor(workArea.x + (workArea.width - openW) / 2);

  const TOP_MARGIN = 80;
  const usableY = workArea.y + TOP_MARGIN;
  const usableH = workArea.height - TOP_MARGIN;
  const y = Math.floor(usableY + (usableH - openH) / 2);

  return { x, y, w: openW, h: openH };
}

/**
 * Destroy all masks.
 */
function destroyMaskWindows() {
  for (const w of maskWins) {
    try { w.destroy(); } catch {}
  }
  maskWins = [];
}

/**
 * Create the 4 blackout mask windows around the opening.
 *
 * IMPORTANT: We do NOT trust any passed-in display bounds.
 * We re-read the primary display bounds here every time and build masks from that.
 */
function createMaskWindows(_displayBoundsIgnored, opening) {
  destroyMaskWindows();

  // ALWAYS use the real physical display bounds for mask coverage.
  // This is the only way to reliably cover menu bar / dock / notch weirdness.
  const full = screen.getPrimaryDisplay().bounds;

  // Seam hiding without cutting into the tunnel opening
  const seam = 22; // keeps joins from showing at edges

  // Optional extra insurance to prevent 1–2px slivers (Retina rounding)
  const OVERSCAN = 60;

  const maskHTML = ({ showExit = false } = {}) => {
    const exitText = "EXIT: Cmd+Shift+X    QUIT: Cmd+Shift+Z";
    const safeExit = exitText.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const html = `
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              overflow: hidden;

              /* Base fabric tone */
              background: #4a4a4a;

              /* Subtle cubicle weave */
              background-image:
                linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.015)),
                repeating-linear-gradient(
                  0deg,
                  rgba(255,255,255,0.035) 0px,
                  rgba(255,255,255,0.035) 1px,
                  rgba(0,0,0,0.00) 1px,
                  rgba(0,0,0,0.00) 6px
                ),
                repeating-linear-gradient(
                  90deg,
                  rgba(255,255,255,0.020) 0px,
                  rgba(255,255,255,0.020) 1px,
                  rgba(0,0,0,0.00) 1px,
                  rgba(0,0,0,0.00) 9px
                );
              background-blend-mode: multiply;
            }

            body::before {
              content: "";
              position: absolute;
              inset: 0;
              pointer-events: none;
              background-image:
                repeating-linear-gradient(
                  45deg,
                  rgba(255,255,255,0.010) 0px,
                  rgba(255,255,255,0.010) 1px,
                  rgba(0,0,0,0.00) 1px,
                  rgba(0,0,0,0.00) 4px
                );
              opacity: 0.35;
              mix-blend-mode: overlay;
            }

            .exitSign {
              position: absolute;
              bottom: 18px;
              left: 0;
              right: 0;
              text-align: center;
              font: 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
              color: rgba(0,0,0,0.48);
              letter-spacing: 0.6px;
              user-select: none;
            }

            .exitSign span {
              display: inline-block;
              padding: 8px 14px;
              border-radius: 10px;
              background: rgba(0,0,0,0.08);
              border: 1px solid rgba(0,0,0,0.12);
            }
          </style>
        </head>
        <body>
          ${showExit ? `<div class="exitSign"><span>${safeExit}</span></div>` : ""}
        </body>
      </html>
    `.trim();

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  };

  function makeMask(bounds, { showExit = false } = {}) {
    const w = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: "#4a4a4a",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      show: false,
      hasShadow: false,
      skipTaskbar: true,
      // DO NOT rely on ctor alwaysOnTop on macOS; we force it after show/load.
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // Prevent mask from ever becoming key/main window
    w.setFocusable(false);
    w.setAlwaysOnTop(true, "status");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try { w.setIgnoreMouseEvents(true, { forward: true }); } catch {}

    // Helper: macOS compositor sometimes needs repeated assertions.
    const assertTopmost = () => {
      try { w.setAlwaysOnTop(true, "status"); } catch {}
      try { w.moveTop(); } catch {}
    };

    w.loadURL(maskHTML({ showExit }));

    // Phase 1: after load
    w.webContents.on("did-finish-load", () => {
      assertTopmost();
      // one extra tick after load
      setTimeout(assertTopmost, 50);
    });

    w.once("ready-to-show", () => {
      try { w.show(); } catch {}

      // Phase 2: after show
      assertTopmost();
      // Phase 3: compositor tick
      setTimeout(assertTopmost, 50);
      setTimeout(assertTopmost, 150);

      // Re-apply bounds after show (no math change, just commit)
      try { w.setBounds(bounds, false); } catch {}
      setTimeout(() => { try { w.setBounds(bounds, false); } catch {} }, 50);
    });

    // Hard-set bounds immediately too (same as your current behavior)
    try { w.setBounds(bounds, false); } catch {}

    return w;
  }

  // TOP CAP: tiny 6px mask at the very top to kill the macOS sliver
  const cap = makeMask({
    x: full.x,
    y: full.y,
    width: full.width,
    height: 6,
  });
  // Cap uses same level as other masks

  // TOP: cover from top of screen to opening edge
  const top = makeMask({
    x: full.x,
    y: full.y,
    width: full.width,
    height: opening.y - full.y,
  });

  // BOTTOM: cover from opening bottom to bottom of screen
  const bottom = makeMask(
    {
      x: full.x,
      y: opening.y + opening.h,
      width: full.width,
      height: (full.y + full.height) - (opening.y + opening.h),
    },
    { showExit: true }
  );

  // LEFT: cover from opening top to opening bottom on the left
  const left = makeMask({
    x: full.x,
    y: opening.y,
    width: opening.x - full.x,
    height: opening.h,
  });

  // RIGHT: cover from opening top to opening bottom on the right
  const right = makeMask({
    x: opening.x + opening.w,
    y: opening.y,
    width: (full.x + full.width) - (opening.x + opening.w),
    height: opening.h,
  });

  maskWins = [cap, top, bottom, left, right];

  log("[BLINDERS] full display bounds:", full);
  log("[BLINDERS] opening:", {
    openX: opening.x,
    openY: opening.y,
    openW: opening.w,
    openH: opening.h,
  });
  log(`[BLINDERS] masks created: count=${maskWins.length}`);
}

/**
 * Picker UI window
 * UX:
 * - Centered on screen
 * - Reasonable size on ultrawide / large monitors
 */
function createPickerWindow() {
  if (pickerWin) return pickerWin;

  const display = screen.getPrimaryDisplay();
  const work = display.workArea; // respects menu bar + dock

  const width = Math.round(Math.max(560, Math.min(820, work.width * 0.32)));
  const height = Math.round(Math.max(420, Math.min(620, work.height * 0.45)));

  const x = Math.round(work.x + (work.width - width) / 2);
  const y = Math.round(work.y + (work.height - height) / 2);

  pickerWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: true,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  pickerWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (DEBUG.devtools) pickerWin.webContents.openDevTools({ mode: "detach" });

  pickerWin.once("ready-to-show", () => {
    pickerWin.show();
    pickerWin.focus();
  });

  pickerWin.on("closed", () => {
    pickerWin = null;
  });

  return pickerWin;
}

/**
 * Normalize duration rules:
 * - null / undefined / "done" => UNTIL I'M DONE (no timer)
 * - number => timed
 */
function normalizeDuration(durationMin) {
  if (durationMin === null || durationMin === undefined) {
    return { mode: "done", minutes: null };
  }

  if (typeof durationMin === "string" && durationMin.toLowerCase() === "done") {
    return { mode: "done", minutes: null };
  }

  const n = Number(durationMin);
  if (!Number.isFinite(n)) {
    return { mode: "timed", minutes: 15 };
  }

  return { mode: "timed", minutes: Math.max(1, n) };
}

/**
 * Session lifecycle
 */
async function startSession(selectedApp, durationMin) {
  pinFailCount = 0;

  if (pinInterval) { clearInterval(pinInterval); pinInterval = null; }
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

  const dur = normalizeDuration(durationMin);
  session = { selectedApp, durationMin, startedAt: Date.now(), mode: dur.mode };

  log(`[SESSION] start: selectedApp="${selectedApp}" durationMin=${durationMin} mode=${dur.mode}`);

  await activateApp(selectedApp);

  const hasWin = await appHasWindows(selectedApp);
  if (!hasWin) {
    log(`[SESSION] abort: "${selectedApp}" has no open windows`);
    session = null;
    return { ok: false, error: "no-windows" };
  }

  const display = screen.getPrimaryDisplay();
  const full = display.bounds;
  const work = display.workArea;

  // Compute opening from workArea (includes top margin and vertical centering).
  let opening = computeOpening(work);

  // Clamp height to stay on-screen.
  opening.h = Math.min(opening.h, (full.y + full.height) - opening.y);

  // Hide picker BEFORE any masking so the target app can become truly frontmost.
  if (pickerWin) pickerWin.hide();

  // IMPORTANT: Pin the target window FIRST, before masks exist.
  // (Masks at screen-saver level can interfere with frontmost/AX behavior.)
  await setFrontWindowBounds(selectedApp, opening);

  // Toggle macOS auto-hide menu bar so the masks reliably 'close' the menu bar.
  try {
    // Read and store previous value so we can restore it later.
    const prev = await readAutoHideMenuBar();
    menuBarPrev = prev === null ? null : Number(prev);
    // Now set autohide to true
    await setAutoHideMenuBar(true);
    // give the system a moment to restart UI services and apply the setting
    await new Promise((r) => setTimeout(r, 600));
    log(`[MENUBAR] prev=${menuBarPrev === null ? "<unknown>" : menuBarPrev} set=1 restored=0`);
  } catch (e) {
    log("[SESSION] warning: could not enable auto-hide menu bar:", e?.message || e);
  }

  try {
    // Masks always cover full screen regardless of input
    createMaskWindows(full, opening);
  } catch (e) {
    log("[SESSION] abort: mask creation failed:", e?.message || e);
    session = null;
    return { ok: false, error: "mask-failed" };
  }

  // Immediately re-activate the selected app and re-pin its front window.
  // This restores the snapback behavior and ensures the app remains frontmost
  // above the masks after the masks have been placed at screen-saver level.
  try {
    await activateApp(selectedApp);
    await setFrontWindowBounds(selectedApp, opening);
  } catch (e) {
    log("[SESSION] warning: re-activate/re-pin failed:", e?.message || e);
  }

  if (!maskWins || maskWins.length !== 5) {
    log(`[SESSION] abort: masks not present (count=${maskWins?.length || 0})`);
    try { destroyMaskWindows(); } catch {}
    session = null;
    return { ok: false, error: "mask-missing" };
  }

  watchdogInterval = setInterval(async () => {
    try {
      if (!session) return;
      if (!maskWins || maskWins.length !== 5) {
        log(`[WATCHDOG] mask invariant failed (count=${maskWins?.length || 0}) -> teardown`);
        await endSession("watchdog");
        return;
      }
    } catch (e) {
      log("[WATCHDOG] error -> teardown:", e?.message || e);
      await endSession("watchdog-error");
    }
  }, 1000);

  pinInterval = setInterval(async () => {
    try {
      if (!session) return;

      const stillHasWin = await appHasWindows(session.selectedApp);
      if (!stillHasWin) {
        log(`[SESSION] selected app closed -> ending session (safety)`);
        await endSession("app-closed");
        return;
      }

      await setFrontWindowBounds(session.selectedApp, opening);
      pinFailCount = 0;
    } catch (e) {
      pinFailCount++;
      log(`[PIN] ERROR ${pinFailCount}/5:`, e?.message || e);
      if (pinFailCount >= 5) {
        log(`[SESSION] pinning failed ${pinFailCount}x -> ending session (failsafe)`);
        await endSession("pin-failed");
      }
    }
  }, 600);

  if (dur.mode === "timed") {
    sessionTimer = setTimeout(() => {
      if (session) endSession("timer");
    }, dur.minutes * 60 * 1000);
  } else {
    sessionTimer = null;
  }

  return { ok: true };
}

async function endSession(reason = "manual") {
  if (!session) return { ok: true };

  log(`[SESSION] end: reason=${reason} selectedApp="${session.selectedApp}"`);

  lastEndReason = reason;

  session = null;

  if (pinInterval) { clearInterval(pinInterval); pinInterval = null; }
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

  pinFailCount = 0;

  destroyMaskWindows();

  if (pickerWin) {
    pickerWin.show();
    pickerWin.focus();
  }

  // Restore macOS menu bar autohide to its previous value when session ends.
  try {
    const restored = await restoreAutoHideMenuBar();
    if (!restored) log("[SESSION] warning: could not restore auto-hide menu bar");
  } catch (e) {
    log("[SESSION] warning: could not restore auto-hide menu bar:", e?.message || e);
  }

  return { ok: true };
}

/**
 * Emergency quit
 */
async function emergencyQuit() {
  log("[EXIT] emergency quit");

  try { if (pinInterval) clearInterval(pinInterval); } catch {}
  try { if (sessionTimer) clearTimeout(sessionTimer); } catch {}
  try { if (watchdogInterval) clearInterval(watchdogInterval); } catch {}

  pinInterval = null;
  sessionTimer = null;
  watchdogInterval = null;

  session = null;
  pinFailCount = 0;

  try { destroyMaskWindows(); } catch {}
  try { if (pickerWin) pickerWin.destroy(); } catch {}

  // Attempt to restore the menu-bar autohide preference before quitting
  try {
    await restoreAutoHideMenuBar();
  } catch (e) {
    log("[EXIT] warning: could not restore autohide before quit:", e?.message || e);
  }

  app.quit();
}

/**
 * Global shortcuts
 */
function registerShortcuts() {
  const okX = globalShortcut.register("CommandOrControl+Shift+X", () => {
    log("[EXIT] Cmd+Shift+X");
    endSession("manual");
  });

  const okL = globalShortcut.register("CommandOrControl+Shift+L", () => {
    if (!pickerWin) createPickerWindow();
    pickerWin.show();
    pickerWin.focus();
  });

  const okF12 = globalShortcut.register("F12", () => {
    if (pickerWin) pickerWin.webContents.openDevTools({ mode: "detach" });
  });

  const okZ = globalShortcut.register("CommandOrControl+Shift+Z", () => {
    // fire-and-forget async emergency quit
    void emergencyQuit();
  });

  log(`[EXITS] registered: X=${okX} Z=${okZ} F12=${okF12} L=${okL} READY=true`);
}

/**
 * IPC
 */
ipcMain.handle("apps:list", async () => {
  log("[IPC] apps:list requested");
  try {
    const items = await listApps();
    log(`[IPC] apps:list -> ${items.length} items`);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: e.message };
  }
});

ipcMain.handle("session:start", async (_evt, payload) => {
  try {
    const { selectedApp, durationMin } = payload || {};
    return await startSession(selectedApp, durationMin);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("session:end", async (_evt, payload) => {
  try {
    const reason = payload?.reason || "manual";
    return await endSession(reason);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// picker reads this to show “Time’s up — you made it.” once
ipcMain.handle("session:lastEndReason", async () => {
  const r = lastEndReason;
  lastEndReason = null;
  return r;
});

/**
 * Boot
 */
app.whenReady().then(() => {
  log("[BOOT] __dirname =", __dirname);
  log("[BOOT] preload =", path.join(__dirname, "preload.js"));
  log("[BOOT] index   =", path.join(__dirname, "renderer", "index.html"));

  createPickerWindow();
  registerShortcuts();

  if (DEBUG.showPickerOnBoot && pickerWin) {
    pickerWin.show();
    pickerWin.focus();
  }
});

/**
 * Always tear down masks on quit paths.
 */
app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { if (pinInterval) clearInterval(pinInterval); } catch {}
  try { if (sessionTimer) clearTimeout(sessionTimer); } catch {}
  try { if (watchdogInterval) clearInterval(watchdogInterval); } catch {}

  pinInterval = null;
  sessionTimer = null;
  watchdogInterval = null;

  try { destroyMaskWindows(); } catch {}
});

app.on("window-all-closed", () => {
  // Closing the picker window quits the app
  app.quit();
});

/**
 * Crash handlers: never leave masks stranded.
 */
process.on("uncaughtException", (err) => {
  log("[FATAL] uncaughtException:", err);
  try { destroyMaskWindows(); } catch {}
  try { globalShortcut.unregisterAll(); } catch {}
  // try restore menu bar, then quit
  (async () => {
    try { await restoreAutoHideMenuBar(); } catch (e) { log('[FATAL] menubar restore failed', e); }
    app.quit();
  })();
});

process.on("unhandledRejection", (err) => {
  log("[FATAL] unhandledRejection:", err);
  try { destroyMaskWindows(); } catch {}
  try { globalShortcut.unregisterAll(); } catch {}
  // try restore menu bar, then quit
  (async () => {
    try { await restoreAutoHideMenuBar(); } catch (e) { log('[FATAL] menubar restore failed', e); }
    app.quit();
  })();
});
