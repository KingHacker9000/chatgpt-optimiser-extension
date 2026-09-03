const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "turbo",
  keepCount: 30,
  batchSize: 10,
  autoCollapseTraces: true,
  longResponseVirtualization: true,
  pauseHiddenRendering: true,
  showDock: true
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});
