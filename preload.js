// preload.js
const { contextBridge, ipcRenderer } = require("electron");

function normalizeItems(payload) {
  if (!payload) return { ok: false, items: [], error: "No payload" };

  let items = payload.items;

  if (typeof items === "string") {
    items = items.includes(",")
      ? items.split(",").map((s) => s.trim()).filter(Boolean)
      : [items.trim()].filter(Boolean);
  }

  if (!Array.isArray(items)) items = [];
  items = items.map((s) => String(s).trim()).filter(Boolean);
  items = items.filter((v, i, a) => a.indexOf(v) === i);

  return { ok: !!payload.ok, items, error: payload.error };
}

contextBridge.exposeInMainWorld("workroom", {
  listApps: async () => normalizeItems(await ipcRenderer.invoke("apps:list")),

  // durationMin:
  // - number (15,30,60,...) for timed
  // - null for "Until I’m done"
  startSession: async (selectedApp, durationMin) =>
    ipcRenderer.invoke("session:start", { selectedApp, durationMin }),

  endSession: async (reason = "manual") =>
    ipcRenderer.invoke("session:end", { reason }),

  // NEW: returns last end reason once, then clears it
  getLastEndReason: async () => ipcRenderer.invoke("session:lastEndReason"),
});
