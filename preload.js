const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] loaded');

function normalizeItems(payload) {
  // We expect: { ok: boolean, items: array<string> } OR occasionally items as a single string.
  if (!payload) return { ok: false, items: [], error: 'No payload' };

  let items = payload.items;

  // If main accidentally sends back one giant string, split it safely.
  if (typeof items === 'string') {
    // Most common: "Brave Browser, Pages, Final Draft 12, Safari, ..."
    if (items.includes(',')) {
      items = items
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else {
      // Fallback: split on 2+ spaces (last resort)
      items = items
        .split(/\s{2,}/)
        .map(s => s.trim())
        .filter(Boolean);
    }
  }

  // If items is not an array at this point, hard-fail
  if (!Array.isArray(items)) items = [];

  return { ok: !!payload.ok, items, error: payload.error || null };
}

contextBridge.exposeInMainWorld('workroom', {
  listWindows: async () => {
    const res = await ipcRenderer.invoke('list-windows');
    return normalizeItems(res);
  },
  selectWindow: async (label) => {
    return ipcRenderer.invoke('select-window', { label });
  },
  openAccessibility: async () => {
    return ipcRenderer.invoke('open-accessibility-prefs');
  },
  log: (msg) => {
    ipcRenderer.send('log', String(msg || ''));
  }
});
