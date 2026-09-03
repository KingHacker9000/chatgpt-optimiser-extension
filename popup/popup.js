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

const THREAD_OVERRIDES_KEY = "threadKeepCounts";
const MODE_HINTS = {
  safe: "Maximum compatibility. Keeps the full React tree and uses rendering containment only.",
  turbo: "Best balance. Trims old history before React and keeps lightweight lazy history.",
  extreme: "Lowest RAM. Adds more aggressive fallback snapshots and trace compaction."
};

let activeTabId = null;
let activeConversationId = null;
let settings = { ...DEFAULT_SETTINGS };
let threadOverrides = {};
let saveTimer = null;
let threadDirty = false;

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, Number(value) || fallback));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function conversationIdFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const match = url.pathname.match(/\/c\/([^/?#]+)/) || url.pathname.match(/\/share\/([^/?#]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  activeConversationId = conversationIdFromUrl(tab?.url || "");
  return tab;
}

async function send(type) {
  if (!activeTabId) return null;
  try { return await chrome.tabs.sendMessage(activeTabId, { type }); }
  catch { return null; }
}

function setModeHint(mode) {
  $("#modeHint").textContent = MODE_HINTS[mode] || "";
}

function updateThreadControls() {
  const available = Boolean(activeConversationId);
  const hasOverride = available && Object.prototype.hasOwnProperty.call(threadOverrides, activeConversationId);
  const overrideValue = hasOverride ? threadOverrides[activeConversationId] : settings.keepCount;

  $("#threadOverrideRow").style.opacity = available ? "1" : ".42";
  $("#threadOverrideEnabled").disabled = !available;
  $("#threadOverrideEnabled").checked = hasOverride;
  $("#threadKeepCount").disabled = !available || !hasOverride;
  $("#threadKeepCount").value = overrideValue;
  $("#threadOverrideHelp").textContent = available
    ? `Override the ${settings.keepCount}-message default only for this thread.`
    : "Open a saved ChatGPT conversation to set a thread override.";

  const effective = hasOverride ? overrideValue : settings.keepCount;
  $("#effectiveBadge").textContent = hasOverride ? `This thread · ${effective}` : `Default · ${effective}`;
  $("#reloadNotice").hidden = !threadDirty || !available;
}

async function load() {
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
  const local = await chrome.storage.local.get({ [THREAD_OVERRIDES_KEY]: {} });
  threadOverrides = local[THREAD_OVERRIDES_KEY] || {};

  $("#enabled").checked = settings.enabled;
  $(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  $("#keepCount").value = settings.keepCount;
  $("#batchSize").value = settings.batchSize;
  $("#autoCollapseTraces").checked = settings.autoCollapseTraces;
  $("#longResponseVirtualization").checked = settings.longResponseVirtualization;
  $("#pauseHiddenRendering").checked = settings.pauseHiddenRendering;
  $("#showDock").checked = settings.showDock;
  setModeHint(settings.mode);

  const tab = await activeTab();
  updateThreadControls();
  const isChatGPT = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab?.url || "");
  if (!isChatGPT) {
    $("#statusLine").textContent = "Open ChatGPT to use the optimizer";
    document.querySelectorAll(".actions button").forEach((button) => { button.disabled = true; });
    return;
  }
  await refreshStatus();
}

async function refreshStatus() {
  const status = await send("CGO_GET_STATUS");
  if (!status?.ok) {
    $("#statusLine").textContent = "Reload this ChatGPT tab once to activate";
    return;
  }
  $("#liveCount").textContent = status.liveDom.toLocaleString();
  $("#trimmedCount").textContent = status.networkRemoved.toLocaleString();
  $("#nodesSaved").textContent = status.approxNodesSaved.toLocaleString();
  const mode = status.mode[0].toUpperCase() + status.mode.slice(1);
  const source = status.networkTrimmed ? "pre-React trim" : status.mode === "safe" ? "containment" : "DOM fallback";
  $("#statusLine").textContent = `${mode} · ${source}${status.generating ? " · streaming" : ""}`;
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 100);
}

async function saveSettings() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "turbo";
  settings = {
    enabled: $("#enabled").checked,
    mode,
    keepCount: clamp($("#keepCount").value, 1, 200, 30),
    batchSize: clamp($("#batchSize").value, 1, 50, 10),
    autoCollapseTraces: $("#autoCollapseTraces").checked,
    longResponseVirtualization: $("#longResponseVirtualization").checked,
    pauseHiddenRendering: $("#pauseHiddenRendering").checked,
    showDock: $("#showDock").checked
  };
  await chrome.storage.sync.set(settings);
  setModeHint(mode);
  updateThreadControls();
  setTimeout(refreshStatus, 180);
}

async function saveThreadOverride() {
  if (!activeConversationId) return;
  const enabled = $("#threadOverrideEnabled").checked;
  if (enabled) {
    threadOverrides[activeConversationId] = clamp($("#threadKeepCount").value, 1, 200, settings.keepCount);
  } else {
    delete threadOverrides[activeConversationId];
  }
  await chrome.storage.local.set({ [THREAD_OVERRIDES_KEY]: threadOverrides });
  threadDirty = true;
  updateThreadControls();
}

for (const control of document.querySelectorAll("#enabled,input[name='mode'],#keepCount,#batchSize,#autoCollapseTraces,#longResponseVirtualization,#pauseHiddenRendering,#showDock")) {
  control.addEventListener("change", queueSave);
  if (control.type === "number") control.addEventListener("input", queueSave);
}

$("#threadOverrideEnabled").addEventListener("change", async () => {
  if ($("#threadOverrideEnabled").checked && activeConversationId && !Object.prototype.hasOwnProperty.call(threadOverrides, activeConversationId)) {
    $("#threadKeepCount").value = settings.keepCount;
  }
  await saveThreadOverride();
});

$("#threadKeepCount").addEventListener("input", () => {
  if (!$("#threadOverrideEnabled").checked) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveThreadOverride, 120);
});
$("#threadKeepCount").addEventListener("change", saveThreadOverride);

$("#applyThreadReload").addEventListener("click", async () => {
  await saveThreadOverride();
  await sleep(160);
  if (activeTabId) await chrome.tabs.reload(activeTabId);
  window.close();
});

$("#older").addEventListener("click", async () => { await send("CGO_OPEN_ARCHIVE"); window.close(); });
$("#latest").addEventListener("click", async () => { await send("CGO_SHOW_LATEST"); await refreshStatus(); });
$("#optimize").addEventListener("click", async () => { await send("CGO_OPTIMIZE_NOW"); await refreshStatus(); });
$("#fullHistory").addEventListener("click", async () => { await send("CGO_FULL_HISTORY"); window.close(); });

load();
