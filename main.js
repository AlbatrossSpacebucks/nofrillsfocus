require("fs").appendFileSync("/tmp/nff_boot.log", `[${new Date().toISOString()}] BOOT main.js loaded\n`);
// main.js
console.log("NFF_BUILD_FINGERPRINT", "2026-01-16_1645_LOCAL");

const path = require("path");
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");

// Disable macOS menu bar auto-hide reservation to prevent hover region conflicts
app.commandLine.appendSwitch("disable-features", "MacMenuBarAutoHide");

function nffLog(...args) {
  try {
    fs.appendFileSync("/tmp/nff.log", `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch (_) {}
}

let pickerWin = null;
let maskWins = [];
let cornerWins = null;
let session = null;
// Remember previous menu-bar autohide state so we can restore it.
let menuBarPrev = null;

const ENABLE_CORNER_PATCHES = false;  // easy toggle
const CORNER_PATCH_PX = 16;          // start with 14 or 16; 16 recommended
const CORNER_RADIUS_PX = 10;         // tweak only if needed
const MASK_COLOR = "#DEDEDE";

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

let permissionModalWin = null;

function log(...args) {
  console.log(...args);
}

function isAccessibilityDenied(errText = "") {
  return (
    errText.includes("osascript is not allowed assistive access") ||
    errText.includes("(-25211)") ||
    errText.includes("Not authorized to send Apple events") ||
    errText.includes("1743")
  );
}

/**
 * AppleScript helper: run small scripts safely.
 */
function runOSA(lines) {
  return new Promise((resolve, reject) => {
    const script = Array.isArray(lines) ? lines.join("\n") : String(lines);
    const startTime = Date.now();
    nffLog(`[OSA] starting: ${script.substring(0, 80)}`);
    
    const timeout = setTimeout(() => {
      nffLog(`[OSA] TIMEOUT after ${Date.now() - startTime}ms: ${script.substring(0, 80)}`);
      reject(new Error("osascript timeout"));
    }, 5000);
    
    execFile("/usr/bin/osascript", ["-e", script], (err, stdout, stderr) => {
      clearTimeout(timeout);
      const elapsed = Date.now() - startTime;
      if (err) {
        nffLog(`[OSA] ERROR (${elapsed}ms) exit=${err.code} stderr=${stderr}`);
        return reject(new Error(stderr || err.message));
      }
      nffLog(`[OSA] OK (${elapsed}ms) stdout=${(stdout || "").trim().substring(0, 100)}`);
      resolve((stdout || "").trim());
    });
  });
}

/**
 * Get the name of the frontmost (active) app on macOS.
 * Returns app name string or null if unable to determine.
 */
async function getFrontmostAppName() {
  try {
    nffLog("[getFrontmostAppName] calling System Events");
    const out = await runOSA(
      'tell application "System Events" to get name of first application process whose frontmost is true'
    );
    nffLog("[getFrontmostAppName] result:", out);
    return (out || "").trim() || null;
  } catch (e) {
    nffLog("[getFrontmostAppName] error:", String(e));
    return null;
  }
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
  nffLog("[listApps] start");
  const script = `
    tell application "System Events"
      set appNames to (name of every application process where background only is false)
    end tell
    set text item delimiters to ","
    return appNames as text
  `;
  try {
    const raw = await runOSA(script);
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    nffLog("[listApps] success count=", String(items.length));
    return items;
  } catch (e) {
    nffLog("[listApps] error:", String(e));
    throw e;
  }
}

/**
 * Activate the chosen app (OK to do ONCE at session start).
 */
async function activateApp(appName) {
  if (!appName) return;
  nffLog("[activateApp] start appName=", appName);
  const script = `tell application "${appName}" to activate`;
  try {
    await runOSA(script);
    nffLog("[activateApp] success");
  } catch (e) {
    nffLog("[activateApp] error:", String(e));
    throw e;
  }
}

/**
 * Get whether the chosen app has at least one window.
 */
async function appHasWindows(appName) {
  if (!appName) return false;
  nffLog("[appHasWindows] start appName=", appName);
  const script = `
    tell application "System Events"
      if not (exists application process "${appName}") then return "NO"
      tell application process "${appName}"
        if (count of windows) is 0 then return "NO"
        return "YES"
      end tell
    end tell
  `;
  try {
    const out = await runOSA(script);
    const result = out === "YES";
    nffLog("[appHasWindows] result=", String(result));
    return result;
  } catch (e) {
    const msg = String(e && (e.stderr || e.message || e) || "");
    nffLog("[appHasWindows] error:", msg);
    if (isAccessibilityDenied(msg)) {
      const err = new Error("ACCESSIBILITY_DENIED");
      err.code = "ACCESSIBILITY_DENIED";
      throw err;
    }
    throw e;
  }
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
  nffLog("[setFrontWindowBounds] appName=", appName, "x=", String(x), "y=", String(y), "w=", String(w), "h=", String(h));

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

  try {
    const out = await runOSA(script);
    log(`[PIN] DONE ${appName} -> ${out}`);
    nffLog("[setFrontWindowBounds] result=", out);
  } catch (e) {
    nffLog("[setFrontWindowBounds] error:", String(e));
    throw e;
  }
}

/**
 * Measure the actual bounds of the front window (including titlebar/traffic lights).
 * Returns {x, y, w, h} or null if unable to measure.
 */
async function getFrontWindowBounds(appName) {
  if (!appName) return null;

  nffLog("[getFrontWindowBounds] start appName=", appName);

  const script = `
    tell application "System Events"
      if not (exists application process "${appName}") then return "NOAPP"
      tell application process "${appName}"
        if (count of windows) is 0 then return "NOWIN"
        
        set pos to position of window 1
        set sz to size of window 1
        
        set x to item 1 of pos
        set y to item 2 of pos
        set w to item 1 of sz
        set h to item 2 of sz
        
        return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
      end tell
    end tell
  `;

  try {
    const out = await runOSA(script);
    if (out === "NOAPP" || out === "NOWIN") {
      log(`[AX] getFrontWindowBounds failed: ${out}`);
      nffLog("[getFrontWindowBounds] failed:", out);
      return null;
    }

    const parts = out.split(",").map((s) => parseInt(s.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) {
      log(`[AX] getFrontWindowBounds parse error: ${out}`);
      nffLog("[getFrontWindowBounds] parse error:", out);
      return null;
    }

    const measured = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    log(`[AX] front window bounds: x=${measured.x} y=${measured.y} w=${measured.w} h=${measured.h}`);
    nffLog("[getFrontWindowBounds] success x=", String(measured.x), "y=", String(measured.y), "w=", String(measured.w), "h=", String(measured.h));
    return measured;
  } catch (e) {
    log(`[AX] getFrontWindowBounds error: ${e?.message || e}`);
    nffLog("[getFrontWindowBounds] error:", String(e));
    return null;
  }
}

/**
 * Compute opening rect (the tunnel) from workArea bounds.
 * Returns {x,y,w,h}
 *
 * UX:
 * - Centered horizontally
 * - Positioned based on workArea
 */
function computeOpening(bounds) {
  const openW = Math.floor(bounds.width * 0.55);
  const openH = Math.floor(bounds.height * 0.76);

  const x = Math.floor(bounds.x + (bounds.width - openW) / 2);

  const TOP_MARGIN = 80; // allowed tuning range 60–120 if needed
  const usableY = bounds.y + TOP_MARGIN;
  const usableH = bounds.height - TOP_MARGIN;

  const y = Math.floor(usableY + (usableH - openH) / 2);

  return { x, y, w: openW, h: openH };
}

/**
 * Destroy corner patch windows.
 */
function destroyCornerPatches() {
  if (!cornerWins) return;
  try {
    for (const w of cornerWins) {
      try { w.close(); } catch {}
    }
  } finally {
    cornerWins = null;
  }
}

/**
 * Create corner patch windows to cover rounded corner triangles.
 */
function createCornerPatches(opening) {
  if (!ENABLE_CORNER_PATCHES) return;

  destroyCornerPatches();

  const patch = CORNER_PATCH_PX;

  const mk = (corner, x, y) => {
    const w = new BrowserWindow({
      x, y,
      width: patch,
      height: patch,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    // Critical: never take focus or intercept clicks
    try { w.setIgnoreMouseEvents(true, { forward: true }); } catch {}

    const url = `file://${path.join(__dirname, "renderer", "corner.html")}?corner=${corner}&c=${encodeURIComponent(MASK_COLOR)}&r=${CORNER_RADIUS_PX}`;
    w.loadURL(url);

    // Match mask tier
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch {}

    w.once("ready-to-show", () => {
      try { w.showInactive(); } catch {}
    });

    return w;
  };

  const x = opening.x;
  const y = opening.y;
  const ow = opening.w;
  const oh = opening.h;

  cornerWins = [
    mk("tl", x, y),
    mk("tr", x + ow - patch, y),
    mk("bl", x, y + oh - patch),
    mk("br", x + ow - patch, y + oh - patch),
  ];

  log(`[CORNERS] created ${cornerWins.length} patches`);
}

/**
 * Update corner patch positions after opening changes.
 */
function updateCornerPatches(opening) {
  if (!ENABLE_CORNER_PATCHES) return;
  if (!cornerWins || cornerWins.length !== 4) return;

  const patch = CORNER_PATCH_PX;

  const positions = [
    { x: opening.x,                    y: opening.y },                           // tl
    { x: opening.x + opening.w - patch, y: opening.y },                          // tr
    { x: opening.x,                    y: opening.y + opening.h - patch },       // bl
    { x: opening.x + opening.w - patch, y: opening.y + opening.h - patch }       // br
  ];

  for (let i = 0; i < 4; i++) {
    try {
      cornerWins[i].setBounds({ ...positions[i], width: patch, height: patch }, false);
      cornerWins[i].setAlwaysOnTop(true, "screen-saver");
      try { cornerWins[i].setIgnoreMouseEvents(true, { forward: true }); } catch {}
    } catch {}
  }
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
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const bounds = display.bounds;     // FULL display (includes menu bar region)
  const work = display.workArea;     // usable region (excludes menu bar/dock)

  // Calculate real menu bar height (gap between bounds and workArea)
  const menuBarH = Math.max(0, work.y - bounds.y);

  const full = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  // Small overlap for seam removal (do not exceed 3px)
  const OL = 2;
  const EDGE = 4;     // 2–6px works; 4 is safe
  const TOP_JOIN = 4; // overlap between cap and topMask

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

              /* Base flat tone */
              background: #dedede;
            }

            body::before {
              content: "";
              position: absolute;
              inset: 0;
              pointer-events: none;
              background-image:
                repeating-linear-gradient(
                  45deg,
                  rgba(255,255,255,0.02) 0px,
                  rgba(255,255,255,0.02) 1px,
                  rgba(0,0,0,0.00) 1px,
                  rgba(0,0,0,0.00) 4px
                );
              opacity: 0.08;
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
      backgroundColor: "#dedede",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      show: false,
      hasShadow: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      kiosk: true,
      fullscreen: true,
      simpleFullscreen: true,
      // DO NOT rely on ctor alwaysOnTop on macOS; we force it after show/load.
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // Prevent mask from ever becoming key/main window
    w.setFocusable(false);
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try { w.setIgnoreMouseEvents(false); } catch {}
    
    // Ensure mask never becomes key window
    w.on('focus', () => w.blur());

    // Helper: macOS compositor sometimes needs repeated assertions.
    const assertTopmost = () => {
      try { w.setAlwaysOnTop(true, "screen-saver"); } catch {}
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

  // TOP CAP: tiny mask to cover menu bar sliver
  const CAP_H = Math.max(6, menuBarH + 2); // +2 safety overlap
  log("[MASK] menuBarH", menuBarH);
  const topCap = makeMask({
    x: full.x,
    y: full.y,
    width: full.width,
    height: CAP_H,
  });

  // TOP MASK: covers everything above opening (below the cap)
  const topMaskY = full.y + CAP_H - TOP_JOIN; // overlap upward into the cap by 4px
  const topMaskH = Math.max(0, opening.y - topMaskY) + OL; // small overlap down
  const topMask = makeMask({
    x: full.x,
    y: topMaskY,
    width: full.width,
    height: topMaskH,
  });

  // BOTTOM: cover everything below opening
  const bottomY = opening.y + opening.h;
  const bottom = makeMask(
    {
      x: full.x,
      y: bottomY - OL, // small overlap up
      width: full.width,
      height: Math.max(0, (full.y + full.height) - bottomY) + OL,
    },
    { showExit: true }
  );

  // LEFT: cover left of opening, start at opening.y (no vertical climb)
  const leftY = opening.y - OL;
  const leftH = opening.h + (OL * 2);
  const left = makeMask({
    x: full.x,
    y: leftY,
    width: Math.max(0, opening.x - full.x) + OL, // add horizontal overlap
    height: leftH,
  });

  // RIGHT: cover right of opening, start at opening.y (no vertical climb)
  const rightX = opening.x + opening.w;
  const rightY = opening.y - OL;
  const rightH = opening.h + (OL * 2);
  const right = makeMask({
    x: rightX - OL, // shift left slightly
    y: rightY,
    width: Math.max(0, (full.x + full.width) - rightX) + OL,
    height: rightH,
  });

  maskWins = [topCap, topMask, bottom, left, right];

  // Debug logs
  log("[OPENING]", opening);
  log("[MASK] topCap", { x: full.x, y: full.y, w: full.width, h: CAP_H });
  log("[MASK] topMask", { y: topMaskY, h: topMaskH });
  log("[MASK] left", { y: leftY, h: leftH });
  log("[MASK] right", { y: rightY, h: rightH });

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
 * Check if accessibility permission is granted
 */
async function checkAccessibilityPermission() {
  const script = `
    tell application "System Events"
      set frontProc to first application process whose frontmost is true
      set b to position of front window of frontProc
      return "OK"
    end tell
  `;
  try {
    await runOSA(script);
    return { ok: true };
  } catch (e) {
    if (e.message && (e.message.includes("-25211") || e.message.includes("not allowed assistive access"))) {
      return { ok: false, reason: "accessibility" };
    }
    return { ok: true }; // other errors, assume OK
  }
}

/**
 * Create permission modal window
 */
function createPermissionModal({ onOpenSettings, onRecheck, onTimeout }) {
  const { BrowserWindow, shell } = require("electron");

  const modal = new BrowserWindow({
    width: 620,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "No Frills Focus",
    backgroundColor: "#f5f5f5",
    show: false,
    alwaysOnTop: false,
    center: true,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>No Frills Focus</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #f5f5f5;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }

    .container {
      width: 480px;
      background: white;
      border-radius: 12px;
      padding: 32px;
      box-sizing: border-box;
    }

    h1 {
      margin: 0 0 16px 0;
      font-size: 18px;
      font-weight: 500;
      color: #333;
      letter-spacing: -0.3px;
    }

    p {
      margin: 0 0 16px 0;
      font-size: 13px;
      line-height: 1.45;
      color: #555;
    }

    p:last-of-type {
      margin-bottom: 24px;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .timeout-message {
      display: none;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 13px;
      line-height: 1.45;
      color: #664d03;
    }

    .timeout-message.show {
      display: block;
    }

    button {
      appearance: none;
      background: #ededed;
      border: 1px solid #d0d0d0;
      color: #222;
      border-radius: 8px;
      height: 38px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }

    button:hover {
      background: #e0e0e0;
    }

    button:active {
      background: #d8d8d8;
    }

    button:focus {
      outline: none;
      box-shadow: 0 0 0 2px #f5f5f5, 0 0 0 4px #b0b0b0;
    }

    #relaunch {
      grid-column: 1 / -1;
      display: none;
      background: #dc3545;
      color: white;
      border-color: #bb2d3b;
    }

    #relaunch:hover {
      background: #bb2d3b;
    }

    #relaunch:active {
      background: #a02834;
    }

    #relaunch.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Accessibility Permission Required</h1>
    <p>No Frills Focus needs accessibility permission to manage window positioning.</p>
    <p>Click "Open System Settings" below, then enable No Frills Focus in<br>Privacy & Security → Accessibility.</p>
    <div class="timeout-message" id="timeoutMsg">
      If the app doesn't proceed, remove and re-add No Frills Focus using the + button.
    </div>
    <div class="actions">
      <button id="open">Open System Settings</button>
      <button id="done">I've Granted Permission</button>
      <button id="relaunch">Quit and Relaunch</button>
    </div>
  </div>

  <script>
    const openBtn = document.getElementById('open');
    const doneBtn = document.getElementById('done');
    const relaunchBtn = document.getElementById('relaunch');
    const timeoutMsg = document.getElementById('timeoutMsg');

    openBtn.addEventListener('click', () => {
      window.location.href = 'nff://open-accessibility';
    });

    doneBtn.addEventListener('click', () => {
      window.location.href = 'nff://recheck-accessibility';
    });

    relaunchBtn.addEventListener('click', () => {
      window.location.href = 'nff://relaunch';
    });

    // Listen for messages from main process to show timeout UI
    window.addEventListener('message', (event) => {
      if (event.data.type === 'show-timeout') {
        timeoutMsg.classList.add('show');
        relaunchBtn.classList.add('show');
      }
    });
  </script>
</body>
</html>`;

  modal.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

  // Helper: set modal to BLOCKING state (always on top, blocks everything)
  const setBlocking = () => {
    try { modal.setAlwaysOnTop(true, "screen-saver"); } catch {}
  };

  // Helper: set modal to PENDING state (visible but not on top, allows system settings to come forward)
  const setPending = () => {
    try { modal.setAlwaysOnTop(false); } catch {}
  };

  // Handle the three pseudo-links without exposing Node in the renderer
  modal.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("nff://")) return;
    e.preventDefault();

    if (url === "nff://open-accessibility") {
      log("[MODAL] User clicked 'Open System Settings'");
      try {
        // Deep link to Accessibility settings
        const { shell } = require("electron");
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      } catch (_) {}
      if (typeof onOpenSettings === "function") onOpenSettings();
    }

    if (url === "nff://recheck-accessibility") {
      if (typeof onRecheck === "function") onRecheck(modal);
    }

    if (url === "nff://relaunch") {
      log("[MODAL] User clicked 'Quit and Relaunch'");
      app.relaunch();
      app.exit(0);
    }
  });

  modal.once("ready-to-show", () => modal.show());

  return { modal, setBlocking, setPending };
}

/**
 * Picker UI window
 * UX:
 * - Centered on screen
 * - Reasonable size on ultrawide / large monitors
 */
function createPickerWindow() {
  if (pickerWin) return pickerWin;

  // Use display nearest cursor for multi-monitor setups
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const work = display.workArea; // respects menu bar + dock

  const width = Math.round(Math.max(560, Math.min(820, work.width * 0.32)));
  const height = Math.round(Math.max(420, Math.min(620, work.height * 0.45)));

  // Center within workArea
  let x = Math.round(work.x + (work.width - width) / 2);
  let y = Math.round(work.y + (work.height - height) / 2);

  // Clamp to ensure window stays fully visible within workArea
  x = Math.max(work.x, Math.min(x, work.x + work.width - width));
  y = Math.max(work.y, Math.min(y, work.y + work.height - height));

  pickerWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    resizable: false,
    movable: true,
    show: false,
    autoHideMenuBar: true,
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
  nffLog("[STEP] startSession entered");
  nffLog("[START] selected=", String(selectedApp), "durationMin=", String(durationMin));
  pinFailCount = 0;

  if (pinInterval) { clearInterval(pinInterval); pinInterval = null; }
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

  const dur = normalizeDuration(durationMin);
  session = { 
    selectedApp, 
    durationMin, 
    startedAt: Date.now(), 
    mode: dur.mode,
    targetBounds: null  // will be set after computing opening
  };

  log(`[SESSION] start: selectedApp="${selectedApp}" durationMin=${durationMin} mode=${dur.mode}`);

  nffLog("[STEP] before activate target app", String(selectedApp));
  await activateApp(selectedApp);
  nffLog("[STEP] after activate target app");

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
  let targetRect = computeOpening(work);

  // Clamp height to stay on-screen.
  targetRect.h = Math.min(targetRect.h, (full.y + full.height) - targetRect.y);
  
  // Store target bounds for snapback
  session.targetBounds = targetRect;

  // Hide picker BEFORE any masking so the target app can become truly frontmost.
  if (pickerWin) pickerWin.hide();

  // IMPORTANT: Pin the target window FIRST, before masks exist.
  // (Masks at screen-saver level can interfere with frontmost/AX behavior.)
  log(`[DEBUG] requested bounds: x=${targetRect.x} y=${targetRect.y} w=${targetRect.w} h=${targetRect.h}`);
  await setFrontWindowBounds(selectedApp, targetRect);

  // Give macOS a compositor beat to apply the window changes
  await new Promise((r) => setTimeout(r, 150));

  // MEASURE REAL BOUNDS: Get the actual window position/size (includes titlebar/traffic lights)
  const measured1 = await getFrontWindowBounds(selectedApp);
  if (measured1) {
    log(`[AX] measured1: x=${measured1.x} y=${measured1.y} w=${measured1.w} h=${measured1.h}`);
  }

  // Give another settle tick and re-measure
  await new Promise((r) => setTimeout(r, 100));
  const measured2 = await getFrontWindowBounds(selectedApp);
  
  let opening;
  if (measured2) {
    log(`[AX] measured2: x=${measured2.x} y=${measured2.y} w=${measured2.w} h=${measured2.h}`);
    // Use measured bounds with tiny ±2px pad to avoid 1px slivers from rounding
    opening = {
      x: measured2.x - 2,
      y: measured2.y - 2,
      w: measured2.w + 4,
      h: measured2.h + 4
    };
    log(`[OPENING] final opening used: x=${opening.x} y=${opening.y} w=${opening.w} h=${opening.h}`);
  } else {
    // Fallback to computed bounds if measurement failed
    log(`[DEBUG] measurement failed, using computed bounds`);
    opening = targetRect;
  }

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
    nffLog("[STEP] before create masks");
    createMaskWindows(full, opening);
    nffLog("[STEP] after create masks count=", String(maskWins?.length || 0));
  } catch (e) {
    log("[SESSION] abort: mask creation failed:", e?.message || e);
    session = null;
    return { ok: false, error: "mask-failed" };
  }

  try {
    // Create corner patches to cover rounded corner artifacts
    createCornerPatches(opening);
  } catch (e) {
    log("[SESSION] warning: corner patch creation failed:", e?.message || e);
  }

  nffLog("[STEP] before assertAllMasksOnTop");
  
  // Immediately re-activate the selected app and re-pin its front window.
  // This restores the snapback behavior and ensures the app remains frontmost
  // above the masks after the masks have been placed at screen-saver level.
  try {
    await activateApp(selectedApp);

    const repinRect = measured2 || opening;

    await setFrontWindowBounds(selectedApp, repinRect);
  } catch (e) {
    log("[SESSION] warning: re-activate/re-pin failed:", e?.message || e);
  }

  nffLog("[STEP] after assertAllMasksOnTop");

  if (!maskWins || maskWins.length < 5) {
    log(`[SESSION] abort: masks not present (count=${maskWins?.length || 0})`);
    try { destroyMaskWindows(); } catch {}
    session = null;
    return { ok: false, error: "mask-missing" };
  }

  watchdogInterval = setInterval(async () => {
    try {
      if (!session) return;
      if (!maskWins || maskWins.length < 5) {
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

      // SNAPBACK: pin window to the target position (snaps back if user dragged it)
      const s = session;
      if (s?.targetBounds) {
        await setFrontWindowBounds(s.selectedApp, s.targetBounds);
      }
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

  destroyCornerPatches();
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

  try { destroyCornerPatches(); } catch {}
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
  nffLog("[IPC session:start]", JSON.stringify(payload || {}));
  try {
    const { selectedApp, durationMin } = payload || {};
    nffLog("[IPC] calling startSession selectedApp=", selectedApp, "durationMin=", String(durationMin));
    const result = await startSession(selectedApp, durationMin);
    nffLog("[IPC] startSession returned:", JSON.stringify(result || {}));
    return result;
  } catch (e) {
    const code = e && e.code ? String(e.code) : "";
    const message =
      code === "ACCESSIBILITY_DENIED"
        ? "ACCESSIBILITY_DENIED"
        : (e && e.message ? String(e.message) : "UNKNOWN_ERROR");
    nffLog("[IPC] startSession threw error code=", code, "message=", message);
    return { ok: false, code: code || "START_FAILED", message };
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

ipcMain.handle("accessibility:check", async () => {
  return await checkAccessibilityPermission();
});

/**
 * Boot
 */
app.whenReady().then(async () => {
  log("[BOOT] __dirname =", __dirname);
  log("[BOOT] preload =", path.join(__dirname, "preload.js"));
  log("[BOOT] index   =", path.join(__dirname, "renderer", "index.html"));

  // Check accessibility permission first
  const hasPermission = await checkAccessibilityPermission();
  
  if (!hasPermission.ok) {
    log("[BOOT] Accessibility permission not granted, showing modal");
    const { modal, setBlocking, setPending } = createPermissionModal({
      onOpenSettings: () => {
        log("[MODAL] Opening System Settings → entering PENDING state");
        setPending();
        
        // Start polling for permission (500ms interval, ~20s timeout)
        let pollCount = 0;
        const maxPolls = 40; // ~20 seconds at 500ms intervals
        
        const pollInterval = setInterval(async () => {
          pollCount++;
          log(`[POLL] attempt ${pollCount}/${maxPolls}`);
          
          const perm = await checkAccessibilityPermission();
          if (perm.ok) {
            log("[POLL] Permission granted! Closing modal and proceeding.");
            clearInterval(pollInterval);
            modal.close();
            
            // Continue boot sequence
            createPickerWindow();
            registerShortcuts();
            if (pickerWin) {
              pickerWin.show();
              pickerWin.focus();
            }
            return;
          }
          
          if (pollCount >= maxPolls) {
            log("[POLL] Timeout reached, showing escape hatch");
            clearInterval(pollInterval);
            // Show timeout message in modal
            try {
              modal.webContents.executeJavaScript(
                `window.postMessage({ type: 'show-timeout' }, '*')`
              );
            } catch (_) {}
            return;
          }
        }, 500);
      },
      onRecheck: async (modalWindow) => {
        log("[MODAL] User clicked 'I've Granted Permission', rechecking...");
        const recheckPermission = await checkAccessibilityPermission();
        if (recheckPermission.ok) {
          log("[MODAL] Permission now granted, closing modal and showing picker");
          modalWindow.close();
          createPickerWindow();
          registerShortcuts();
          if (pickerWin) {
            pickerWin.show();
            pickerWin.focus();
          }
        } else {
          log("[MODAL] Permission still not granted");
        }
      },
    });
    
    // Set BLOCKING state initially (always on top, prevents interaction with anything else)
    setBlocking();
    return;
  }

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

  try { destroyCornerPatches(); } catch {}
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
