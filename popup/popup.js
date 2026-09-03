const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "turbo",
  keepCount: 30,
  batchSize: 10,
  autoCollapseTraces: true,
  longResponseVirtualization: true,
  pauseHiddenRendering: true,
  showDock: true
};

const MODE_HINTS = {
  safe: "Keeps the full ChatGPT React tree. CSS containment skips off-screen paint/layout, but RAM savings are limited.",
  turbo: "Trims old history before React sees it, keeps a lightweight text archive for lazy browsing, and hibernates excess DOM as a fallback.",
  extreme: "Turbo plus text-only DOM fallback snapshots and more aggressive trace compaction. Reload for original formatting after fallback pruning."
};

let activeTabId = null;
let saveTimer = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  return tab;
}

async function send(type) {
  if (!activeTabId) return null;
  try { return await chrome.tabs.sendMessage(activeTabId, { type }); }
  catch { return null; }
}

function setModeHint(mode) {
  document.querySelector("#modeHint").textContent = MODE_HINTS[mode] || "";
}

async function load() {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
  document.querySelector("#enabled").checked = settings.enabled;
  document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  document.querySelector("#keepCount").value = settings.keepCount;
  document.querySelector("#batchSize").value = settings.batchSize;
  document.querySelector("#autoCollapseTraces").checked = settings.autoCollapseTraces;
  document.querySelector("#longResponseVirtualization").checked = settings.longResponseVirtualization;
  document.querySelector("#pauseHiddenRendering").checked = settings.pauseHiddenRendering;
  document.querySelector("#showDock").checked = settings.showDock;
  setModeHint(settings.mode);

  const tab = await activeTab();
  const isChatGPT = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab?.url || "");
  if (!isChatGPT) {
    document.querySelector("#statusLine").textContent = "Open a ChatGPT conversation to use it";
    document.querySelectorAll(".actions button").forEach((button) => { button.disabled = true; });
    return;
  }
  await refreshStatus();
}

async function refreshStatus() {
  const status = await send("CGO_GET_STATUS");
  if (!status?.ok) {
    document.querySelector("#statusLine").textContent = "Reload this ChatGPT tab once to activate";
    return;
  }
  document.querySelector("#liveCount").textContent = status.liveDom.toLocaleString();
  document.querySelector("#trimmedCount").textContent = status.networkRemoved.toLocaleString();
  document.querySelector("#nodesSaved").textContent = status.approxNodesSaved.toLocaleString();
  const mode = status.mode[0].toUpperCase() + status.mode.slice(1);
  const source = status.networkTrimmed ? "pre-React trim active" : status.mode === "safe" ? "containment only" : "DOM fallback";
  document.querySelector("#statusLine").textContent = `${mode} · ${source}${status.generating ? " · streaming" : ""}`;
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 120);
}

async function saveSettings() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "turbo";
  const settings = {
    enabled: document.querySelector("#enabled").checked,
    mode,
    keepCount: Math.min(200, Math.max(5, Number(document.querySelector("#keepCount").value) || 30)),
    batchSize: Math.min(50, Math.max(1, Number(document.querySelector("#batchSize").value) || 10)),
    autoCollapseTraces: document.querySelector("#autoCollapseTraces").checked,
    longResponseVirtualization: document.querySelector("#longResponseVirtualization").checked,
    pauseHiddenRendering: document.querySelector("#pauseHiddenRendering").checked,
    showDock: document.querySelector("#showDock").checked
  };
  await chrome.storage.sync.set(settings);
  setModeHint(mode);
  setTimeout(refreshStatus, 220);
}

for (const control of document.querySelectorAll("input")) {
  control.addEventListener("change", queueSave);
  if (control.type === "number") control.addEventListener("input", queueSave);
}

document.querySelector("#older").addEventListener("click", async () => { await send("CGO_OPEN_ARCHIVE"); window.close(); });
document.querySelector("#latest").addEventListener("click", async () => { await send("CGO_SHOW_LATEST"); await refreshStatus(); });
document.querySelector("#optimize").addEventListener("click", async () => { await send("CGO_OPTIMIZE_NOW"); await refreshStatus(); });
document.querySelector("#fullHistory").addEventListener("click", async () => { await send("CGO_FULL_HISTORY"); window.close(); });

load();
