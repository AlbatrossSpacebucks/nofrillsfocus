// renderer/renderer.js
(() => {
  const appSelect = document.getElementById("appSelect");
  const durationSelect = document.getElementById("durationSelect");
  const confirmBtn = document.getElementById("confirmBtn");
  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setHint(msg) {
    hintEl.textContent = msg || "";
  }

  function showTimedCongratsIfNeeded(reason) {
    if (reason === "timer") {
      setStatus("Time’s up — you made it.");
      setHint("");
      return true;
    }
    return false;
  }

  function messageNoWindows(appName) {
    const name = appName || "That app";
    return (
      `${name} isn’t open yet.\n` +
      `Open ${name} first, then come back and press Confirm.`
    );
  }

  async function loadApps() {
    setStatus("Loading apps…");
    setHint("");

    let lastReason = null;
    try {
      // Pull & clear last reason first; we’ll show it after the dropdown loads
      if (window.workroom.getLastEndReason) {
        lastReason = await window.workroom.getLastEndReason();
      }
    } catch {
      lastReason = null;
    }

    try {
      const res = await window.workroom.listApps();
      if (!res || !res.ok) {
        setStatus("Couldn’t read your running apps. Quit and reopen Blinders, then try again.");
        return;
      }

      const items = res.items || [];
      appSelect.innerHTML = "";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose an app…";
      appSelect.appendChild(placeholder);

      for (const name of items) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        appSelect.appendChild(opt);
      }

      // If timer ended last session, show the congrats now (once).
      const shown = showTimedCongratsIfNeeded(lastReason);
      if (!shown) {
        setStatus("");
        setHint("");
      }
    } catch {
      setStatus("Couldn’t read your running apps. Quit and reopen Blinders, then try again.");
      setHint("");
    }
  }

  async function onConfirm() {
    const selectedApp = appSelect.value;
    const durationValue = String(durationSelect.value || "15");

    setStatus("");
    setHint("");

    if (!selectedApp) {
      setStatus("Please choose an app first.");
      return;
    }

    // Convert picker choice to main.js expectation:
    // - "done" => durationMin = null
    // - otherwise => number minutes
    const durationMin =
      durationValue === "done" ? null : Number(durationValue);

    if (durationValue === "done") {
      setHint("Exit anytime with Cmd+Shift+X.");
    }

    setStatus(`Starting session for ${selectedApp}…`);

    try {
      const res = await window.workroom.startSession(selectedApp, durationMin);

      if (res && res.ok) {
        // Picker will hide on success, so nothing else needed here.
        setStatus("");
        setHint("");
        return;
      }

      if (res && res.error === "no-windows") {
        setStatus(messageNoWindows(selectedApp));
        setHint("");
        return;
      }

      setStatus(
        `Couldn’t start.\nMake sure ${selectedApp} is open, then try again.`
      );
      setHint("");
    } catch {
      setStatus(
        `Couldn’t start.\nMake sure ${selectedApp} is open, then try again.`
      );
      setHint("");
    }
  }

  confirmBtn.addEventListener("click", onConfirm);

  loadApps();
})();
