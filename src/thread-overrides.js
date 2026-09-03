(() => {
  "use strict";

  const OVERRIDES_STORAGE_KEY = "threadKeepCounts";
  const OVERRIDES_PAGE_KEY = "cgo_thread_overrides_v1";
  const OVERRIDES_EVENT = "cgo-thread-overrides";
  const MIN_KEEP = 1;
  const MAX_KEEP = 200;

  let overrides = {};

  function normalizeMap(value) {
    const clean = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return clean;
    for (const [id, raw] of Object.entries(value)) {
      if (!id || typeof id !== "string") continue;
      const count = Math.min(MAX_KEEP, Math.max(MIN_KEEP, Math.round(Number(raw) || 0)));
      if (Number.isFinite(count) && count >= MIN_KEEP) clean[id] = count;
    }
    return clean;
  }

  function syncToPage() {
    overrides = normalizeMap(overrides);
    const payload = JSON.stringify(overrides);
    try { localStorage.setItem(OVERRIDES_PAGE_KEY, payload); } catch {}
    window.dispatchEvent(new CustomEvent(OVERRIDES_EVENT, { detail: payload }));
  }

  async function load() {
    const result = await chrome.storage.local.get({ [OVERRIDES_STORAGE_KEY]: {} });
    overrides = normalizeMap(result[OVERRIDES_STORAGE_KEY]);
    syncToPage();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[OVERRIDES_STORAGE_KEY]) return;
    overrides = normalizeMap(changes[OVERRIDES_STORAGE_KEY].newValue);
    syncToPage();
  });

  window.addEventListener("cgo-proxy-ready", syncToPage);
  load().catch(() => syncToPage());
})();
